/**
 * Brings the tool's issues in line with one frozen assessment: reads them (the token's own, open and closed), asks
 * `reconcile` for operations, applies them, and reads again until nothing is left or the rounds run out. Every text is
 * cleaned of local paths before it's published, and compared cleaned, so an unchanged issue is never rewritten.
 *
 * GitHub's filtered issue listing lags writes by seconds (an issue created a moment ago isn't listed yet, an edited one
 * is listed with its old body), while reading an issue by its number doesn't. So every issue the sync wrote is read
 * back by number in the rounds after: a round never takes the listing's stale copy for the truth and writes again.
 *
 * A write GitHub refuses as forbidden is a setup problem, likely the write PAT's Issues permission. So is a create
 * GitHub answers as gone: the repository has Issues disabled. Either fails the sync with that, never a fallback; a rate
 * limit stays a rate limit (`issueWrite`).
 */
import type { GitHubIssue, GitHubIssues } from "@leanish/tool-runtime/github-issues";

import { issueWrite, unlessGone } from "./issue-access.ts";
import type { Assessment, PendingClose } from "./issue-model.ts";
import { postNotice } from "./issue-notices.ts";
import { type IssueOperation, reconcile, type TrackedIssue } from "./issue-reconcile.ts";
import { hasLabel, ISSUE_LABEL, type IssueWriter, issueWriter, noticeMarker, recordOf } from "./issue-text.ts";

export interface IssueSync {
  readonly issues: GitHubIssues;
  readonly repo: string;
  /** Local paths out of a text bound for GitHub (`cleanBody`). */
  readonly clean: (body: string) => string;
  /** The wall clock, read just before each round's writes; the system's by default. */
  readonly clock?: () => Date;
}

export interface SyncResult {
  /** The tool's issues after the last round, readable ones only. */
  readonly tracked: ReadonlyArray<TrackedIssue & { readonly labels: ReadonlyArray<string> }>;
  /** Open issues of the tool whose record can't be read. */
  readonly unreadable: ReadonlyArray<number>;
  readonly notes: ReadonlyArray<string>;
  /** Whether a round found nothing left to do; false when the rounds ran out first. */
  readonly settled: boolean;
}

const ROUNDS = 4;

/**
 * The clock skew allowed against GitHub's label times when a round confirms a pending young version as shown
 * (`Shown.since`): the round's clock, read after it saw the published body, plus this. A label inside that margin is
 * refused rather than taken to cover what it may not have seen; a later one authorizes it.
 */
export const SHOWN_MARGIN_MS = 120_000;

export async function syncIssues(sync: IssueSync, assessment: Assessment): Promise<SyncResult> {
  const writer = issueWriter(sync.clean);
  const login = await sync.issues.login();
  const notes: string[] = [];
  const clock = sync.clock ?? (() => new Date());
  const written = new Set<number>();
  for (let round = 0; ; round++) {
    const read = await readTracked(sync, login, written);
    // Read first: a pending young version this round confirms was published before this clock reading.
    const shownFrom = new Date(clock().getTime() + SHOWN_MARGIN_MS).toISOString();
    const result = reconcile({ ...assessment, at: shownFrom }, read.tracked, writer, read.unreadable);
    if (result.operations.length === 0 || round === ROUNDS) {
      notes.push(...result.notes);
      return { ...read, notes: [...new Set(notes)], settled: result.operations.length === 0 };
    }
    const seen = new Map(read.tracked.map((issue) => [issue.number, issue]));
    for (const operation of result.operations) {
      // An edit is decided on what this round read, which a lagging listing may show stale: one whose issue changed
      // since (a person's label, an attempt recorded) isn't written, and the next round decides on its fresh copy.
      if (operation.kind !== "create" && !(await unchanged(sync, seen.get(operation.number)))) {
        written.add(operation.number);
        continue;
      }
      written.add(await apply(sync, operation.kind === "close" ? await withEventBoundary(sync, writer, operation) : operation));
    }
  }
}

/**
 * A closing whose record names the issue's last event before it (`PendingClose.afterEvent`), so a later reading tells
 * the tool's own `closed` event from a person's earlier ones by event order. A closing already recorded keeps its own.
 */
async function withEventBoundary(sync: IssueSync, writer: IssueWriter, operation: Extract<IssueOperation, { kind: "close" }>): Promise<IssueOperation> {
  const record = recordOf(operation.body);
  if (record?.pendingClose === undefined || record.pendingClose.afterEvent !== undefined) return operation;
  const events = await sync.issues.listEvents({ repo: sync.repo, number: operation.number });
  const afterEvent = events.reduce((last, event) => Math.max(last, event.id), 0);
  return { ...operation, body: writer.withRecord(operation.body, { ...record, pendingClose: { ...record.pendingClose, afterEvent } }) };
}

/** Whether `read` is still what GitHub has: the same body, state and labels, read by its number. */
async function unchanged(sync: IssueSync, read: { readonly number: number; readonly body: string; readonly state: string; readonly labels: ReadonlyArray<string> } | undefined): Promise<boolean> {
  if (read === undefined) return false;
  const fresh = await readWritten(sync, read.number);
  if (fresh === undefined) return false;
  const labels = (issue: { readonly labels: ReadonlyArray<string> }) => [...issue.labels].sort().join("\n");
  return fresh.body === read.body && fresh.state === read.state && labels(fresh) === labels(read);
}

/**
 * The tool's issues as listed, with each one in `written` read by its number instead of the listing's copy, and kept
 * only as the listing would keep it (the token's login opened it, it carries the tool's label). One that is gone (a
 * person deleted or transferred it) drops out, as it does from the listing.
 */
async function readTracked(sync: IssueSync, login: string, written: ReadonlySet<number>): Promise<Pick<SyncResult, "tracked" | "unreadable">> {
  const listed = await sync.issues.listIssues({ repo: sync.repo, creator: login, label: ISSUE_LABEL });
  const fresh: GitHubIssue[] = [];
  for (const number of written) {
    const issue = await readWritten(sync, number);
    if (issue !== undefined && issue.author === login && hasLabel(issue.labels, ISSUE_LABEL)) fresh.push(issue);
  }
  const tracked: Array<TrackedIssue & { readonly labels: ReadonlyArray<string> }> = [];
  const unreadable: number[] = [];
  for (const issue of [...listed.filter((issue) => !written.has(issue.number)), ...fresh]) {
    const record = recordOf(issue.body);
    if (record === undefined) {
      // A closed one without a readable record stays out of everything; an open one blocks creates (`reconcile`).
      if (issue.state === "open" && looksOurs(issue)) unreadable.push(issue.number);
      continue;
    }
    // A reopening only matters where the tool recorded a closing: read the events there alone.
    const reopened = record.pendingClose !== undefined && await reopenedAfterClosing(sync, login, issue.number, record.pendingClose);
    tracked.push({ number: issue.number, state: issue.state, body: issue.body, record, reopened, labels: issue.labels });
  }
  return { tracked, unreadable };
}

/**
 * Whether a person reopened issue `number` after the tool's own closing `pending`, not merely at some time before it
 * (closed and reopened by hand, then superseded by the tool). The tool's closing is the first `closed` event by the
 * token's login after the last one it saw when it recorded the closing (`afterEvent`), and only a `reopened` after that
 * counts: another account closing and reopening it in between is never taken for the tool's closing. A person using
 * the token's own account can be (a documented limit in docs/coverage-gaps.md). A closing
 * recorded before `afterEvent` existed goes by its notice comment, which the tool posts right before closing, at a
 * second's precision; without the notice (deleted, or not listed), any reopening counts, so a person's is never lost.
 */
async function reopenedAfterClosing(sync: IssueSync, login: string, number: number, pending: PendingClose): Promise<boolean> {
  const events = await sync.issues.listEvents({ repo: sync.repo, number });
  const reopenings = events.filter((event) => event.event === "reopened");
  if (reopenings.length === 0) return false;
  const closings = events.filter((event) => event.event === "closed" && event.actor === login);
  let toolClosing: number | undefined;
  if (pending.afterEvent !== undefined) {
    toolClosing = closings.filter((event) => event.id > pending.afterEvent!).sort((a, b) => a.id - b.id)[0]?.id;
  } else {
    // Only the tool's own notice dates its closing: a marker someone else posted later would hide a person's reopening.
    const marker = noticeMarker(pending.id);
    const notice = (await sync.issues.listComments({ repo: sync.repo, number })).find((comment) => comment.author === login && comment.body.includes(marker));
    if (notice === undefined) return true;
    toolClosing = closings.filter((event) => Date.parse(event.createdAt) >= Date.parse(notice.createdAt)).sort((a, b) => a.id - b.id)[0]?.id;
  }
  return toolClosing !== undefined && reopenings.some((event) => event.id > toolClosing);
}

/**
 * Issue `number` as GitHub has it now, or undefined once it's gone: transferred to a repository the token reads (301)
 * or to one it can't (404), or deleted (410).
 */
function readWritten(sync: IssueSync, number: number): Promise<GitHubIssue | undefined> {
  return unlessGone(() => sync.issues.getIssue({ repo: sync.repo, number }));
}

/** An issue the token's login opened that looks like the tool's (its section heading), not the owner's own issue. */
const looksOurs = (issue: GitHubIssue) => issue.body.includes("## secure-it") || issue.title.startsWith("secure-it:");

/** Applies one operation and returns the number of the issue it wrote. */
async function apply(sync: IssueSync, operation: IssueOperation): Promise<number> {
  const { issues, repo } = sync;
  return issueWrite(async () => {
    switch (operation.kind) {
      case "create":
        return (await issues.createIssue({ repo, title: operation.title, body: operation.body, labels: [ISSUE_LABEL] })).number;
      case "update":
        await issues.updateIssue({ repo, number: operation.number, body: operation.body });
        return operation.number;
      case "close": {
        // The record first, then the notice once, then the closing: a crash anywhere finishes on the next round.
        await issues.updateIssue({ repo, number: operation.number, body: operation.body });
        await postNotice(sync, operation.number, operation.comment.noticeId, operation.comment.body);
        await issues.updateIssue({ repo, number: operation.number, state: "closed", stateReason: operation.reason });
        return operation.number;
      }
    }
  });
}

