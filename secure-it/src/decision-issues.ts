/**
 * The one place a decision's issue is looked up and a `take-early` grant on it is read, for runs and reviews alike.
 *
 * Three lifetimes, kept apart on purpose:
 * - Whether the issue records a PR as a running early attempt (`EarlyPrs`): read once per PR and invocation, and
 *   forgotten when recovery may have attached a PR to its attempt. It stays true when the label was removed meanwhile:
 *   a PR taken early is never treated as ordinary because its grant went away.
 * - Whether a grant stands now (`grantStanding`): read afresh every time it's asked, never cached.
 * - What a review may do with a PR this tick: the review's own per-PR permit, from its disposition (`issue-review.ts`).
 */
import { GitHubApiError } from "@leanish/agent-runtime/github/github-client";
import type { GitHubPullRequest } from "@leanish/agent-runtime/types/clients";
import type { GitHubIssue, GitHubIssues } from "@leanish/tool-runtime/github-issues";

import { decisionMoves } from "./issue-assessment.ts";
import { type GrantDecision, grantOf } from "./issue-grant.ts";
import { type Attempt, type DecisionMove, type Grant, type IssueRecord, subjectId, type SubjectStatus } from "./issue-model.ts";
import { recordOf } from "./issue-text.ts";
import type { ChangePlan } from "./plan.ts";

/** What the lookups read through. */
export interface IssueReader {
  readonly issues: GitHubIssues;
  readonly repo: string;
}

const TRACKS = /^Tracks #(\d+)(, taken early)?\.$/gm;

/** The issue a PR body says it tracks: the last `Tracks #N.` line, the one the tool appends after the agent's text. */
export function trackedIssueOf(body: string): number | undefined {
  const last = [...body.matchAll(TRACKS)].at(-1);
  return last === undefined ? undefined : Number(last[1]);
}

/** Whether that line says an early attempt published the PR (`Tracks #N, taken early.`). */
export function takenEarlyOf(body: string): boolean {
  return [...body.matchAll(TRACKS)].at(-1)?.[2] !== undefined;
}

/** The tool's issue `number` with its record, when that record is `plan`'s decision. */
export async function decisionIssue(client: IssueReader, number: number, plan: ChangePlan): Promise<{ issue: GitHubIssue; record: IssueRecord } | undefined> {
  const tracked = await toolIssue(client, number);
  return tracked !== undefined && subjectId(tracked.record.subject) === subjectId({ kind: "decision", moves: decisionMoves(plan) }) ? tracked : undefined;
}

/**
 * Whether a PR with `plan` may name issue `number`: the tool's, for a decision that includes every move of `plan`, which
 * is the whole decision's or the one a retry reduced (`retryWithoutNamed`), still published under its whole decision's issue.
 */
export async function issueCovers(client: IssueReader, number: number, plan: ChangePlan): Promise<boolean> {
  const subject = (await toolIssue(client, number))?.record.subject;
  if (subject?.kind !== "decision") return false;
  const key = (move: DecisionMove) => JSON.stringify([move.ecosystem, move.name, move.from, move.to]);
  const whole = new Set(subject.moves.map(key));
  return decisionMoves(plan).every((move) => whole.has(key(move)));
}

/** Issue `number` when the token's login opened it and its record reads. */
async function toolIssue(client: IssueReader, number: number): Promise<{ issue: GitHubIssue; record: IssueRecord } | undefined> {
  // An issue gone (transferred to a repository the token reads: 301, or to one it can't: 404; deleted: 410) is no issue
  // of this decision's; any other failure goes through, so nothing proceeds unread.
  const read = await client.issues.getIssue({ repo: client.repo, number }).catch((error: unknown) => {
    if (error instanceof GitHubApiError && (error.status === 301 || error.status === 404 || error.status === 410)) return undefined;
    throw error;
  });
  if (read === undefined) return undefined;
  const [issue, login] = [read, await client.issues.login()];
  const record = recordOf(issue.body);
  return issue.author === login && record !== undefined ? { issue, record } : undefined;
}

/**
 * What a tracked PR is to its issue: an early attempt's (a running attempt there is this PR's, with the grant it ran
 * under), an ordinary one's, or one whose issue isn't the tool's or this decision's. Read from the issue, never from the
 * gate's cooldown: the gate holds what's new anywhere in the repository, secure-it what's new where it arrives, so a
 * PR taken early may hold nothing in its plan and still be one.
 */
export type Scope =
  | { readonly kind: "foreign"; readonly number: number }
  | { readonly kind: "ordinary"; readonly number: number }
  | { readonly kind: "early"; readonly number: number; readonly issue: GitHubIssue; readonly record: IssueRecord; readonly attempt: Attempt; readonly grant: Grant };

export async function scopeOf(client: IssueReader, pr: GitHubPullRequest, plan: ChangePlan, number: number): Promise<Scope> {
  const tracked = await decisionIssue(client, number, plan);
  if (tracked === undefined) return { kind: "foreign", number };
  const attempt = tracked.record.attempts.find((entry) => entry.pr === pr.number && entry.outcome === undefined);
  const grant = tracked.record.grant;
  if (attempt === undefined || grant === undefined || grant.labelEventId !== attempt.grantEventId) return { kind: "ordinary", number };
  return { kind: "early", number, issue: tracked.issue, record: tracked.record, attempt, grant };
}

/**
 * Whether the issue's `take-early` label grants its decision now (`grantOf`), from its events, comments and each
 * actor's current permission, read afresh. A read that fails goes through: nothing is authorized unread.
 */
export async function grantStanding(
  client: IssueReader,
  number: number,
  issue: { readonly state: GitHubIssue["state"]; readonly labels: ReadonlyArray<string>; readonly record: IssueRecord; readonly status: SubjectStatus },
): Promise<GrantDecision> {
  const [events, comments] = await Promise.all([
    client.issues.listEvents({ repo: client.repo, number }),
    client.issues.listComments({ repo: client.repo, number }),
  ]);
  const actors = [...new Set(events.flatMap((event) => (event.actor === null ? [] : [event.actor])))];
  const permissions = new Map(await Promise.all(actors.map(async (actor) => [actor, await client.issues.permission({ repo: client.repo, login: actor })] as const)));
  return grantOf({ state: issue.state, labels: issue.labels, record: issue.record, status: issue.status, events, comments, permissions });
}

/**
 * Whether the issue records each PR as a running early attempt, read once per PR in one run or review tick. A
 * disposition that already read a PR's scope `remember`s it, so later questions about that PR read nothing more.
 */
export class EarlyPrs {
  readonly #client: IssueReader;
  readonly #known = new Map<number, Promise<boolean>>();

  constructor(client: IssueReader) {
    this.#client = client;
  }

  /** Whether `pr`'s tracked issue records it as a running early attempt for `plan`'s decision. */
  is(pr: GitHubPullRequest, plan: ChangePlan): Promise<boolean> {
    let known = this.#known.get(pr.number);
    if (known === undefined) {
      const number = trackedIssueOf(pr.body);
      known = number === undefined ? Promise.resolve(false) : scopeOf(this.#client, pr, plan, number).then((scope) => scope.kind === "early");
      this.#known.set(pr.number, known);
    }
    return known;
  }

  /** Records what a disposition found for `pr`, whatever it then decided. */
  remember(pr: GitHubPullRequest, scope: Scope): void {
    this.#known.set(pr.number, Promise.resolve(scope.kind === "early"));
  }

  /** Drops every answer: recovery may have attached a PR to its attempt since. */
  forget(): void {
    this.#known.clear();
  }
}
