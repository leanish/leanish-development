import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isDeepStrictEqual } from "node:util";

import { isMap, isScalar, isSeq, parseDocument } from "yaml";

import { parseToolConfig, type ToolRepo } from "@leanish/tool-runtime/config";
import { ownPullRequests, topicOf } from "@leanish/tool-runtime/own-pr";

import { result, type SetupResult } from "./contracts.ts";
import { GitHubHttpError, githubApi, list, object, required, sha, string, type GitHubApi } from "./github.ts";
import { TOOLS, type Tool } from "./tools.ts";

export interface FixtureCleanupOptions {
  readonly bumpItConfig: string;
  readonly secureItConfig: string;
  /** One listed fixture to restrict a run to; undefined: all of them. */
  readonly repo: string | undefined;
  readonly apply: boolean;
}

export type Classification = "gate-upgrade" | "mixed" | "other";

const GATE_REPOSITORY = "leanish/leanish-development";
const GATE_WORKFLOW = ".github/workflows/supply-chain.yml";
const FIXTURE = /^[A-Za-z0-9-]+\/supply-chain_TEST_[A-Za-z0-9_.-]+$/;
const ZERO = "0".repeat(40);
const COMPARE_FILE_LIMIT = 300;
// GitHub checks beforeOid and applies the update atomically; afterOid zero deletes the ref.
const UPDATE_REFS = "mutation($repositoryId: ID!, $refUpdates: [RefUpdate!]!) { updateRefs(input: { repositoryId: $repositoryId, refUpdates: $refUpdates }) { clientMutationId } }";
const CLOSE_COMMENT = "Closed by `fixture-cleanup` after a release-candidate pass: fixture repositories keep their seeded dependencies, "
  + "so only gate-only upgrades of the supply-chain workflow stay open.";

class RateLimited extends Error {
  /** Already published on the row of the PR or branch it stopped. */
  reported = false;
}
class IncompleteEvidence extends Error {}

/**
 * Closes the tools' PRs on the fixture repositories, except gate-only upgrades, and deletes their branches. Dry-run
 * unless `apply`: planned actions are `needs-confirmation` rows. Every decision is recomputed from GitHub, right
 * before acting, so a rerun finishes what an interrupted one left.
 */
export async function fixtureCleanup(
  options: FixtureCleanupOptions, emit: (entry: SetupResult) => void, api: GitHubApi = githubApi(),
  read: (path: string) => Promise<string> = (path) => readFile(path, "utf8"), home = homedir(),
): Promise<ReadonlyArray<SetupResult>> {
  const fixtures = await fixtureScope(options, read, home);
  const github = rateLimitAware(api);
  const results: SetupResult[] = [];
  const publish = (entry: SetupResult) => { results.push(entry); emit(entry); };
  const repinsNeeded: string[] = [];
  const notRun: string[] = [];
  for (const [index, fixture] of fixtures.entries()) {
    const noteRepin = () => { if (!repinsNeeded.includes(fixture.repo)) repinsNeeded.push(fixture.repo); };
    try {
      await cleanRepository(github, fixture, options.apply, publish, noteRepin);
    } catch (error) {
      if (!(error instanceof RateLimited && error.reported)) {
        publish(result("fixture-cleanup", "repository", "blocked", `${fixture.repo}: ${(error as Error).message}`, { repo: fixture.repo, reason: reasonOf(error) }));
      }
      if (error instanceof RateLimited) {
        notRun.push(...fixtures.slice(index + 1).map((entry) => entry.repo));
        break;
      }
    }
  }
  publish(summary(results, repinsNeeded, notRun, options.apply));
  return results;
}

/** Both tools' fixture configs, which must list the same repositories and branches, all of them `supply-chain_TEST_*`. */
export async function fixtureScope(
  options: Pick<FixtureCleanupOptions, "bumpItConfig" | "secureItConfig" | "repo">,
  read: (path: string) => Promise<string>, home: string,
): Promise<ReadonlyArray<ToolRepo>> {
  const bumpIt = parseToolConfig("bump-it", await read(options.bumpItConfig), options.bumpItConfig, home).repos;
  const secureIt = parseToolConfig("secure-it", await read(options.secureItConfig), options.secureItConfig, home).repos;
  const key = (repos: ReadonlyArray<ToolRepo>) => repos.map((entry) => `${entry.repo.toLowerCase()} ${entry.branch ?? ""}`).sort().join("\n");
  if (key(bumpIt) !== key(secureIt)) throw new Error("The bump-it and secure-it fixture configs must list the same repositories and branches");
  const outside = bumpIt.find((entry) => !FIXTURE.test(entry.repo));
  if (outside !== undefined) throw new Error(`${outside.repo} isn't a supply-chain_TEST_* fixture repository; refusing to clean it`);
  if (options.repo === undefined) return bumpIt;
  const selected = bumpIt.filter((entry) => entry.repo.toLowerCase() === options.repo!.toLowerCase());
  if (selected.length === 0) throw new Error("--repo must be one of the fixture configs' repositories");
  return selected;
}

/** `noteRepin` records a mixed PR: its gate upgrade is dropped with it and still needs a gate-only PR. */
async function cleanRepository(
  api: GitHubApi, fixture: ToolRepo, apply: boolean, publish: (entry: SetupResult) => void, noteRepin: () => void,
): Promise<void> {
  const repo = fixture.repo;
  const metadata = object(await required(api, "GET", `repos/${repo}`));
  const repositoryId = string(metadata["node_id"]);
  const base = fixture.branch ?? string(metadata["default_branch"]);
  const open = (await list(api, `repos/${repo}/pulls?state=open`)).map(pull);
  const branches = (await list(api, `repos/${repo}/branches`)).map((entry) => ({ name: string(entry["name"]), head: sha(object(entry["commit"])["sha"]) }));
  const openHeads = new Set(open.filter((pr) => pr.headRepo?.toLowerCase() === repo.toLowerCase()).map((pr) => pr.headRef));
  // One failing PR or branch (possibly after its PR was closed) is reported on its own row, with what was learned and
  // done before the failure; the rest still run.
  const each = async (where: Record<string, unknown>, step: "pull" | "branch", clean: (progress: Progress) => Promise<SetupResult>) => {
    const progress: Progress = { ...where };
    try {
      publish(await clean(progress));
    } catch (error) {
      publish(result("fixture-cleanup", step, "blocked", `${repo}: ${(error as Error).message}`, { repo, ...progress, reason: reasonOf(error) }));
      if (error instanceof RateLimited) {
        error.reported = true;
        throw error;
      }
    }
  };
  for (const listed of open) {
    await each({ kind: "pull", number: listed.number, branch: listed.headRef }, "pull",
      (progress) => cleanPull(api, repo, repositoryId, base, listed.number, apply, noteRepin, progress));
  }
  for (const branch of branches) {
    if (branchTool(branch.name) === undefined || openHeads.has(branch.name)) continue;
    await each({ kind: "branch", tool: branchTool(branch.name), branch: branch.name, head: branch.head }, "branch",
      (progress) => cleanBranch(api, repo, repositoryId, base, branch.name, branch.head, apply, progress));
  }
}

/** What a PR's or branch's row says if it fails midway: what was read and done so far. */
type Progress = Record<string, unknown>;

/** Classified from a fresh read, right before acting on it. */
async function cleanPull(
  api: GitHubApi, repo: string, repositoryId: string, base: string, number: number, apply: boolean, noteMixed: () => void, progress: Progress,
): Promise<SetupResult> {
  const pr = pull(await required(api, "GET", `repos/${repo}/pulls/${number}`));
  const where = { repo, kind: "pull", number, branch: pr.headRef, head: pr.headSha };
  Object.assign(progress, where);
  if (pr.state !== "open") return result("fixture-cleanup", "pull", "already-done", `${repo}#${number} closed meanwhile`, { ...where, reason: "closed", action: "none" });
  const tool = openedBy(pr, repo, base);
  if (tool === undefined) return result("fixture-cleanup", "pull", "already-done", `${repo}#${number} isn't a tool PR; left alone`, { ...where, reason: "not-owned", action: "none" });
  progress["tool"] = tool;
  const { classification, reason } = await classify(api, repo, pr);
  const data = { ...where, tool, classification, reason };
  Object.assign(progress, { classification, action: apply && classification !== "gate-upgrade" ? "close" : "none", closed: false });
  // Noted before any write, so a failure after closing can't lose the repin it drops.
  if (classification === "mixed") noteMixed();
  if (classification === "gate-upgrade") return result("fixture-cleanup", "pull", "already-done", `${repo}#${number} only upgrades the gate; kept open`, { ...data, action: "keep" });
  if (!apply) return result("fixture-cleanup", "pull", "needs-confirmation", `${repo}#${number} would be closed and ${pr.headRef} deleted`, { ...data, action: "close" });
  await required(api, "PATCH", `repos/${repo}/pulls/${number}`, { state: "closed" });
  progress["closed"] = true;
  let commented = true;
  try {
    await required(api, "POST", `repos/${repo}/issues/${number}/comments`, { body: CLOSE_COMMENT });
  } catch (error) {
    if (!(error instanceof GitHubHttpError)) throw error;
    commented = false;
  }
  progress["commented"] = commented;
  const deletion = await deleteBranch(api, repo, repositoryId, pr.headRef, pr.headSha);
  const done = { ...data, action: "close", closed: true, commented, deletion };
  if (deletion === "moved") return result("fixture-cleanup", "pull", "blocked", `${repo}#${number} closed; ${pr.headRef} moved since it was read, so it stays`, done);
  return result("fixture-cleanup", "pull", "changed", `${repo}#${number} closed; ${pr.headRef} ${deletion === "deleted" ? "deleted" : "was already gone"}`, done);
}

/** A tool branch without an open PR: deleted only when its latest PR is the tool's, closed unmerged, at the same head. */
async function cleanBranch(
  api: GitHubApi, repo: string, repositoryId: string, base: string, branch: string, head: string, apply: boolean, progress: Progress,
): Promise<SetupResult> {
  const where = { repo, kind: "branch", tool: branchTool(branch), branch, head };
  const decision = orphanDecision(await pullsFrom(api, repo, branch), branch, head, repo, base);
  if (decision.status !== "delete") return result("fixture-cleanup", "branch", decision.status, `${repo}: ${branch} kept (${decision.reason})`, { ...where, reason: decision.reason, action: "none" });
  const data = { ...where, number: decision.number, reason: decision.reason };
  if (!apply) return result("fixture-cleanup", "branch", "needs-confirmation", `${repo}: ${branch} would be deleted`, { ...data, action: "delete" });
  const again = orphanDecision(await pullsFrom(api, repo, branch), branch, head, repo, base);
  if (again.status !== "delete" || again.number !== decision.number) {
    return result("fixture-cleanup", "branch", "blocked", `${repo}: ${branch} changed while being checked; kept`, { ...data, reason: "changed", action: "none" });
  }
  progress["action"] = "delete";
  const deletion = await deleteBranch(api, repo, repositoryId, branch, head);
  if (deletion === "moved") return result("fixture-cleanup", "branch", "blocked", `${repo}: ${branch} moved since it was read; kept`, { ...data, action: "delete", deletion });
  return deletion === "deleted"
    ? result("fixture-cleanup", "branch", "changed", `${repo}: ${branch} deleted`, { ...data, action: "delete", deletion })
    : result("fixture-cleanup", "branch", "already-done", `${repo}: ${branch} was already gone`, { ...data, action: "delete", deletion });
}

type OrphanDecision =
  | { readonly status: "delete"; readonly number: number; readonly reason: string }
  | { readonly status: "already-done" | "blocked"; readonly reason: string };

function orphanDecision(pulls: ReadonlyArray<Pull>, branch: string, head: string, repo: string, base: string): OrphanDecision {
  if (pulls.some((pr) => pr.state === "open")) return { status: "blocked", reason: "an open PR uses it" };
  const latest = [...pulls].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (latest === undefined) return { status: "blocked", reason: "no PR was ever opened from it" };
  if (openedBy(latest, repo, base) !== branchTool(branch)) return { status: "blocked", reason: `its latest PR #${latest.number} isn't the tool's` };
  if (latest.merged) return { status: "already-done", reason: `its latest PR #${latest.number} was merged` };
  if (latest.headSha !== head) return { status: "blocked", reason: `it moved after its PR #${latest.number} was closed` };
  return { status: "delete", number: latest.number, reason: `its PR #${latest.number} was closed unmerged` };
}

async function pullsFrom(api: GitHubApi, repo: string, branch: string): Promise<ReadonlyArray<Pull>> {
  const owner = repo.split("/")[0]!;
  return (await list(api, `repos/${repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}`)).map(pull)
    .filter((pr) => pr.headRef === branch && pr.headRepo?.toLowerCase() === repo.toLowerCase());
}

/**
 * Deletes `branch` only while it still points at `expected`, checked by GitHub itself. A refusal is told apart by the
 * branch's current head: gone (done by someone else) or moved (kept, for a person to look at).
 */
async function deleteBranch(api: GitHubApi, repo: string, repositoryId: string, branch: string, expected: string): Promise<"deleted" | "missing" | "moved"> {
  // force: a deletion is never a fast-forward; beforeOid is the guard.
  const refUpdates = [{ name: `refs/heads/${branch}`, beforeOid: expected, afterOid: ZERO, force: true }];
  const reply = object(await required(api, "POST", "graphql", { query: UPDATE_REFS, variables: { repositoryId, refUpdates } }));
  const errors = reply["errors"];
  if (Array.isArray(errors) && errors.some((error) => object(error)["type"] === "RATE_LIMITED")) throw new RateLimited("GitHub's GraphQL rate limit was reached; rerun the cleanup later");
  const data = reply["data"];
  // Success only when GitHub says so; anything else is settled by the branch's current head.
  if ((errors === undefined || errors === null) && data !== null && typeof data === "object" && (data as Record<string, unknown>)["updateRefs"] != null) return "deleted";
  const response = await api.request("GET", `repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
  if (response.status === 404) return "missing";
  if (response.status !== 200) throw new GitHubHttpError(response.status);
  if (sha(object(object(response.body)["object"])["sha"]) !== expected) return "moved";
  throw new Error(`GitHub refused deleting ${branch}`);
}

/**
 * A gate-only upgrade changes nothing but the ref (and its `# v…` comment) of the gate's reusable-workflow callers:
 * every changed file is a workflow modified in place with the same mode, equal to its merge-base version once those
 * are masked, and at least one caller moved to a full SHA. A PR changing a caller and anything else is `mixed`.
 */
export async function classify(api: GitHubApi, repo: string, pr: Pick<Pull, "baseSha" | "headSha">): Promise<{ classification: Classification; reason: string }> {
  // Pinned to the SHAs read with the PR, so the files, trees and blobs are one snapshot.
  const comparison = object(await required(api, "GET", `repos/${repo}/compare/${pr.baseSha}...${pr.headSha}`));
  const mergeBase = sha(object(comparison["merge_base_commit"])["sha"]);
  const files = comparison["files"];
  if (!Array.isArray(files) || files.length >= COMPARE_FILE_LIMIT) throw new IncompleteEvidence("the PR's file list is missing or truncated");
  if (files.length === 0) return { classification: "other", reason: "no changed files" };
  const [before, after] = await Promise.all([tree(api, repo, mergeBase), tree(api, repo, pr.headSha)]);
  let gateMoved = false;
  const others: string[] = [];
  for (const entry of files) {
    const file = object(entry);
    const path = string(file["filename"]);
    // A renamed file's old content is under its previous name; the rename itself still makes it "other".
    const was = before.get(typeof file["previous_filename"] === "string" ? file["previous_filename"] : path);
    const now = after.get(path);
    if (!/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path) || was === undefined || now === undefined || was.type !== "blob" || now.type !== "blob") {
      others.push(path);
      continue;
    }
    const [oldCallers, newCallers] = await Promise.all([blob(api, repo, was.sha), blob(api, repo, now.sha)]).then(([a, b]) => [gateCallers(a), gateCallers(b)]);
    if (oldCallers === undefined || newCallers === undefined) {
      others.push(path);
      continue;
    }
    // Whether the gate moved is told apart from whether that's all the file's change, so a mixed PR is never "other".
    const moved = !isDeepStrictEqual(oldCallers.refs, newCallers.refs);
    if (moved) gateMoved = true;
    if (file["status"] !== "modified" || was.mode !== now.mode) others.push(`${path} (${file["status"] === "modified" ? "mode changed" : String(file["status"])})`);
    else if (!newCallers.refs.every((ref) => /^[0-9a-f]{40}$/.test(ref))) others.push(`${path} (a gate ref isn't a full commit SHA)`);
    else if (!moved || oldCallers.masked !== newCallers.masked) others.push(path);
  }
  if (!gateMoved) return { classification: "other", reason: `changes ${files.length} file(s), none a gate upgrade` };
  if (others.length > 0) return { classification: "mixed", reason: `upgrades the gate and also changes ${others.join(", ")}` };
  return { classification: "gate-upgrade", reason: "only moves the gate's reusable-workflow pin" };
}

/** The YAML's gate callers' refs, and its text with each one's ref and `# v…` comment masked; undefined for invalid YAML. */
export function gateCallers(text: string): { readonly refs: ReadonlyArray<string>; readonly masked: string } | undefined {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return undefined;
  const refs: string[] = [];
  const ranges: Array<[number, number]> = [];
  let unmaskable = false;
  const walk = (node: unknown): void => {
    if (isMap(node)) {
      for (const pair of node.items) {
        const value = pair.value;
        if (isScalar(pair.key) && pair.key.value === "uses" && isScalar(value) && typeof value.value === "string" && value.range !== undefined && value.range !== null) {
          const at = value.value.indexOf("@");
          if (at !== -1 && isGateCaller(value.value.slice(0, at))) {
            refs.push(value.value.slice(at + 1));
            // The mask starts at the literal '@' inside this scalar; an escaped one (`\x40`) can't be masked safely.
            const literal = text.indexOf("@", value.range[0]);
            if (literal === -1 || literal >= value.range[1]) {
              unmaskable = true;
              return;
            }
            const start = literal + 1;
            const lineEnd = text.indexOf("\n", value.range[1]);
            const end = lineEnd === -1 ? text.length : lineEnd;
            ranges.push([start, /^\s*#\s*v\S+\s*$/.test(text.slice(value.range[1], end)) ? end : value.range[1]]);
          }
        }
        walk(pair.value);
      }
    } else if (isSeq(node)) {
      for (const item of node.items) walk(item);
    }
  };
  walk(doc.contents);
  if (unmaskable) return undefined;
  let masked = "";
  let from = 0;
  for (const [start, end] of ranges.sort(([a], [b]) => a - b)) {
    masked += `${text.slice(from, start)}\u0000`;
    from = end;
  }
  return { refs, masked: masked + text.slice(from) };
}

function isGateCaller(action: string): boolean {
  const [owner, name, ...path] = action.split("/");
  return `${owner}/${name}`.toLowerCase() === GATE_REPOSITORY && path.join("/") === GATE_WORKFLOW;
}

interface TreeEntry { readonly mode: string; readonly type: string; readonly sha: string }
async function tree(api: GitHubApi, repo: string, commit: string): Promise<ReadonlyMap<string, TreeEntry>> {
  const body = object(await required(api, "GET", `repos/${repo}/git/trees/${commit}?recursive=1`));
  if (body["truncated"] !== false || !Array.isArray(body["tree"])) throw new IncompleteEvidence(`the tree at ${commit} is truncated or missing`);
  return new Map(body["tree"].map((entry) => {
    const item = object(entry);
    return [string(item["path"]), { mode: string(item["mode"]), type: string(item["type"]), sha: sha(item["sha"]) }];
  }));
}

async function blob(api: GitHubApi, repo: string, blobSha: string): Promise<string> {
  const body = object(await required(api, "GET", `repos/${repo}/git/blobs/${blobSha}`));
  if (body["encoding"] !== "base64") throw new IncompleteEvidence(`blob ${blobSha} isn't base64`);
  try {
    // Strict and BOM-preserving: a lenient decode replaces invalid bytes or drops a BOM, and two different files could compare equal.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.from(string(body["content"]).replace(/\s/g, ""), "base64"));
  } catch {
    throw new IncompleteEvidence(`blob ${blobSha} isn't valid UTF-8`);
  }
}

interface Pull {
  readonly number: number;
  readonly state: string;
  readonly merged: boolean;
  readonly createdAt: string;
  readonly headRef: string;
  readonly headSha: string;
  /** undefined when the head repository was deleted. */
  readonly headRepo: string | undefined;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly body: string;
  readonly labels: ReadonlyArray<string>;
}

function pull(value: unknown): Pull {
  const pr = object(value);
  const head = object(pr["head"]);
  const base = object(pr["base"]);
  const number = pr["number"];
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) throw new Error("GitHub returned an invalid PR number");
  return {
    number,
    state: string(pr["state"]),
    merged: pr["merged_at"] !== null && pr["merged_at"] !== undefined,
    createdAt: string(pr["created_at"]),
    headRef: string(head["ref"]),
    headSha: sha(head["sha"]),
    headRepo: head["repo"] === null || head["repo"] === undefined ? undefined : string(object(head["repo"])["full_name"]),
    baseRef: string(base["ref"]),
    baseSha: sha(base["sha"]),
    body: typeof pr["body"] === "string" ? pr["body"] : "",
    labels: Array.isArray(pr["labels"]) ? pr["labels"].map((label) => string(object(label)["name"])) : [],
  };
}

/** The tool whose rule `pr` meets: `isOwnPullRequest`'s, without its open-state check so closed PRs count too. */
function openedBy(pr: Pull, repo: string, base: string): Tool | undefined {
  return TOOLS.find((tool) => {
    const rules = ownPullRequests(tool);
    return topicOf(rules, pr.headRef) !== undefined && pr.headRepo?.toLowerCase() === repo.toLowerCase() && pr.baseRef === base
      && (pr.body.includes(rules.marker) || pr.labels.includes(rules.label));
  });
}

function branchTool(branch: string): Tool | undefined {
  return TOOLS.find((tool) => topicOf(ownPullRequests(tool), branch) !== undefined);
}

function rateLimitAware(api: GitHubApi): GitHubApi {
  return { async request(method, path, body) {
    const reply = await api.request(method, path, body);
    const headers = reply.headers ?? {};
    if ((reply.status === 403 || reply.status === 429) && (headers["x-ratelimit-remaining"] === "0" || headers["retry-after"] !== undefined)) {
      const reset = headers["x-ratelimit-reset"];
      const when = reset !== undefined && /^\d+$/.test(reset) ? `resets at ${new Date(Number(reset) * 1000).toISOString()}` : `retry after ${headers["retry-after"] ?? "?"}s`;
      throw new RateLimited(`GitHub's rate limit was reached (${when}); rerun the cleanup then`);
    }
    return reply;
  } };
}

function reasonOf(error: unknown): string {
  if (error instanceof RateLimited) return "rate-limited";
  if (error instanceof IncompleteEvidence) return "incomplete-evidence";
  return "failed";
}

function summary(results: ReadonlyArray<SetupResult>, repinsNeeded: ReadonlyArray<string>, notRun: ReadonlyArray<string>, apply: boolean): SetupResult {
  const count = (status: SetupResult["status"]) => results.filter((entry) => entry.status === status).length;
  const data = { apply, changed: count("changed"), planned: count("needs-confirmation"), blocked: count("blocked"), unchanged: count("already-done"), repinsNeeded, notRun };
  if (notRun.length > 0) return result("fixture-cleanup", "summary", "blocked", `Stopped at GitHub's rate limit; not run: ${notRun.join(", ")}`, data);
  if (repinsNeeded.length > 0) {
    const what = apply ? "A closed mixed PR carried" : "A mixed PR to close carries";
    return result("fixture-cleanup", "summary", "needs-confirmation", `${what} the gate upgrade in ${repinsNeeded.join(", ")}; a gate-only repin is needed there`, data);
  }
  if (data.blocked > 0) return result("fixture-cleanup", "summary", "blocked", "Some PRs or branches need a person; see the blocked rows", data);
  if (data.planned > 0) return result("fixture-cleanup", "summary", "needs-confirmation", "Dry run: rerun with --apply to do the planned actions", data);
  return result("fixture-cleanup", "summary", data.changed > 0 ? "changed" : "already-done", data.changed > 0 ? "Fixture cleanup done" : "Nothing to clean", data);
}
