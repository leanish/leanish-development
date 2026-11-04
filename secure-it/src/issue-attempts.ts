/**
 * An early attempt's life on its issue after `issueDisposition` recorded it: its PR attached once published, its end
 * written when it can't go on, and, at the start of every run, attempts a crash left behind recovered from PR history.
 *
 * Every write re-reads the issue and changes only that attempt, so a run never writes back a record it read earlier.
 * The issue's text is rendered again from the run's assessment, so what it says about the attempt follows its record.
 * An attempt whose PR was closed without merging gives its label back: the label event it consumed is removed, so the
 * issue no longer shows an authorization nothing can use.
 */
import type { GitHubClient, GitHubPullRequest } from "@leanish/agent-runtime/types/clients";
import type { GitHubIssues } from "@leanish/tool-runtime/github-issues";
import { TooLargeError } from "@leanish/tool-runtime/plan-blocks";

import { type Assessment, type Attempt, type IssueRecord, subjectId } from "./issue-model.ts";
import type { TrackedIssue } from "./issue-reconcile.ts";
import { issueWriter, recordOf, TAKE_EARLY_LABEL } from "./issue-text.ts";

export interface AttemptClient {
  readonly issues: GitHubIssues;
  readonly github: GitHubClient;
  readonly repo: string;
  /** Local paths out of a text bound for GitHub (`cleanBody`). */
  readonly clean: (body: string) => string;
  /** Whether a PR is one the tool opened: its own branch, label or marker, from this repository. */
  readonly ours: (pr: GitHubPullRequest) => boolean;
}

export type AttemptPatch = Pick<Attempt, "pr" | "outcome">;

/**
 * Writes `patch` into attempt `id` of issue `number`, read fresh; an attempt that ended already stays as it ended.
 * `assessment` is the run's: the issue's text is rendered again from it (`bodyWith`). A review assesses nothing, so it
 * passes none: only the record changes, and the next run's sync renders the text from it.
 */
export async function settleAttempt(client: AttemptClient, number: number, id: string, patch: AttemptPatch, assessment: Assessment | undefined): Promise<void> {
  const issue = await client.issues.getIssue({ repo: client.repo, number });
  const record = recordOf(issue.body);
  if (record === undefined) throw new Error(`#${number}'s record can't be read; attempt ${id} isn't recorded as ${describe(patch)}`);
  const attempt = record.attempts.find((entry) => entry.id === id);
  if (attempt === undefined || attempt.outcome !== undefined) return;
  const settled: Attempt = { ...attempt, ...patch };
  const updated: IssueRecord = { ...record, attempts: record.attempts.map((entry) => (entry.id === id ? settled : entry)) };
  // Only an open issue the run's sync rendered: a closed one (dismissed, superseded, resolved) or one waiting to close
  // keeps the text it was left with.
  const current = issue.state === "open" && updated.pendingClose === undefined;
  await client.issues.updateIssue({ repo: client.repo, number, body: bodyWith(client, issue.body, updated, current ? assessment : undefined) });
  if (settled.outcome !== "pr-closed") return;
  try {
    await returnLabel(client, number, settled.grantEventId);
  } catch {
    // Pending cleanup: the attempt's end is recorded, and every run's recovery returns the label again.
  }
}

/**
 * Ends attempt `id` after its unit failed, unless it published: a PR on its branch (the tool's), found now even when
 * recording it failed before, is attached and the attempt goes on with it; only with none is it `failed`.
 */
export async function endAttempt(client: AttemptClient, number: number, id: string, assessment: Assessment): Promise<void> {
  const record = recordOf((await client.issues.getIssue({ repo: client.repo, number })).body);
  const attempt = record?.attempts.find((entry) => entry.id === id);
  if (attempt === undefined || attempt.outcome !== undefined || attempt.pr !== undefined) return;
  const pr = (await client.github.findPullRequests({ repo: client.repo, branch: attempt.branch })).find(client.ours);
  await settleAttempt(client, number, id, pr === undefined ? { outcome: "failed" } : { pr: pr.number, ...ended(pr) }, assessment);
}

/**
 * Attempts a previous run left running, settled from what GitHub shows: a PR from the attempt's branch (open, closed or
 * merged, kept after its branch is deleted) is attached, and ends the attempt when it's closed; an attempt that never
 * got one was interrupted, and only a new label authorizes another. A closed attempt's label whose removal failed is
 * removed again. Called before any disposition of this run.
 */
export async function recoverAttempts(client: AttemptClient, tracked: ReadonlyArray<TrackedIssue & { readonly labels: ReadonlyArray<string> }>, assessment: Assessment): Promise<string[]> {
  const notes: string[] = [];
  // Closed issues too: one superseded or resolved in this run's sync may still record an attempt to settle, or a label to
  // return. Bookkeeping only: nothing executes for a closed issue.
  for (const issue of tracked) {
    for (const attempt of issue.record.attempts) {
      // A closed attempt's label whose removal failed: returned now, still only while it's the event that attempt used.
      if (attempt.outcome === "pr-closed" && issue.labels.includes(TAKE_EARLY_LABEL) && issue.record.grant?.labelEventId === attempt.grantEventId) {
        try {
          await returnLabel(client, issue.number, attempt.grantEventId);
        } catch (error) {
          notes.push(`#${issue.number}: its \`take-early\` label couldn't be removed yet (${error instanceof Error ? error.message : String(error)}); the next run tries again`);
        }
        continue;
      }
      if (attempt.outcome !== undefined) continue;
      const pr = attempt.pr === undefined
        ? (await client.github.findPullRequests({ repo: client.repo, branch: attempt.branch })).find(client.ours)
        : await client.github.getPullRequest({ repo: client.repo, number: attempt.pr });
      const patch: AttemptPatch = pr === undefined ? { outcome: "interrupted" } : { pr: pr.number, ...ended(pr) };
      if (attempt.pr === pr?.number && patch.outcome === undefined) continue;
      await settleAttempt(client, issue.number, attempt.id, patch, assessment);
      notes.push(`#${issue.number}: attempt ${attempt.id} ${describe(patch)}`);
    }
  }
  return notes;
}

/**
 * `body` with `record`, its text rendered again from `assessment` while that still assesses the issue's subject: the
 * headline and the attempts it lists then say what the record now does. Otherwise (no assessment: a review, or an
 * issue that isn't open as its subject's; a subject the run no longer assesses; a text that no longer fits) only the
 * record changes, so an attempt's end is never lost to its text.
 */
function bodyWith(client: AttemptClient, body: string, record: IssueRecord, assessment: Assessment | undefined): string {
  const writer = issueWriter(client.clean);
  if (assessment === undefined) return writer.withRecord(body, record);
  const subject = assessment.subjects.find((entry) => subjectId(entry.subject) === subjectId(record.subject));
  if (subject === undefined) return writer.withRecord(body, record);
  try {
    return writer.render(subject, record, assessment.sha).body;
  } catch (error) {
    if (error instanceof TooLargeError) return writer.withRecord(body, record);
    throw error;
  }
}

/** How a PR ended an attempt, if it did. */
function ended(pr: GitHubPullRequest): Pick<Attempt, "outcome"> {
  if (pr.merged) return { outcome: "pr-merged" };
  return pr.state === "closed" ? { outcome: "pr-closed" } : {};
}

/** Removes the label when its current event is still the one the attempt consumed; a newer label is a new grant. */
async function returnLabel(client: AttemptClient, number: number, grantEventId: number): Promise<void> {
  const events = await client.issues.listEvents({ repo: client.repo, number });
  const current = events.filter((event) => event.label === TAKE_EARLY_LABEL && (event.event === "labeled" || event.event === "unlabeled")).at(-1);
  if (current?.event === "labeled" && current.id === grantEventId) await client.issues.removeLabel({ repo: client.repo, number, label: TAKE_EARLY_LABEL });
}

function describe(patch: AttemptPatch): string {
  return [patch.pr === undefined ? undefined : `has PR #${patch.pr}`, patch.outcome === undefined ? undefined : `ended (${patch.outcome})`].filter(Boolean).join(" and ");
}
