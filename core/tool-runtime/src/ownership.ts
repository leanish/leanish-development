/**
 * Whether an open PR of the tool is still the tool's, and what its effective title and body are: the one place both
 * tools' runs and the review tick decide it. The body's state records the head the tool published; when a body update
 * failed after a push, the journal (`journal.ts`) records that exact head and the publication meant for it. Inspection
 * only reads; `repairOwnership` writes that saved publication back, right before a caller uses the PR.
 */
import type { GitHubPullRequest } from "@leanish/agent-runtime/types/clients";

import type { PushedState } from "./journal.ts";
import { stateOf } from "./own-pr.ts";
import { checkedText, ensureLabel, type PublicationContext, reReadOwn } from "./publication.ts";

/** A publication the journal saved for a head: the title and the full body (state and plan included). */
export type SavedPublication = NonNullable<PushedState["publication"]>;

/**
 * An open PR the tool may still act on, with how its effective content was found:
 *
 *   - `none`: its body records its current head; `pr` is as read;
 *   - `saved`: the journal saved the publication for its current head, which the body lags behind; `pr` carries that
 *     publication's title and body, which `repairOwnership` writes back;
 *   - `legacy`: an old journal entry records its current head, without the publication; `pr` is as read (stale);
 *   - `state-removed`: someone removed the state from its body, and the journal records its current head; `pr` is as
 *     read. `saved`, when the journal saved the publication (a mismatched one is refused, as for `saved`), is a
 *     read-only view of what the tool published there: it never makes the PR repairable or the same plan.
 */
export type Ours =
  | { readonly kind: "ours"; readonly pr: GitHubPullRequest; readonly recovery: "none" }
  | { readonly kind: "ours"; readonly pr: GitHubPullRequest; readonly recovery: "saved"; readonly saved: SavedPublication }
  | { readonly kind: "ours"; readonly pr: GitHubPullRequest; readonly recovery: "legacy" }
  | { readonly kind: "ours"; readonly pr: GitHubPullRequest; readonly recovery: "state-removed"; readonly saved?: SavedPublication };

/**
 * What an open PR of the tool is now: still `ours`; `untracked` (its body has no state and the journal doesn't
 * record its head: someone rewrote it); or `pushed-by-someone-else` (its head is neither the one its body records,
 * `recordedHead`, nor the journal's).
 */
export type Ownership =
  | Ours
  | { readonly kind: "untracked" }
  | { readonly kind: "pushed-by-someone-else"; readonly recordedHead: string };

/**
 * Who `pr` belongs to now, and its effective content; never writes to GitHub. `pr` must already be one of the tool's
 * open PRs (`isOwnPullRequest`): a matching state or journal entry alone doesn't establish its repository, branch and
 * tool. A body recording the current head is enough, without reading the journal. Throws when the journal can't be
 * read, or saves a publication for the current head that doesn't match it (its state's head, base and adaptations).
 */
export async function inspectOwnership(context: PublicationContext, pr: GitHubPullRequest): Promise<Ownership> {
  const recorded = stateOf(pr.body);
  if (recorded?.head === pr.headSha) return { kind: "ours", pr, recovery: "none" };
  const pushed = await context.journal.last(context.repo, pr.number);
  if (pushed?.head !== pr.headSha) {
    return recorded === undefined ? { kind: "untracked" } : { kind: "pushed-by-someone-else", recordedHead: recorded.head };
  }
  if (pushed.publication === undefined) {
    return recorded === undefined ? { kind: "ours", pr, recovery: "state-removed" } : { kind: "ours", pr, recovery: "legacy" };
  }
  // A saved publication that doesn't match is refused either way, never read around: the raw body could then stand in
  // for it (and miss a held plan a person took over, say).
  const saved = matchingPublication(pr, pushed, pushed.publication);
  if (recorded === undefined) return { kind: "ours", pr, recovery: "state-removed", saved };
  return { kind: "ours", pr: { ...pr, title: saved.title, body: saved.body }, recovery: "saved", saved };
}

/** The entry's publication, once its own state records the entry's head, base and adaptation count; else throws. */
function matchingPublication(pr: GitHubPullRequest, pushed: PushedState, saved: SavedPublication): SavedPublication {
  const state = stateOf(saved.body);
  if (state?.head !== pushed.head || state.base !== pushed.base || state.adaptations !== saved.adaptations) {
    throw new Error(`${pr.url}: the journal has no matching publication content; rerun the tool to recompute before reviewing`);
  }
  return saved;
}

/**
 * The PR to use from here on: a `saved` publication is written back first (title and body, label restored), once the
 * PR is still the tool's at the head it was inspected at; every other kind of ownership returns its `pr` unchanged.
 * Restores the entire publication for that exact head, never an old plan with a new state marker.
 */
export async function repairOwnership(context: PublicationContext, owned: Ours): Promise<GitHubPullRequest> {
  if (owned.recovery !== "saved") return owned.pr;
  const { pr, saved } = owned;
  await reReadOwn(context, pr.number, pr.headSha);
  const updated = await context.github.updatePullRequest({ repo: context.repo, number: pr.number, title: saved.title, body: checkedText(saved.title, saved.body) });
  // Someone may push between the re-read and the update: the PR is the tool's only at the head it was inspected at,
  // so a reuse never redoes, and publishes over, a person's push.
  if (updated.headSha !== pr.headSha) throw new Error(`${pr.url} moved to ${updated.headSha} while ${context.rules.tool} restored its publication`);
  await ensureLabel(context, updated);
  return updated;
}

/**
 * Whether `pr` already carries the plan whose digest is `digest`, as the tool last published it: its body must record
 * its current head (checked before `read`), so a legacy or state-removed PR never matches, and `read` (the tool's
 * digest of the body's plan, undefined when it has none it can read) must give `digest`.
 */
export function samePlan(pr: GitHubPullRequest, digest: string, read: (body: string) => string | undefined): boolean {
  if (stateOf(pr.body)?.head !== pr.headSha) return false;
  return read(pr.body) === digest;
}
