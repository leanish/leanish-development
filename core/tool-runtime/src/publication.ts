// Adapted from leanish/leanish-development agents/bump-it/src/publication.ts at c6282df: parametrised by the tool's
// own-PR rules; a repository can have several open PRs of a tool (one per topic); the workspace and logger are passed
// in instead of bump-it's runtime; Dependabot closing is left out; the PR body records the published state;
// the pre-push journal stores the matching title, body, plan and adaptation count for recovery;
// adds the current label when publishing, restoring a body, recording state or marking a PR ready; published text keeps
// local paths out.
import { GitHubApiError, MAX_BODY_CHARS, MAX_TITLE_CHARS } from "@leanish/agent-runtime/github/github-client";
import type { GitHubClient, GitHubPullRequest } from "@leanish/agent-runtime/types/clients";
import type { Logger } from "@leanish/agent-runtime/types/logger";
import type { PreparedBranch, WorkingCopy } from "@leanish/agent-runtime/types/working-copy";
import type { Workspace } from "@leanish/agent-runtime/working-copy/workspace";

import type { PublicationJournal } from "./journal.ts";
import { cleanBody, cleanContent, type LocalRoots, withCanonical } from "./publication-text.ts";
import { isOwnPullRequest, type OwnPullRequests, type PullRequestState, stateOf, withMarker } from "./own-pr.ts";

/**
 * Everything a tool writes to GitHub, done by the tool's own process with its
 * write token from what the agent prepared — the agent itself only edits the
 * working tree and reads GitHub with a read-only token. Every write that acts
 * on an existing PR re-reads it immediately before and stops unless it's still
 * the tool's, open, and at the head the run was prepared from. GitHub can't
 * condition closing a PR or marking it ready on its head, so a push landing
 * between that re-read and the write still gets through; deleting a branch is
 * conditioned on its head (`Workspace.deleteRemoteBranch`).
 */
export interface PublicationContext {
  readonly rules: OwnPullRequests;
  readonly github: GitHubClient;
  readonly workspace: Workspace;
  readonly logger: Logger;
  readonly repo: string;
  /** The default branch every PR of the tool targets. */
  readonly base: string;
  readonly workingCopy: WorkingCopy;
  /** Where each push is recorded before the PR's body says so (see journal.ts). */
  readonly journal: PublicationJournal;
  /** Directories outside the working copy whose paths never reach a PR (see publication-text.ts). */
  readonly localRoots: ReadonlyArray<string>;
  /**
   * The tree the last verification read (`snapshotCandidate` in git-copies.ts): publication commits nothing else. Absent,
   * nothing is enforced; present but without a snapshot, nothing was verified, so nothing is published.
   */
  readonly verifiedTree?: () => Promise<string | undefined>;
  /** Restore a base redo's PR parent, leaving the verified files for the workspace's normal checked publication. */
  readonly publicationParent?: (prepared: PreparedBranch) => Promise<PreparedBranch>;
}

/** What `publishBranch` must find staged: the verified tree. */
async function expectedTree(context: PublicationContext): Promise<{ readonly expectedTree?: string }> {
  if (context.verifiedTree === undefined) return {};
  const tree = await context.verifiedTree();
  if (tree === undefined) throw new Error(`${context.rules.tool}: nothing was verified, so nothing is published`);
  return { expectedTree: tree };
}

/** Published text keeps the machine out: see publication-text.ts. */
function rootsOf(context: PublicationContext): LocalRoots {
  return { workingCopy: withCanonical([context.workingCopy.path]), other: context.localRoots };
}

/**
 * Apply the client's title/body checks to the actual cleaned, marked output before any push/API write. Raw composition
 * budgets leave ordinary publications room; extreme path expansion can still exceed them. Refuse here rather than
 * letting the client reject the text after a push. This final guard only refuses: it does not recompose the plan or
 * drop informational evidence. Also for a publication the journal saved (`ownership.ts`).
 */
export function checkedText(title: string, body: string): string {
  if (title.trim() === "") throw new Error("the PR title is empty");
  if (title.length > MAX_TITLE_CHARS) throw new Error(`the PR title would be ${title.length} UTF-16 units, over the client's ${MAX_TITLE_CHARS} limit`);
  if (body.length > MAX_BODY_CHARS) throw new Error(`the PR body would be ${body.length} UTF-16 units, over the client's ${MAX_BODY_CHARS} limit`);
  return body;
}

/** A state line as long as any real one: placeholder SHAs, since publication only knows the head once it commits. */
const PLACEHOLDER_STATE: PullRequestState = { head: "0".repeat(40), base: "0".repeat(40), adaptations: 0 };

/**
 * Throws unless `content` passes the checks publication applies to what it sends: the title and the body as cleaned
 * and marked. For a caller to refuse before the work a refusal would waste (a push, a rebase's publication);
 * publication checks the exact text again with the real head, and the journal records that text.
 */
export function assertPublishable(context: PublicationContext, content: PullRequestContent, adaptations = 0): void {
  const cleaned = cleanContent(content, rootsOf(context));
  checkedText(cleaned.title, withMarker(context.rules, cleaned.body, { ...PLACEHOLDER_STATE, adaptations }));
}

/** A PR's title, description and the commit message of the agent's change. */
export interface PullRequestContent {
  readonly title: string;
  readonly body: string;
  readonly commitMessage: string;
}

/** The tool's open PRs in the repository, oldest first. */
export async function ownOpenPullRequests(
  github: GitHubClient,
  rules: OwnPullRequests,
  repo: string,
  base: string,
): Promise<GitHubPullRequest[]> {
  return (await github.listOpenPullRequests({ repo })).filter((pr) => isOwnPullRequest(rules, pr, repo, base)).sort((a, b) => a.number - b.number);
}

/**
 * Make room for a new branch: a remote branch of that name with no open PR is
 * a leftover and goes (its commits must not ride along); one with an open PR
 * stops the run.
 */
export async function clearLeftoverBranch(github: GitHubClient, rules: OwnPullRequests, repo: string, branch: string): Promise<void> {
  const open = (await github.findPullRequests({ repo, branch })).filter((pr) => pr.state === "open");
  if (open.length > 0) {
    throw new Error(`${rules.tool}: ${repo} branch ${branch} already has an open PR (#${open[0]!.number})`);
  }
  try {
    await github.deleteBranch({ repo, branch });
  } catch (err) {
    // 422: no such ref — nothing left over.
    if (!(err instanceof GitHubApiError) || err.status !== 422) throw err;
  }
}

/** Commit and push the agent's edits on a new branch and open a draft PR; `undefined` when there was nothing to publish. */
export async function publishNew(
  context: PublicationContext,
  prepared: PreparedBranch,
  agentContent: PullRequestContent,
): Promise<GitHubPullRequest | undefined> {
  const content = cleanContent(agentContent, rootsOf(context));
  if (prepared.remoteHeadSha !== null) throw new Error(`${context.rules.tool}: ${prepared.branch} exists already; update its PR instead`);
  const verified = await expectedTree(context);
  const parent = await context.publicationParent?.(prepared) ?? prepared;
  const pushed = await context.workspace.publishBranch(context.workingCopy, parent, {
    message: content.commitMessage, ...verified,
    beforePush: async (head) => { checkedText(content.title, withMarker(context.rules, content.body, { head, base: prepared.baseSha, adaptations: 0 })); },
  });
  if (pushed.kind === "unchanged") return undefined;
  const created = await createDraftPullRequest(context, prepared.branch, content, { head: pushed.sha, base: prepared.baseSha, adaptations: 0 });
  await ensureLabel(context, created);
  return created;
}

/**
 * Commit and push onto an existing PR's branch (drafted again first when it
 * was ready), then rewrite its title and description with the new state:
 * the head now on the branch, the base `prepared` was computed against, and
 * `adaptations` (by default the PR's own count). Returns the PR as updated.
 */
export async function publishUpdate(
  context: PublicationContext,
  prepared: PreparedBranch,
  number: number,
  agentContent: PullRequestContent,
  adaptations?: number,
): Promise<{ readonly pr: GitHubPullRequest; readonly pushed: boolean }> {
  const { github, repo } = context;
  // Cleaned before the journal records it, so a recovery restores the same text.
  const content = cleanContent(agentContent, rootsOf(context));
  const remoteHead = existingHead(context, prepared);
  const current = await reReadOwn(context, number, remoteHead);
  const attempts = adaptations ?? stateOf(current.body)?.adaptations ?? 0;
  const bodyAt = (head: string) => checkedText(content.title, withMarker(context.rules, content.body, { head, base: prepared.baseSha, adaptations: attempts }));
  // Also before drafting a ready PR, or a no-push update (which has no beforePush callback).
  bodyAt(remoteHead);
  const verified = await expectedTree(context);
  const parent = await context.publicationParent?.(prepared) ?? prepared;
  if (!current.isDraft) await github.convertToDraft({ nodeId: current.nodeId });
  const pushed = await context.workspace.publishBranch(context.workingCopy, parent, {
    message: content.commitMessage,
    ...verified,
    // Recorded before the push: whatever fails after it lands, the next tick still knows this exact head as the tool's.
    beforePush: (sha) => context.journal.pushed(repo, current.number, {
      head: sha,
      base: prepared.baseSha,
      publication: { title: content.title, body: bodyAt(sha), adaptations: attempts },
    }),
  });
  // GitHub may still report the old head for a moment after a push; anything else is someone else's push.
  await reReadOwn(context, current.number, remoteHead, ...(pushed.kind === "pushed" ? [pushed.sha] : []));
  const head = pushed.kind === "pushed" ? pushed.sha : remoteHead;
  const body = bodyAt(head);
  const updated = await github.updatePullRequest({ repo, number: current.number, title: content.title, body });
  await ensureLabel(context, updated);
  // Nothing new reached the branch: the PR stays as ready as it was.
  if (pushed.kind === "unchanged" && !current.isDraft) await markReady(context, current.number, remoteHead);
  return { pr: updated, pushed: pushed.kind === "pushed" };
}

/**
 * Rewrite the state in the PR's body (its text kept), once it's still the
 * tool's at `expectedHead`: to count an adaptation before the agent starts, or
 * to repair the head a failed update left behind.
 */
export async function recordState(context: PublicationContext, number: number, expectedHead: string, state: PullRequestState): Promise<GitHubPullRequest> {
  const current = await reReadOwn(context, number, expectedHead);
  const updated = await context.github.updatePullRequest({ repo: context.repo, number, title: current.title, body: checkedText(current.title, withMarker(context.rules, current.body, state)) });
  await ensureLabel(context, updated);
  return updated;
}

/**
 * Rewrite the PR's text (its state kept), once it's still the tool's at `expectedHead`: for what a recomputed plan
 * says without changing what it does (its notes), so an open PR never shows an outdated reason.
 */
export async function rewriteText(context: PublicationContext, number: number, expectedHead: string, rewrite: (body: string) => string): Promise<GitHubPullRequest> {
  const current = await reReadOwn(context, number, expectedHead);
  const state = stateOf(current.body);
  if (state === undefined) throw new Error(`${current.url}: no recorded state to keep while rewriting its text`);
  // From the body as it is now, so an edit made since the caller read it (an owner's note, say) is kept.
  const updated = await context.github.updatePullRequest({ repo: context.repo, number, title: current.title, body: checkedText(current.title, withMarker(context.rules, cleanBody(rewrite(current.body), rootsOf(context)), state)) });
  await ensureLabel(context, updated);
  return updated;
}

/** Mark the PR ready, once it's still the tool's draft at `expectedHead`. */
export async function markReady(context: PublicationContext, number: number, expectedHead: string): Promise<void> {
  const current = await reReadOwn(context, number, expectedHead);
  if (current.isDraft) await context.github.markReadyForReview({ nodeId: current.nodeId });
  await ensureLabel(context, current);
}

/**
 * Close the PR — once it's still the tool's at `expectedHead` — explain why,
 * and delete its branch unless someone pushed to it since (then it stays, for
 * a human to look at).
 */
export async function closeAndDelete(
  context: PublicationContext,
  number: number,
  expectedHead: string,
  comment: string,
  options: { readonly onlyDraft?: boolean } = {},
): Promise<"closed" | "not-draft"> {
  const { github, repo, logger, rules } = context;
  const current = await reReadOwn(context, number, expectedHead);
  // A person who marked it ready took the decision over; it stays open.
  if (options.onlyDraft === true && !current.isDraft) return "not-draft";
  await github.closePullRequest({ repo, number });
  try {
    await github.createComment({ repo, number, body: comment });
  } catch (err) {
    if (!(err instanceof GitHubApiError)) throw err;
    logger.warn(`${rules.tool}: explaining the close failed; the PR is closed`, { repo, number, error: err.message, comment });
  }
  const deleted = await context.workspace.deleteRemoteBranch(context.workingCopy, { branch: current.headRef, expectedSha: expectedHead });
  if (deleted.kind === "moved") {
    logger.warn(`${rules.tool}: kept the closed PR's branch — it moved after the check`, { repo, number, branch: current.headRef, found: deleted.found });
  }
  return "closed";
}

async function createDraftPullRequest(
  context: PublicationContext,
  branch: string,
  content: PullRequestContent,
  state: PullRequestState,
): Promise<GitHubPullRequest> {
  const { github, repo, base, rules } = context;
  const request = { repo, head: branch, base, title: content.title, body: checkedText(content.title, withMarker(rules, content.body, state)), draft: true };
  try {
    return await github.createPullRequest(request);
  } catch (err) {
    if (!(err instanceof GitHubApiError)) throw err;
    // The PR may exist even though the response was lost; otherwise try once more.
    const open = (await github.findPullRequests({ repo, branch })).find((pr) => isOwnPullRequest(rules, pr, repo, base));
    return open ?? (await github.createPullRequest(request));
  }
}

/** A missing label is logged, not fatal: the marker still identifies the PR. */
export async function ensureLabel(context: PublicationContext, pr: GitHubPullRequest): Promise<void> {
  if (pr.labels.includes(context.rules.label)) return;
  try {
    await context.github.addLabels({ repo: context.repo, number: pr.number, labels: [context.rules.label] });
  } catch (err) {
    if (!(err instanceof GitHubApiError)) throw err;
    context.logger.warn(`${context.rules.tool}: labelling the PR failed`, { repo: context.repo, number: pr.number, error: err.message });
  }
}

/** The remote head of a branch that has a PR (so it exists). */
function existingHead(context: PublicationContext, prepared: PreparedBranch): string {
  if (prepared.remoteHeadSha === null) throw new Error(`${context.rules.tool}: ${prepared.branch} has a PR but was prepared as a new branch`);
  return prepared.remoteHeadSha;
}

/** The PR again, refused unless it is still an open PR of the tool at one of `expectedHeads`. */
export async function reReadOwn(context: PublicationContext, number: number, ...expectedHeads: ReadonlyArray<string | null>): Promise<GitHubPullRequest> {
  const { github, repo, base, rules } = context;
  const current = await github.getPullRequest({ repo, number });
  if (!isOwnPullRequest(rules, current, repo, base)) throw new Error(`${rules.tool}: ${repo}#${number} is no longer an open ${rules.tool} PR`);
  if (!expectedHeads.includes(current.headSha)) {
    throw new Error(
      `${rules.tool}: ${repo}#${number} moved to ${current.headSha} (expected ${expectedHeads.map((head) => head ?? "none").join(" or ")}); not publishing over it`,
    );
  }
  return current;
}
