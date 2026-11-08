/**
 * The review tick both tools run between their scheduled runs: it looks at
 * every open PR of the tool, in this order, and never lets one PR's problem
 * stop the others:
 *
 *   1. someone else pushed (the head isn't the one the PR's body records) or
 *      removed the body's state → leave the PR alone, report it (`ownership.ts`);
 *   2. the base moved (any merge, conflicts or not) → `steps.rebase`, before
 *      anything else: the tool recomputes its plan on the new base, retires
 *      what the base already has, or merges the base and re-applies (the agent
 *      only when code needs adapting);
 *   3. CI pending → nothing; green → ready for review; no checks → report;
 *   4. CI failed → `steps.adapt` (the agent), at most `MAX_ADAPTATIONS` times
 *      per PR, each attempt counted in its body before the agent starts (a
 *      failed attempt counts too); after that, close it with a comment.
 *
 * A tool may keep a PR a draft through its disposition, until the display time it supplies. A person who marked
 * that PR ready owns it: the tick leaves it alone. The tool also reports any graduation it completed there, before
 * branch or CI work. A PR held only by the gate's cooldown waits too: no adaptation can make a version older.
 *
 * Steps 1 and 3 need no model.
 */
import { GitHubApiError } from "@leanish/agent-runtime/github/github-client";
import type { GitHubClient, GitHubPullRequest, GitHubRequiredChecks } from "@leanish/agent-runtime/types/clients";
import type { Logger } from "@leanish/agent-runtime/types/logger";
import type { PreparedBranch, WorkingCopy } from "@leanish/agent-runtime/types/working-copy";
import type { Workspace } from "@leanish/agent-runtime/working-copy/workspace";

import { classifyCi, failingCheckNames, onlyCooldownHolds, unreportedRequired } from "./ci-state.ts";
import { type OwnPullRequests, type PullRequestState, stateOf } from "./own-pr.ts";
import { inspectOwnership } from "./ownership.ts";
import { closeAndDelete, markReady, ownOpenPullRequests, type PublicationContext, recordState } from "./publication.ts";

/** How many times the agent may adapt one PR after a failed CI before the tool gives it up. */
export const MAX_ADAPTATIONS = 2;

/** What happened to one PR in a tick. */
export type ReviewOutcome =
  | "left-alone"
  | "rebased"
  | "retired"
  | "pending"
  | "marked-ready"
  | "already-ready"
  | "no-checks"
  | "ready-missing-required"
  | "adapted"
  | "adaptation-unchanged"
  | "closed"
  | "held"
  | "graduated"
  | "deferred"
  | "error";

export interface ReviewEntry {
  readonly number: number;
  readonly url: string;
  readonly outcome: ReviewOutcome;
  readonly detail: string | undefined;
}

/** The tool-specific parts of a tick. */
export interface ReviewSteps {
  /**
   * The base moved since the PR was published: recompute the plan on it and
   * either retire the PR (the base already has everything; the step closes
   * it) or publish the reconciled change on `merge.prepared`: the PR's branch
   * with the new base merged in, or with the merge in progress and
   * `merge.conflicted` to resolve in the working tree first (mechanically for
   * dependency files, the agent for code). Returns which.
   */
  rebase(pr: GitHubPullRequest, merge: BaseMerge, context: PublicationContext): Promise<"retired" | "rebased" | "deferred">;
  /**
   * CI failed: the agent adapts the change once (`attempt` from 1); whether a change was published, or `deferred` when
   * it couldn't execute at all (the attempt is then given back, so it must mean nothing ran). `failingChecks`
   * names the failed jobs and statuses of the same snapshot that classified CI as failed.
   */
  adapt(pr: GitHubPullRequest, prepared: PreparedBranch, context: PublicationContext, attempt: number, failingChecks: ReadonlyArray<string>): Promise<boolean | "deferred">;
  /**
   * Whether the tick may act on the PR at all, asked once its ownership is settled and before anything else: retiring
   * a draft, preparing its branch, a rebase, readiness or an adaptation. `leave` reports it and does nothing.
   * A proceed result may carry a draft hold with a display time; `graduated` reports a retirement the tool completed.
   * Absent, every PR the tool owns is acted on.
   */
  disposition?(pr: GitHubPullRequest): Promise<
    | { readonly kind: "proceed"; readonly held?: { readonly until: string } }
    | { readonly kind: "leave"; readonly reason: string }
    | { readonly kind: "graduated"; readonly reason: string }
  >;
  /** Told after the tick closed a PR whose CI kept failing past its adaptations, for the tool's own bookkeeping. */
  closed?(pr: GitHubPullRequest): Promise<void>;
}

/** The PR's branch with the new base merged in, or with the merge in progress and its conflicted paths. */
export type BaseMerge =
  | { readonly kind: "merged"; readonly prepared: PreparedBranch }
  | { readonly kind: "conflicted"; readonly prepared: PreparedBranch; readonly conflicted: ReadonlyArray<string> };

export interface ReviewContext {
  readonly rules: OwnPullRequests;
  readonly github: GitHubClient;
  readonly workspace: Workspace;
  readonly workingCopy: WorkingCopy;
  readonly logger: Logger;
  readonly repo: string;
  readonly base: string;
  /** Directories outside the working copy whose paths never reach a PR (see publication-text.ts). */
  readonly localRoots: ReadonlyArray<string>;
}

/** Runs one tick over the tool's open PRs in `repo`; one entry per PR. */
export async function reviewOpenPullRequests(context: ReviewContext, steps: ReviewSteps): Promise<ReviewEntry[]> {
  const entries: ReviewEntry[] = [];
  for (const pr of await ownOpenPullRequests(context.github, context.rules, context.repo, context.base)) {
    let entry: ReviewEntry;
    try {
      entry = await reviewOne(context, steps, pr);
    } catch (err) {
      // One PR's problem is logged and reported; the tick goes on.
      const detail = err instanceof Error ? err.message : String(err);
      context.logger.warn(`${context.rules.tool}: reviewing a PR failed`, { repo: context.repo, number: pr.number, error: detail });
      entry = { number: pr.number, url: pr.url, outcome: "error", detail };
    }
    entries.push(entry);
  }
  return entries;
}

async function reviewOne(context: ReviewContext, steps: ReviewSteps, pr: GitHubPullRequest): Promise<ReviewEntry> {
  const result = (outcome: ReviewOutcome, detail?: string): ReviewEntry => ({ number: pr.number, url: pr.url, outcome, detail });
  const publication: PublicationContext = { ...context };
  const ownership = inspectOwnership(pr);
  if (ownership.kind === "untracked") return result("left-alone", "its body no longer has the tool's state; someone rewrote it");
  if (ownership.kind === "pushed-by-someone-else") {
    return result("left-alone", `someone else pushed (${pr.headSha.slice(0, 12)}, the tool published ${ownership.recordedHead.slice(0, 12)}), or the tool stopped right after pushing; in that case close it, and a later run recomputes it`);
  }
  const state: PullRequestState = stateOf(pr.body)!;

  const disposition = await steps.disposition?.(pr);
  if (disposition?.kind === "leave") return result("left-alone", disposition.reason);
  if (disposition?.kind === "graduated") return result("graduated", disposition.reason);
  const held = disposition?.held;
  if (held !== undefined && !pr.isDraft) return result("left-alone", "a person marked the held PR ready");

  const checkedOut = await context.workspace.prepareBranch(context.workingCopy, { branch: pr.headRef, start: "remote" });
  if (checkedOut.kind !== "prepared") throw new Error(`${pr.headRef} couldn't be checked out`);
  if (checkedOut.prepared.remoteHeadSha !== pr.headSha) {
    return result("left-alone", `the branch moved while the tick read it (${checkedOut.prepared.remoteHeadSha ?? "gone"})`);
  }

  if (checkedOut.prepared.baseSha !== state.base) {
    const merged = await context.workspace.prepareBranch(context.workingCopy, { branch: pr.headRef, start: "remote-merging" });
    if (merged.kind === "conflict") throw new Error(`${pr.headRef}: remote-merging reported a conflict without leaving it in progress`);
    // Someone may have pushed between the two preparations: the PR is only the tool's at the head it checked.
    if (merged.prepared.remoteHeadSha !== pr.headSha) {
      return result("left-alone", `the branch moved while the tick read it (${merged.prepared.remoteHeadSha ?? "gone"})`);
    }
    const merge: BaseMerge =
      merged.kind === "prepared" ? { kind: "merged", prepared: merged.prepared } : { kind: "conflicted", prepared: merged.prepared, conflicted: merged.conflicted };
    const outcome = await steps.rebase(pr, merge, publication);
    return result(outcome, `base moved from ${state.base.slice(0, 12)} to ${checkedOut.prepared.baseSha.slice(0, 12)}`);
  }

  const checks = await context.github.headChecks({ repo: context.repo, sha: pr.headSha });
  const ci = classifyCi(checks);
  if (ci === "pending") return result("pending");
  if (ci === "none") return result("no-checks", "no check has passed or failed on the head yet");
  // Green, or red only because the gate's cooldown holds it: waiting, not ready and not broken.
  if (held !== undefined && (ci === "success" || onlyCooldownHolds(checks))) return result("held", `until ${held.until}`);
  // Held by the gate although it took nothing young itself: the base's wait grew past one of its versions.
  if (onlyCooldownHolds(checks)) return result("held", "by the gate's cooldown under the base's current wait");
  if (ci === "success") {
    // A person or an earlier tick already made it ready: nothing to decide, and no extra call that could fail it.
    if (!pr.isDraft) return result("already-ready");
    // Green by what the head reported, but a check the base's rulesets require may not have started. It's marked
    // ready anyway: a workflow can start only on `ready_for_review`, and waiting for it would never end. GitHub still
    // blocks the merge until it passes, and the distinct outcome, reported on this tick, tells the person.
    const required = await requiredChecksOrUnknown(context, pr.number);
    const unreported = required.known ? unreportedRequired(checks, required.checks) : { missing: [], unobservable: [] };
    const unseen = !required.known ? `required checks unknown (${required.reason}); readiness used the reported checks`
      : unreported.unobservable.length > 0 ? `${unreported.unobservable.join(", ")} required but not reported, maybe by an app this token can't read` : undefined;
    await markReady(publication, pr.number, pr.headSha);
    if (unreported.missing.length > 0) {
      const missing = `${unreported.missing.join(", ")} required on ${context.base} but not reported on the head yet`;
      return result("ready-missing-required", unseen === undefined ? missing : `${missing}; ${unseen}`);
    }
    return result("marked-ready", unseen);
  }
  if (state.adaptations >= MAX_ADAPTATIONS) {
    await closeAndDelete(
      publication,
      pr.number,
      pr.headSha,
      `CI still fails after ${state.adaptations} adaptation(s); ${context.rules.tool} is giving this one up. The next run starts over from the current default branch.`,
    );
    await steps.closed?.(pr);
    return result("closed", `CI failed after ${state.adaptations} adaptation(s)`);
  }
  // Counted before the agent starts: an attempt that fails or publishes nothing still uses one up.
  const attempt = state.adaptations + 1;
  await recordState(publication, pr.number, pr.headSha, { ...state, adaptations: attempt });
  const pushed = await steps.adapt(pr, checkedOut.prepared, publication, attempt, failingCheckNames(checks));
  if (pushed === "deferred") {
    // Nothing ran: the attempt counted before the agent goes back, so a deferral never uses one up.
    await recordState(publication, pr.number, pr.headSha, state);
    return result("deferred", `attempt ${attempt} of ${MAX_ADAPTATIONS} can't execute now`);
  }
  return result(pushed ? "adapted" : "adaptation-unchanged", `attempt ${attempt} of ${MAX_ADAPTATIONS}`);
}

/**
 * The base's required checks, or unknown when GitHub won't answer: readiness doesn't wait for them, so a failed read
 * (a 5xx, a rate limit, a malformed answer) only turns into the outcome's note, as a refused one does.
 */
async function requiredChecksOrUnknown(context: ReviewContext, pr: number): Promise<GitHubRequiredChecks> {
  try {
    return await context.github.requiredChecks({ repo: context.repo, branch: context.base });
  } catch (err) {
    if (!(err instanceof GitHubApiError)) throw err;
    context.logger.warn(`${context.rules.tool}: reading the base's required checks failed; marking ready on the reported checks`, { repo: context.repo, number: pr, error: err.message });
    return { known: false, reason: err.message };
  }
}
