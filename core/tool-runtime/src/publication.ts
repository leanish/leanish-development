// Adapted from leanish/leanish-development agents/bump-it/src/publication.ts at c6282df: parametrised by the tool's
// own-PR rules; a repository can have several open PRs of a tool (one per topic); the workspace and logger are passed
// in instead of bump-it's runtime; Dependabot closing is left out; the PR body records the published state;
// adds the current label when publishing, recording state or marking a PR ready; published text keeps local paths out.
import { GitHubApiError, MAX_BODY_CHARS, MAX_TITLE_CHARS } from "@leanish/agent-runtime/github/github-client";
import type { GitHubClient, GitHubPullRequest } from "@leanish/agent-runtime/types/clients";
import type { Logger } from "@leanish/agent-runtime/types/logger";
import type { PreparedBranch, WorkingCopy } from "@leanish/agent-runtime/types/working-copy";
import type { Workspace } from "@leanish/agent-runtime/working-copy/workspace";

import { cleanBody, cleanContent, type LocalRoots, withCanonical } from "./publication-text.ts";
import { carriesLabel, isOwnPullRequest, type OwnPullRequests, type PullRequestState, verifiedStateOf, withMarker } from "./own-pr.ts";

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
  /** Signs the state in the tool's PRs (`RecordContext`); held only by the tool's process. */
  readonly signingKey: Uint8Array;
  /** The default branch every PR of the tool targets. */
  readonly base: string;
  readonly workingCopy: WorkingCopy;
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
 * drop informational evidence.
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
 * publication checks the exact text again with the real head.
 */
export function assertPublishable(context: PublicationContext, content: PullRequestContent, adaptations = 0): void {
  const cleaned = cleanContent(content, rootsOf(context));
  checkedText(cleaned.title, withMarker(context, cleaned.body, { ...PLACEHOLDER_STATE, adaptations }));
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
    beforePush: async (head) => { checkedText(content.title, withMarker(context, content.body, { head, base: prepared.baseSha, adaptations: 0 })); },
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
  const content = cleanContent(agentContent, rootsOf(context));
  const remoteHead = existingHead(context, prepared);
  const { pr: current, state: recorded } = await reReadRecorded(context, number, remoteHead);
  const attempts = adaptations ?? recorded.adaptations;
  const bodyAt = (head: string) => checkedText(content.title, withMarker(context, content.body, { head, base: prepared.baseSha, adaptations: attempts }));
  // Also before drafting a ready PR, or a no-push update (which has no beforePush callback).
  bodyAt(remoteHead);
  const verified = await expectedTree(context);
  const parent = await context.publicationParent?.(prepared) ?? prepared;
  if (!current.isDraft) await github.convertToDraft({ nodeId: current.nodeId });
  const pushed = await context.workspace.publishBranch(context.workingCopy, parent, {
    message: content.commitMessage,
    ...verified,
    // The exact text fits before anything is pushed: a push whose body can't be written is what this refuses.
    beforePush: async (sha) => { bodyAt(sha); },
  });
  const head = pushed.kind === "pushed" ? pushed.sha : remoteHead;
  const body = bodyAt(head);
  const update = async () => {
    // GitHub may still report the old head for a moment after a push; anything else is someone else's push.
    await reReadOwn(context, current.number, remoteHead, ...(pushed.kind === "pushed" ? [pushed.sha] : []));
    return github.updatePullRequest({ repo, number: current.number, title: content.title, body });
  };
  const updated = pushed.kind === "pushed" ? await updateAfterPush(context, current.number, head, update) : await update();
  await ensureLabel(context, updated);
  // Nothing new reached the branch: the PR stays as ready as it was.
  if (pushed.kind === "unchanged" && !current.isDraft) await markReady(context, current.number, remoteHead);
  return { pr: updated, pushed: pushed.kind === "pushed" };
}

/**
 * The body update that follows a push. Until it lands, the body names the previous commit, and the tool's next look
 * takes its own push for someone else's. Tried twice: the same text, so the second try also covers a response lost after
 * the first applied. Then the PR is retired, so a later run recomputes it, unless someone took it over. Always an error.
 */
async function updateAfterPush(context: PublicationContext, number: number, head: string, update: () => Promise<GitHubPullRequest>): Promise<GitHubPullRequest> {
  try {
    return await update();
  } catch (err) {
    context.logger.warn(`${context.rules.tool}: updating the PR's body after a push failed; trying once more`, { repo: context.repo, number, error: reasonOf(err) });
  }
  try {
    return await update();
  } catch (err) {
    throw new Error(`${context.rules.tool}: pushed ${head} to ${context.repo}#${number} but couldn't confirm its body update (${reasonOf(err)}); ${await retire(context, number, head)}`, { cause: err });
  }
}

/** Closes a PR whose body update couldn't be confirmed, while it's still the tool's draft at that head; says what happened. */
async function retire(context: PublicationContext, number: number, head: string): Promise<string> {
  const { github, repo, base, rules } = context;
  const left = "it's no longer the tool's open draft at that head, so the tool leaves it: if it's still open and nobody took it over, close it, and a later run recomputes it";
  // A removed state or a PR marked ready: someone took it over, and it's theirs to decide.
  // Of any head: the body still names the previous one when the update never applied.
  const stillDraftWithState = (pr: GitHubPullRequest) => pr.isDraft && verifiedStateOf(context, pr.body) !== undefined;
  try {
    const current = await github.getPullRequest({ repo, number });
    if (!isOwnPullRequest(rules, current, repo, base) || current.headSha !== head || !stillDraftWithState(current)) return left;
    const comment = `${rules.tool} couldn't confirm updating this PR's description after pushing to it, so the description may not match its head. Closing it: a later run recomputes the change from the default branch.`;
    return await closeIf(context, number, head, comment, stillDraftWithState) ? "closed the PR, and a later run recomputes it" : left;
  } catch (err) {
    return `and couldn't finish closing it (${reasonOf(err)}): the commit is published but the body may not say so. If it's still open and nobody took it over, close it by hand, and a later run recomputes it`;
  }
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Rewrite the state in the PR's body (its text kept), once it's still the
 * tool's at `expectedHead`: to count an adaptation before the agent starts.
 */
export async function recordState(context: PublicationContext, number: number, expectedHead: string, state: PullRequestState): Promise<GitHubPullRequest> {
  const { pr: current } = await reReadRecorded(context, number, expectedHead);
  const updated = await context.github.updatePullRequest({ repo: context.repo, number, title: current.title, body: checkedText(current.title, withMarker(context, current.body, state)) });
  await ensureLabel(context, updated);
  return updated;
}

/**
 * Rewrite the PR's text (its state kept), once it's still the tool's at `expectedHead`: for what a recomputed plan
 * says without changing what it does (its notes), so an open PR never shows an outdated reason.
 */
export async function rewriteText(context: PublicationContext, number: number, expectedHead: string, rewrite: (body: string) => string): Promise<GitHubPullRequest> {
  const { pr: current, state } = await reReadRecorded(context, number, expectedHead);
  // From the body as it is now, so an edit made since the caller read it (an owner's note, say) is kept.
  const updated = await context.github.updatePullRequest({ repo: context.repo, number, title: current.title, body: checkedText(current.title, withMarker(context, cleanBody(rewrite(current.body), rootsOf(context)), state)) });
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
  // A person who marked it ready took the decision over; it stays open.
  const closed = await closeIf(context, number, expectedHead, comment, (current) => options.onlyDraft !== true || current.isDraft);
  return closed ? "closed" : "not-draft";
}

/** `closeAndDelete`, once `eligible` holds for the PR as re-read right before closing; whether it closed it. */
async function closeIf(context: PublicationContext, number: number, expectedHead: string, comment: string, eligible: (current: GitHubPullRequest) => boolean): Promise<boolean> {
  const { github, repo, logger, rules } = context;
  const current = await reReadOwn(context, number, expectedHead);
  if (!eligible(current)) return false;
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
  return true;
}

async function createDraftPullRequest(
  context: PublicationContext,
  branch: string,
  content: PullRequestContent,
  state: PullRequestState,
): Promise<GitHubPullRequest> {
  const { github, repo, base, rules } = context;
  const request = { repo, head: branch, base, title: content.title, body: checkedText(content.title, withMarker(context, content.body, state)), draft: true };
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
  if (carriesLabel(context.rules, pr)) return;
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

/** `reReadOwn`, and the state the tool signed for that head: what gets carried forward and signed again is the tool's own. */
async function reReadRecorded(context: PublicationContext, number: number, expectedHead: string): Promise<{ readonly pr: GitHubPullRequest; readonly state: PullRequestState }> {
  const pr = await reReadOwn(context, number, expectedHead);
  const state = verifiedStateOf(context, pr.body);
  if (state?.head !== expectedHead) throw new Error(`${context.rules.tool}: ${context.repo}#${number}'s body has no state the tool signed for ${expectedHead}; not publishing over it`);
  return { pr, state };
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
