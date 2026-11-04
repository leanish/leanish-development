/**
 * What review does with an open PR now that issues decide what executes, before it prepares the PR's branch:
 *
 * - A PR taken early (its issue records a running attempt that is this PR's) goes on only while the grant that started
 *   it stands: the `take-early` label still there, its reason unedited, its labeler still a writer, and the decision
 *   taking no young version the grant didn't cover. Otherwise it's left to the owner, which the issue says once. Once
 *   every version it was taken early for is past the wait, it's retired and its attempt ends.
 * - A version PR without an issue line is left to the owner; nothing migrates it.
 *
 * Issue numbers come from the PR's own line (`Tracks #N.`), and a tracked issue counts only when the tool opened it and
 * its record is this PR's decision: a body someone edited can't point review at another issue.
 */
import { GitHubApiError } from "@leanish/agent-runtime/github/github-client";
import type { GitHubPullRequest } from "@leanish/agent-runtime/types/clients";
import { label, versionKey } from "@leanish/gate/package-version";
import type { Ecosystem } from "@leanish/gate/versions";
import type { GitHubIssue } from "@leanish/tool-runtime/github-issues";

import { decisionMoves } from "./issue-assessment.ts";
import type { AttemptClient } from "./issue-attempts.ts";
import { settleAttempt } from "./issue-attempts.ts";
import { grantOf } from "./issue-grant.ts";
import { type Attempt, type Grant, type IssueRecord, subjectId, type PackageVersion, type YoungVersion } from "./issue-model.ts";
import { postNotice } from "./issue-notices.ts";
import { recordOf } from "./issue-text.ts";
import { planOf } from "./plan-block.ts";
import type { ChangePlan } from "./plan.ts";
import { youngAt } from "./young-at.ts";

export interface ReviewIssues extends AttemptClient {
  readonly now: Date;
  /** Whether a package is trusted (`trustedPackages`): its young versions are a trusted exception, needing no grant. */
  readonly trusted: (pkg: { readonly ecosystem: Ecosystem; readonly name: string }) => boolean;
  /**
   * Closes a PR taken early with `comment`, deleting its branch (`closeAndDelete`), only while it's still a draft
   * when re-read: "not-draft" when a person marked it ready meanwhile.
   */
  readonly retire: (pr: GitHubPullRequest, comment: string) => Promise<"closed" | "not-draft">;
  /** When a version is past the wait, from its registry publication; undefined when that can't be read. */
  readonly eligibleAt: (pkg: { readonly ecosystem: Ecosystem; readonly name: string; readonly version: string }) => Promise<string | undefined>;
}

/**
 * Whether review goes on with a PR. A PR taken early whose granted versions are still young goes on `held` until the
 * last of them ages ("unknown" when a date can't be read): kept a draft whatever its plan's cooldown holds, so it
 * never becomes ready before then, and a person marking it ready takes it over. `young` is what its standing grant
 * covers this tick: the young versions verification may admit for it (none for an ordinary PR).
 */
export type ReviewDisposition =
  | { readonly kind: "proceed"; readonly held?: { readonly until: string }; readonly young?: ReadonlyArray<PackageVersion> }
  | { readonly kind: "leave"; readonly reason: string }
  | { readonly kind: "graduated"; readonly reason: string };

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

/** The versions `plan` holds that are still younger than the wait and need a grant: a trusted package's never do. */
function youngIn(client: ReviewIssues, plan: ChangePlan) {
  return (plan.cooldown ?? []).filter((held) => youngAt(held.eligibleAt, client.now) && !client.trusted(held));
}

/**
 * What a tracked PR is to its issue: an early attempt's (a running attempt there is this PR's, with the grant it ran
 * under), an ordinary one's, or one whose issue isn't the tool's or this decision's. Read from the issue, never from the
 * gate's cooldown: the gate holds what's new anywhere in the repository, secure-it what's new where it arrives, so a
 * PR taken early may hold nothing in its plan and still be one.
 */
type Scope =
  | { readonly kind: "foreign"; readonly number: number }
  | { readonly kind: "ordinary"; readonly number: number }
  | { readonly kind: "early"; readonly number: number; readonly issue: GitHubIssue; readonly record: IssueRecord; readonly attempt: Attempt; readonly grant: Grant };

async function scopeOf(client: Pick<ReviewIssues, "issues" | "repo">, pr: GitHubPullRequest, plan: ChangePlan, number: number): Promise<Scope> {
  const tracked = await trackedIssue(client, number, plan);
  if (tracked === undefined) return { kind: "foreign", number };
  const attempt = tracked.record.attempts.find((entry) => entry.pr === pr.number && entry.outcome === undefined);
  const grant = tracked.record.grant;
  if (attempt === undefined || grant === undefined || grant.labelEventId !== attempt.grantEventId) return { kind: "ordinary", number };
  return { kind: "early", number, issue: tracked.issue, record: tracked.record, attempt, grant };
}

/** The versions a grant covered that are still younger than the wait now (an unreadable date counts as young). */
async function stillYoung(client: ReviewIssues, grant: Grant): Promise<YoungVersion[]> {
  const young: YoungVersion[] = [];
  for (const pkg of grant.young) {
    if (client.trusted(pkg)) continue;
    const eligibleAt = await client.eligibleAt(pkg).catch(() => undefined);
    if (youngAt(eligibleAt, client.now)) young.push({ ...pkg, eligibleAt: eligibleAt ?? "unknown" });
  }
  return young;
}

export async function reviewDisposition(client: ReviewIssues, pr: GitHubPullRequest, plan: ChangePlan): Promise<ReviewDisposition> {
  const number = trackedIssueOf(pr.body);
  if (number === undefined) return { kind: "leave", reason: "it tracks no issue; close it by hand and run secure-it again" };
  const scope = await scopeOf(client, pr, plan, number);
  // A PR taken early that its issue can't confirm (gone, unreadable, no running attempt) fails closed: nothing on it
  // says it's ordinary now. Any other without its issue, or with no early attempt there, is an ordinary PR: fine while
  // it holds no young version.
  if (scope.kind === "foreign") {
    return youngIn(client, plan).length === 0 && !takenEarlyOf(pr.body) ? { kind: "proceed" } : { kind: "leave", reason: `it tracks #${number}, which isn't this decision's issue` };
  }
  if (scope.kind === "ordinary") {
    return youngIn(client, plan).length === 0 && !takenEarlyOf(pr.body) ? { kind: "proceed" } : leave(client, number, `no-attempt:${pr.number}`, pr, "no running early attempt on its issue is this PR's");
  }
  const young = await stillYoung(client, scope.grant);
  if (young.length === 0) return graduated(client, pr, scope);
  const standing = await grantFor(client, scope, young);
  if (standing.kind === "stands") return { kind: "proceed", held: { until: latest(young) }, young: standing.grant.young };
  return leave(client, number, `left:${pr.number}:${standing.key}`, pr, standing.why);
}

/** Retires a PR whose granted versions all aged, before any branch or CI work, and ends its attempt. */
async function graduated(client: ReviewIssues, pr: GitHubPullRequest, scope: Scope & { readonly kind: "early" }): Promise<ReviewDisposition> {
  const retired = await client.retire(pr, "Every version this PR was taken early for is now past the release-age wait. secure-it retires this draft: its next run plans that work again from the default branch, with fresh checks.");
  if (retired === "not-draft") return { kind: "leave", reason: "a person marked the held PR ready" };
  await settleAttempt(client, scope.number, scope.attempt.id, { outcome: "pr-closed" });
  return { kind: "graduated", reason: "every version it was taken early for aged" };
}

/** When the last of `young` ages: "unknown" when any date can't be read. */
function latest(young: ReadonlyArray<YoungVersion>): string {
  if (young.some((entry) => entry.eligibleAt === "unknown")) return "unknown";
  return young.map((entry) => entry.eligibleAt).sort().at(-1)!;
}

type GrantStanding = { readonly kind: "stands"; readonly grant: Grant } | { readonly kind: "gone"; readonly why: string; readonly key: string };

/** Whether `grantOf` still grants an early attempt's label for the versions still `young`. Reads only. */
async function grantFor(client: ReviewIssues, scope: Scope & { readonly kind: "early" }, young: ReadonlyArray<YoungVersion>): Promise<GrantStanding> {
  const { number, issue, record, attempt } = scope;
  const [events, comments] = await Promise.all([
    client.issues.listEvents({ repo: client.repo, number }),
    client.issues.listComments({ repo: client.repo, number }),
  ]);
  const actors = [...new Set(events.flatMap((event) => (event.actor === null ? [] : [event.actor])))];
  const permissions = new Map(await Promise.all(actors.map(async (actor) => [actor, await client.issues.permission({ repo: client.repo, login: actor })] as const)));
  const decision = grantOf({ state: issue.state, labels: issue.labels, record, status: { kind: "waiting", young }, events, comments, permissions });
  if (decision.kind === "granted" && decision.grant.labelEventId === attempt.grantEventId) return { kind: "stands", grant: decision.grant };
  const why = decision.kind === "refused" ? decision.reason : decision.kind === "none" ? "its `take-early` label was removed" : "a newer label isn't this attempt's";
  return { kind: "gone", why, key: decision.kind === "refused" ? decision.noticeId : `take-early:${attempt.grantEventId}:withdrawn` };
}

/** Whether this PR is a running early attempt on the tool's issue for its exact decision. */
export async function isEarlyPr(client: Pick<ReviewIssues, "issues" | "repo">, pr: GitHubPullRequest, plan: ChangePlan): Promise<boolean> {
  const number = trackedIssueOf(pr.body);
  return number !== undefined && (await scopeOf(client, pr, plan, number)).kind === "early";
}

/** Decisions taken early are never reduced by review, even when their issue can no longer confirm the attempt. */
export async function earlyDecisions(client: ReviewIssues, open: ReadonlyArray<GitHubPullRequest>): Promise<Set<string>> {
  const taken = new Set<string>();
  for (const pr of open) {
    const plan = planOf(pr.body);
    if (plan !== undefined && (takenEarlyOf(pr.body) || await isEarlyPr(client, pr, plan))) taken.add(subjectId({ kind: "decision", moves: decisionMoves(plan) }));
  }
  return taken;
}

/**
 * Whether review may execute `plan`, recomputed on a new base. A PR taken early, while any of its granted versions is
 * young, only as the exact decision its grant covered and with no young version beyond the grant's: otherwise it's left
 * to the owner, which the issue says once. Any other PR only while the recomputed plan takes no young version (`young`,
 * non-trusted): no grant covers one, so it waits, said on its issue, and a later review tries again. A tracked PR only as
 * the decision its issue tracks: another one waits for the next run, which updates it through that decision's issue.
 */
export async function reviewExecution(client: ReviewIssues, pr: GitHubPullRequest, previous: ChangePlan, plan: ChangePlan, young: ReadonlyArray<PackageVersion>): Promise<ReviewDisposition> {
  const number = trackedIssueOf(pr.body);
  const scope = number === undefined ? undefined : await scopeOf(client, pr, previous, number);
  const granted = scope?.kind === "early" ? await stillYoung(client, scope.grant) : [];
  if (scope !== undefined && scope.kind !== "early" && takenEarlyOf(pr.body)) return { kind: "leave", reason: `its early attempt can't be confirmed on #${scope.number}` };
  const same = subjectId({ kind: "decision", moves: decisionMoves(plan) }) === subjectId({ kind: "decision", moves: decisionMoves(previous) });
  if (scope?.kind !== "early" || granted.length === 0) {
    // `Tracks #N.` names the issue of the decision the PR makes: review never turns a tracked PR into another decision
    // (its link would then say something false). The next run moves it through the new decision's own issue.
    if (number !== undefined && !same) {
      await postNotice(client, number, `decision:${pr.number}:${pr.headSha}`,
        `secure-it didn't update #${pr.number} on review: on the new base it's a different decision than this issue tracks. Its next run updates it through that decision's issue.`);
      return { kind: "leave", reason: `on the new base it's a different decision than #${number} tracks` };
    }
    if (young.length === 0) return { kind: "proceed" };
    const named = young.map(label);
    const why = `on the new base it would take young versions no grant covers: ${named.join(", ")}`;
    if (number !== undefined) {
      await postNotice(client, number, `young:${pr.number}:${named.join(",")}`,
        `secure-it didn't update #${pr.number}: on the new base it would take young versions no grant covers: ${named.map((entry) => `\`${entry}\``).join(", ")}. It tries again on a later review.`);
    }
    return { kind: "leave", reason: why };
  }
  if (!same) return leave(client, scope.number, `changed:${pr.number}:${pr.headSha}`, pr, "on the new base it's a different decision than the one `take-early` authorized");
  // The same moves can still take more young versions (one a parent probe now brings in): only the grant's may run.
  const standing = await grantFor(client, scope, granted);
  if (standing.kind === "gone") return leave(client, scope.number, `left:${pr.number}:${standing.key}`, pr, standing.why);
  const covered = new Set(standing.grant.young.map(versionKey));
  const beyond = young.filter((entry) => !covered.has(versionKey(entry))).map(label);
  return beyond.length === 0
    ? { kind: "proceed" }
    : leave(client, scope.number, `beyond:${pr.number}:${beyond.join(",")}`, pr, `on the new base it takes young versions its \`take-early\` label didn't cover: ${beyond.join(", ")}`);
}

/** Ends the early attempt of a PR review closed: the attempt is over, its label returned. */
export async function reviewClosed(client: ReviewIssues, pr: GitHubPullRequest, plan: ChangePlan): Promise<void> {
  const number = trackedIssueOf(pr.body);
  if (number === undefined) return;
  const issue = await trackedIssue(client, number, plan);
  const attempt = issue?.record.attempts.find((entry) => entry.pr === pr.number && entry.outcome === undefined);
  if (attempt !== undefined) await settleAttempt(client, number, attempt.id, { outcome: "pr-closed" });
}

/** The tool's issue `number` with its record, when that record is `plan`'s decision. */
async function trackedIssue(client: Pick<ReviewIssues, "issues" | "repo">, number: number, plan: ChangePlan): Promise<{ issue: GitHubIssue; record: IssueRecord } | undefined> {
  // A deleted issue is no issue of this decision's; any other failure goes through, so nothing proceeds unread.
  const read = await client.issues.getIssue({ repo: client.repo, number }).catch((error: unknown) => {
    if (error instanceof GitHubApiError && error.status === 404) return undefined;
    throw error;
  });
  if (read === undefined) return undefined;
  const [issue, login] = [read, await client.issues.login()];
  const record = recordOf(issue.body);
  if (issue.author !== login || record === undefined) return undefined;
  return subjectId(record.subject) === subjectId({ kind: "decision", moves: decisionMoves(plan) }) ? { issue, record } : undefined;
}

async function leave(client: ReviewIssues, number: number, noticeId: string, pr: GitHubPullRequest, why: string): Promise<ReviewDisposition> {
  await postNotice(client, number, noticeId, `secure-it leaves #${pr.number} to you: ${why}. It won't update, adapt or mark it ready; close it, or merge it if you still want it.`);
  return { kind: "leave", reason: why };
}
