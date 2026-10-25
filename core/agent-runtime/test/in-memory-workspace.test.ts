// Copied from leanish/leanish-development core/runtime/test/unit/in-memory-workspace.test.ts at c6282df; see PROVENANCE.md.
// Local changes: `RepoSource` instead of catalog-it's `Project`; imports this package's modules from `../src/` instead of `../../src/`.
import { describe, expect, it } from "vitest";

import { InMemoryWorkspace } from "../src/working-copy/in-memory-workspace.ts";
import type { RepoSource as Project } from "../src/types/repo-source.ts";

const ATC: Project = {
  id: "leanish/atc",
  source: { url: "https://github.com/leanish/atc.git", branch: "main" },
};

describe("InMemoryWorkspace.sync", () => {
  it("records pushes at the push point, not failed callbacks or a caller's eventual result", async () => {
    const workspace = new InMemoryWorkspace();
    const workingCopy = (await workspace.sync([ATC])).workingCopies[0]!;
    const prepared = { branch: "secure-it/test", baseSha: workingCopy.headSha, remoteHeadSha: null, preparedSha: workingCopy.headSha };
    await expect(workspace.publishBranch(workingCopy, prepared, { message: "fixing", beforePush: async () => { throw new Error("refused"); } }))
      .rejects.toThrow("refused");
    expect(workspace.pushes).toEqual([]);
    await expect((async () => {
      await workspace.publishBranch(workingCopy, prepared, { message: "fixing" });
      throw new Error("failed after the push");
    })()).rejects.toThrow("failed after the push");
    expect(workspace.pushes).toEqual([{ projectId: ATC.id, branch: prepared.branch, sha: "c".repeat(40) }]);
    workspace.setPublishUnchanged();
    await workspace.publishBranch(workingCopy, prepared, { message: "fixing" });
    expect(workspace.pushes).toHaveLength(1);
  });

  it("first sync reports 'cloned' with the synthesised sha", async () => {
    const ws = new InMemoryWorkspace();
    const result = await ws.sync([ATC]);
    expect(result.report[0]).toMatchObject({ projectId: ATC.id, outcome: "cloned" });
    expect(result.workingCopies[0]?.path).toBe("/synthetic/leanish/atc");
  });

  it("repeated sync without a scheduled outcome reports 'dedup'", async () => {
    const ws = new InMemoryWorkspace();
    await ws.sync([ATC]);
    const second = await ws.sync([ATC]);
    expect(second.report[0]).toMatchObject({ outcome: "dedup" });
  });

  it("setExpectedOutcome('fast-forward') reports the advance and updates headSha", async () => {
    const ws = new InMemoryWorkspace();
    await ws.sync([ATC]);
    ws.setExpectedOutcome(ATC.id, "fast-forward", "1".repeat(40));
    const result = await ws.sync([ATC]);
    expect(result.report[0]).toMatchObject({
      outcome: "fast-forward",
      fromSha: "0".repeat(40),
      toSha: "1".repeat(40),
    });
    expect(result.workingCopies[0]?.headSha).toBe("1".repeat(40));
  });

  it("setExpectedOutcome('no-change') reports no-change with the supplied toSha", async () => {
    const ws = new InMemoryWorkspace();
    await ws.sync([ATC]);
    ws.setExpectedOutcome(ATC.id, "no-change", "0".repeat(40));
    const result = await ws.sync([ATC]);
    expect(result.report[0]).toMatchObject({
      outcome: "no-change",
      fromSha: "0".repeat(40),
      toSha: "0".repeat(40),
    });
  });

  it("setExpectedOutcome('reset') reports reset and reflects the new head", async () => {
    const ws = new InMemoryWorkspace();
    await ws.sync([ATC]);
    ws.setExpectedOutcome(ATC.id, "reset", "2".repeat(40));
    const result = await ws.sync([ATC]);
    expect(result.report[0]).toMatchObject({
      outcome: "reset",
      fromSha: "0".repeat(40),
      toSha: "2".repeat(40),
    });
  });

  it("scheduled outcomes are single-use; the next sync reverts to dedup", async () => {
    const ws = new InMemoryWorkspace();
    await ws.sync([ATC]);
    ws.setExpectedOutcome(ATC.id, "fast-forward", "1".repeat(40));
    await ws.sync([ATC]);
    const next = await ws.sync([ATC]);
    expect(next.report[0]?.outcome).toBe("dedup");
  });
});
