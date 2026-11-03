/**
 * Brings the tool's issues in line with one frozen assessment: reads them (the token's own, open and closed), asks
 * `reconcile` for operations, applies them, and reads again until nothing is left or the rounds run out. Every text is
 * cleaned of local paths before it's published, and compared cleaned, so an unchanged issue is never rewritten.
 *
 * A write GitHub refuses as forbidden is a setup problem: the write PAT lacks Issues: read and write. It fails the
 * sync with that, never a fallback; a rate limit stays a rate limit.
 */
import { GitHubApiError } from "@leanish/agent-runtime/github/github-client";
import type { GitHubIssue, GitHubIssues } from "@leanish/tool-runtime/github-issues";

import type { Assessment } from "./issue-model.ts";
import { type IssueOperation, type IssueWriter, reconcile, type TrackedIssue } from "./issue-reconcile.ts";
import { ISSUE_LABEL, ISSUE_WRITER, noticeMarker, recordOf } from "./issue-text.ts";

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
  const writer = cleaned(sync.clean);
  const login = await sync.issues.login();
  const notes: string[] = [];
  const clock = sync.clock ?? (() => new Date());
  for (let round = 0; ; round++) {
    const read = await readTracked(sync, login);
    // Read first: a pending young version this round confirms was published before this clock reading.
    const shownFrom = new Date(clock().getTime() + SHOWN_MARGIN_MS).toISOString();
    const result = reconcile({ ...assessment, at: shownFrom }, read.tracked, writer, read.unreadable);
    if (result.operations.length === 0 || round === ROUNDS) {
      notes.push(...result.notes);
      return { ...read, notes: [...new Set(notes)], settled: result.operations.length === 0 };
    }
    for (const operation of result.operations) await apply(sync, operation);
  }
}

/** The writer, with every text it produces cleaned as publication will clean it. */
function cleaned(clean: (body: string) => string): IssueWriter {
  return {
    render: (assessment, record, sha) => {
      const text = ISSUE_WRITER.render(assessment, record, sha);
      return { title: text.title, body: clean(text.body) };
    },
    withRecord: (body, record) => clean(ISSUE_WRITER.withRecord(body, record)),
  };
}

async function readTracked(sync: IssueSync, login: string): Promise<Pick<SyncResult, "tracked" | "unreadable">> {
  const tracked: Array<TrackedIssue & { readonly labels: ReadonlyArray<string> }> = [];
  const unreadable: number[] = [];
  for (const issue of await sync.issues.listIssues({ repo: sync.repo, creator: login, label: ISSUE_LABEL })) {
    const record = recordOf(issue.body);
    if (record === undefined) {
      // A closed one without a readable record stays out of everything; an open one blocks creates (`reconcile`).
      if (issue.state === "open" && looksOurs(issue)) unreadable.push(issue.number);
      continue;
    }
    // A reopening only matters where the tool recorded a closing: read the events there alone.
    const reopened = record.pendingClose !== undefined
      && (await sync.issues.listEvents({ repo: sync.repo, number: issue.number })).some((event) => event.event === "reopened");
    tracked.push({ number: issue.number, state: issue.state, body: issue.body, record, reopened, labels: issue.labels });
  }
  return { tracked, unreadable };
}

/** An issue the token's login opened that looks like the tool's (its section heading), not the owner's own issue. */
const looksOurs = (issue: GitHubIssue) => issue.body.includes("## secure-it") || issue.title.startsWith("secure-it:");

async function apply(sync: IssueSync, operation: IssueOperation): Promise<void> {
  const { issues, repo } = sync;
  await setup(async () => {
    switch (operation.kind) {
      case "create":
        await issues.createIssue({ repo, title: operation.title, body: operation.body, labels: [ISSUE_LABEL] });
        return;
      case "update":
        await issues.updateIssue({ repo, number: operation.number, body: operation.body });
        return;
      case "close": {
        // The record first, then the notice once, then the closing: a crash anywhere finishes on the next round.
        await issues.updateIssue({ repo, number: operation.number, body: operation.body });
        await postNotice(sync, operation.number, operation.comment.noticeId, operation.comment.body);
        await issues.updateIssue({ repo, number: operation.number, state: "closed", stateReason: operation.reason });
        return;
      }
    }
  });
}

/** Comments `text` on issue `number` unless a comment already carries notice `id`: each notice is posted once. */
export async function postNotice(sync: IssueSync, number: number, id: string, text: string): Promise<void> {
  const marker = noticeMarker(id);
  const comments = await sync.issues.listComments({ repo: sync.repo, number });
  if (comments.some((comment) => comment.body.includes(marker))) return;
  await sync.issues.createComment({ repo: sync.repo, number, body: `${sync.clean(text)}\n\n${marker}` });
}

/** Runs a write, turning GitHub's plain refusal into what to fix; a rate limit or anything else goes through as it is. */
async function setup(write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 403 && error.reason === "forbidden") {
      throw new Error(`GitHub refused secure-it's issue write (${error.operation}): the write PAT needs Issues: read and write (docs/adopting-tools.md)`);
    }
    throw error;
  }
}
