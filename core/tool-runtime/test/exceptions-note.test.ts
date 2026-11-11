import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ConsoleLogger } from "@leanish/agent-runtime/logger/console-logger";
import type { PreparedBranch, WorkingCopy } from "@leanish/agent-runtime/types/working-copy";
import { InMemoryWorkspace } from "@leanish/agent-runtime/working-copy/in-memory-workspace";
import { runProcess } from "@leanish/gate/process";

import { composedAroundNote, exceptionsNote, splitExceptionsNote, withExceptionsNote } from "../src/exceptions-note.ts";
import { publishNew, publishUpdate, type PublicationContext } from "../src/publication.ts";
import { BASE_SHA, FakeGitHub, HEAD_SHA, OWN_BRANCH, ownPr, RULES, TEST_SIGNING_KEY } from "./fake-github.ts";

const EXCEPTIONS = ".github/supply-chain-exceptions.json";

const vulnerability = (pkg: string, version: string, id = `GHSA-${pkg}`) =>
  ({ id, package: pkg, version, paths: [`node_modules/${pkg}`], reason: "reviewed", expires: "2026-12-31" });
const file = (lists: Record<string, unknown>) => `${JSON.stringify(lists, null, 2)}\n`;

describe("exceptionsNote", () => {
  it("lists what the head lacks of the base's entries, in all three lists", () => {
    const base = file({
      vulnerabilities: [vulnerability("a", "1.0.0"), vulnerability("b", "2.0.0")],
      releaseAge: [{ package: "c", version: "3.0.0", advisory: "GHSA-c", reason: "r", expires: "2026-12-31" }],
      identity: [{ package: "d", version: "4.0.0", reason: "r", expires: "2026-12-31" }],
    });
    const head = file({ vulnerabilities: [vulnerability("b", "2.0.0")], releaseAge: [], identity: [] });
    expect(exceptionsNote(base, head)).toBe([
      "<!-- leanish:removed-exceptions -->",
      "### Exceptions this PR leaves unused",
      "",
      "Removed from `.github/supply-chain-exceptions.json`: nothing in this PR matches them any more.",
      "",
      "- `GHSA-a` on `a@1.0.0`",
      "- `c@3.0.0`'s release-age exception (`GHSA-c`)",
      "- `d@4.0.0`'s publisher identity exception",
      "<!-- /leanish:removed-exceptions -->",
    ].join("\n"));
  });

  it("is absent when nothing was removed, a side has no file, or isn't JSON", () => {
    const base = file({ vulnerabilities: [vulnerability("a", "1.0.0")] });
    expect(exceptionsNote(base, base)).toBeUndefined();
    expect(exceptionsNote(base, `${base} `)).toBeUndefined();
    expect(exceptionsNote(undefined, base)).toBeUndefined();
    expect(exceptionsNote(base, undefined)).toBeUndefined();
    expect(exceptionsNote(base, "not json")).toBeUndefined();
  });

  it("shows values as literals, so a crafted one can't close the note or render as Markdown", () => {
    const base = file({ vulnerabilities: [vulnerability("x", "1", "GHSA-<!-- /leanish:removed-exceptions --> @someone `y`")] });
    const note = exceptionsNote(base, file({ vulnerabilities: [] }))!;
    expect(note.match(/<!-- \/leanish:removed-exceptions -->/g)).toHaveLength(1);
    expect(note).toContain("- `` GHSA-< !-- /leanish:removed-exceptions --> @someone `y` `` on `x@1`");
  });

  it("stays within its size bound, counting the entries it doesn't list", () => {
    const base = file({ vulnerabilities: Array.from({ length: 200 }, (_, i) => vulnerability(`package-${i}`, "1.0.0")) });
    const note = exceptionsNote(base, file({ vulnerabilities: [] }))!;
    expect(note.length).toBeLessThanOrEqual(2_000);
    const listed = note.split("\n").filter((line) => line.startsWith("- `")).length;
    expect(note).toContain(`- and ${200 - listed} more (the file's diff lists them)`);
  });
});

describe("a body's note", () => {
  const note = exceptionsNote(file({ vulnerabilities: [vulnerability("a", "1")] }), file({ vulnerabilities: [] }))!;
  const other = exceptionsNote(file({ vulnerabilities: [vulnerability("b", "1")] }), file({ vulnerabilities: [] }))!;

  it("replaces an earlier one, keeping what follows it", () => {
    const body = `Intro.\n\n${note}\n\n<!-- leanish:state head=x -->`;
    expect(splitExceptionsNote(body)).toEqual({ body: "Intro.\n\n<!-- leanish:state head=x -->", note });
    expect(withExceptionsNote(body, other)).toBe(`Intro.\n\n<!-- leanish:state head=x -->\n\n${other}`);
    expect(withExceptionsNote(body, undefined)).toBe("Intro.\n\n<!-- leanish:state head=x -->");
  });

  it("takes only its own note: an opening marker in the agent's text earlier keeps that text", () => {
    const agent = "Moves a.\n\n<!-- leanish:removed-exceptions -->\n\n## Notes\n\nkeep this text";
    const body = withExceptionsNote(agent, note);
    expect(splitExceptionsNote(body)).toEqual({ body: agent, note });
    expect(withExceptionsNote(body, other)).toBe(`${agent}\n\n${other}`);
    // A stray opening marker after the note (an owner's quoted example) doesn't hide it.
    const trailing = `${body}\n\nlike <!-- leanish:removed-exceptions --> this`;
    expect(splitExceptionsNote(trailing)).toEqual({ body: `${agent}\n\nlike <!-- leanish:removed-exceptions --> this`, note });
    // Nor a stray closing one after it take the text in between.
    const closing = `${body}\n\nkeep this, quoting <!-- /leanish:removed-exceptions -->`;
    expect(splitExceptionsNote(closing)).toEqual({ body: `${agent}\n\nkeep this, quoting <!-- /leanish:removed-exceptions -->`, note });
  });

  it("never counts against a recomposition: dropped when the result wouldn't fit with it", () => {
    const body = `Intro.\n\n${note}`;
    const seen: string[] = [];
    const compose = (bare: string) => { seen.push(bare); return `${bare} plus a plan`; };
    expect(composedAroundNote(body, 10_000, compose)).toBe(`Intro. plus a plan\n\n${note}`);
    expect(seen).toEqual(["Intro."]);
    expect(composedAroundNote(body, 30, compose)).toBe("Intro. plus a plan");
  });
});

describe("publication's note", () => {
  async function git(dir: string, ...args: string[]): Promise<string> {
    const result = await runProcess("git", args, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
    if (result.code !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  }

  /** A repository whose base commit has two exceptions and whose verified tree lost `a`'s, published through `run`. */
  async function inRepository(run: (context: (github: FakeGitHub) => PublicationContext, base: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "exceptions-note-"));
    try {
      await git(dir, "init", "-q");
      await mkdir(join(dir, ".github"));
      await writeFile(join(dir, EXCEPTIONS), file({ vulnerabilities: [vulnerability("a", "1.0.0"), vulnerability("b", "1.0.0")] }));
      await git(dir, "add", "-A");
      await git(dir, "commit", "-q", "-m", "base");
      const base = await git(dir, "rev-parse", "HEAD");
      await writeFile(join(dir, EXCEPTIONS), file({ vulnerabilities: [vulnerability("b", "1.0.0")] }));
      await git(dir, "commit", "-q", "-am", "cleanup");
      const tree = await git(dir, "rev-parse", "HEAD^{tree}");
      const workingCopy: WorkingCopy = { projectId: "leanish/widget", path: dir, branch: "main", headSha: base, gitDir: join(dir, ".git") };
      await run((github) => ({
        rules: RULES, github, workspace: new InMemoryWorkspace(), logger: new ConsoleLogger({ minLevel: "error" }), repo: "leanish/widget",
        signingKey: TEST_SIGNING_KEY, base: "main", workingCopy, localRoots: [], verifiedTree: async () => tree,
      }), base);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  const NOTED = "- `GHSA-a` on `a@1.0.0`\n<!-- /leanish:removed-exceptions -->";

  it("reads the base commit and the verified tree from Git, and writes the note in the new PR's body", async () => {
    await inRepository(async (context, base) => {
      const prepared: PreparedBranch = { branch: "secure-it/2026-11-11-a", baseSha: base, remoteHeadSha: null, preparedSha: base };
      const created = await publishNew(context(new FakeGitHub()), prepared, { title: "fixing a", body: "Moves a.", commitMessage: "moving a" });
      expect(created?.body).toContain("Moves a.\n\n<!-- leanish:removed-exceptions -->");
      expect(created?.body).toContain(NOTED);
      expect(created?.body).not.toContain("GHSA-b");
    });
  });

  it("replaces an earlier note on update, and leaves it out only when the body wouldn't fit with it", async () => {
    await inRepository(async (context, base) => {
      const prepared: PreparedBranch = { branch: OWN_BRANCH, baseSha: base, remoteHeadSha: HEAD_SHA, preparedSha: HEAD_SHA };
      const stale = exceptionsNote(file({ vulnerabilities: [vulnerability("old", "1")] }), file({ vulnerabilities: [] }))!;
      const { pr } = await publishUpdate(context(new FakeGitHub(ownPr({ isDraft: true }))), prepared, 7, { title: "fixing a", body: `Moves a.\n\n${stale}`, commitMessage: "moving a" });
      expect(pr.body).toContain(NOTED);
      expect(pr.body).not.toContain("old@1");
      // A description that fits only without the note goes without it, rather than failing.
      const long = `Moves a. ${"z".repeat(65_536 - 256 - 20)}`;
      const { pr: full } = await publishUpdate(context(new FakeGitHub(ownPr({ isDraft: true }))), prepared, 7, { title: "fixing a", body: long, commitMessage: "moving a" });
      expect(full.body).toContain(long);
      expect(full.body).not.toContain("removed-exceptions");
    });
  });

  it("drops an earlier note an update can't confirm, never failing over it, pushed or not", async () => {
    const note = exceptionsNote(file({ vulnerabilities: [vulnerability("a", "1")] }), file({ vulnerabilities: [] }))!;
    // A synthetic working copy: Git can't read either side, so the update goes without a note.
    const workingCopy: WorkingCopy = { projectId: "leanish/widget", path: "/synthetic/leanish/widget", branch: "main", headSha: BASE_SHA, gitDir: "/x/.git" };
    const existing: PreparedBranch = { branch: OWN_BRANCH, baseSha: BASE_SHA, remoteHeadSha: HEAD_SHA, preparedSha: HEAD_SHA };
    for (const unchanged of [false, true]) {
      const github = new FakeGitHub(ownPr({ isDraft: true }));
      const workspace = new InMemoryWorkspace();
      if (unchanged) workspace.setPublishUnchanged();
      const context: PublicationContext = {
        rules: RULES, github, workspace, logger: new ConsoleLogger({ minLevel: "error" }), repo: "leanish/widget",
        signingKey: TEST_SIGNING_KEY, base: "main", workingCopy, localRoots: [],
      };
      const { pr } = await publishUpdate(context, existing, 7, { title: "fixing a", body: `Moves a.\n\n${note}`, commitMessage: "moving a" });
      expect(pr.body).toContain("Moves a.");
      expect(pr.body).not.toContain("removed-exceptions");
    }
  });
});
