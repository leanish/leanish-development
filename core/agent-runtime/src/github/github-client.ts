// Copied from leanish/leanish-development core/runtime/src/needs/github-client.ts at c6282df; see PROVENANCE.md.
// Local changes: `GitHubApiError`'s parameter properties written as fields; the body and title caps exported; the
// required `headChecks` option picks check runs with the Actions-jobs fallback, or Actions jobs only; the Actions
// path keeps a jobless run only when no newer run in its workflow/event group supersedes it, and each job's steps.
import { RuntimeError } from "../errors.ts";
import type {
  GitHubCheckRun,
  GitHubCheckStep,
  GitHubClient,
  GitHubCommitStatus,
  GitHubHeadChecks,
  GitHubRequiredCheck,
  GitHubRequiredChecks,
  GitHubPullRequest,
} from "../types/clients.ts";

const API_ORIGIN = "https://api.github.com";
const PAGE_SIZE = 100;
/** Hard stop on pagination, far above anything a PR's head realistically carries. */
const MAX_PAGES = 10;
const DEFAULT_TIMEOUT_MS = 15_000;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
/** Branch names the client sends in a URL path: plain refs, never `..` or an option. */
const BRANCH_PATTERN = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;
/** Conservative client cap on a PR body, in UTF-16 units, for both create and update. */
export const MAX_BODY_CHARS = 65_536;
export const MAX_TITLE_CHARS = 256;

/**
 * Any GitHub-side failure of a `GitHubClient` call: missing token, network
 * error or timeout, non-2xx, GraphQL errors, malformed response. The message
 * names the operation and the HTTP status only — never the token, headers or
 * response body.
 */
export class GitHubApiError extends RuntimeError {
  readonly operation: string;
  readonly reason: string;
  readonly status: number | undefined;

  constructor(operation: string, reason: string, status?: number) {
    super(`GitHub ${operation} failed: ${reason}${status !== undefined ? ` (HTTP ${status})` : ""}`);
    this.operation = operation;
    this.reason = reason;
    this.status = status;
  }
}

/**
 * Where `headChecks` reads the head's CI from; the host's token decides which it can read:
 *   - `check-runs-then-jobs`: the latest check runs of every app, and the Actions jobs only when the Checks API answers
 *     403 (a token without Checks read on a private repo);
 *   - `actions-jobs`: only the Actions jobs, for a token that never has Checks read (a fine-grained PAT offers none).
 */
export type HeadChecksMode = "check-runs-then-jobs" | "actions-jobs";

const HEAD_CHECKS_MODES: ReadonlySet<string> = new Set<HeadChecksMode>(["check-runs-then-jobs", "actions-jobs"]);

export interface CreateGitHubClientOptions {
  /** Read on every call, so a missing `GITHUB_TOKEN` fails the call, not the cold start. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Required: no default fits every host, and the wrong one hides checks or calls an API the token can't read. */
  readonly headChecks: HeadChecksMode;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

export function createGitHubClient(options: CreateGitHubClientOptions): GitHubClient {
  // JavaScript callers get no type check.
  if (!HEAD_CHECKS_MODES.has(options.headChecks)) {
    throw new Error(`createGitHubClient: headChecks must be 'check-runs-then-jobs' or 'actions-jobs'; got '${String(options.headChecks)}'`);
  }
  const headChecksMode = options.headChecks;
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function request(
    operation: string,
    path: string,
    init?: { readonly method: "POST" | "PATCH" | "DELETE"; readonly body?: string },
  ): Promise<unknown> {
    const token = options.env["GITHUB_TOKEN"];
    if (token === undefined || token.length === 0) {
      throw new GitHubApiError(operation, "GITHUB_TOKEN is not set");
    }
    let response: Response;
    try {
      response = await doFetch(`${API_ORIGIN}${path}`, {
        method: init?.method ?? "GET",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28",
          ...(init?.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(init?.body !== undefined ? { body: init.body } : {}),
        // Never carry the token to wherever a redirect points.
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new GitHubApiError(operation, err instanceof Error ? err.name : "network error");
    }
    if (!response.ok) {
      throw new GitHubApiError(operation, response.status === 403 ? "forbidden" : "unexpected response", response.status);
    }
    if (response.status === 204) return undefined;
    try {
      return await response.json();
    } catch {
      throw new GitHubApiError(operation, "response is not JSON", response.status);
    }
  }

  /** The head's latest check runs, with the Actions jobs instead only when the mode says so or Checks read is refused. */
  async function headCheckRuns(repo: string, sha: string): Promise<Pick<GitHubHeadChecks, "source" | "checkRuns">> {
    if (headChecksMode === "actions-jobs") return { source: "actions-jobs", checkRuns: await latestWorkflowJobs(repo, sha) };
    try {
      return { source: "check-runs", checkRuns: await latestCheckRuns(repo, sha) };
    } catch (err) {
      // A token without Checks read (a fine-grained PAT offers none) gets 403 for a private repo's check runs; its
      // Actions jobs are readable with Actions: read.
      if (!(err instanceof GitHubApiError) || err.status !== 403) throw err;
      return { source: "actions-jobs", checkRuns: await latestWorkflowJobs(repo, sha) };
    }
  }

  async function latestCheckRuns(repo: string, sha: string): Promise<GitHubCheckRun[]> {
    const operation = "headChecks";
    // `filter=latest`: one entry per check name, its most recent run.
    return paged(operation, `/repos/${repo}/commits/${sha}/check-runs?filter=latest`, "check_runs", (value) => toCheckRun(operation, value));
  }

  /**
   * The head's Actions jobs as check runs, like `filter=latest` does for check runs: every run on
   * the head and the jobs of its latest attempt, then the newest job (highest id — a re-run creates
   * new jobs) per workflow, event and job name. Jobs, not just runs: a `continue-on-error` job can
   * fail inside a successful run. A run counts as itself only while it isn't completed (it may
   * still be scheduling jobs, so it stays pending) or when it has no jobs (e.g. it failed to
   * start) and is the newest run in its workflow/event group — never on top of its jobs, so a run
   * whose jobs were all skipped isn't a success.
   */
  async function latestWorkflowJobs(repo: string, sha: string): Promise<GitHubCheckRun[]> {
    const operation = "headChecks";
    const runs = await paged(operation, `/repos/${repo}/actions/runs?head_sha=${sha}`, "workflow_runs", (value) => toWorkflowRun(operation, value));
    const latestRunByGroup = new Map<string, WorkflowRun>();
    for (const run of runs) {
      const group = `${run.workflowId}:${run.event}`;
      const current = latestRunByGroup.get(group);
      if (current === undefined || run.id > current.id) latestRunByGroup.set(group, run);
    }
    const newest = new Map<string, IdentifiedRun>();
    const keep = (key: string, entry: IdentifiedRun): void => {
      const current = newest.get(key);
      if (current === undefined || entry.id > current.id) newest.set(key, entry);
    };
    for (const run of runs) {
      const group = `${run.workflowId}:${run.event}`;
      const jobs = await paged(operation, `/repos/${repo}/actions/runs/${run.id}/jobs?filter=latest`, "jobs", (value) => toJob(operation, value));
      if (run.status !== "completed") keep(`active run ${run.id}`, run);
      else if (jobs.length === 0 && latestRunByGroup.get(group)?.id === run.id) keep(`jobless run ${group}`, run);
      for (const job of jobs) keep(`job ${group}/${job.name}`, job);
    }
    return [...newest.values()].map(({ name, status, conclusion, steps }) => (steps === undefined ? { name, status, conclusion } : { name, status, conclusion, steps }));
  }

  /** Every page of a `{ total_count, <field>: [...] }` listing. */
  async function paged<T>(operation: string, path: string, field: string, map: (value: unknown) => T): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; ; page++) {
      guardPage(operation, page);
      const body = record(operation, await request(operation, `${path}${path.includes("?") ? "&" : "?"}per_page=${PAGE_SIZE}&page=${page}`));
      const values = body[field];
      const total = body["total_count"];
      if (!Array.isArray(values) || typeof total !== "number") throw new GitHubApiError(operation, `malformed ${field} response`);
      items.push(...values.map(map));
      if (values.length < PAGE_SIZE || items.length >= total) return items;
    }
  }

  return {
    async findPullRequests({ repo, branch }) {
      const operation = "findPullRequests";
      const [owner] = splitRepo(operation, repo);
      if (branch.length === 0) throw new GitHubApiError(operation, "empty branch");
      const head = encodeURIComponent(`${owner}:${branch}`);
      const pulls: GitHubPullRequest[] = [];
      for (let page = 1; ; page++) {
        guardPage(operation, page);
        const body = await request(operation, `/repos/${repo}/pulls?head=${head}&state=all&per_page=${PAGE_SIZE}&page=${page}`);
        if (!Array.isArray(body)) throw new GitHubApiError(operation, "malformed response");
        pulls.push(...body.map((item) => toPullRequest(operation, item)));
        if (body.length < PAGE_SIZE) return pulls;
      }
    },

    async headChecks({ repo, sha }) {
      const operation = "headChecks";
      splitRepo(operation, repo);
      if (!SHA_PATTERN.test(sha)) throw new GitHubApiError(operation, "invalid commit sha");
      const { source, checkRuns } = await headCheckRuns(repo, sha);
      // The combined status already keeps only the latest status per context.
      const statuses = await paged(operation, `/repos/${repo}/commits/${sha}/status`, "statuses", (value) => toStatus(operation, value));
      return { source, checkRuns, statuses } satisfies GitHubHeadChecks;
    },

    async requiredChecks({ repo, branch }) {
      const operation = "requiredChecks";
      splitRepo(operation, repo);
      if (branch.length === 0) throw new GitHubApiError(operation, "empty branch");
      const checks = new Map<string, GitHubRequiredCheck>();
      for (let page = 1; ; page++) {
        guardPage(operation, page);
        let body: unknown;
        try {
          body = await request(operation, `/repos/${repo}/rules/branches/${encodeURIComponent(branch)}?per_page=${PAGE_SIZE}&page=${page}`);
        } catch (err) {
          // Refused, not failed: the token can't read the rules, so what they require is unknown, not empty.
          if (err instanceof GitHubApiError && (err.status === 403 || err.status === 404)) return { known: false, reason: `rules unreadable (HTTP ${err.status})` };
          throw err;
        }
        if (!Array.isArray(body)) throw new GitHubApiError(operation, "malformed response");
        for (const rule of body) {
          const value = record(operation, rule);
          if (value["type"] !== "required_status_checks") continue;
          const listed = record(operation, value["parameters"])["required_status_checks"];
          if (!Array.isArray(listed)) throw new GitHubApiError(operation, "malformed required_status_checks");
          for (const item of listed) {
            const check = record(operation, item);
            const context = check["context"];
            const integration = check["integration_id"];
            if (typeof context !== "string" || context.length === 0 || (integration !== undefined && integration !== null && typeof integration !== "number")) {
              throw new GitHubApiError(operation, "malformed required status check");
            }
            const integrationId = typeof integration === "number" ? integration : undefined;
            checks.set(`${context}\u0000${integrationId ?? ""}`, { context, integrationId });
          }
        }
        if (body.length < PAGE_SIZE) return { known: true, checks: [...checks.values()] } satisfies GitHubRequiredChecks;
      }
    },

    async listOpenPullRequests({ repo }) {
      const operation = "listOpenPullRequests";
      splitRepo(operation, repo);
      const pulls: GitHubPullRequest[] = [];
      for (let page = 1; ; page++) {
        guardPage(operation, page);
        const body = await request(operation, `/repos/${repo}/pulls?state=open&per_page=${PAGE_SIZE}&page=${page}`);
        if (!Array.isArray(body)) throw new GitHubApiError(operation, "malformed response");
        pulls.push(...body.map((item) => toPullRequest(operation, item)));
        if (body.length < PAGE_SIZE) return pulls;
      }
    },

    async getPullRequest({ repo, number }) {
      const operation = "getPullRequest";
      splitRepo(operation, repo);
      assertNumber(operation, number);
      return toPullRequest(operation, await request(operation, `/repos/${repo}/pulls/${number}`));
    },

    async markReadyForReview({ nodeId }) {
      await draftMutation("markReadyForReview", "markPullRequestReadyForReview", nodeId, false);
    },

    async convertToDraft({ nodeId }) {
      await draftMutation("convertToDraft", "convertPullRequestToDraft", nodeId, true);
    },

    async createPullRequest({ repo, head, base, title, body, draft }) {
      const operation = "createPullRequest";
      splitRepo(operation, repo);
      assertBranch(operation, head);
      assertBranch(operation, base);
      assertText(operation, title, body);
      const created = await request(operation, `/repos/${repo}/pulls`, {
        method: "POST",
        body: JSON.stringify({ head, base, title, body, draft }),
      });
      return toPullRequest(operation, created);
    },

    async updatePullRequest({ repo, number, title, body }) {
      const operation = "updatePullRequest";
      splitRepo(operation, repo);
      assertNumber(operation, number);
      assertText(operation, title, body);
      return toPullRequest(
        operation,
        await request(operation, `/repos/${repo}/pulls/${number}`, { method: "PATCH", body: JSON.stringify({ title, body }) }),
      );
    },

    async closePullRequest({ repo, number }) {
      const operation = "closePullRequest";
      splitRepo(operation, repo);
      assertNumber(operation, number);
      return toPullRequest(
        operation,
        await request(operation, `/repos/${repo}/pulls/${number}`, { method: "PATCH", body: JSON.stringify({ state: "closed" }) }),
      );
    },

    async addLabels({ repo, number, labels }) {
      const operation = "addLabels";
      splitRepo(operation, repo);
      assertNumber(operation, number);
      if (labels.length === 0 || labels.some((label) => label.length === 0)) throw new GitHubApiError(operation, "empty label");
      await request(operation, `/repos/${repo}/issues/${number}/labels`, { method: "POST", body: JSON.stringify({ labels }) });
    },

    async createComment({ repo, number, body }) {
      const operation = "createComment";
      splitRepo(operation, repo);
      assertNumber(operation, number);
      if (body.trim() === "" || body.length > MAX_BODY_CHARS) throw new GitHubApiError(operation, "invalid comment body");
      await request(operation, `/repos/${repo}/issues/${number}/comments`, { method: "POST", body: JSON.stringify({ body }) });
    },

    async deleteBranch({ repo, branch }) {
      const operation = "deleteBranch";
      splitRepo(operation, repo);
      assertBranch(operation, branch);
      await request(operation, `/repos/${repo}/git/refs/heads/${branch}`, { method: "DELETE" });
    },
  };

  /** A GraphQL draft-state mutation, checked against the state GitHub reports back. */
  async function draftMutation(operation: string, mutation: string, nodeId: string, expectDraft: boolean): Promise<void> {
    if (nodeId.length === 0) throw new GitHubApiError(operation, "empty node id");
    const body = record(
      operation,
      await request(operation, "/graphql", {
        method: "POST",
        body: JSON.stringify({
          query: `mutation($id: ID!) { ${mutation}(input: { pullRequestId: $id }) { pullRequest { isDraft } } }`,
          variables: { id: nodeId },
        }),
      }),
    );
    // GraphQL reports failures with HTTP 200 and an `errors` array.
    if (body["errors"] !== undefined) throw new GitHubApiError(operation, "GraphQL errors");
    const data = body["data"];
    const result = typeof data === "object" && data !== null ? (data as Record<string, unknown>)[mutation] : undefined;
    const pullRequest = typeof result === "object" && result !== null ? (result as Record<string, unknown>)["pullRequest"] : undefined;
    const isDraft = typeof pullRequest === "object" && pullRequest !== null ? (pullRequest as Record<string, unknown>)["isDraft"] : undefined;
    if (isDraft !== expectDraft) throw new GitHubApiError(operation, expectDraft ? "PR not draft after the mutation" : "PR still draft after the mutation");
  }
}

function assertNumber(operation: string, number: number): void {
  if (!Number.isInteger(number) || number <= 0) throw new GitHubApiError(operation, "invalid PR number");
}

function assertBranch(operation: string, branch: string): void {
  if (!BRANCH_PATTERN.test(branch) || branch.includes("..") || branch.endsWith("/")) throw new GitHubApiError(operation, "invalid branch");
}

function assertText(operation: string, title: string, body: string): void {
  if (title.trim() === "" || title.length > MAX_TITLE_CHARS) throw new GitHubApiError(operation, "invalid title");
  if (body.length > MAX_BODY_CHARS) throw new GitHubApiError(operation, "body too long");
}

function splitRepo(operation: string, repo: string): [string, string] {
  if (!REPO_PATTERN.test(repo)) throw new GitHubApiError(operation, "invalid repo");
  const [owner, name] = repo.split("/") as [string, string];
  return [owner, name];
}

function guardPage(operation: string, page: number): void {
  if (page > MAX_PAGES) throw new GitHubApiError(operation, `more than ${MAX_PAGES} pages`);
}

function record(operation: string, value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GitHubApiError(operation, "malformed response");
  }
  return value as Record<string, unknown>;
}

function toPullRequest(operation: string, value: unknown): GitHubPullRequest {
  const pr = record(operation, value);
  const head = record(operation, pr["head"]);
  const base = record(operation, pr["base"]);
  const headRepo = head["repo"] === null ? null : record(operation, head["repo"])["full_name"];
  const user = pr["user"] === null ? null : record(operation, pr["user"])["login"];
  const labels = pr["labels"];
  const body = pr["body"] ?? "";
  const state = pr["state"];
  if (
    typeof pr["number"] !== "number" ||
    typeof pr["node_id"] !== "string" ||
    typeof pr["html_url"] !== "string" ||
    typeof pr["title"] !== "string" ||
    typeof body !== "string" ||
    (state !== "open" && state !== "closed") ||
    typeof pr["draft"] !== "boolean" ||
    (user !== null && typeof user !== "string") ||
    !Array.isArray(labels) ||
    typeof base["ref"] !== "string" ||
    typeof head["sha"] !== "string" ||
    typeof head["ref"] !== "string" ||
    (headRepo !== null && typeof headRepo !== "string")
  ) {
    throw new GitHubApiError(operation, "malformed pull request");
  }
  return {
    number: pr["number"],
    nodeId: pr["node_id"],
    url: pr["html_url"],
    title: pr["title"],
    body,
    state,
    merged: typeof pr["merged_at"] === "string",
    isDraft: pr["draft"],
    author: user,
    labels: labels.map((label) => {
      const name = record(operation, label)["name"];
      if (typeof name !== "string") throw new GitHubApiError(operation, "malformed pull request label");
      return name;
    }),
    baseRef: base["ref"],
    headSha: head["sha"],
    headRef: head["ref"],
    headRepo,
  };
}

function toCheckRun(operation: string, value: unknown): GitHubCheckRun {
  const run = record(operation, value);
  const conclusion = run["conclusion"];
  if (typeof run["name"] !== "string" || typeof run["status"] !== "string" || (conclusion !== null && typeof conclusion !== "string")) {
    throw new GitHubApiError(operation, "malformed check run");
  }
  return { name: run["name"], status: run["status"], conclusion };
}

interface IdentifiedRun extends GitHubCheckRun {
  readonly id: number;
}

interface WorkflowRun extends IdentifiedRun {
  readonly workflowId: number;
  readonly event: string;
}

function toWorkflowRun(operation: string, value: unknown): WorkflowRun {
  const run = identifiedRun(operation, value, "malformed workflow run");
  const item = record(operation, value);
  if (typeof item["workflow_id"] !== "number" || typeof item["event"] !== "string") {
    throw new GitHubApiError(operation, "malformed workflow run");
  }
  return { ...run, workflowId: item["workflow_id"], event: item["event"] };
}

function toJob(operation: string, value: unknown): IdentifiedRun {
  const job = identifiedRun(operation, value, "malformed workflow job");
  const steps = record(operation, value)["steps"];
  if (steps === undefined || steps === null) return job;
  if (!Array.isArray(steps)) throw new GitHubApiError(operation, "malformed workflow job steps");
  return { ...job, steps: steps.map((step) => toStep(operation, step)) };
}

function toStep(operation: string, value: unknown): GitHubCheckStep {
  const step = record(operation, value);
  const conclusion = step["conclusion"];
  if (typeof step["name"] !== "string" || typeof step["status"] !== "string" || (conclusion !== null && typeof conclusion !== "string")) {
    throw new GitHubApiError(operation, "malformed workflow job step");
  }
  return { name: step["name"], status: step["status"], conclusion };
}

function identifiedRun(operation: string, value: unknown, malformed: string): IdentifiedRun {
  const item = record(operation, value);
  const conclusion = item["conclusion"];
  if (
    typeof item["id"] !== "number" ||
    typeof item["name"] !== "string" ||
    typeof item["status"] !== "string" ||
    (conclusion !== null && typeof conclusion !== "string")
  ) {
    throw new GitHubApiError(operation, malformed);
  }
  return { id: item["id"], name: item["name"], status: item["status"], conclusion };
}

function toStatus(operation: string, value: unknown): GitHubCommitStatus {
  const status = record(operation, value);
  if (typeof status["context"] !== "string" || typeof status["state"] !== "string") {
    throw new GitHubApiError(operation, "malformed commit status");
  }
  return { context: status["context"], state: status["state"] };
}
