import { describe, expect, it } from "vitest";

import { ConsoleLogger } from "@leanish/agent-runtime/logger/console-logger";
import type { WorkingCopy } from "@leanish/agent-runtime/types/working-copy";
import { InMemoryWorkspace } from "@leanish/agent-runtime/working-copy/in-memory-workspace";
import { prepareUnitBranch, type UnitBranch } from "../src/branches.ts";
import type { PublicationContext } from "../src/publication.ts";
import { MemoryJournal } from "./memory-journal.ts";
import { BASE_SHA, FakeGitHub, HEAD_SHA, OWN_BRANCH, ownPr, RULES } from "./fake-github.ts";

const REPO = "leanish/widget";
const NOW = new Date("2026-10-07T06:00:00Z");
const OTHER_SHA = "9".repeat(40);
/** InMemoryWorkspace reports the working copy's head as each preparation's base. */
const WC: WorkingCopy = { projectId: REPO, path: "/synthetic/leanish/widget", branch: "main", headSha: BASE_SHA, gitDir: "/x/.git" };

function context(github = new FakeGitHub(), workspace = new InMemoryWorkspace()): PublicationContext {
  return { rules: RULES, github, workspace, logger: new ConsoleLogger({ minLevel: "error" }), repo: REPO, base: "main", workingCopy: WC, journal: new MemoryJournal(), localRoots: [] };
}

function unit(overrides: Partial<UnitBranch> = {}): UnitBranch & { readonly reverted: string[] } {
  const reverted: string[] = [];
  return {
    topic: "vite", reusable: undefined, own: [], taken: new Set(), baseSha: BASE_SHA, now: NOW,
    revert: async (_wc, sha) => { reverted.push(sha); },
    reverted,
    ...overrides,
  };
}

describe("prepareUnitBranch", () => {
  it.each([false, true])("reuses the PR's branch with the base merged in, conflicted %s, then reverts to the base", async (conflicted) => {
    const workspace = new InMemoryWorkspace();
    workspace.setRemoteHead(OWN_BRANCH, HEAD_SHA);
    if (conflicted) workspace.setPrepareConflict(OWN_BRANCH);
    const reusing = unit({ reusable: ownPr() });
    const prepared = await prepareUnitBranch(context(new FakeGitHub(), workspace), reusing);
    expect(prepared).toMatchObject({ branch: OWN_BRANCH, baseSha: BASE_SHA, remoteHeadSha: HEAD_SHA });
    expect(workspace.preparations.map((entry) => entry.args)).toEqual([{ branch: OWN_BRANCH, start: "remote-merging" }]);
    expect(reusing.reverted).toEqual([BASE_SHA]);
    expect(reusing.taken.size).toBe(0);
  });

  it("refuses a PR that moved, or a default branch that moved, before reverting anything", async () => {
    const moved = new InMemoryWorkspace();
    moved.setRemoteHead(OWN_BRANCH, OTHER_SHA);
    const pushed = unit({ reusable: ownPr() });
    await expect(prepareUnitBranch(context(new FakeGitHub(), moved), pushed)).rejects.toThrow("https://github.com/leanish/widget/pull/7 moved while secure-it prepared it");
    expect(pushed.reverted).toEqual([]);

    const base = new InMemoryWorkspace();
    base.setRemoteHead(OWN_BRANCH, HEAD_SHA);
    base.setPrepareConflict(OWN_BRANCH);
    const stale = unit({ reusable: ownPr(), baseSha: OTHER_SHA });
    await expect(prepareUnitBranch(context(new FakeGitHub(), base), stale)).rejects.toThrow(/^the default branch moved while secure-it ran \(9{12} → e{12}\); the next run starts over$/);
    expect(stale.reverted).toEqual([]);
  });

  it("refuses a merge that conflicted without leaving its conflicts in progress", async () => {
    const workspace = new InMemoryWorkspace();
    workspace.prepareBranch = async () => ({ kind: "conflict" });
    const reusing = unit({ reusable: ownPr() });
    await expect(prepareUnitBranch(context(new FakeGitHub(), workspace), reusing)).rejects.toThrow(`${OWN_BRANCH}: remote-merging reported a conflict without leaving it in progress`);
    expect(reusing.reverted).toEqual([]);
  });

  it("starts a fresh branch at the base, clearing a leftover of that name, past the open PRs' and this run's branches", async () => {
    const github = new FakeGitHub();
    github.branches.add("secure-it/2026-10-07-vite-3");
    const workspace = new InMemoryWorkspace();
    const fresh = unit({ own: [ownPr({ headRef: "secure-it/2026-10-07-vite" })], taken: new Set(["secure-it/2026-10-07-vite-2"]) });
    const prepared = await prepareUnitBranch(context(github, workspace), fresh);
    expect(prepared).toEqual({ branch: "secure-it/2026-10-07-vite-3", baseSha: BASE_SHA, remoteHeadSha: null, preparedSha: BASE_SHA });
    expect(workspace.preparations.map((entry) => entry.args)).toEqual([{ branch: "secure-it/2026-10-07-vite-3", start: "default" }]);
    expect(github.branches.has("secure-it/2026-10-07-vite-3")).toBe(false);
    expect([...fresh.taken]).toEqual(["secure-it/2026-10-07-vite-2", "secure-it/2026-10-07-vite-3"]);
    expect(fresh.reverted).toEqual([]);
  });

  it("keeps a fresh branch reserved when preparing it fails, so the next unit of the run takes another", async () => {
    const taken = new Set<string>();
    const github = new FakeGitHub(ownPr({ number: 8, headRef: "secure-it/2026-10-07-vite", body: "a person's PR", labels: [] }));
    // An open PR on the name (someone's, not the tool's): clearing the leftover refuses.
    await expect(prepareUnitBranch(context(github), unit({ taken }))).rejects.toThrow("already has an open PR (#8)");
    const refusing = new InMemoryWorkspace();
    refusing.prepareBranch = async () => ({ kind: "conflict" });
    await expect(prepareUnitBranch(context(new FakeGitHub(), refusing), unit({ taken }))).rejects.toThrow("secure-it/2026-10-07-vite-2 couldn't be prepared");
    const moved = new InMemoryWorkspace();
    await expect(prepareUnitBranch(context(new FakeGitHub(), moved), unit({ taken, baseSha: OTHER_SHA }))).rejects.toThrow("the default branch moved while secure-it ran");
    expect([...taken]).toEqual(["secure-it/2026-10-07-vite", "secure-it/2026-10-07-vite-2", "secure-it/2026-10-07-vite-3"]);
    expect((await prepareUnitBranch(context(), unit({ taken }))).branch).toBe("secure-it/2026-10-07-vite-4");
  });
});
