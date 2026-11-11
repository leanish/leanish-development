// Adapted from leanish/leanish-development agents/bump-it/src/own-pr.ts at c6282df: one set of rules per tool
// (secure-it, bump-it) instead of bump-it's constants, and the PR's state (what the tool last published) in its body;
// labels and body markers are named leanish:<tool>.
import type { GitHubPullRequest } from "@leanish/agent-runtime/types/clients";

import { planPayload } from "./plan-blocks.ts";
import { canonicalJson, type RecordTrust, recordSignature, signatureMatches } from "./record-signature.ts";

export type ToolName = "secure-it" | "bump-it";

/** How a tool recognises its own PRs: branch, label and body marker. */
export interface OwnPullRequests {
  readonly tool: ToolName;
  /** `leanish:<tool>`; it says which rule applies, CI still checks the proof for skipping the wait. */
  readonly label: string;
  /** The footer every PR body of the tool ends with. */
  readonly marker: string;
  /**
   * The lines of a body the tool acts on besides its plan (global and multiline), signed with the state: secure-it's
   * `Tracks #N.` line, as its reader (`trackedIssueOf`) matches it. Undefined: none.
   */
  readonly machineLines: RegExp | undefined;
}

const MARKER = (tool: ToolName) => `<!-- leanish:${tool} -->`;
/** The state line; its signature is absent in `trusted-editors` and ignored there when present. */
const STATE = /<!-- leanish:state head=([0-9a-f]{40}) base=([0-9a-f]{40}) adaptations=(\d+)(?: sig=([A-Za-z0-9_-]{43}))? -->/;
const MACHINE_LINES: Readonly<Record<ToolName, RegExp | undefined>> = {
  "secure-it": /^Tracks #(\d+)(, taken early)?\.$/gm,
  "bump-it": undefined,
};
/** What the signed payload's layout is; a change to it makes every earlier signature fail, as it should. */
const STATE_FORMAT = 2;

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
  return { tool, label: `leanish:${tool}`, marker: MARKER(tool), machineLines: MACHINE_LINES[tool] };
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
 * Whether `pr` comes from the tool, whatever its state: authored by the login the tool's write token acts as (in any
 * casing; a deleted author is nobody's), from one of the tool's dated branches of `repo` itself (not a fork), carrying
 * the marker or the label, so a PR whose labelling failed is still recognised. For bookkeeping that must also recognise
 * the tool's closed and merged PRs; nothing it says makes a PR safe to act on.
 */
export function comesFromTool(rules: OwnPullRequests, pr: GitHubPullRequest, repo: string, login: string): boolean {
  return (
    pr.author !== null &&
    pr.author.toLowerCase() === login.toLowerCase() &&
    isOwnBranch(rules, pr.headRef) &&
    pr.headRepo?.toLowerCase() === repo.toLowerCase() &&
    (pr.body.includes(rules.marker) || carriesLabel(rules, pr))
  );
}

/**
 * A candidate for the tool's own PR: one of its open PRs (`comesFromTool`) into `base`. Being a candidate doesn't make
 * it safe to adopt: that takes a state the tool recorded for its head (`verifiedStateOf`).
 */
export function isOwnPullRequest(rules: OwnPullRequests, pr: GitHubPullRequest, repo: string, base: string, login: string): boolean {
  return pr.state === "open" && pr.baseRef === base && comesFromTool(rules, pr, repo, login);
}

/** Whether `pr` has the tool's label, in any casing: GitHub treats label names that differ only by case as one label. */
export function carriesLabel(rules: OwnPullRequests, pr: GitHubPullRequest): boolean {
  return pr.labels.some((label) => label.toLowerCase() === rules.label.toLowerCase());
}

/** What writes a PR's state and checks it, for this tool and repository: how records are trusted, and the tool's login. */
export interface RecordContext {
  readonly rules: OwnPullRequests;
  readonly repo: string;
  /** The default branch every PR of the tool targets. */
  readonly base: string;
  /** The login the tool's write token acts as: the author of every PR of the tool's. */
  readonly login: string;
  readonly trust: RecordTrust;
}

/**
 * What the tool acts on in a body besides its state: the first plan block's payload, as the tools' plan readers parse
 * it (`planPayload`), and the tool's machine lines.
 */
function machineData(rules: OwnPullRequests, body: string): { readonly plan: unknown; readonly lines: ReadonlyArray<string> } {
  const plan = planPayload(body);
  return { plan: plan ?? null, lines: rules.machineLines === undefined ? [] : [...body.matchAll(rules.machineLines)].map((line) => line[0]) };
}

/**
 * What a PR's signature covers: the state, where it is (tool, repository, head and base branch) and what the body tells
 * the tool to do (`machineData`). Not the PR number, so a PR is born signed, nor the prose, which people may edit.
 */
function signedState(record: RecordContext, branch: string, baseBranch: string, state: PullRequestState, body: string): unknown {
  return {
    format: STATE_FORMAT, tool: record.rules.tool, repo: record.repo.toLowerCase(), branch, baseBranch,
    head: state.head, base: state.base, adaptations: state.adaptations, ...machineData(record.rules, body),
  };
}

/**
 * `body` ending with the PR's state and the marker, replacing earlier ones; signed (`signed` trust) for a PR from
 * `branch` into the record's base. Throws when what the tool acts on in the result (`machineData`) isn't what `before`
 * says: rewriting text, cleaning it or removing markers must never create machine data. `before` is the text as the
 * tool composed it, before cleaning; by default `body` itself.
 */
export function withMarker(record: RecordContext, body: string, state: PullRequestState, branch: string, before = body): string {
  const { rules } = record;
  if (!/^[0-9a-f]{40}$/.test(state.head) || !/^[0-9a-f]{40}$/.test(state.base) || !Number.isInteger(state.adaptations) || state.adaptations < 0) {
    throw new Error(`invalid PR state ${JSON.stringify(state)}`);
  }
  // Each removed marker leaves a line break: removed outright, the text around one could join into a plan block
  // (`<!-- leanish:` + marker + `plan …`), and no block spans a line break.
  const bare = body.replaceAll(rules.marker, "\n").replace(new RegExp(STATE.source, "g"), "\n").trimEnd();
  const marked = (signature: string | undefined) =>
    `${bare}\n\n<!-- leanish:state head=${state.head} base=${state.base} adaptations=${state.adaptations}${signature === undefined ? "" : ` sig=${signature}`} -->\n${rules.marker}\n`;
  const unsigned = marked(undefined);
  if (canonicalJson(machineData(rules, before)) !== canonicalJson(machineData(rules, unsigned))) {
    throw new Error(`${rules.tool}: preparing the PR's text changed its plan or its machine lines; refusing to publish it`);
  }
  if (record.trust.mode === "trusted-editors") return unsigned;
  return marked(recordSignature(record.trust.key, "pr-state", signedState(record, branch, record.base, state, unsigned)));
}

/**
 * Room for what withMarker appends to a body (its state line and marker), for whatever fills a body up to GitHub's
 * limit: 206 characters for secure-it with fewer than 10 adaptations, so it fits with room to spare.
 */
export const MARKER_ROOM = 256;

/**
 * The state line in a PR body, as written, signature unchecked; undefined when there's none (a body someone rewrote).
 * Only for what doesn't depend on who wrote it, such as sizing a body: `verifiedStateOf` for anything the tool acts on.
 */
export function stateOf(body: string): PullRequestState | undefined {
  const found = STATE.exec(body);
  return found === null ? undefined : stateFrom(found);
}

/**
 * The state the tool recorded in `pr`'s body; undefined when there's none, or more than one line claims to be it. With
 * `signed` trust it must carry a valid signature for this PR's branches and body; with `trusted-editors` any signature
 * is ignored.
 */
export function verifiedStateOf(record: RecordContext, pr: GitHubPullRequest): PullRequestState | undefined {
  const found = [...pr.body.matchAll(new RegExp(STATE.source, "g"))];
  if (found.length !== 1) return undefined;
  const state = stateFrom(found[0]!);
  if (record.trust.mode === "trusted-editors") return state;
  const signature = found[0]![4];
  if (signature === undefined) return undefined;
  return signatureMatches(record.trust.key, "pr-state", signedState(record, pr.headRef, pr.baseRef, state, pr.body), signature) ? state : undefined;
}

function stateFrom(found: RegExpExecArray | RegExpMatchArray): PullRequestState {
  return { head: found[1]!, base: found[2]!, adaptations: Number(found[3]) };
}
