// Adapted from leanish/leanish-development agents/bump-it/src/own-pr.ts at c6282df: one set of rules per tool
// (secure-it, bump-it) instead of bump-it's constants, and the PR's state (what the tool last published) in its body;
// labels and body markers are named leanish:<tool>.
import type { GitHubPullRequest } from "@leanish/agent-runtime/types/clients";

export type ToolName = "secure-it" | "bump-it";

/** How a tool recognises its own PRs: branch, label and body marker. */
export interface OwnPullRequests {
  readonly tool: ToolName;
  /** `leanish:<tool>`; it says which rule applies, CI still checks the proof for skipping the wait. */
  readonly label: string;
  /** The footer every PR body of the tool ends with. */
  readonly marker: string;
}

const MARKER = (tool: ToolName) => `<!-- leanish:${tool} -->`;
const STATE = /<!-- leanish:state head=([0-9a-f]{40}) base=([0-9a-f]{40}) adaptations=(\d+) -->/;

/**
 * What the tool last published on a PR, kept in its body: the head it pushed,
 * the base it was computed against, and how many times the agent adapted it
 * after a failed CI. A head that differs means someone else pushed; a base
 * that differs means the plan has to be recomputed.
 */
export interface PullRequestState {
  readonly head: string;
  readonly base: string;
  readonly adaptations: number;
}

export function ownPullRequests(tool: ToolName): OwnPullRequests {
  return { tool, label: `leanish:${tool}`, marker: MARKER(tool) };
}

/** The branch a run opens a PR from: `<tool>/<UTC date>-<topic>`, the topic made branch-safe. */
export function branchFor(rules: OwnPullRequests, now: Date, topic: string): string {
  const slug = trimSeparators(topic.toLowerCase().replace(/[^a-z0-9._-]+/g, "-")).slice(0, 60);
  if (slug === "") throw new Error(`a ${rules.tool} branch needs a topic with letters or digits; got '${topic}'`);
  return `${rules.tool}/${now.toISOString().slice(0, 10)}-${slug}`;
}

/**
 * `text` without leading or trailing `-` and `.`, in linear time: a trailing-anchored regex (`[-.]+$`) retries from
 * every dash of a long run that doesn't end the text, which is quadratic on a topic a repository controls.
 */
function trimSeparators(text: string): string {
  const separator = (char: string | undefined) => char === "-" || char === ".";
  let start = 0;
  let end = text.length;
  while (start < end && separator(text[start])) start += 1;
  while (end > start && separator(text[end - 1])) end -= 1;
  return text.slice(start, end);
}

/**
 * The first of `branchFor(topic)`, `…-2`, `…-3`, … that isn't `taken`. The suffix goes after the topic is cut to its
 * length: appended before, a long topic would give the same name forever.
 */
export function freeBranch(rules: OwnPullRequests, now: Date, topic: string, taken: ReadonlySet<string>): string {
  const first = branchFor(rules, now, topic);
  const slug = topicOf(rules, first)!;
  let branch = first;
  for (let n = 2; taken.has(branch); n++) {
    const suffix = `-${n}`;
    branch = branchFor(rules, now, `${slug.slice(0, 60 - suffix.length)}${suffix}`);
  }
  return branch;
}

/** The topic of one of the tool's branches (`secure-it/2026-10-07-vite` → `vite`), whatever its date; undefined for another branch. */
export function topicOf(rules: OwnPullRequests, branch: string): string | undefined {
  return new RegExp(`^${rules.tool}/\\d{4}-\\d{2}-\\d{2}-([a-z0-9._-]+)$`).exec(branch)?.[1];
}

function isOwnBranch(rules: OwnPullRequests, branch: string): boolean {
  return new RegExp(`^${rules.tool}/\\d{4}-\\d{2}-\\d{2}-[a-z0-9._-]+$`).test(branch);
}

/**
 * A PR the tool may update, mark ready or close: an open PR from one of its
 * dated branches of `repo` itself (not a fork) into `base`, carrying the
 * marker or the label, so a PR whose labelling failed is still recognised.
 */
export function isOwnPullRequest(rules: OwnPullRequests, pr: GitHubPullRequest, repo: string, base: string): boolean {
  return (
    pr.state === "open" &&
    isOwnBranch(rules, pr.headRef) &&
    pr.headRepo?.toLowerCase() === repo.toLowerCase() &&
    pr.baseRef === base &&
    (pr.body.includes(rules.marker) || pr.labels.includes(rules.label))
  );
}

/** `body` ending with the PR's state and the marker, replacing earlier ones. */
export function withMarker(rules: OwnPullRequests, body: string, state: PullRequestState): string {
  if (!/^[0-9a-f]{40}$/.test(state.head) || !/^[0-9a-f]{40}$/.test(state.base) || !Number.isInteger(state.adaptations) || state.adaptations < 0) {
    throw new Error(`invalid PR state ${JSON.stringify(state)}`);
  }
  // Each removed marker leaves a line break: removed outright, the text around one could join into a plan block
  // (`<!-- leanish:` + marker + `plan …`), and no block spans a line break.
  const bare = body.replaceAll(rules.marker, "\n").replace(new RegExp(STATE.source, "g"), "\n").trimEnd();
  return `${bare}\n\n<!-- leanish:state head=${state.head} base=${state.base} adaptations=${state.adaptations} -->\n${rules.marker}\n`;
}

/**
 * Room for what withMarker appends to a body (its state line and marker), for whatever fills a body up to GitHub's
 * limit: 158 characters for secure-it with fewer than 10 adaptations, so it fits with room to spare.
 */
export const MARKER_ROOM = 256;

/** The state the tool recorded in a PR body; undefined when there's none (a body someone rewrote). */
export function stateOf(body: string): PullRequestState | undefined {
  const found = STATE.exec(body);
  return found === null ? undefined : { head: found[1]!, base: found[2]!, adaptations: Number(found[3]) };
}
