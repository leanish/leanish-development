/**
 * Which issue operations bring the tool's issues in line with a run's assessment, without any I/O. The caller runs
 * them in order and calls again on the refreshed issues until nothing is left: a predecessor is closed only once every
 * successor exists, so a crash between the two leaves a repairable state, never a lost one.
 *
 *   - Each subject the assessment has keeps one open issue: its current instance, updated when its text changes; a
 *     missing one is created, unless a person dismissed every finding it has (closed an issue for them while they
 *     stayed present).
 *   - An open issue whose subject is gone is closed once its successors exist (the subjects now carrying any of its
 *     findings: a decision may split or merge), or as resolved when a complete assessment finds none of them outside a
 *     valid exception.
 *   - A complete assessment records, on every issue still tracking a finding, the commit where it's absent: that
 *     finding's episode ended, so its return is new and opens a new issue, past any dismissal and without any grant.
 *     A finding a valid exception covers is still there: it's in no subject, but never taken for absent.
 *   - An incomplete assessment never takes a finding for gone: it makes no new resolution decision and closes no issue
 *     whose subject it no longer finds. It closes only a duplicate whose findings its survivor already tracks, and finishes a closing
 *     an earlier run recorded.
 */
import { versionKey } from "@leanish/gate/package-version";

import { type Assessment, type FindingKey, type IssueRecord, keyOf, type PackageVersion, sameFinding, SHOWN_PENDING, type SubjectAssessment, subjectId } from "./issue-model.ts";
import { hasLabel, type IssueWriter, TAKE_EARLY_LABEL } from "./issue-text.ts";

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
   * again, that closing wasn't the tool's: a dismissal, when `closedByPerson` says a person made it.
   */
  readonly reopened: boolean;
  /**
   * GitHub shows a person last closed it, with no PR or commit behind that closing: the only closing that dismisses. Read
   * only for an issue the tool has no closing of its own to account for; false for every other.
   */
  readonly closedByPerson: boolean;
  /** Its labels, where known: a duplicate a person labelled `take-early` is theirs to settle. */
  readonly labels?: ReadonlyArray<string>;
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
  const known = (pkg: PackageVersion) => record.shown?.young.some((entry) => versionKey(entry) === versionKey(pkg)) === true;
  const since = record.shown === undefined || !young.every(known) ? SHOWN_PENDING
    : record.shown.since === SHOWN_PENDING ? at
      : record.shown.since;
  // Unchanged only when the very same versions are shown since the same time: a pending record whose versions changed
  // (a crash left it, and the decision now takes others) is rewritten, so what it records is what the body shows.
  const same = record.shown !== undefined && since === record.shown.since && record.shown.young.length === young.length && young.every(known);
  return same ? record : { ...record, shown: { young, since } };
}

/**
 * Whether `record` already tracks what rendering `subject` shows: every finding (`withFindings` would add none) and, for
 * a waiting decision, every young version (`withShown` would record none). Only then may a body be rendered from it
 * outside a sync, which alone records what an issue shows and confirms it.
 */
export function recordShows(record: IssueRecord, subject: SubjectAssessment): boolean {
  if (withFindings(record, subject.findings) !== record) return false;
  if (subject.status.kind !== "waiting") return true;
  return subject.status.young.every((young) => record.shown?.young.some((entry) => versionKey(entry) === versionKey(young)) === true);
}

/**
 * How a tracked issue stands: the subject's current instance, a closing still to finish, closed by the tool, reopened by
 * a person after that (retired, left alone), closed with no person's decision (by a reference or a bot: it holds nothing
 * back, so a finding still there gets a new issue, with no grant or attempt of this one), or dismissed.
 */
type Standing = "current" | "closing" | "closed-by-tool" | "reopened" | "closed-without-decision" | "dismissed";

function standingOf(issue: TrackedIssue): Standing {
  if (issue.state === "open") {
    if (issue.record.pendingClose === undefined) return "current";
    return issue.reopened ? "reopened" : "closing";
  }
  if (issue.record.pendingClose !== undefined && !issue.reopened) return "closed-by-tool";
  return issue.closedByPerson ? "dismissed" : "closed-without-decision";
}

/**
 * The operations for `assessment` over the tool's `issues` (open and closed). `unreadable` are the tool's open issues
 * whose record can't be read (a person edited it): what they track is unknown, so nothing new is created while there
 * are any, which could duplicate one of them; updates and closings of the readable ones go on.
 */
export function reconcile(assessment: Assessment, issues: ReadonlyArray<TrackedIssue>, writer: IssueWriter, unreadable: ReadonlyArray<number> = []): Reconciliation {
  const operations: IssueOperation[] = [];
  const notes: string[] = unreadable.map((number) => `#${number}: its record can't be read; secure-it creates no issue until it can (restore its hidden block, or close it)`);
  // What's still there: the subjects' findings, and those a valid exception covers (no issue, no work, but not gone).
  const present = [...assessment.subjects.flatMap((subject) => subject.findings.map(keyOf)), ...assessment.excepted.map(keyOf)];
  // Every issue, open or closed, learns the aliases its findings have now, so one that later drops an id it had still
  // matches them. A complete assessment then ends the episode of every tracked finding it no longer has.
  const records = new Map(issues.map((issue) => [issue.number, withAbsences(withAliases(issue.record, present), present, assessment)]));
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
  // Each subject's current issue, as read.
  const instances = new Map<string, TrackedIssue>();
  const coveredByDismissal = new Set<string>();
  for (const [id, subject] of wanted) {
    const current = bySubject.get(id)?.[0];
    if (current !== undefined) instances.set(id, current);
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
      if (standing === "closed-by-tool" || standing === "closed-without-decision" || standing === "dismissed" || standing === "reopened") {
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
        const authorized = hasLabel(issue.labels ?? [], TAKE_EARLY_LABEL) || record.attempts.some((attempt) => attempt.outcome === undefined);
        // Covered as GitHub shows the survivor, not by an update this round only schedules (sync may skip it).
        const covered = record.findings.every((finding) => first.record.findings.some((kept) => sameFinding(finding, kept)));
        if (authorized) notes.push(`#${issue.number}: duplicates #${first.number} but carries an authorization; a person closes one of them`);
        else if (assessment.complete || covered) operations.push(closing(issue, record, writer, "superseded", [first.number], assessment.sha));
        return;
      }
      if (!assessment.complete) {
        notes.push(`#${issue.number}: its subject is gone, but the assessment is incomplete; it stays open`);
        // Open, it mustn't keep promising what this run didn't confirm (a PR on the next run, a way to take it early):
        // it says the run couldn't assess it, with the findings this run did see. Its record stays as it is: no closing,
        // no absence, no attempt or grant settled because of this text.
        const seen = [...new Map(assessment.subjects.flatMap((subject) => subject.findings)
          .filter((finding) => record.findings.some((tracked) => sameFinding(tracked, finding)))
          .map((finding) => [JSON.stringify(keyOf(finding)), finding])).values()];
        const excepted = record.findings.some((tracked) => assessment.excepted.some((finding) => sameFinding(tracked, finding)));
        const { body } = writer.render({ subject: record.subject, findings: seen, status: { kind: "blocked", reason: "unassessed", detail: notConfirmed(record, seen.length > 0, excepted) } }, record, assessment.sha);
        if (body !== issue.body) operations.push({ kind: "update", number: issue.number, body });
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
      // A successor counts once GitHub shows it tracking the findings that moved there: its record as read, never an
      // update this round only schedules (sync skips one whose issue a person changed meanwhile, and a text that can't
      // be written schedules none). The closing then waits for a round that reads that update back.
      const unshown = successors.flatMap((successor) => {
        const current = instances.get(successor);
        if (current === undefined) return [];
        const moved = record.findings.filter((tracked) => wanted.get(successor)!.findings.some((finding) => sameFinding(tracked, finding)));
        return moved.every((tracked) => current.record.findings.some((shown) => sameFinding(tracked, shown))) ? [] : [current.number];
      });
      if (unshown.length > 0) {
        notes.push(`#${issue.number}: closes once ${unshown.map((number) => `#${number}`).join(", ")} shows its findings`);
        return;
      }
      const numbers = [...new Set(successors.flatMap((successor) => instances.get(successor)?.number ?? []))].sort((a, b) => a - b);
      operations.push(closing(issue, record, writer, "superseded", numbers, assessment.sha));
    });
  }
  return { operations, notes };
}

/**
 * What an open issue says while an incomplete assessment no longer finds its subject: no promise the run didn't confirm,
 * and, when the run saw none of its findings (so no table shows them), the advisories it tracks, from its own record.
 * One a valid exception now covers isn't said to be gone: `excepted` qualifies it.
 */
function notConfirmed(record: IssueRecord, seenAny: boolean, excepted: boolean): string {
  const what = record.subject.kind === "decision"
    ? "didn't confirm this decision; the moves below aren't queued for execution"
    : seenAny ? "couldn't confirm this issue's current status"
      : excepted ? "didn't find these advisories again outside a valid exception" : "didn't find these advisories again";
  const tracked = seenAny ? "" : `; it tracks ${record.findings.map((finding) => `${finding.name} ${finding.ids.join(", ")}`).join("; ")}`;
  return `this run's assessment is incomplete and ${what}${tracked}. This issue stays open until an assessment settles it`;
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
 * `record` with each of `shown` it doesn't track yet (overlapping ids count as tracked), and without the absence of any
 * finding shown again; the same object when nothing changes. An issue shows its subject's current findings, so a
 * finding that joined later is one it tracks too, and one that came back after a complete scan missed it starts a new
 * episode on this issue: closing it as resolved, or a person's dismissal, then goes by those findings as they are now.
 */
function withFindings(record: IssueRecord, shown: ReadonlyArray<FindingKey>): IssueRecord {
  const joined = shown.filter((finding) => !record.findings.some((tracked) => sameFinding(tracked, finding))).map(keyOf);
  const absences = record.absences.filter((absence) => !shown.some((finding) => sameFinding(absence.finding, finding)));
  if (joined.length === 0 && absences.length === record.absences.length) return record;
  return { ...record, findings: [...record.findings, ...joined], absences };
}

/**
 * `record` with each tracked finding's ids grown by those of every observed finding it shares one with, and each
 * recorded absence's alike: sources add aliases over time and can drop the first one seen, and a finding tracked by an
 * id nothing reports any more would read as gone (resolving its issue, or escaping a dismissal) while it's still there,
 * or its ended episode as still running (a dismissal covering it again). The same object when nothing is new.
 */
function withAliases(record: IssueRecord, observed: ReadonlyArray<FindingKey>): IssueRecord {
  let changed = false;
  const grown = (key: FindingKey): FindingKey => {
    const ids = new Set(key.ids);
    for (const finding of observed) if (sameFinding(key, finding)) for (const id of finding.ids) ids.add(id);
    if (ids.size === key.ids.length) return key;
    changed = true;
    return { ...key, ids: [...ids].sort() };
  };
  const findings = record.findings.map(grown);
  const absences = record.absences.map((absence) => {
    const finding = grown(absence.finding);
    return finding === absence.finding ? absence : { ...absence, finding };
  });
  return changed ? { ...record, findings, absences } : record;
}

/**
 * `record` with an absence for each of its findings a complete assessment no longer has (`present`, an excepted one
 * included); the same object when none. An absence recorded earlier stays: that episode ended.
 */
function withAbsences(record: IssueRecord, present: ReadonlyArray<FindingKey>, assessment: Assessment): IssueRecord {
  if (!assessment.complete) return record;
  const ended = record.findings.filter((finding) =>
    !present.some((seen) => sameFinding(seen, finding)) && !record.absences.some((absence) => sameFinding(absence.finding, finding)));
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
    ? `secure-it closes this issue: a complete assessment of \`${pending.at.slice(0, 12)}\` finds none of its advisories outside a valid exception.`
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
