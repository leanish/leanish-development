/** The branch a run's unit works on: its open PR's, reconciled from a clean base, or a fresh one of its own. */
import type { GitHubPullRequest } from "@leanish/agent-runtime/types/clients";
import type { PreparedBranch, WorkingCopy } from "@leanish/agent-runtime/types/working-copy";

import { freeBranch } from "./own-pr.ts";
import { clearLeftoverBranch, type PublicationContext } from "./publication.ts";

export interface UnitBranch {
  /** The unit's topic, which names a fresh branch (`freeBranch`). */
  readonly topic: string;
  /** The open PR the unit reuses (already repaired: `repairOwnership`); undefined for a fresh branch. */
  readonly reusable: GitHubPullRequest | undefined;
  /** The tool's open PRs: their branches are taken. */
  readonly own: ReadonlyArray<GitHubPullRequest>;
  /**
   * Branches this run took, the caller's for the whole run: a fresh branch is added before anything can fail, and
   * stays, so a later unit never takes a branch this run may have pushed (two topics can cut to the same name).
   */
  readonly taken: Set<string>;
  /** The default branch's head the unit's plan was computed on. */
  readonly baseSha: string;
  readonly now: Date;
  /** Starts the reused PR's redo detached at `baseSha`, with a clean index and worktree (`revertToBase`). */
  readonly revert: (workingCopy: WorkingCopy, baseSha: string) => Promise<unknown>;
}

/**
 * The unit's branch, prepared from the base its plan was computed on. A reused PR's branch keeps its history: the base
 * merged in (a conflicting merge is fine, its edits go anyway), then, only once its head and the base are the ones
 * expected, `revert` drops its earlier edits for the new plan to start clean. A fresh branch starts at the base.
 * Throws when the default branch or the PR moved meanwhile: the next run starts over.
 */
export async function prepareUnitBranch(context: PublicationContext, unit: UnitBranch): Promise<PreparedBranch> {
  return unit.reusable === undefined ? freshBranch(context, unit) : reusedBranch(context, unit.reusable, unit);
}

async function reusedBranch(context: PublicationContext, pr: GitHubPullRequest, unit: UnitBranch): Promise<PreparedBranch> {
  const merged = await context.workspace.prepareBranch(context.workingCopy, { branch: pr.headRef, start: "remote-merging" });
  if (merged.kind === "conflict") throw new Error(`${pr.headRef}: remote-merging reported a conflict without leaving it in progress`);
  if (merged.prepared.remoteHeadSha !== pr.headSha) throw new Error(`${pr.url} moved while ${context.rules.tool} prepared it`);
  assertBase(context, merged.prepared, unit.baseSha);
  await unit.revert(context.workingCopy, unit.baseSha);
  return merged.prepared;
}

async function freshBranch(context: PublicationContext, unit: UnitBranch): Promise<PreparedBranch> {
  const branch = freeBranch(context.rules, unit.now, unit.topic, new Set([...unit.own.map((pr) => pr.headRef), ...unit.taken]));
  unit.taken.add(branch);
  await clearLeftoverBranch(context.github, context.rules, context.repo, branch);
  const fresh = await context.workspace.prepareBranch(context.workingCopy, { branch, start: "default" });
  if (fresh.kind !== "prepared") throw new Error(`${branch} couldn't be prepared`);
  assertBase(context, fresh.prepared, unit.baseSha);
  return fresh.prepared;
}

function assertBase(context: PublicationContext, prepared: PreparedBranch, baseSha: string): void {
  if (prepared.baseSha !== baseSha) {
    throw new Error(`the default branch moved while ${context.rules.tool} ran (${baseSha.slice(0, 12)} → ${prepared.baseSha.slice(0, 12)}); the next run starts over`);
  }
}
