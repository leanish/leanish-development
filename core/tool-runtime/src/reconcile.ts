/** Redo a plan on a clean base; restore its publication parent only after verification. */
import type { PreparedBranch, WorkingCopy } from "@leanish/agent-runtime/types/working-copy";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runProcess, type RunProcess } from "@leanish/gate/process";

import { changedSince, git } from "./git-copies.ts";

/** Detach at the base with a clean index/worktree, dropping old edits and non-ignored leftovers. Branch refs stay put. */
export async function revertToBase(workingCopy: WorkingCopy, baseSha: string, run: RunProcess = runProcess): Promise<string[]> {
  if (!/^[0-9a-f]{40}$/.test(baseSha)) throw new Error(`revertToBase needs a full commit sha; got '${baseSha}'`);
  const changed = await changedSince(workingCopy, baseSha, run);
  await step(workingCopy, ["checkout", "--detach", "--force", baseSha], run);
  if (changed.length > 0) await step(workingCopy, ["clean", "-q", "-f", "-d", "--", ...changed], run);
  const still = await changedSince(workingCopy, baseSha, run);
  if (still.length > 0) throw new Error(`reverting to ${baseSha} left ${still.join(", ")} changed`);
  return changed;
}

/**
 * Reattach a verified base redo to the original PR head without changing its worktree or index. The runtime still
 * stages and checks the verified tree, checks the remote head, journals and pushes normally. A moved base is a second
 * merge parent, preserving its ancestry too. Attached workspaces (including conflict resolution) are left alone.
 */
export async function publicationParent(workingCopy: WorkingCopy, prepared: PreparedBranch, run: RunProcess = runProcess): Promise<PreparedBranch> {
  const attached = await git(workingCopy, ["symbolic-ref", "--quiet", "HEAD"], run);
  if (attached.code === 0) return prepared;
  if (attached.code !== 1) throw new Error(`reading the publication branch failed: ${attached.stderr.trim()}`);
  const head = await step(workingCopy, ["rev-parse", "HEAD"], run);
  if (head !== prepared.baseSha) throw new Error("publication workspace is no longer at the prepared base");
  const branch = `refs/heads/${prepared.branch}`;
  const parent = prepared.remoteHeadSha ?? prepared.baseSha;
  // The compare-and-swap preserves the original preparation check even though the agent worked detached.
  await step(workingCopy, ["update-ref", branch, parent, prepared.preparedSha], run);
  await step(workingCopy, ["symbolic-ref", "HEAD", branch], run);
  if (prepared.remoteHeadSha !== null) {
    const ancestor = await git(workingCopy, ["merge-base", "--is-ancestor", prepared.baseSha, parent], run);
    if (ancestor.code === 1) await writeFile(join(workingCopy.gitDir!, "MERGE_HEAD"), `${prepared.baseSha}\n`);
    else if (ancestor.code !== 0) throw new Error(`checking the publication base ancestry failed: ${ancestor.stderr.trim()}`);
  }
  return { ...prepared, preparedSha: parent };
}

async function step(workingCopy: WorkingCopy, args: ReadonlyArray<string>, run: RunProcess): Promise<string> {
  const result = await git(workingCopy, args, run);
  if (result.code !== 0) throw new Error(`git ${args[0]} while preparing the workspace failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}
