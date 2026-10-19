import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { result, type SetupResult } from "./contracts.ts";
import { gateSettings } from "./gate-settings.ts";
import { ADOPTION_FILES, GATE_SOURCE, gateWorkflow, pinnedActions, PR_MARKER, stopVersionUpdates, WORKFLOW } from "./gate-workflow.ts";
import { githubApi, list, object, required, sha, string, type GitHubApi } from "./github.ts";
import { readInstalledRelease, type InstalledRelease } from "./release.ts";
import { requireFixturesForCandidate } from "./fixtures.ts";
import { repositoryName } from "./tools.ts";

export interface GateOptions {
  readonly repo: string;
  readonly release: string;
  readonly java?: string;
  readonly confirmSettings: boolean;
}

interface Contents { readonly sha: string; readonly text: string }
async function contents(api: GitHubApi, repo: string, path: string, ref: string): Promise<Contents | undefined> {
  const response = await api.request("GET", `repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`);
  if (response.status === 404) return undefined;
  if (response.status !== 200) throw new Error("Cannot inspect the repository's gate or Dependabot config");
  const body = object(response.body);
  if (body["type"] !== "file" || body["encoding"] !== "base64") throw new Error("Adoption files must be regular files");
  const encoded = string(body["content"]).replace(/\s/g, "");
  if (encoded.length > 1_400_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error("Adoption file is too large or unreadable");
  return { sha: sha(body["sha"]), text: Buffer.from(encoded, "base64").toString("utf8") };
}

async function branchHead(api: GitHubApi, root: string, branch: string): Promise<string | undefined> {
  const response = await api.request("GET", `${root}/git/ref/heads/${encodeURIComponent(branch)}`);
  if (response.status === 404) return undefined;
  if (response.status !== 200) throw new Error("Cannot inspect adoption branch");
  return sha(object(object(response.body)["object"])["sha"]);
}

async function checkOwnedPr(api: GitHubApi, root: string, pr: Record<string, unknown>, repo: string, login: string, head: string): Promise<void> {
  if (object(pr["user"])["login"] !== login || !string(pr["body"]).includes(PR_MARKER) || object(pr["head"])["sha"] !== head
    || object(object(pr["head"])["repo"])["full_name"] !== repo || object(object(pr["base"])["repo"])["full_name"] !== repo) throw new Error("Adoption branch/PR ownership changed; inspect before editing");
  const files = await list(api, `${root}/pulls/${pr["number"]}/files`);
  if (!onlyAdoptionFiles(files)) throw new Error("Adoption PR contains unrelated changes; refusing to edit it");
}

function onlyAdoptionFiles(files: ReadonlyArray<unknown>): boolean {
  const allowed = (name: unknown) => typeof name === "string" && (ADOPTION_FILES as ReadonlyArray<string>).includes(name);
  return files.every((file) => allowed(object(file)["filename"]) && (object(file)["previous_filename"] === undefined || allowed(object(file)["previous_filename"])));
}

/** Bound compare evidence and inspect each commit's diff, including files later reverted. */
async function checkOrphanBranch(api: GitHubApi, root: string, base: string, head: string, login: string): Promise<boolean> {
  const refusal = "Adoption branch exists without an owned open PR; commit authors/files could not be verified";
  const comparison = object(await required(api, "GET", `${root}/compare/${base}...${head}?per_page=100`));
  const commits = comparison["commits"];
  if (!Array.isArray(commits) || commits.length !== comparison["total_commits"] || commits.length !== comparison["ahead_by"] || commits.length > 100) throw new Error(refusal);
  if (commits.length > 0 && object(commits.at(-1))["sha"] !== head) throw new Error(refusal);
  for (const entry of commits) {
    const commit = object(entry);
    const parents = commit["parents"];
    if (object(commit["author"])["login"] !== login || !Array.isArray(parents) || parents.length !== 1) throw new Error(refusal);
    const parent = sha(object(parents[0])["sha"]);
    const current = sha(commit["sha"]);
    const diff = object(await required(api, "GET", `${root}/compare/${parent}...${current}?per_page=100`));
    if (diff["total_commits"] !== 1 || !Array.isArray(diff["files"]) || diff["files"].length >= 300 || !onlyAdoptionFiles(diff["files"])) throw new Error(refusal);
  }
  return commits.length > 0;
}

/** The only gate writer: selected repository only, guarded branch/file updates, no merge operation. */
export async function adoptGate(
  options: GateOptions,
  machine: { readonly api: GitHubApi; readonly release: (tag: string) => Promise<InstalledRelease> } = { api: githubApi(), release: readInstalledRelease },
  emit: (entry: SetupResult) => void = () => {},
): Promise<ReadonlyArray<SetupResult>> {
  const repo = repositoryName(options.repo);
  requireFixturesForCandidate(options.release, [repo]);
  if (options.java !== undefined && !/^\d+(?:\.\d+)*$/.test(options.java)) throw new Error("Select a Java version for the gate");
  const release = await machine.release(options.release);
  const source = await readFile(join(release.path, ".github", "workflows", "supply-chain.yml"), "utf8");
  let actions: ReadonlyArray<string>;
  try { actions = pinnedActions(source); } catch {
    return [result("gate", "release-actions", "blocked", "Installed release workflow contains unreadable or unpinned uses entries; inspect it locally")];
  }
  const patterns = [...actions, `${GATE_SOURCE}@${release.sha}`];
  const { api } = machine;
  const root = `repos/${repo}`;
  const repositoryReply = await api.request("GET", root);
  if (repositoryReply.status !== 200) throw new Error(`Cannot inspect selected repository (HTTP ${repositoryReply.status})`);
  const scopesHeader = repositoryReply.headers?.["x-oauth-scopes"];
  const scopes = scopesHeader?.split(",").map((scope) => scope.trim());
  if (scopes !== undefined && (!scopes.includes("workflow") || !scopes.includes("repo"))) return [result("gate", "workflow-scope", "blocked", "GitHub credential needs repo and workflow scopes; run gh auth refresh -h github.com -s workflow")];
  const repository = object(repositoryReply.body);
  if (repository["full_name"] !== repo) throw new Error("GitHub returned a different repository; use its canonical owner/name");
  const base = string(repository["default_branch"]);
  const permissions = object(repository["permissions"]);
  const rendered = gateWorkflow((await contents(api, repo, WORKFLOW, base))?.text, release, base, options.java);
  if (permissions["push"] !== true) return [
    result("gate", "admin-request", "needs-confirmation", "Ask a repository maintainer to open this ready gate workflow PR", { path: WORKFLOW, content: rendered, repo }),
    ...await gateSettings(api, repo, false, repository["private"] === true, patterns, false),
  ];
  const login = string(object(await required(api, "GET", "user"))["login"]);
  const branch = `setup/gate-${release.tag}`;
  const prs = await list(api, `${root}/pulls?state=open&head=${encodeURIComponent(repo.split("/")[0] + ":" + branch)}&base=${encodeURIComponent(base)}`);
  if (prs.length > 1) throw new Error("Multiple adoption PRs need review");
  const pr = prs[0];
  let head = await branchHead(api, root, branch);
  let recovered = false;
  if (pr !== undefined) {
    if (head === undefined) throw new Error("Adoption PR has no branch");
    await checkOwnedPr(api, root, pr, repo, login, head);
  } else if (head !== undefined) {
    const baseHead = await branchHead(api, root, base);
    if (baseHead === undefined) throw new Error("Default branch is missing");
    recovered = await checkOrphanBranch(api, root, baseHead, head, login);
  }
  const ref = head === undefined ? base : branch;
  const changes: Array<{ path: string; old: Contents | undefined; text: string }> = [];
  const prior = await contents(api, repo, WORKFLOW, ref);
  const workflow = gateWorkflow(prior?.text, release, base, options.java);
  if (prior?.text !== workflow) changes.push({ path: WORKFLOW, old: prior, text: workflow });
  const results: SetupResult[] = [];
  for (const path of [".github/dependabot.yml", ".github/dependabot.yaml"]) {
    const file = await contents(api, repo, path, ref);
    if (file === undefined) continue;
    const disabled = stopVersionUpdates(file.text);
    if (disabled === file.text) continue;
    if (!options.confirmSettings) results.push(result("gate", "dependabot-version-prs", "needs-confirmation", "Disable Dependabot version PRs through the adoption PR", { path }));
    else changes.push({ path, old: file, text: disabled });
  }
  if (changes.length > 0) {
    if (head === undefined) {
      const baseHead = await branchHead(api, root, base);
      if (baseHead === undefined) throw new Error("Default branch is missing");
      await required(api, "POST", `${root}/git/refs`, { ref: `refs/heads/${branch}`, sha: baseHead });
      head = baseHead;
    }
    for (const change of changes) {
      if (await branchHead(api, root, branch) !== head) throw new Error("Adoption branch moved; refusing a stale write");
      const saved = object(await required(api, "PUT", `${root}/contents/${change.path}`, {
        message: "enabling dependency gate", branch, content: Buffer.from(change.text).toString("base64"), ...(change.old === undefined ? {} : { sha: change.old.sha }),
      }));
      head = sha(object(saved["commit"])["sha"]);
    }
  }
  let published = pr;
  if (published === undefined && (changes.length > 0 || recovered)) {
    if (await branchHead(api, root, branch) !== head) throw new Error("Adoption branch moved; refusing a stale PR");
    published = object(await required(api, "POST", `${root}/pulls`, {
    title: "enable dependency gate", head: branch, base, body: `${PR_MARKER}\nEnable the gate pinned to ${release.tag} (${release.sha}).\nReview checks and settings before merging. This installer never merges.`,
    }));
  }
  results.unshift(result("gate", "workflow", changes.length > 0 || (pr === undefined && published !== undefined) ? "changed" : "already-done", published === undefined ? "Gate caller already present on the default branch" : "Adoption PR ready; merge only when explicitly requested", {
    ...(published === undefined ? {} : { pullRequest: string(published["html_url"]) }), tag: release.tag, sha: release.sha, pendingMerge: published !== undefined,
  }));
  for (const entry of results) emit(entry);
  results.push(...await gateSettings(api, repo, permissions["admin"] === true, repository["private"] === true, patterns, options.confirmSettings, emit));
  return results;
}
