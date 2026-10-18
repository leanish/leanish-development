import { describe, expect, it, vi } from "vitest";

import type { RunProcess } from "@leanish/gate/process";

import { Commands } from "../src/commands.ts";
import { latestRelease, RELEASE_REPOSITORY } from "../src/github-release.ts";

const SHA = "a".repeat(40);
const TAG_SHA = "b".repeat(40);
const RELEASES = `repos/${RELEASE_REPOSITORY}/releases?per_page=100`;
const REF = `repos/${RELEASE_REPOSITORY}/git/ref/tags/v0.7.0`;
const TAG = `repos/${RELEASE_REPOSITORY}/git/tags/${TAG_SHA}`;
const stable = (overrides: Readonly<Record<string, unknown>> = {}) => ({ tag_name: "v0.7.0", published_at: "2026-10-17T00:00:00Z", draft: false, prerelease: false, immutable: true, ...overrides });

function github(pages: unknown = [[stable()]]) {
  const responses = new Map<string, unknown>([[RELEASES, pages], [REF, { ref: "refs/tags/v0.7.0", object: { type: "commit", sha: SHA } }]]);
  const run = vi.fn<RunProcess>(async (command, args) => {
    expect(command).toBe("gh");
    expect(args.slice(0, 5)).toEqual(["api", "--hostname", "github.com", "--method", "GET"]);
    const response = responses.get(args.at(-1)!);
    if (response === undefined) return { code: 1, stdout: "secret-sentinel", stderr: "secret-sentinel" };
    return { code: 0, stdout: JSON.stringify(response), stderr: "" };
  });
  return { responses, run, commands: new Commands(run, {}) };
}

describe("stable release resolution", () => {
  it("chooses newest publication across pages, excluding candidates even when mislabeled", async () => {
    const { commands, run } = github([[stable({ tag_name: "v99.0.0", published_at: "2026-01-01T00:00:00Z" }), stable({ tag_name: "v0.8.0-rc.1" })],
      [stable({ tag_name: "v0.8.0", draft: true }), stable({ tag_name: "v0.9.0", prerelease: true }), stable()]]);
    expect(await latestRelease(commands)).toEqual({ tag: "v0.7.0", sha: SHA });
    expect(run.mock.calls[0]![1]).toContain("--paginate");
    expect(run.mock.calls[0]![1]).toContain("--slurp");
  });

  it("peels annotated tags, including a nested annotation", async () => {
    const { commands, responses } = github();
    responses.set(REF, { ref: "refs/tags/v0.7.0", object: { type: "tag", sha: TAG_SHA } });
    responses.set(TAG, { sha: TAG_SHA, object: { type: "tag", sha: "c".repeat(40) } });
    responses.set(`repos/${RELEASE_REPOSITORY}/git/tags/${"c".repeat(40)}`, { sha: "c".repeat(40), object: { type: "commit", sha: SHA } });
    expect(await latestRelease(commands)).toEqual({ tag: "v0.7.0", sha: SHA });
  });

  it.each([false, undefined, "true"])("refuses mutable or unproven newest releases (%s), without falling back", async (immutable) => {
    const { commands, run } = github([[stable({ tag_name: "v0.6.0", published_at: "2026-01-01T00:00:00Z" }), stable({ immutable })]]);
    await expect(latestRelease(commands)).rejects.toThrow("not immutable");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each([[], [[]], [[stable({ tag_name: "v0.7.0-rc.1" })]], [[stable({ draft: true })]], [[stable({ tag_name: "../../escape" })]]].map((pages) => ({ pages })))("refuses missing stable releases: $pages", async ({ pages }) => {
    await expect(latestRelease(github(pages).commands)).rejects.toThrow();
  });

  it.each([{}, [null], [[null]], [[stable({ published_at: "bad" })]], [[{ tag_name: "v0.7.0" }]]].map((pages) => ({ pages })))("fails closed on malformed metadata: $pages", async ({ pages }) => {
    await expect(latestRelease(github(pages).commands)).rejects.toThrow();
  });

  it.each([
    { ref: "refs/heads/v0.7.0", object: { type: "commit", sha: SHA } },
    { ref: "refs/tags/v0.7.0", object: { type: "commit", sha: "short" } },
    { ref: "refs/tags/v0.7.0", object: { type: "tree", sha: SHA } },
    { ref: "refs/tags/v0.7.0", object: null },
  ])("refuses a false, malformed, or noncommit tag target", async (reference) => {
    const { commands, responses } = github();
    responses.set(REF, reference);
    await expect(latestRelease(commands)).rejects.toThrow();
  });

  it("refuses cyclic tags and mismatched annotation responses", async () => {
    const { commands, responses } = github();
    responses.set(REF, { ref: "refs/tags/v0.7.0", object: { type: "tag", sha: TAG_SHA } });
    responses.set(TAG, { sha: TAG_SHA, object: { type: "tag", sha: TAG_SHA } });
    await expect(latestRelease(commands)).rejects.toThrow("cyclic");
    responses.set(TAG, { sha: SHA, object: { type: "commit", sha: SHA } });
    await expect(latestRelease(commands)).rejects.toThrow("different annotated tag");
  });

  it("sanitizes transport errors and non-JSON responses", async () => {
    const commands = new Commands(async () => ({ code: 1, stdout: "secret-sentinel", stderr: "secret-sentinel" }), {});
    await expect(latestRelease(commands)).rejects.toThrow(/^Could not read GitHub releases/);
    const malformed = new Commands(async () => ({ code: 0, stdout: "secret-sentinel", stderr: "" }), {});
    await expect(latestRelease(malformed)).rejects.toThrow(/^GitHub returned invalid JSON$/);
  });
});
