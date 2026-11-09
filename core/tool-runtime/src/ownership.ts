/**
 * Whether an open PR of the tool is still the tool's: the one place both tools' runs and the review tick decide it.
 * The body's state is signed with a key only the tool holds and records the head the tool published. Any other head is
 * someone else's push, or the tool stopped right after pushing, before its body said so; the PR is left alone either way.
 * The signature proves the tool published that head at some point. It says nothing about the plan or other text in the body.
 */
import type { GitHubPullRequest } from "@leanish/agent-runtime/types/clients";

import { type PullRequestState, type RecordContext, stateOf, verifiedStateOf } from "./own-pr.ts";

/** An open PR the tool may still act on: its body carries the tool's signed state for its current head. */
export interface Ours {
  readonly kind: "ours";
  readonly pr: GitHubPullRequest;
  readonly state: PullRequestState;
}

/**
 * What an open PR of the tool is now: still `ours`; `untracked` (its body has no state the tool signed); or
 * `pushed-by-someone-else` (its head isn't the one its signed state records, `recordedHead`).
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
  const state = verifiedStateOf(record, pr.body);
  if (state === undefined) return { kind: "untracked" };
  return state.head === pr.headSha ? { kind: "ours", pr, state } : { kind: "pushed-by-someone-else", recordedHead: state.head };
}

/**
 * Whether `pr` already carries the plan whose digest is `digest`, as the tool last published it: its body must record
 * its current head (checked before `read`), and `read` (the tool's digest of the body's plan, undefined when it has none
 * it can read) must give `digest`.
 */
export function samePlan(pr: GitHubPullRequest, digest: string, read: (body: string) => string | undefined): boolean {
  if (stateOf(pr.body)?.head !== pr.headSha) return false;
  return read(pr.body) === digest;
}
