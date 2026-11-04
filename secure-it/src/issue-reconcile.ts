/**
 * Which issue operations bring the tool's issues in line with a run's assessment, without any I/O. The caller runs
 * them in order and calls again on the refreshed issues until nothing is left: a predecessor is closed only once every
 * successor exists, so a crash between the two leaves a repairable state, never a lost one.
 *
 *   - Each subject the assessment has keeps one open issue: its current instance, updated when its text changes; a
 *     missing one is created, unless a person dismissed every finding it has (closed an issue for them while they
 *     stayed present).
 *   - An open issue whose subject is gone is closed once its successors exist (the subjects now carrying any of its
 *     findings: a decision may split or merge), or as resolved when a complete assessment no longer finds any of them.
 *   - A complete assessment records, on every issue still tracking a finding, the commit where it's absent: that
 *     finding's episode ended, so its return is new and opens a new issue, past any dismissal and without any grant.
 *   - An incomplete assessment closes and resolves nothing.
 */
import { type Assessment, type FindingKey, type IssueRecord, keyOf, type PackageVersion, sameFinding, SHOWN_PENDING, type SubjectAssessment, subjectId } from "./issue-model.ts";
import { TAKE_EARLY_LABEL } from "./issue-text.ts";

/** An issue the tool opened, with its record read back. */
export interface TrackedIssue {
  readonly number: number;
  readonly state: "open" | "closed";
  /** What it shows now: an unchanged text isn't written again. */
  readonly body: string;
  readonly record: IssueRecord;
  /**
   * A person reopened it after the tool closed it (a `reopened` event after the tool's closing). Open, it's theirs:
   * left open but retired, never the current instance of its subject, so nothing it held (a grant) comes back. Closed
   * again, that closing was theirs: a dismissal.
   */
  readonly reopened: boolean;
  /** Its labels, where known: a duplicate a person labelled `take-early` is theirs to settle. */
  readonly labels?: ReadonlyArray<string>;
}

/** How issue text is written (`issue-text.ts`). */
export interface IssueWriter {
  /** The whole text for a subject this run assessed, with `record` in its hidden block. */
  render(assessment: SubjectAssessment, record: IssueRecord, sha: string): { readonly title: string; readonly body: string };
  /** `body` with `record` replacing its hidden block: what a closing or an ended episode changes on any issue. */
  withRecord(body: string, record: IssueRecord): string;
}

export type IssueOperation =
  | { readonly kind: "create"; readonly subject: string; readonly title: string; readonly body: string }
  | { readonly kind: "update"; readonly number: number; readonly body: string }
  /**
   * Write `body` (the record with its pending closing) first, then post `comment` unless a comment already carries its
   * notice id, then close with GitHub's `reason`.
   */
  | {
      readonly kind: "close";
      readonly number: number;
      readonly body: string;
      readonly reason: "completed" | "not_planned";
      readonly comment: { readonly noticeId: string; readonly body: string };
    };

export interface Reconciliation {
  readonly operations: ReadonlyArray<IssueOperation>;
  /** Why something waits for a later call or run, for the report. */
  readonly notes: ReadonlyArray<string>;
}

/**
 * `record` showing a waiting subject's young versions. A version joining makes `since` pending: the issue is being
 * rewritten, and no label authorizes anything until a later round reads that body back from GitHub and confirms it,
 * setting `since` to `at` (that round's clock, taken after the read, plus a skew margin). So a label counts only after
 * the scope it covers was published. One aging out keeps `since`. Any other status leaves the record as it is.
 */
function withShown(record: IssueRecord, subject: SubjectAssessment, at: string): IssueRecord {
  if (subject.status.kind !== "waiting") return record;
  const young = subject.status.young.map(({ ecosystem, name, version }) => ({ ecosystem, name, version }));
  const known = (pkg: PackageVersion) => record.shown?.young.some((entry) => entry.ecosystem === pkg.ecosystem && entry.name === pkg.name && entry.version === pkg.version) === true;
  const since = record.shown === undefined || !young.every(known) ? SHOWN_PENDING
    : record.shown.since === SHOWN_PENDING ? at
      : record.shown.since;
  // Unchanged only when the very same versions are shown since the same time: a pending record whose versions changed
  // (a crash left it, and the decision now takes others) is rewritten, so what it records is what the body shows.
  const same = record.shown !== undefined && since === record.shown.since && record.shown.young.length === young.length && young.every(known);
  return same ? record : { ...record, shown: { young, since } };
}

/**
 * How a tracked issue stands: the subject's current instance, a closing still to finish, closed by the tool, reopened by
 * a person after that (retired, left alone), or dismissed.
 */
type Standing = "current" | "closing" | "closed-by-tool" | "reopened" | "dismissed";

function standingOf(issue: TrackedIssue): Standing {
  if (issue.state === "open") {
    if (issue.record.pendingClose === undefined) return "current";
    return issue.reopened ? "reopened" : "closing";
  }
  return issue.record.pendingClose === undefined || issue.reopened ? "dismissed" : "closed-by-tool";
}

/**
 * The operations for `assessment` over the tool's `issues` (open and closed). `unreadable` are the tool's open issues
 * whose record can't be read (a person edited it): what they track is unknown, so nothing new is created while there
 * are any, which could duplicate one of them; updates and closings of the readable ones go on.
 */
export function reconcile(assessment: Assessment, issues: ReadonlyArray<TrackedIssue>, writer: IssueWriter, unreadable: ReadonlyArray<number> = []): Reconciliation {
  const operations: IssueOperation[] = [];
  const notes: string[] = unreadable.map((number) => `#${number}: its record can't be read; secure-it creates no issue until it can (restore its hidden block, or close it)`);
  const observed = assessment.subjects.flatMap((subject) => subject.findings.map(keyOf));
  // A complete assessment ends the episode of every tracked finding it no longer has, on every issue tracking it.
  const records = new Map(issues.map((issue) => [issue.number, withAbsences(issue.record, observed, assessment)]));
  const recordOf = (issue: TrackedIssue) => records.get(issue.number)!;

  const bySubject = new Map<string, TrackedIssue[]>();
  for (const issue of issues) {
    if (standingOf(issue) !== "current") continue;
    const id = subjectId(issue.record.subject);
    bySubject.set(id, [...bySubject.get(id) ?? [], issue].sort((a, b) => a.number - b.number));
  }
  const dismissed = issues.filter((issue) => standingOf(issue) === "dismissed");
  const wanted = new Map(assessment.subjects.map((subject) => [subjectId(subject.subject), subject]));

  // Phase 1: every subject has its current instance, up to date.
  const instances = new Map<string, number>();
  const coveredByDismissal = new Set<string>();
  for (const [id, subject] of wanted) {
    const current = bySubject.get(id)?.[0];
    if (current !== undefined) instances.set(id, current.number);
    // One subject's text failing (a decision too large to show whole) is noted and leaves the others going.
    isolated(notes, current === undefined ? `${id}` : `#${current.number}`, () => {
      if (current !== undefined) {
        // The record keeps every finding the issue has shown: its successors, closing and dismissal go by all of them.
        // It takes them only along with a text that shows them: a render that fails leaves the record as it was.
        const record = withFindings(recordOf(current), subject.findings);
        const { body } = writer.render(subject, withShown(record, subject, assessment.at), assessment.sha);
        records.set(current.number, record);
        if (body !== current.body) operations.push({ kind: "update", number: current.number, body });
        return;
      }
      // A subject without findings has nothing a dismissal could cover.
      if (subject.findings.length > 0 && subject.findings.every((finding) => isDismissed(finding, dismissed, recordOf))) {
        coveredByDismissal.add(id);
        return;
      }
      if (unreadable.length > 0) return;
      const record = withShown({ version: 1, subject: subject.subject, openedAt: assessment.sha, findings: subject.findings.map(keyOf), absences: [], attempts: [] }, subject, assessment.at);
      const text = writer.render(subject, record, assessment.sha);
      operations.push({ kind: "create", subject: id, title: text.title, body: text.body });
    });
  }

  // Phase 2, once phase 1 created everything: an issue whose subject is gone closes after its successors exist.
  const creating = operations.some((operation) => operation.kind === "create");
  for (const issue of issues) {
    // One issue's body failing (a person rewrote it past reading) is noted and leaves the others going.
    isolated(notes, `#${issue.number}`, () => {
      const standing = standingOf(issue);
      const id = subjectId(issue.record.subject);
      const record = recordOf(issue);
      if (standing === "closed-by-tool" || standing === "dismissed" || standing === "reopened") {
        if (record !== issue.record) operations.push({ kind: "update", number: issue.number, body: writer.withRecord(issue.body, record) });
        // Its pending closing stays recorded: no grant on it ever counts again (`grantOf`), and its subject has a new issue.
        if (standing === "reopened") notes.push(`#${issue.number}: a person reopened it after secure-it closed it; it stays open, retired`);
        return;
      }
      if (standing === "closing") {
        // A closing interrupted after its record was written: finish it as decided then.
        const pending = record.pendingClose!;
        operations.push(closing(issue, record, writer, pending.reason, pending.successors, pending.at));
        return;
      }
      if (wanted.has(id)) {
        // A duplicate instance (a create retried after its answer was lost, or one a lagging listing hid): the
        // lowest-numbered one carries on. A complete assessment closes the others. An incomplete one (a repository
        // with a lasting gap is never complete) closes one only when the survivor was opened for every finding it was,
        // so no finding leaves tracking unseen. Neither closes one a person labelled `take-early` or one running an
        // early attempt: a grant is a person's and never moves to another issue, so while two stay open the decision
        // executes through neither (`issueDisposition`) until a person closes one.
        const first = bySubject.get(id)![0]!;
        if (first === issue) return;
        const authorized = (issue.labels ?? []).includes(TAKE_EARLY_LABEL) || record.attempts.some((attempt) => attempt.outcome === undefined);
        const covered = record.findings.every((finding) => recordOf(first).findings.some((kept) => sameFinding(finding, kept)));
        if (authorized) notes.push(`#${issue.number}: duplicates #${first.number} but carries an authorization; a person closes one of them`);
        else if (assessment.complete || covered) operations.push(closing(issue, record, writer, "superseded", [first.number], assessment.sha));
        return;
      }
      if (!assessment.complete) {
        notes.push(`#${issue.number}: its subject is gone, but the assessment is incomplete; it stays open`);
        return;
      }
      const successors = successorsOf(record, assessment.subjects);
      if (successors.length === 0) {
        operations.push(closing(issue, record, writer, "resolved", [], assessment.sha));
        return;
      }
      if (creating) {
        notes.push(`#${issue.number}: closes once its successors exist`);
        return;
      }
      // A successor a dismissal covers has no issue and needs none: it doesn't hold this one open.
      if (successors.some((successor) => !instances.has(successor) && !coveredByDismissal.has(successor))) {
        notes.push(`#${issue.number}: a successor has no issue yet`);
        return;
      }
      const numbers = [...new Set(successors.flatMap((successor) => instances.get(successor) ?? []))].sort((a, b) => a - b);
      operations.push(closing(issue, record, writer, "superseded", numbers, assessment.sha));
    });
  }
  return { operations, notes };
}

/** Runs `step`, turning a failure into a note about `what`: one subject or issue never stops the others. */
function isolated(notes: string[], what: string, step: () => void): void {
  try {
    step();
  } catch (error) {
    notes.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The subjects carrying any of the record's findings now, by id. */
function successorsOf(record: IssueRecord, subjects: ReadonlyArray<SubjectAssessment>): string[] {
  return subjects
    .filter((subject) => subject.findings.some((finding) => record.findings.some((tracked) => sameFinding(tracked, finding))))
    .map((subject) => subjectId(subject.subject));
}

/**
 * Whether a person dismissed `finding`: they closed an issue opened for it, and no complete assessment has seen it
 * absent since (its episode goes on). Overlapping ids count as the same finding, so a new alias doesn't undo it.
 */
function isDismissed(finding: FindingKey, dismissed: ReadonlyArray<TrackedIssue>, recordOf: (issue: TrackedIssue) => IssueRecord): boolean {
  return dismissed.some((issue) => {
    const record = recordOf(issue);
    return record.findings.some((tracked) => sameFinding(tracked, finding)) && !record.absences.some((absence) => sameFinding(absence.finding, finding));
  });
}

/**
 * `record` with each of `shown` it doesn't track yet (overlapping ids count as tracked); the same object when none.
 * An issue shows its subject's current findings, so a finding that joined later is one it tracks too: closing it as
 * resolved, or a person's dismissal, then goes by that finding as well.
 */
function withFindings(record: IssueRecord, shown: ReadonlyArray<FindingKey>): IssueRecord {
  const joined = shown.filter((finding) => !record.findings.some((tracked) => sameFinding(tracked, finding))).map(keyOf);
  return joined.length === 0 ? record : { ...record, findings: [...record.findings, ...joined] };
}

/** `record` with an absence for each of its findings a complete assessment no longer has; the same object when none. */
function withAbsences(record: IssueRecord, observed: ReadonlyArray<FindingKey>, assessment: Assessment): IssueRecord {
  if (!assessment.complete) return record;
  const ended = record.findings.filter((finding) =>
    !observed.some((seen) => sameFinding(seen, finding)) && !record.absences.some((absence) => sameFinding(absence.finding, finding)));
  return ended.length === 0 ? record : { ...record, absences: [...record.absences, ...ended.map((finding) => ({ finding, at: assessment.sha }))] };
}

/** The close operation for `issue`, its pending closing recorded in its body first (kept when one is already there). */
function closing(
  issue: TrackedIssue,
  record: IssueRecord,
  writer: IssueWriter,
  reason: "superseded" | "resolved",
  successors: ReadonlyArray<number>,
  at: string,
): IssueOperation {
  const pending = record.pendingClose ?? { id: `close:${issue.number}:${reason}:${at}`, reason, successors: [...successors], at };
  const said = pending.reason === "resolved"
    ? `secure-it closes this issue: a complete assessment of \`${pending.at.slice(0, 12)}\` no longer finds its advisories.`
    : pending.successors.length === 0
      ? "secure-it closes this issue: its findings now belong to work a person dismissed earlier."
      : `secure-it closes this issue: superseded by ${pending.successors.map((number) => `#${number}`).join(", ")}, which tracks its findings now. Nothing here carries over, a \`take-early\` label included.`;
  return {
    kind: "close",
    number: issue.number,
    body: writer.withRecord(issue.body, { ...record, pendingClose: pending }),
    reason: pending.reason === "resolved" ? "completed" : "not_planned",
    comment: { noticeId: pending.id, body: said },
  };
}
