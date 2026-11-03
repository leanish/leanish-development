/**
 * Issues, their comments, events and labels, and the people who act on them: what secure-it needs to track advisories
 * as issues and to read a `take-early` authorization. Apart from the shared `GitHubClient`, which the incubator also
 * implements and consumes: only these tools need issues. Every method throws `GitHubApiError` on any GitHub-side
 * problem (missing token, network failure or timeout, non-2xx, malformed response, more pages than the cap), so an
 * unreadable history never reads as an empty one.
 */
import { GitHubApiError } from "@leanish/agent-runtime/github/github-client";

const API_ORIGIN = "https://api.github.com";
const PAGE_SIZE = 100;
/** Hard stop on pagination: 1,000 issues, comments or events; past it a call fails rather than read part of a history. */
const MAX_PAGES = 10;
/** A tool's own issues, open and closed, for as long as it runs on a repository: 5,000 before it says so. */
const ISSUE_PAGES = 50;
const DEFAULT_TIMEOUT_MS = 15_000;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/** GitHub logins: alphanumerics and single hyphens; `[bot]` suffixes appear on apps. */
const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\[bot\])?$/;
/** Conservative client cap on an issue or comment body, in UTF-16 units, as for PR bodies. */
export const MAX_ISSUE_BODY_CHARS = 65_536;
export const MAX_ISSUE_TITLE_CHARS = 256;

export interface GitHubIssue {
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly body: string;
  readonly state: "open" | "closed";
  /** `completed`, `not_planned`, `reopened`, or null (GitHub's `state_reason`). */
  readonly stateReason: string | null;
  /** The author's login; null when GitHub gives no user (a deleted account may also show as `ghost`). */
  readonly author: string | null;
  readonly labels: ReadonlyArray<string>;
}

export interface GitHubIssueComment {
  readonly id: number;
  readonly author: string | null;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One entry of an issue's event history: labels added or removed, closings and reopenings, among others. */
export interface GitHubIssueEvent {
  readonly id: number;
  /** GitHub's event name: `labeled`, `unlabeled`, `closed`, `reopened`, ... */
  readonly event: string;
  /** Who did it; null when GitHub gives no user (a deleted account may also show as `ghost`). */
  readonly actor: string | null;
  readonly createdAt: string;
  /** The label's name, for `labeled` and `unlabeled`. */
  readonly label?: string;
}

/** A person's effective permission on a repository; `none` when they have no access at all. */
export type RepositoryPermission = "admin" | "maintain" | "write" | "triage" | "read" | "none";

export interface GitHubIssues {
  /**
   * Every issue (open and closed, never a PR) `creator` opened in `repo` with `label`. The label keeps the listing to the
   * tool's own issues, so the login's PRs and other issues, however many, never fill its pages.
   */
  listIssues(args: { readonly repo: string; readonly creator: string; readonly label: string }): Promise<ReadonlyArray<GitHubIssue>>;
  getIssue(args: { readonly repo: string; readonly number: number }): Promise<GitHubIssue>;
  /** Opens an issue with `labels` (GitHub creates a label that doesn't exist yet). */
  createIssue(args: { readonly repo: string; readonly title: string; readonly body: string; readonly labels: ReadonlyArray<string> }): Promise<GitHubIssue>;
  /** Changes only what's given: the body, and the state with GitHub's reason for a closing. */
  updateIssue(args: {
    readonly repo: string;
    readonly number: number;
    readonly body?: string;
    readonly state?: "open" | "closed";
    readonly stateReason?: "completed" | "not_planned" | "reopened";
  }): Promise<GitHubIssue>;
  listComments(args: { readonly repo: string; readonly number: number }): Promise<ReadonlyArray<GitHubIssueComment>>;
  createComment(args: { readonly repo: string; readonly number: number; readonly body: string }): Promise<GitHubIssueComment>;
  listEvents(args: { readonly repo: string; readonly number: number }): Promise<ReadonlyArray<GitHubIssueEvent>>;
  /** Resolves when the label is gone, including when it already was. */
  removeLabel(args: { readonly repo: string; readonly number: number; readonly label: string }): Promise<void>;
  /**
   * `login`'s effective permission; `none` on a 404, which is GitHub's answer for a non-collaborator but also for a
   * repository the token can't see: either way no permission is established, so callers must fail closed on it.
   */
  permission(args: { readonly repo: string; readonly login: string }): Promise<RepositoryPermission>;
  /** The login the token acts as. */
  login(): Promise<string>;
}

export interface CreateGitHubIssuesOptions {
  /** Read on every call, so a missing `GITHUB_TOKEN` fails the call, not the construction. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

export function createGitHubIssues(options: CreateGitHubIssuesOptions): GitHubIssues {
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function request(operation: string, path: string, init?: { readonly method: "POST" | "PATCH" | "DELETE"; readonly body?: string }): Promise<{ readonly status: number; readonly body: unknown }> {
    const token = options.env["GITHUB_TOKEN"];
    if (token === undefined || token.length === 0) throw new GitHubApiError(operation, "GITHUB_TOKEN is not set");
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
    if (!response.ok) return { status: response.status, body: refusal(operation, response) };
    if (response.status === 204) return { status: 204, body: undefined };
    try {
      return { status: response.status, body: await response.json() };
    } catch {
      throw new GitHubApiError(operation, "response is not JSON", response.status);
    }
  }

  /** The body of a 2xx answer; any other status throws. */
  async function ok(operation: string, path: string, init?: { readonly method: "POST" | "PATCH" | "DELETE"; readonly body?: string }): Promise<unknown> {
    const answer = await request(operation, path, init);
    if (answer.body instanceof GitHubApiError) throw answer.body;
    return answer.body;
  }

  /**
   * Every page of a plain JSON array listing, until a short page. A full last page reads one more to know it was the
   * last: past the cap, only an empty one is accepted, so exactly the cap's worth still reads whole.
   */
  async function paged<T>(operation: string, path: string, map: (value: unknown) => T | undefined, maxPages = MAX_PAGES): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; ; page++) {
      const values = await ok(operation, `${path}${path.includes("?") ? "&" : "?"}per_page=${PAGE_SIZE}&page=${page}`);
      if (!Array.isArray(values)) throw new GitHubApiError(operation, "malformed listing");
      if (page > maxPages && values.length > 0) throw new GitHubApiError(operation, `more than ${maxPages} pages`);
      for (const value of values) {
        const item = map(value);
        if (item !== undefined) items.push(item);
      }
      if (values.length < PAGE_SIZE) return items;
    }
  }

  return {
    async listIssues({ repo, creator, label }) {
      const operation = "listIssues";
      checkRepo(operation, repo);
      checkLogin(operation, creator);
      checkLabel(operation, label);
      // The issues listing includes PRs; those carry `pull_request` and are dropped. A tool keeps every issue it opened
      // (closed ones too, for dismissals), so its listing reads more pages than others: still all of them, or an error.
      return paged(operation, `/repos/${repo}/issues?state=all&creator=${encodeURIComponent(creator)}&labels=${encodeURIComponent(label)}`, (value) =>
        record(operation, value)["pull_request"] === undefined ? toIssue(operation, value) : undefined, ISSUE_PAGES);
    },
    async getIssue({ repo, number }) {
      const operation = "getIssue";
      checkRepo(operation, repo);
      checkNumber(operation, number);
      const value = await ok(operation, `/repos/${repo}/issues/${number}`);
      if (record(operation, value)["pull_request"] !== undefined) throw new GitHubApiError(operation, "not an issue");
      return toIssue(operation, value);
    },
    async createIssue({ repo, title, body, labels }) {
      const operation = "createIssue";
      checkRepo(operation, repo);
      checkText(operation, title, body);
      for (const label of labels) checkLabel(operation, label);
      return toIssue(operation, await ok(operation, `/repos/${repo}/issues`, { method: "POST", body: JSON.stringify({ title, body, labels }) }));
    },
    async updateIssue({ repo, number, body, state, stateReason }) {
      const operation = "updateIssue";
      checkRepo(operation, repo);
      checkNumber(operation, number);
      if (body !== undefined) checkBody(operation, body);
      if (stateReason !== undefined && state === undefined) throw new GitHubApiError(operation, "a state reason without a state");
      const change = { ...(body === undefined ? {} : { body }), ...(state === undefined ? {} : { state }), ...(stateReason === undefined ? {} : { state_reason: stateReason }) };
      if (Object.keys(change).length === 0) throw new GitHubApiError(operation, "nothing to change");
      return toIssue(operation, await ok(operation, `/repos/${repo}/issues/${number}`, { method: "PATCH", body: JSON.stringify(change) }));
    },
    async listComments({ repo, number }) {
      const operation = "listComments";
      checkRepo(operation, repo);
      checkNumber(operation, number);
      return paged(operation, `/repos/${repo}/issues/${number}/comments`, (value) => toComment(operation, value));
    },
    async createComment({ repo, number, body }) {
      const operation = "createComment";
      checkRepo(operation, repo);
      checkNumber(operation, number);
      checkBody(operation, body);
      return toComment(operation, await ok(operation, `/repos/${repo}/issues/${number}/comments`, { method: "POST", body: JSON.stringify({ body }) }));
    },
    async listEvents({ repo, number }) {
      const operation = "listEvents";
      checkRepo(operation, repo);
      checkNumber(operation, number);
      return paged(operation, `/repos/${repo}/issues/${number}/events`, (value) => toEvent(operation, value));
    },
    async removeLabel({ repo, number, label }) {
      const operation = "removeLabel";
      checkRepo(operation, repo);
      checkNumber(operation, number);
      checkLabel(operation, label);
      const answer = await request(operation, `/repos/${repo}/issues/${number}/labels/${encodeURIComponent(label)}`, { method: "DELETE" });
      if (!(answer.body instanceof GitHubApiError)) return;
      if (answer.status !== 404) throw answer.body;
      // A 404 is also a wrong issue or a repository the token can't see: only an issue read without the label says it's gone.
      const issue = toIssue(operation, await ok(operation, `/repos/${repo}/issues/${number}`));
      if (issue.labels.includes(label)) throw answer.body;
    },
    async permission({ repo, login }) {
      const operation = "permission";
      checkRepo(operation, repo);
      checkLogin(operation, login);
      const answer = await request(operation, `/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`);
      // 404: not a collaborator (or no such account): no permission at all.
      if (answer.body instanceof GitHubApiError) {
        if (answer.status === 404) return "none";
        throw answer.body;
      }
      return toPermission(operation, answer.body);
    },
    async login() {
      const operation = "login";
      const value = record(operation, await ok(operation, "/user"))["login"];
      if (typeof value !== "string" || !LOGIN_PATTERN.test(value)) throw new GitHubApiError(operation, "malformed user");
      return value;
    },
  };
}

/** Why GitHub refused a request, as the shared client says it: a rate limit whose headers say so, or a refusal. */
function refusal(operation: string, response: Response): GitHubApiError {
  const limited = response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after");
  const reason = limited && (response.status === 403 || response.status === 429) ? "rate limited" : response.status === 403 ? "forbidden" : "unexpected response";
  return new GitHubApiError(operation, reason, response.status);
}

function checkRepo(operation: string, repo: string): void {
  // `.` and `..` match the pattern but would move the URL out of `/repos/` once it's normalized.
  if (!REPO_PATTERN.test(repo) || repo.split("/").some((part) => part === "." || part === "..")) throw new GitHubApiError(operation, "invalid repo");
}

function checkNumber(operation: string, number: number): void {
  if (!Number.isSafeInteger(number) || number <= 0) throw new GitHubApiError(operation, "invalid issue number");
}

function checkLogin(operation: string, login: string): void {
  if (!LOGIN_PATTERN.test(login)) throw new GitHubApiError(operation, "invalid login");
}

function checkLabel(operation: string, label: string): void {
  // `.` and `..` survive encoding and would move a path to the issue's whole label collection, or above it.
  if (label.length === 0 || label.length > 50 || label === "." || label === "..") throw new GitHubApiError(operation, "invalid label");
}

function checkText(operation: string, title: string, body: string): void {
  if (title.length === 0 || title.length > MAX_ISSUE_TITLE_CHARS) throw new GitHubApiError(operation, `title must have 1-${MAX_ISSUE_TITLE_CHARS} characters`);
  checkBody(operation, body);
}

function checkBody(operation: string, body: string): void {
  if (body.length > MAX_ISSUE_BODY_CHARS) throw new GitHubApiError(operation, `body over ${MAX_ISSUE_BODY_CHARS} characters`);
}

function record(operation: string, value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new GitHubApiError(operation, "malformed response");
  return value as Record<string, unknown>;
}

/** A user object's login, or null when GitHub sends none. */
function loginOf(operation: string, value: unknown, malformed: string): string | null {
  if (value === null) return null;
  const login = record(operation, value)["login"];
  if (typeof login !== "string") throw new GitHubApiError(operation, malformed);
  return login;
}

function toIssue(operation: string, value: unknown): GitHubIssue {
  const issue = record(operation, value);
  const body = issue["body"] ?? "";
  const state = issue["state"];
  const stateReason = issue["state_reason"] ?? null;
  const labels = issue["labels"];
  if (
    typeof issue["number"] !== "number" ||
    typeof issue["html_url"] !== "string" ||
    typeof issue["title"] !== "string" ||
    typeof body !== "string" ||
    (state !== "open" && state !== "closed") ||
    (stateReason !== null && typeof stateReason !== "string") ||
    !Array.isArray(labels)
  ) {
    throw new GitHubApiError(operation, "malformed issue");
  }
  return {
    number: issue["number"],
    url: issue["html_url"],
    title: issue["title"],
    body,
    state,
    stateReason,
    author: loginOf(operation, issue["user"], "malformed issue author"),
    labels: labels.map((label) => {
      const name = record(operation, label)["name"];
      if (typeof name !== "string") throw new GitHubApiError(operation, "malformed issue label");
      return name;
    }),
  };
}

function toComment(operation: string, value: unknown): GitHubIssueComment {
  const comment = record(operation, value);
  const body = comment["body"] ?? "";
  if (typeof comment["id"] !== "number" || typeof body !== "string" || typeof comment["created_at"] !== "string" || typeof comment["updated_at"] !== "string") {
    throw new GitHubApiError(operation, "malformed issue comment");
  }
  return { id: comment["id"], author: loginOf(operation, comment["user"], "malformed comment author"), body, createdAt: comment["created_at"], updatedAt: comment["updated_at"] };
}

function toEvent(operation: string, value: unknown): GitHubIssueEvent {
  const event = record(operation, value);
  if (typeof event["id"] !== "number" || typeof event["event"] !== "string" || typeof event["created_at"] !== "string") {
    throw new GitHubApiError(operation, "malformed issue event");
  }
  const base = { id: event["id"], event: event["event"], actor: loginOf(operation, event["actor"], "malformed event actor"), createdAt: event["created_at"] };
  if (event["event"] !== "labeled" && event["event"] !== "unlabeled") return base;
  const name = record(operation, event["label"])["name"];
  if (typeof name !== "string") throw new GitHubApiError(operation, "malformed event label");
  return { ...base, label: name };
}

const PERMISSIONS: ReadonlySet<string> = new Set<RepositoryPermission>(["admin", "maintain", "write", "triage", "read", "none"]);

/**
 * The effective role: `role_name` when it's a built-in one (it knows maintain and triage), else the legacy `permission`
 * field, which maps custom roles onto admin, write, read or none. Anything else is malformed, never a guess.
 */
function toPermission(operation: string, value: unknown): RepositoryPermission {
  const answer = record(operation, value);
  const role = answer["role_name"];
  if (typeof role === "string" && PERMISSIONS.has(role)) return role as RepositoryPermission;
  const legacy = answer["permission"];
  if (typeof legacy !== "string" || !PERMISSIONS.has(legacy)) throw new GitHubApiError(operation, "malformed permission");
  return legacy as RepositoryPermission;
}
