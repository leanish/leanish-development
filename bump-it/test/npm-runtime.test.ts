import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { GateEnvironment } from "@leanish/gate/gate";
import type { Tree } from "@leanish/gate/tree";
import type { ToolRunContext } from "@leanish/tool-runtime/command";
import { exportCommit } from "@leanish/tool-runtime/git-copies";
import { runSandboxed } from "@leanish/tool-runtime/sandboxed";

import { fakeFetch } from "@leanish/gate/test/fake-fetch";

import { computeOnBase, targetSources } from "../src/npm-runtime.ts";
import { majorUnits } from "../src/units.ts";
import { candidate } from "./fixtures.ts";

vi.mock("@leanish/tool-runtime/git-copies", () => ({ exportCommit: vi.fn() }));
vi.mock("@leanish/tool-runtime/sandboxed", () => ({ runSandboxed: vi.fn() }));

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
  vi.clearAllMocks();
});

const NOW = new Date("2026-10-07T12:00:00Z");
const manifest = { dependencies: { lib: "^1.0.0" } };
const lock = (version = "1.0.0") => ({
  lockfileVersion: 3,
  packages: {
    "": manifest,
    "node_modules/lib": { version, dependencies: { child: "^1" } },
    "node_modules/child": { version: "1.0.0" },
  },
});

async function fixture(npmVersion: string) {
  const dir = await mkdtemp(join(process.cwd(), ".bump-test-"));
  dirs.push(dir);
  const files: Record<string, string> = {
    "package.json": JSON.stringify(manifest),
    "package-lock.json": JSON.stringify(lock()),
  };
  for (const [path, content] of Object.entries(files)) {
    await writeFile(join(dir, path), content);
  }
  const base: Tree = { id: "a".repeat(40), read: async (path) => files[path], list: async () => [] };
  const context = {
    workingCopy: { path: "/synthetic/widget", projectId: "leanish/widget", gitDir: "/synthetic/git", headSha: base.id, branch: "main" },
    isolation: { readDenied: [], env: {}, buildCacheRoot: "/tmp/bump-it-test-cache" },
    releaseAgeDays: 7,
    releaseAgeExclude: [],
  } as unknown as ToolRunContext;
  const remove = vi.fn(async () => {});
  vi.mocked(exportCommit).mockResolvedValue({ dir, remove });
  const fetch = vi.fn<GateEnvironment["fetch"]>(async (url) => {
    const young = String(url).endsWith("/child");
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ versions: { "1.0.0": {} }, time: { "1.0.0": young ? "2026-10-06T12:00:00Z" : "2026-09-01T12:00:00Z" } }),
      text: async () => "",
    };
  });
  const env: GateEnvironment = {
    fetch,
    run: async () => { throw new Error("only sandboxed npm may run"); },
    now: () => NOW,
    osvScanner: "/synthetic/osv-scanner",
    githubToken: undefined,
  };
  vi.mocked(runSandboxed).mockImplementation(async (isolation, args) => {
    expect(isolation).toBe(context.isolation);
    expect(args.workingCopy).toEqual({ ...context.workingCopy, path: dir });
    if (args.command[1] === "--version") {
      return { code: 0, stdout: npmVersion, stderr: "" };
    }
    if (!args.command.includes("--min-release-age-exclude=child")) {
      return { code: 1, stdout: "", stderr: "notarget No matching version found for child@1.0.0 with a date before the window" };
    }
    await writeFile(join(dir, "package-lock.json"), JSON.stringify(lock("2.0.0")));
    return { code: 0, stdout: "", stderr: "" };
  });
  return { dir, base, context, env, fetch, remove, unit: majorUnits([candidate()])[0]! };
}

describe("sandboxed computation on base", () => {
  it("protects a young base version on a major without any trusted-scope exclusions", async () => {
    const h = await fixture("11.20.0");
    const result = await computeOnBase(h.context, h.unit, h.base, h.env, undefined);
    const calls = vi.mocked(runSandboxed).mock.calls.map(([, args]) => args.command);
    expect(calls[0]).toEqual(["npm", "--version"]);
    expect(calls[1]).toContain("--min-release-age-exclude=child");
    expect(calls[1]).toContain("--min-release-age=7");
    expect(result.notes).toEqual(["child: its locked 1.0.0 is younger than the window, so npm's own window skips it; bump-it's targets still require the age"]);
    expect(result.changes).toMatchObject([{ name: "lib", from: "1.0.0", to: "2.0.0" }]);
    expect(h.fetch.mock.calls.filter(([url]) => String(url).endsWith("/child"))).toHaveLength(1);
    expect(h.remove).toHaveBeenCalledOnce();
  });

  it("requires npm >= 11.17 for a young base alone, and removes the scratch copy on failure", async () => {
    const h = await fixture("11.14.1");
    await expect(computeOnBase(h.context, h.unit, h.base, h.env, undefined))
      .rejects.toThrow("young or unreadable locked versions require npm >= 11.17.0 (min-release-age-exclude: child); got 11.14.1");
    expect(vi.mocked(runSandboxed).mock.calls.map(([, args]) => args.command)).toEqual([["npm", "--version"]]);
    expect(await readFile(join(h.dir, "package.json"), "utf8")).toBe(JSON.stringify(manifest));
    expect(h.remove).toHaveBeenCalledOnce();
  });
});

it("filters ignored npm transitive candidates without removing their manifest history", async () => {
  const config = JSON.stringify({ ignoredVersions: [{ package: "npm:child", versions: ["0.9.0", "1.0.0", "1.2.0"], reason: "broken" }] });
  const base: Tree = { id: "base", read: async (path) => path === ".github/supply-chain.json" ? config : path === "package-lock.json" ? JSON.stringify(lock()) : undefined, list: async () => [] };
  const env: GateEnvironment = { now: () => NOW, osvScanner: "unused", githubToken: undefined, run: async () => { throw new Error("unexpected run"); }, fetch: fakeFetch({
    "https://registry.npmjs.org/child": { body: { versions: { "0.9.0": {}, "1.0.0": {}, "1.1.0": {}, "1.2.0": {} }, time: { "1.2.0": "2026-09-01T00:00:00Z" } } },
  }) };
  const notes: string[] = [];
  const sources = await targetSources(base, env, undefined, (note) => notes.push(note));
  expect(await sources.versions("child")).toEqual(["1.1.0"]);
  expect(notes).toEqual(["child@0.9.0: ignored candidate by policy: broken", "child@1.0.0: ignored candidate by policy: broken", "child@1.2.0: ignored candidate by policy: broken"]);
  expect(sources.ignoredReason?.("child", "1.2.0")).toBe("broken");
  expect(await sources.published("child", "1.2.0")).toEqual(new Date("2026-09-01T00:00:00Z"));
});
