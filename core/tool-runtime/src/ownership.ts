/**
 * Whether an open PR of the tool is still the tool's: the one place both tools' runs and the review tick decide it.
 * The body's state records the head the tool published. Any other head is someone else's push, or the tool stopped
 * right after pushing, before its body said so; the PR is left alone either way.
 */
import type { GitHubPullRequest } from "@leanish/agent-runtime/types/clients";

import { stateOf } from "./own-pr.ts";

/** An open PR the tool may still act on: its body records its current head. */
export interface Ours {
  readonly kind: "ours";
  readonly pr: GitHubPullRequest;
}

/**
 * What an open PR of the tool is now: still `ours`; `untracked` (its body has no state: someone rewrote it); or
 * `pushed-by-someone-else` (its head isn't the one its body records, `recordedHead`).
 */
export type Ownership =
  | Ours
  | { readonly kind: "untracked" }
  | { readonly kind: "pushed-by-someone-else"; readonly recordedHead: string };

/**
 * Who `pr` belongs to now. `pr` must already be one of the tool's open PRs (`isOwnPullRequest`): a matching state alone
 * doesn't establish its repository, branch and tool.
 */
export function inspectOwnership(pr: GitHubPullRequest): Ownership {
  const recorded = stateOf(pr.body);
  if (recorded === undefined) return { kind: "untracked" };
  return recorded.head === pr.headSha ? { kind: "ours", pr } : { kind: "pushed-by-someone-else", recordedHead: recorded.head };
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
