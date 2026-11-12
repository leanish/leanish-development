/**
 * What secure-it says, once, about a closing of one of its issues it didn't make: whether it takes it for a person's
 * dismissal of the issue's findings, and what that does and doesn't change. Without any I/O: the sync posts each notice,
 * then records its closing as acknowledged (`IssueRecord.acknowledged`).
 */
import { literal } from "@leanish/tool-runtime/pr-text";

import { type FindingKey, type IssueRecord, sameFinding } from "./issue-model.ts";
import type { TrackedIssue } from "./issue-reconcile.ts";

export interface ClosingNotice {
  readonly number: number;
  /** The closing it explains (`TrackedIssue.closing`). */
  readonly closing: string;
  /** The notice's id: one per closing, so a reopening and a new closing get a new one. */
  readonly noticeId: string;
  readonly body: string;
}

/**
 * A notice for each closed issue whose latest closing the tool didn't make and no run explained yet: only those have
 * their closing read (`TrackedIssue.closing`), so the tool's own closings, explained when it made them, get none.
 */
export function closingNotices(tracked: ReadonlyArray<TrackedIssue>): ClosingNotice[] {
  return tracked.flatMap((issue) => {
    if (issue.state !== "closed" || issue.closing === undefined || issue.record.acknowledged === issue.closing) return [];
    const body = issue.closedByPerson ? dismissal(issue.record) : noDismissal(successorsOf(issue.record, tracked));
    return [{ number: issue.number, closing: issue.closing, noticeId: `closing:${issue.closing}`, body }];
  });
}

/** Names only the findings the dismissal covers: one recorded absent since ended its episode, and a return opens anew. */
function dismissal(record: IssueRecord): string {
  const covered = record.findings.filter((finding) => !record.absences.some((absence) => sameFinding(absence.finding, finding)));
  return [
    covered.length === 0
      ? "secure-it takes this closing for a person's dismissal, but this issue tracks no finding still present, so it covers none."
      : `secure-it takes this closing for a person's dismissal of these findings: ${findingsText(covered)}.`,
    "A dismissed finding opens no new issue while it stays, unless it's gone and comes back, or shares a fix or a package with a finding that isn't dismissed (that issue then shows it too).",
    "This doesn't change what the gate checks, and doesn't close an open PR for this fix: close that by hand if you don't want it.",
    "Reopening this issue undoes its dismissal; another issue a person closed can still dismiss the same findings.",
  ].join(" ");
}

/**
 * Neutral on the cause: GitHub doesn't tell a PR's or a commit's closing from a bot's, or from one whose closer the token
 * can't see, apart from a person's. It names only the issues that track the findings now, never one still to open.
 */
function noDismissal(successors: ReadonlyArray<number>): string {
  const issues = successors.map((number) => `#${number}`).join(", ");
  return [
    "secure-it doesn't take this closing for a dismissal: GitHub doesn't show a person closing it by hand. A PR, a commit, automation, or a closer the token can't see may have closed it.",
    "It holds none of its findings back.",
    successors.length === 0
      ? "To dismiss them, reopen this issue and close it by hand."
      : `${issues} ${successors.length === 1 ? "tracks" : "track"} them now; to dismiss them, close ${successors.length === 1 ? "it" : "those"} by hand.`,
  ].join(" ");
}

/** The open issues that are their subject's current one and track any of `record`'s findings, still running. */
function successorsOf(record: IssueRecord, tracked: ReadonlyArray<TrackedIssue>): number[] {
  const tracks = (other: IssueRecord, finding: FindingKey) => other.findings.some((own) => sameFinding(own, finding))
    && !other.absences.some((absence) => sameFinding(absence.finding, finding));
  return tracked
    .filter((issue) => issue.state === "open" && issue.record.pendingClose === undefined && record.findings.some((finding) => tracks(issue.record, finding)))
    .map((issue) => issue.number)
    .sort((a, b) => a - b);
}

function findingsText(findings: ReadonlyArray<FindingKey>): string {
  return findings.map((finding) => literal(`${finding.ecosystem} ${finding.name} ${finding.ids.join(", ")}`)).join(", ");
}
