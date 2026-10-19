import { readFile } from "node:fs/promises";
import { homedir } from "node:os";

import { isMap, isScalar, isSeq, parseDocument } from "yaml";

import type { ToolRepo } from "@leanish/tool-runtime/config";

import { Commands } from "./commands.ts";
import { result, type SetupResult } from "./contracts.ts";
import { fixtureScope, IncompleteEvidence, perFixture, rateLimitAware, reasonOf, type FixtureScopeOptions } from "./fixtures.ts";
import { GATE_SOURCE, WORKFLOW } from "./gate-workflow.ts";
import { latestRelease, type VerifiedRelease } from "./github-release.ts";
import { githubApi, list, object, required, sha, string, type GitHubApi } from "./github.ts";

export interface FixtureRepinOptions extends FixtureScopeOptions {
  readonly release: string;
  readonly apply: boolean;
}

const VERSION_COMMENT = /^\s*#\s*v\S+\s*$/;

/**
 * Opens one PR per fixture repository moving its gate caller to `release`, which must be the highest stable release:
 * only the caller's ref and `# v…` comment change. Dry run unless `apply`; never merges.
 */
export async function fixtureRepin(
  options: FixtureRepinOptions, emit: (entry: SetupResult) => void, api: GitHubApi = githubApi(),
  read: (path: string) => Promise<string> = (path) => readFile(path, "utf8"), home = homedir(),
  highest: () => Promise<VerifiedRelease> = () => latestRelease(new Commands()),
): Promise<ReadonlyArray<SetupResult>> {
  const fixtures = await fixtureScope(options, read, home);
  const release = await highest();
  if (release.tag !== options.release) throw new Error(`--release must be the highest stable release, ${release.tag}`);
  const github = rateLimitAware(api);
  const results: SetupResult[] = [];
  const publish = (entry: SetupResult) => { results.push(entry); emit(entry); };
  const notRun = await perFixture(fixtures, publish, async (fixture) => publish(await repinRepository(github, fixture, release, options.apply)),
    (repo, error) => result("fixture-repin", "repository", "blocked", `${repo}: ${(error as Error).message}`, { repo, reason: reasonOf(error) }));
  publish(summary(results, notRun));
  return results;
}

async function repinRepository(api: GitHubApi, fixture: ToolRepo, release: VerifiedRelease, apply: boolean): Promise<SetupResult> {
  const repo = fixture.repo;
  const base = fixture.branch ?? string(object(await required(api, "GET", `repos/${repo}`))["default_branch"]);
  const baseHead = await branchHead(api, repo, base);
  if (baseHead === undefined) throw new Error(`branch ${base} doesn't exist`);
  const current = await workflowAt(api, repo, baseHead);
  const rendered = repinned(current.text, release);
  const branch = `fixture-repin/${release.tag}`;
  const where = { repo, base, branch, release: release.tag, sha: release.sha };
  if (rendered === current.text) return result("fixture-repin", "repository", "already-done", `${repo} already pins ${release.tag}`, { ...where, reason: "pinned" });
  if (!apply) return result("fixture-repin", "repository", "needs-confirmation", `${repo}: would open a PR moving ${WORKFLOW} to ${release.tag}`, { ...where, reason: "planned" });

  // One rule covers every state an interrupted run can leave: the branch is the base head, or the base plus exactly this change.
  let head = await branchHead(api, repo, branch);
  if (head === undefined) {
    await required(api, "POST", `repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: baseHead });
    head = baseHead;
  }
  let state = await branchState(api, repo, baseHead, head, rendered);
  if (state === "empty") {
    // The blob SHA makes GitHub refuse the write if the workflow changed since it was read.
    await required(api, "PUT", `repos/${repo}/contents/${WORKFLOW}`, {
      message: `moving the supply-chain gate to ${release.tag}`, content: Buffer.from(rendered, "utf8").toString("base64"), sha: current.sha, branch,
    });
    head = await branchHead(api, repo, branch);
    state = head === undefined ? "foreign" : await branchState(api, repo, baseHead, head, rendered);
  }
  if (state !== "ours") {
    return result("fixture-repin", "repository", "blocked", `${repo}: ${branch} has other changes or is behind ${base}; delete it and rerun`, { ...where, reason: "foreign-branch" });
  }
  const owner = repo.split("/")[0]!;
  const open = (await list(api, `repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`))
    .filter((pr) => object(pr["base"])["ref"] === base);
  const pr = open[0] ?? object(await required(api, "POST", `repos/${repo}/pulls`, {
    title: `moving the supply-chain gate to ${release.tag}`, head: branch, base,
    body: `Moves the gate caller in \`${WORKFLOW}\` to ${release.tag} (\`${release.sha}\`); nothing else changes.\n\nOpened by \`fixture-repin\` after the release. Merge it by hand.`,
  }));
  return result("fixture-repin", "repository", "changed", `${repo}: ${string(pr["html_url"])}`, { ...where, pr: string(pr["html_url"]), reason: open.length > 0 ? "pr-exists" : "pr-opened" });
}

async function branchState(api: GitHubApi, repo: string, baseHead: string, head: string, rendered: string): Promise<"empty" | "ours" | "foreign"> {
  if (head === baseHead) return "empty";
  const comparison = object(await required(api, "GET", `repos/${repo}/compare/${baseHead}...${head}`));
  const files = comparison["files"];
  if (comparison["behind_by"] !== 0 || comparison["ahead_by"] !== 1 || !Array.isArray(files) || files.length !== 1) return "foreign";
  const file = object(files[0]);
  if (file["filename"] !== WORKFLOW || file["status"] !== "modified") return "foreign";
  return (await workflowAt(api, repo, head)).text === rendered ? "ours" : "foreign";
}

async function branchHead(api: GitHubApi, repo: string, branch: string): Promise<string | undefined> {
  const response = await api.request("GET", `repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
  if (response.status === 404) return undefined;
  if (response.status !== 200) throw new Error(`couldn't read branch ${branch} (HTTP ${response.status})`);
  return sha(object(object(response.body)["object"])["sha"]);
}

async function workflowAt(api: GitHubApi, repo: string, ref: string): Promise<{ readonly sha: string; readonly text: string }> {
  const response = await api.request("GET", `repos/${repo}/contents/${WORKFLOW}?ref=${ref}`);
  if (response.status === 404) throw new Error(`${WORKFLOW} doesn't exist`);
  if (response.status !== 200) throw new Error(`couldn't read ${WORKFLOW} (HTTP ${response.status})`);
  const body = object(response.body);
  if (body["type"] !== "file" || body["encoding"] !== "base64") throw new IncompleteEvidence(`${WORKFLOW} isn't a regular file`);
  try {
    // Strict and BOM-preserving, so the rewrite keeps every byte outside the caller.
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.from(string(body["content"]).replace(/\s/g, ""), "base64"));
    return { sha: sha(body["sha"]), text };
  } catch (error) {
    if (error instanceof TypeError) throw new IncompleteEvidence(`${WORKFLOW} isn't valid UTF-8`);
    throw error;
  }
}

/** The workflow with every gate caller at `release` and its comment `# <tag>`; anything else in it unchanged. */
export function repinned(text: string, release: VerifiedRelease): string {
  const found = gateCallers(text);
  if (found === undefined) throw new Error(`${WORKFLOW} isn't valid YAML, or a gate caller can't be edited in place`);
  if (found.callers.length === 0) throw new Error(`${WORKFLOW} has no gate caller`);
  let rendered = text;
  for (const caller of [...found.callers].sort((a, b) => b.refStart - a.refStart)) {
    if (!versionTail(text.slice(caller.tailStart, caller.tailEnd))) throw new Error(`a gate caller in ${WORKFLOW} has a comment other than its version`);
    rendered = rendered.slice(0, caller.refStart) + release.sha + rendered.slice(caller.refEnd, caller.tailStart) + ` # ${release.tag}` + rendered.slice(caller.tailEnd);
  }
  const check = gateCallers(rendered);
  if (check === undefined || check.masked !== found.masked || check.callers.some((caller) => caller.ref !== release.sha)) {
    throw new Error(`rewriting ${WORKFLOW} would change more than its gate callers`);
  }
  return rendered;
}

interface Caller {
  readonly ref: string;
  readonly refStart: number;
  readonly refEnd: number;
  /** What follows the scalar on its line, up to the line break. */
  readonly tailStart: number;
  readonly tailEnd: number;
}

/**
 * The YAML's gate callers (`uses:` of the gate's exact reusable workflow), and its text with each one's ref and `# v…`
 * comment masked. Undefined for invalid YAML, or a caller whose ref isn't written literally (an escaped `@`, say).
 */
export function gateCallers(text: string): { readonly callers: ReadonlyArray<Caller>; readonly masked: string } | undefined {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return undefined;
  const callers: Caller[] = [];
  let editable = true;
  const walk = (node: unknown): void => {
    if (isMap(node)) {
      for (const pair of node.items) {
        const value = pair.value;
        if (isScalar(pair.key) && pair.key.value === "uses" && isScalar(value) && typeof value.value === "string" && value.range !== undefined && value.range !== null) {
          const at = value.value.indexOf("@");
          if (at !== -1 && isGateCaller(value.value.slice(0, at))) {
            const ref = value.value.slice(at + 1);
            const literal = text.indexOf("@", value.range[0]);
            if (literal === -1 || literal >= value.range[1] || text.slice(literal + 1, literal + 1 + ref.length) !== ref) {
              editable = false;
            } else {
              const lineEnd = text.indexOf("\n", value.range[1]);
              let tailEnd = lineEnd === -1 ? text.length : lineEnd;
              if (text[tailEnd - 1] === "\r") tailEnd--;
              callers.push({ ref, refStart: literal + 1, refEnd: literal + 1 + ref.length, tailStart: value.range[1], tailEnd });
            }
          }
        }
        walk(pair.value);
      }
    } else if (isSeq(node)) {
      for (const item of node.items) walk(item);
    }
  };
  walk(doc.contents);
  if (!editable) return undefined;
  const ranges: Array<[number, number]> = callers.flatMap((caller): Array<[number, number]> => [
    [caller.refStart, caller.refEnd],
    // An empty tail is masked like a version comment: the rewrite may add the missing `# <tag>`.
    ...(versionTail(text.slice(caller.tailStart, caller.tailEnd)) ? [[caller.tailStart, caller.tailEnd] as [number, number]] : []),
  ]).sort(([a], [b]) => a - b);
  let masked = "";
  let from = 0;
  for (const [start, end] of ranges) {
    masked += `${text.slice(from, start)}\u0000`;
    from = end;
  }
  return { callers, masked: masked + text.slice(from) };
}

/** What may follow a gate caller on its line: nothing, or its `# v…` comment. */
function versionTail(tail: string): boolean {
  return tail.trim() === "" || VERSION_COMMENT.test(tail);
}

function isGateCaller(action: string): boolean {
  const [owner, name, ...path] = action.split("/");
  const [gateOwner, gateName, ...gatePath] = GATE_SOURCE.split("/");
  return `${owner}/${name}`.toLowerCase() === `${gateOwner}/${gateName}` && path.join("/") === gatePath.join("/");
}

function summary(results: ReadonlyArray<SetupResult>, notRun: ReadonlyArray<string>): SetupResult {
  const count = (status: SetupResult["status"]) => results.filter((entry) => entry.status === status).length;
  const data = { opened: count("changed"), planned: count("needs-confirmation"), blocked: count("blocked"), pinned: count("already-done"), notRun };
  if (notRun.length > 0) return result("fixture-repin", "summary", "blocked", `Stopped at GitHub's rate limit; not run: ${notRun.join(", ")}`, data);
  if (data.blocked > 0) return result("fixture-repin", "summary", "blocked", "Some fixtures weren't repinned; see the blocked rows", data);
  if (data.planned > 0) return result("fixture-repin", "summary", "needs-confirmation", "Dry run: rerun with --apply to open the PRs", data);
  return result("fixture-repin", "summary", data.opened > 0 ? "changed" : "already-done", data.opened > 0 ? "Repin PRs are open; merge them by hand" : "Every fixture already pins it", data);
}
