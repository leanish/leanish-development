/**
 * Whether an open PR of the tool is still the tool's: the one place both tools' runs and the review tick decide it.
 * The body's state records the head the tool published. Any other head is someone else's push, or the tool stopped
 * right after pushing, before its body said so; the PR is left alone either way. With `signed` trust the state is signed
 * with a key only the tool holds, over the head, the branches and what the body tells the tool to do (its plan and
 * machine lines), so a valid one proves the tool wrote all of that at some point; prose isn't covered. With
 * `trusted-editors`, whoever can edit the PR is trusted to.
 */
import type { GitHubPullRequest } from "@leanish/agent-runtime/types/clients";

import { type PullRequestState, type RecordContext, verifiedStateOf } from "./own-pr.ts";

/** An open PR the tool may still act on: its body carries the tool's state for its current head. */
export interface Ours {
  readonly kind: "ours";
  readonly pr: GitHubPullRequest;
  readonly state: PullRequestState;
}

/**
 * What an open PR of the tool is now: still `ours`; `untracked` (its body has no state the tool recorded); or
 * `pushed-by-someone-else` (its head isn't the one its recorded state names, `recordedHead`).
 */
export type Ownership =
  | Ours
  | { readonly kind: "untracked" }
  | { readonly kind: "pushed-by-someone-else"; readonly recordedHead: string };

/**
 * Who `pr` belongs to now. `pr` must already be one of the tool's open PRs (`isOwnPullRequest`): a matching state alone
 * doesn't establish its repository, branch and tool.
 */
export function inspectOwnership(record: RecordContext, pr: GitHubPullRequest): Ownership {
  const state = verifiedStateOf(record, pr);
  if (state === undefined) return { kind: "untracked" };
  return state.head === pr.headSha ? { kind: "ours", pr, state } : { kind: "pushed-by-someone-else", recordedHead: state.head };
}

/**
 * Whether a PR of the tool's already carries the plan whose digest is `digest`: `read` is the tool's digest of the body's
 * plan, undefined when it has none it can read.
 */
export function samePlan(ours: Ours, digest: string, read: (body: string) => string | undefined): boolean {
  return read(ours.pr.body) === digest;
}
