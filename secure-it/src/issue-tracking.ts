/**
 * A run's issue flow: what it observed becomes an assessment, the assessment the tool's issues, and the issues decide
 * whether each plan may execute now. A decision executes only through its confirmed current issue: eligible (past the
 * wait, or a trusted exception), or waiting with a valid `take-early` grant whose attempt is recorded on the issue before
 * anything runs. Anything else is deferred, with why.
 */
import type { GitHubIssues } from "@leanish/tool-runtime/github-issues";

import { decisionMoves } from "./issue-assessment.ts";
import { grantOf } from "./issue-grant.ts";
import type { Assessment, Attempt, IssueRecord, PackageVersion, SubjectAssessment } from "./issue-model.ts";
import { subjectId } from "./issue-model.ts";
import { postNotice, type SyncResult } from "./issue-sync.ts";
import { ISSUE_LABEL, ISSUE_WRITER, recordOf, TAKE_EARLY_LABEL } from "./issue-text.ts";
import type { ChangePlan } from "./plan.ts";

/** Whether a target may execute now; `defer` says why not, and stops it before anything runs. */
export type Disposition = { readonly kind: "proceed"; readonly tracked?: TrackedExecution } | { readonly kind: "defer"; readonly reason: string };

/** What an execution its issue allowed carries on: that issue, the young versions it may take, and an early attempt. */
export interface TrackedExecution {
  readonly issue: number;
  /**
   * The young versions it may take: a trusted exception's for an eligible decision, the grant's for one taken early.
   * Anything else young that verification finds defers it.
   */
  readonly young: ReadonlyArray<PackageVersion>;
  /** The attempt a `take-early` grant runs, and the branch it publishes to (reserved when it was recorded). */
  readonly attempt?: { readonly id: string; readonly branch: string };
}

export interface Tracking {
  readonly assessment: Assessment;
  readonly sync: SyncResult;
}

/**
 * Whether `plan` may execute now, by its decision's current issue. An early attempt reserves `branch(labelEventId)` and
 * is written to the issue before this returns "proceed", so a crash after it can never start a second one.
 */
export async function issueDisposition(
  tracking: Tracking,
  plan: ChangePlan,
  client: { readonly issues: GitHubIssues; readonly repo: string; readonly clean: (body: string) => string; readonly now: Date },
  branch: (labelEventId: number) => string,
): Promise<Disposition> {
  // Issues still changing when the rounds ran out may not say what this run assessed: nothing executes on them.
  if (!tracking.sync.settled) return { kind: "defer", reason: "the issues didn't settle this run" };
  const id = subjectId({ kind: "decision", moves: decisionMoves(plan) });
  const subject = tracking.assessment.subjects.find((entry) => subjectId(entry.subject) === id);
  if (subject === undefined) return { kind: "defer", reason: "no assessed decision matches this plan" };
  const instances = tracking.sync.tracked.filter((tracked) => tracked.state === "open" && tracked.record.pendingClose === undefined && subjectId(tracked.record.subject) === id);
  const issue = instances[0];
  if (issue === undefined) return { kind: "defer", reason: "no issue tracks this decision yet" };
  // Duplicates the sync left open carry a person's authorization (`reconcile`): which one stands is theirs to say.
  if (instances.length > 1) return { kind: "defer", reason: `${instances.map((tracked) => `#${tracked.number}`).join(" and ")} both track this decision; a person closes one` };

  // Read fresh, by number: the sync's listing can lag a person's closing by seconds, and one run asks for the same plan
  // more than once (preflight, the unit, its retries), so an attempt recorded by an earlier ask must be seen by the next,
  // never started twice.
  const fresh = await client.issues.getIssue({ repo: client.repo, number: issue.number });
  const current = recordOf(fresh.body);
  if (current === undefined || subjectId(current.subject) !== id) return { kind: "defer", reason: `its issue #${issue.number} can't be read any more` };
  if (fresh.state !== "open" || current.pendingClose !== undefined || !fresh.labels.includes(ISSUE_LABEL)) {
    return { kind: "defer", reason: `its issue #${issue.number} is no longer open as secure-it's` };
  }
  if (subject.status.kind === "eligible") return { kind: "proceed", tracked: { issue: issue.number, young: subject.status.trusted } };
  if (subject.status.kind !== "waiting") return { kind: "defer", reason: `its issue #${issue.number} says it can't go ahead` };
  if (!fresh.labels.includes(TAKE_EARLY_LABEL)) return { kind: "defer", reason: `waiting for the release-age wait (#${issue.number})` };

  const [events, comments] = await Promise.all([
    client.issues.listEvents({ repo: client.repo, number: issue.number }),
    client.issues.listComments({ repo: client.repo, number: issue.number }),
  ]);
  const actors = [...new Set(events.flatMap((event) => (event.actor === null ? [] : [event.actor])))];
  const permissions = new Map(await Promise.all(actors.map(async (actor) => [actor, await client.issues.permission({ repo: client.repo, login: actor })] as const)));
  const decision = grantOf({ state: fresh.state, labels: fresh.labels, record: current, status: subject.status, events, comments, permissions });
  if (decision.kind === "none") return { kind: "defer", reason: `waiting for the release-age wait (#${issue.number})` };
  if (decision.kind === "refused") {
    // Every refusal shows on the issue, once per label event and reason.
    await postNotice(client, issue.number, decision.noticeId, `secure-it won't take this decision early: ${decision.reason}.`);
    return { kind: "defer", reason: `take-early refused on #${issue.number}: ${decision.reason}` };
  }
  const young = subject.status.young.map(({ ecosystem, name, version }) => ({ ecosystem, name, version }));
  const early = (attempt: Attempt): Disposition => ({ kind: "proceed", tracked: { issue: issue.number, young, attempt: { id: attempt.id, branch: attempt.branch } } });
  const running = current.attempts.find((attempt) => attempt.outcome === undefined && attempt.grantEventId === decision.grant.labelEventId);
  if (running !== undefined) {
    if (!attemptBranchAllowed(running, branch(running.grantEventId))) {
      return { kind: "defer", reason: `the attempt recorded on #${issue.number} names a branch secure-it didn't reserve for it` };
    }
    return early(running);
  }
  // One grant, one attempt, recorded before anything executes.
  const attempt: Attempt = {
    id: `${decision.grant.labelEventId}-${client.now.getTime()}`, grantEventId: decision.grant.labelEventId, branch: branch(decision.grant.labelEventId), startedAt: client.now.toISOString(),
  };
  const record: IssueRecord = { ...current, grant: decision.grant, attempts: [...current.attempts, attempt] };
  await client.issues.updateIssue({ repo: client.repo, number: issue.number, body: client.clean(ISSUE_WRITER.render(subject as SubjectAssessment, record, tracking.assessment.sha).body) });
  return early(attempt);
}

/**
 * A run's branch for each grant's attempt: the reused PR's head a unit named for it (`named`), remembered so the run's
 * later asks for the same grant (a retry names none) get that same branch, else the one `reserve` gives the grant.
 */
export function attemptBranches(reserve: (labelEventId: number) => string): (named: string | undefined) => (labelEventId: number) => string {
  const reused = new Map<number, string>();
  return (named) => (labelEventId) => {
    if (named !== undefined) reused.set(labelEventId, named);
    return reused.get(labelEventId) ?? reserve(labelEventId);
  };
}

/**
 * Whether a recorded attempt's branch may be used. It comes from the issue's body, which a person can edit, and a run
 * deletes and republishes it: it must be the one its grant reserved (`secure-it/<date>-take-early-<label event>`, on any
 * day) or `expected`, this run's branch for it (the head of the PR the unit reuses, when it reuses one).
 */
export function attemptBranchAllowed(attempt: Pick<Attempt, "branch" | "grantEventId">, expected: string): boolean {
  if (attempt.branch === expected) return true;
  return new RegExp(`^secure-it/\\d{4}-\\d{2}-\\d{2}-take-early-${attempt.grantEventId}$`).test(attempt.branch);
}

/**
 * Says on every issue with a `take-early` label that isn't a current decision waiting for the wait (closed, being
 * superseded or resolved, retired, a package without a decision) that the label authorizes nothing there, once per
 * label event: every refusal is visible, not only the ones a run's execution asks about. A label event an attempt
 * already used says nothing more. Nothing executes here.
 */
export async function inactiveLabelNotices(client: { readonly issues: GitHubIssues; readonly repo: string; readonly clean: (body: string) => string }, tracking: Tracking): Promise<void> {
  // Current decisions, waiting or eligible: a label on an eligible one is moot rather than refused.
  const decided = new Set(tracking.assessment.subjects.filter((subject) => subject.status.kind !== "informational" && subject.status.kind !== "blocked").map((subject) => subjectId(subject.subject)));
  for (const issue of tracking.sync.tracked) {
    if (!issue.labels.includes(TAKE_EARLY_LABEL)) continue;
    const { record } = issue;
    const current = issue.state === "open" && record.pendingClose === undefined && decided.has(subjectId(record.subject));
    if (current) continue;
    const events = await client.issues.listEvents({ repo: client.repo, number: issue.number });
    const label = events.filter((event) => event.label === TAKE_EARLY_LABEL && (event.event === "labeled" || event.event === "unlabeled")).sort((a, b) => a.id - b.id).at(-1);
    if (label?.event !== "labeled" || record.attempts.some((attempt) => attempt.grantEventId === label.id)) continue;
    const why = issue.state !== "open" ? "the issue is closed"
      : record.pendingClose !== undefined ? "this issue is being superseded or resolved; its label doesn't carry over"
        : record.subject.kind === "package" ? "this issue has no fix decision to authorize"
          : "this issue doesn't track a current decision; its current issue does";
    await postNotice(client, issue.number, `take-early:${label.id}:inactive`, `secure-it won't take this early: ${why}.`);
  }
}

