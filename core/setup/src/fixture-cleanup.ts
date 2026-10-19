import { readFile } from "node:fs/promises";
import { homedir } from "node:os";

import { result, type SetupResult } from "./contracts.ts";
import { fixtureScope, perFixture, rateLimitAware, RateLimited, reasonOf, type FixtureScopeOptions } from "./fixtures.ts";
import { GitHubHttpError, githubApi, list, object, required, sha, string, type GitHubApi } from "./github.ts";

export interface FixtureCleanupOptions extends FixtureScopeOptions {
  readonly apply: boolean;
}

/** Every branch the tools publish from; a candidate's fixture runs start without any of them. */
const TOOL_BRANCH = /^(?:bump-it|secure-it)\//;
const ZERO = "0".repeat(40);
/** refUpdates per `updateRefs` call; GitHub applies each call atomically. */
const CHUNK = 25;
// beforeOid is checked by GitHub; afterOid zero deletes the ref.
const UPDATE_REFS = "mutation($repositoryId: ID!, $refUpdates: [RefUpdate!]!) { updateRefs(input: { repositoryId: $repositoryId, refUpdates: $refUpdates }) { clientMutationId } }";

interface Branch { readonly name: string; readonly head: string }
type Row = (status: SetupResult["status"], branch: Branch, message: string, reason: string) => SetupResult;

/**
 * Deletes every `bump-it/` and `secure-it/` branch of the fixture repositories, so a candidate's fixture runs start
 * clean; GitHub closes their open PRs with them. Dry run unless `apply`. Each branch is deleted only while it's still
 * at the head that was listed.
 */
export async function fixtureCleanup(
  options: FixtureCleanupOptions, emit: (entry: SetupResult) => void, api: GitHubApi = githubApi(),
  read: (path: string) => Promise<string> = (path) => readFile(path, "utf8"), home = homedir(),
): Promise<ReadonlyArray<SetupResult>> {
  const fixtures = await fixtureScope(options, read, home);
  const github = rateLimitAware(api);
  const results: SetupResult[] = [];
  const publish = (entry: SetupResult) => { results.push(entry); emit(entry); };
  const notRun = await perFixture(fixtures, publish, (fixture) => cleanRepository(github, fixture.repo, fixture.branch, options.apply, publish),
    (repo, error) => result("fixture-cleanup", "repository", "blocked", `${repo}: ${(error as Error).message}`, { repo, reason: reasonOf(error) }));
  publish(summary(results, notRun));
  return results;
}

async function cleanRepository(
  api: GitHubApi, repo: string, configured: string | undefined, apply: boolean, publish: (entry: SetupResult) => void,
): Promise<void> {
  const metadata = object(await required(api, "GET", `repos/${repo}`));
  const repositoryId = string(metadata["node_id"]);
  // The branch the tools target is never deleted, even if it were named like one of theirs.
  const base = configured ?? string(metadata["default_branch"]);
  const branches = (await list(api, `repos/${repo}/branches`))
    .map((entry) => ({ name: string(entry["name"]), head: sha(object(entry["commit"])["sha"]) }))
    .filter((branch) => TOOL_BRANCH.test(branch.name) && branch.name !== base);
  const row: Row = (status, branch, message, reason) =>
    result("fixture-cleanup", "branch", status, `${repo}: ${branch.name} ${message}`, { repo, branch: branch.name, head: branch.head, reason });
  if (!apply) {
    for (const branch of branches) publish(row("needs-confirmation", branch, "would be deleted, closing its open PR if any", "planned"));
    return;
  }
  let next = 0; // the first branch without a row yet
  try {
    for (let start = 0; start < branches.length; start += CHUNK) {
      const chunk = branches.slice(start, start + CHUNK);
      const outcome = await deleteChunk(api, repositoryId, chunk);
      if (outcome === "deleted") {
        for (const branch of chunk) publish(row("changed", branch, "deleted", "deleted"));
        next += chunk.length;
        continue;
      }
      // Refused, or the answer was lost: what each branch is now says what happened to it.
      for (const branch of chunk) {
        publish(await settle(api, repo, branch, outcome.refusal, row));
        next++;
      }
    }
  } catch (error) {
    if (!(error instanceof RateLimited)) throw error;
    for (const branch of branches.slice(next)) publish(row("blocked", branch, "not checked: GitHub's rate limit stopped the run", "rate-limited"));
    error.reported = true;
    throw error;
  }
}

/** "deleted" when GitHub deleted the whole chunk; otherwise why not, when GitHub said (it refused it, or its answer was lost). */
async function deleteChunk(api: GitHubApi, repositoryId: string, chunk: ReadonlyArray<Branch>): Promise<"deleted" | { readonly refusal: string }> {
  // force: a deletion is never a fast-forward; beforeOid is the guard.
  const refUpdates = chunk.map((branch) => ({ name: `refs/heads/${branch.name}`, beforeOid: branch.head, afterOid: ZERO, force: true }));
  let reply: Record<string, unknown>;
  try {
    reply = object(await required(api, "POST", "graphql", { query: UPDATE_REFS, variables: { repositoryId, refUpdates } }));
  } catch (error) {
    if (error instanceof RateLimited) throw error;
    // Only a lost answer (no reply, or a server error) leaves the outcome open; a refusal like 401/403 is reported as is.
    if (error instanceof GitHubHttpError && error.status < 500) throw error;
    return { refusal: "GitHub's answer was lost" };
  }
  const errors = reply["errors"];
  if (Array.isArray(errors) && errors.some((error) => object(error)["type"] === "RATE_LIMITED")) throw new RateLimited("GitHub's GraphQL rate limit was reached; rerun later");
  const data = reply["data"];
  if ((errors === undefined || errors === null) && data !== null && typeof data === "object" && (data as Record<string, unknown>)["updateRefs"] != null) return "deleted";
  const message = Array.isArray(errors) && errors.length > 0 && typeof object(errors[0])["message"] === "string" ? String(object(errors[0])["message"]) : "no update reported";
  return { refusal: `GitHub refused its batch: ${message.slice(0, 200)}` };
}

async function settle(api: GitHubApi, repo: string, branch: Branch, refusal: string, row: Row): Promise<SetupResult> {
  const response = await api.request("GET", `repos/${repo}/git/ref/heads/${encodeURIComponent(branch.name)}`);
  if (response.status === 404) return row("already-done", branch, "is gone", "gone");
  if (response.status !== 200) return row("blocked", branch, `couldn't be checked (HTTP ${response.status})`, "failed");
  if (sha(object(object(response.body)["object"])["sha"]) !== branch.head) {
    return row("blocked", branch, "moved since it was listed: a tool may be running; rerun when they're idle", "moved");
  }
  return row("blocked", branch, `wasn't deleted (${refusal}); rerun, or delete it by hand if GitHub keeps refusing it`, "refused");
}

function summary(results: ReadonlyArray<SetupResult>, notRun: ReadonlyArray<string>): SetupResult {
  const count = (status: SetupResult["status"]) => results.filter((entry) => entry.status === status).length;
  const data = { deleted: count("changed"), planned: count("needs-confirmation"), blocked: count("blocked"), gone: count("already-done"), notRun };
  if (notRun.length > 0) return result("fixture-cleanup", "summary", "blocked", `Stopped at GitHub's rate limit; not run: ${notRun.join(", ")}`, data);
  if (data.blocked > 0) return result("fixture-cleanup", "summary", "blocked", "Some branches are left; see the blocked rows and rerun before the fixture runs", data);
  if (data.planned > 0) return result("fixture-cleanup", "summary", "needs-confirmation", "Dry run: rerun with --apply to delete them", data);
  // "gone" counts too: after a lost reply the deletion did happen, and the fixtures are clean either way.
  const cleaned = data.deleted + data.gone > 0;
  return result("fixture-cleanup", "summary", cleaned ? "changed" : "already-done", cleaned ? "Fixtures are clean" : "Nothing to clean", data);
}
