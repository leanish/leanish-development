/**
 * Whether an issue's `take-early` label authorizes secure-it to fix its decision before the wait ends, without any
 * I/O: the caller reads the issue's events and comments, and the labeler's permission, and passes them in.
 *
 * A grant is the issue's current label: the latest `take-early` labeled event with no unlabeled after it, the label
 * still on the open issue, added by someone with write, maintain or admin access, after their own
 * `take-early: <reason>` comment, unedited since the label. It covers the young versions the decision took then, or
 * fewer as they age; a new young version voids it. One grant runs one attempt: once that attempt has ended, only a new
 * label event and a new reason comment authorize another, and a new grant never replaces a running attempt.
 *
 * Fails closed: a labeler who lost write access, or a reason edited or deleted since, stops a running attempt too. Once
 * the decision is past the wait there's nothing to authorize (`none`): its PR goes on as an ordinary one. Times are
 * GitHub's, to the second: a reason posted in the label's own second counts as before it.
 */
import { versionKey } from "@leanish/gate/package-version";

import { type Grant, type IssueRecord, type PackageVersion, SHOWN_PENDING, type SubjectStatus } from "./issue-model.ts";
import { TAKE_EARLY_LABEL } from "./issue-text.ts";

/** An issue event as the issues client reads it. */
export interface GrantEvent {
  readonly id: number;
  readonly event: string;
  readonly actor: string | null;
  readonly createdAt: string;
  readonly label?: string;
}

/** An issue comment as the issues client reads it. */
export interface GrantComment {
  readonly id: number;
  readonly author: string | null;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type Permission = "admin" | "maintain" | "write" | "triage" | "read" | "none";

export interface GrantInput {
  readonly state: "open" | "closed";
  readonly labels: ReadonlyArray<string>;
  readonly record: IssueRecord;
  readonly status: SubjectStatus;
  readonly events: ReadonlyArray<GrantEvent>;
  readonly comments: ReadonlyArray<GrantComment>;
  /** The permission each actor has on the repository now; a missing one counts as none. */
  readonly permissions: ReadonlyMap<string, Permission>;
}

export type GrantDecision =
  /** No current label: nothing authorizes an early fix. */
  | { readonly kind: "none" }
  /** The grant to record and act on (the recorded one when the label is the same). */
  | { readonly kind: "granted"; readonly grant: Grant }
  /** A label that doesn't authorize, with why, for a notice comment once per label event and reason. */
  | { readonly kind: "refused"; readonly noticeId: string; readonly reason: string };

const WRITERS: ReadonlySet<Permission> = new Set<Permission>(["admin", "maintain", "write"]);
const REASON = new RegExp(`^${TAKE_EARLY_LABEL}:\\s*(\\S[\\s\\S]*)$`);

export function grantOf(input: GrantInput): GrantDecision {
  const label = currentLabelEvent(input.events);
  if (label === undefined || !input.labels.includes(TAKE_EARLY_LABEL)) return { kind: "none" };
  const refused = (reason: string, key = reason): GrantDecision => ({ kind: "refused", noticeId: `take-early:${label.id}:${key}`, reason });
  if (input.state !== "open") return refused("the issue is closed", "closed");
  if (input.record.subject.kind !== "decision") return refused("this issue has no fix decision to authorize", "no-decision");
  if (input.record.pendingClose !== undefined) return refused("this issue is being superseded or resolved; its label doesn't carry over", "closing");
  if (input.status.kind !== "waiting") return { kind: "none" };
  const actor = label.actor;
  if (actor === null || !WRITERS.has(input.permissions.get(actor) ?? "none")) return refused("whoever added the label has no write access", "permission");

  const recorded = input.record.grant;
  const running = input.record.attempts.find((attempt) => attempt.outcome === undefined);
  if (recorded !== undefined && recorded.labelEventId === label.id) {
    // The same label: still valid while its reason stands as it was (not edited or deleted since) and the decision
    // takes no young version it didn't take then.
    if (reasonComment(input.comments, actor, label.createdAt)?.id !== recorded.reasonCommentId) {
      return refused("the reason comment this label was given with was edited or deleted; a new reason and label authorize it again", "reason-changed");
    }
    const added = input.status.young.filter((young) => !recorded.young.some((granted) => versionKey(granted) === versionKey(young)));
    if (added.length > 0) return refused(`the decision now takes ${added.map(describe).join(", ")}, which the label didn't cover`, "young");
    const ended = input.record.attempts.some((attempt) => attempt.grantEventId === label.id && attempt.outcome !== undefined);
    return ended && running === undefined ? refused("this label's attempt has ended; a new reason and label authorize another", "spent") : { kind: "granted", grant: recorded };
  }
  if (running !== undefined) return refused("an early attempt is still running under an earlier label", "running");

  // A first label covers what the issue showed when it was added: a young version shown only after it wasn't seen.
  const shown = input.record.shown;
  if (shown?.since === SHOWN_PENDING) return refused("the issue is still being updated with what the decision takes; label it again once it shows that", "young-pending");
  // A since that doesn't read as a time compares as not-a-number: refused too, never granted.
  if (shown === undefined || !(Date.parse(label.createdAt) >= Date.parse(shown.since))) {
    return refused(`the decision's young versions changed after the label (now ${input.status.young.map(describe).join(", ")}); a new reason and label authorize them`, "young-shown");
  }
  const reason = reasonComment(input.comments, actor, label.createdAt);
  if (reason === undefined) return refused(`no \`${TAKE_EARLY_LABEL}: <reason>\` comment by the labeler before the label, unedited since`, "reason");
  // A renewed label needs a reason of its own: one written after the earlier grant, never the one that grant used.
  if (recorded !== undefined && (reason.id === recorded.reasonCommentId || Date.parse(reason.createdAt) <= Date.parse(recorded.at))) {
    return refused(`a new label needs a new \`${TAKE_EARLY_LABEL}: <reason>\` comment, written after the earlier authorization`, "reason-reused");
  }
  return {
    kind: "granted",
    grant: { labelEventId: label.id, reasonCommentId: reason.id, actor, at: label.createdAt, young: input.status.young.map(({ ecosystem, name, version }) => ({ ecosystem, name, version })) },
  };
}

/** The latest `take-early` labeled event with no unlabeled after it, by event id. */
function currentLabelEvent(events: ReadonlyArray<GrantEvent>): GrantEvent | undefined {
  const ours = events.filter((event) => event.label === TAKE_EARLY_LABEL && (event.event === "labeled" || event.event === "unlabeled")).sort((a, b) => a.id - b.id);
  const last = ours.at(-1);
  return last?.event === "labeled" ? last : undefined;
}

/**
 * The labeler's latest reason comment at or before the label, when it wasn't edited after it: an edit means the text
 * the label authorized isn't the one shown any more, so it takes a new label, never an older comment instead.
 */
function reasonComment(comments: ReadonlyArray<GrantComment>, actor: string, labeledAt: string): GrantComment | undefined {
  const at = Date.parse(labeledAt);
  const latest = comments
    .filter((comment) => comment.author === actor && Date.parse(comment.createdAt) <= at && REASON.test(comment.body.trim()))
    .sort((a, b) => b.id - a.id)[0];
  return latest !== undefined && Date.parse(latest.updatedAt) <= at ? latest : undefined;
}

const describe = (pkg: PackageVersion) => `${pkg.ecosystem} ${pkg.name}@${pkg.version}`;
