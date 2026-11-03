import { describe, expect, it } from "vitest";

import { GitHubApiError } from "@leanish/agent-runtime/github/github-client";
import { createGitHubIssues, MAX_ISSUE_BODY_CHARS } from "../src/github-issues.ts";

const TOKEN = "ghp_secret-token-value";
const REPO = "leanish/widget";

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

/** Fake `fetch` answering each call with the next scripted response. */
function scripted(...responses: Array<Response | Error>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = responses.shift();
    if (next === undefined) throw new Error("unexpected extra fetch");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { fetch: fetchFn, calls };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function apiIssue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 12,
    html_url: `https://github.com/${REPO}/issues/12`,
    title: "zstd-jni: advisory waiting for its fix",
    body: "body",
    state: "open",
    state_reason: null,
    user: { login: "leanish" },
    labels: [{ name: "take-early" }],
    ...overrides,
  };
}

function issues(fetchFn: typeof fetch, env: Record<string, string | undefined> = { GITHUB_TOKEN: TOKEN }) {
  return createGitHubIssues({ env, fetch: fetchFn });
}

describe("createGitHubIssues", () => {
  it("lists a creator's issues across pages, dropping PRs, with the token and no redirects", async () => {
    const full = Array.from({ length: 100 }, (_, i) => apiIssue({ number: i + 1 }));
    const { fetch, calls } = scripted(
      json([...full.slice(0, 99), apiIssue({ number: 100, pull_request: { url: "x" } })]),
      json([apiIssue({ number: 101, body: null, user: null, state: "closed", state_reason: "not_planned", labels: [] })]),
    );
    const listed = await issues(fetch).listIssues({ repo: REPO, creator: "leanish", label: "leanish:secure-it-issue" });
    expect(listed).toHaveLength(100);
    expect(listed.some((issue) => issue.number === 100)).toBe(false);
    expect(listed.at(-1)).toEqual({ number: 101, url: `https://github.com/${REPO}/issues/12`, title: "zstd-jni: advisory waiting for its fix", body: "", state: "closed", stateReason: "not_planned", author: null, labels: [] });
    expect(calls.map((call) => call.url)).toEqual([
      `https://api.github.com/repos/${REPO}/issues?state=all&creator=leanish&labels=leanish%3Asecure-it-issue&per_page=100&page=1`,
      `https://api.github.com/repos/${REPO}/issues?state=all&creator=leanish&labels=leanish%3Asecure-it-issue&per_page=100&page=2`,
    ]);
    expect((calls[0]!.init.headers as Record<string, string>)["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.init.redirect).toBe("error");
  });

  it("reads exactly the cap's worth whole, and fails past it instead of returning part of the history", async () => {
    const page = json(Array.from({ length: 100 }, (_, i) => ({ id: i, event: "labeled", actor: { login: "leanish" }, created_at: "2026-11-03T00:00:00Z", label: { name: "x" } })));
    const whole = scripted(...Array.from({ length: 10 }, () => page.clone()), json([]));
    expect(await issues(whole.fetch).listEvents({ repo: REPO, number: 12 })).toHaveLength(1000);
    const over = scripted(...Array.from({ length: 11 }, () => page.clone()));
    await expect(issues(over.fetch).listEvents({ repo: REPO, number: 12 })).rejects.toThrow("more than 10 pages");
  });

  it("reads comments and events with their authors, and label names on label events", async () => {
    const { fetch } = scripted(
      json([{ id: 5, user: { login: "leanish" }, body: "take-early: actively exploited", created_at: "2026-11-03T08:00:00Z", updated_at: "2026-11-03T08:00:00Z" }]),
      json([
        { id: 7, event: "labeled", actor: { login: "leanish" }, created_at: "2026-11-03T08:01:00Z", label: { name: "take-early" } },
        { id: 8, event: "closed", actor: null, created_at: "2026-11-03T09:00:00Z" },
      ]),
    );
    const client = issues(fetch);
    expect(await client.listComments({ repo: REPO, number: 12 })).toEqual([
      { id: 5, author: "leanish", body: "take-early: actively exploited", createdAt: "2026-11-03T08:00:00Z", updatedAt: "2026-11-03T08:00:00Z" },
    ]);
    expect(await client.listEvents({ repo: REPO, number: 12 })).toEqual([
      { id: 7, event: "labeled", actor: "leanish", createdAt: "2026-11-03T08:01:00Z", label: "take-early" },
      { id: 8, event: "closed", actor: null, createdAt: "2026-11-03T09:00:00Z" },
    ]);
  });

  it("creates, updates and comments with exactly what's given", async () => {
    const { fetch, calls } = scripted(
      json(apiIssue(), 201),
      json(apiIssue({ state: "closed", state_reason: "not_planned" })),
      json({ id: 9, user: { login: "leanish" }, body: "superseded by #13", created_at: "2026-11-03T10:00:00Z", updated_at: "2026-11-03T10:00:00Z" }, 201),
    );
    const client = issues(fetch);
    await client.createIssue({ repo: REPO, title: "t", body: "b", labels: ["leanish:secure-it-issue"] });
    const closed = await client.updateIssue({ repo: REPO, number: 12, state: "closed", stateReason: "not_planned" });
    await client.createComment({ repo: REPO, number: 12, body: "superseded by #13" });
    expect(closed).toMatchObject({ state: "closed", stateReason: "not_planned" });
    expect(calls.map((call) => [call.init.method, call.url, call.init.body])).toEqual([
      ["POST", `https://api.github.com/repos/${REPO}/issues`, JSON.stringify({ title: "t", body: "b", labels: ["leanish:secure-it-issue"] })],
      ["PATCH", `https://api.github.com/repos/${REPO}/issues/12`, JSON.stringify({ state: "closed", state_reason: "not_planned" })],
      ["POST", `https://api.github.com/repos/${REPO}/issues/12/comments`, JSON.stringify({ body: "superseded by #13" })],
    ]);
  });

  it("refuses invalid input before calling GitHub", async () => {
    const { fetch, calls } = scripted();
    const client = issues(fetch);
    await expect(client.createIssue({ repo: REPO, title: "", body: "b", labels: [] })).rejects.toThrow("title must have");
    await expect(client.createIssue({ repo: REPO, title: "t", body: "x".repeat(MAX_ISSUE_BODY_CHARS + 1), labels: [] })).rejects.toThrow("body over");
    await expect(client.updateIssue({ repo: REPO, number: 12 })).rejects.toThrow("nothing to change");
    await expect(client.updateIssue({ repo: REPO, number: 12, stateReason: "completed" })).rejects.toThrow("a state reason without a state");
    await expect(client.getIssue({ repo: "a/b/c", number: 1 })).rejects.toThrow("invalid repo");
    // Dot segments match the name pattern but would leave `/repos/` once the URL is normalized.
    await expect(client.getIssue({ repo: "../orgs", number: 1 })).rejects.toThrow("invalid repo");
    await expect(client.getIssue({ repo: "acme/..", number: 1 })).rejects.toThrow("invalid repo");
    await expect(client.removeLabel({ repo: REPO, number: 12, label: "" })).rejects.toThrow("invalid label");
    await expect(client.removeLabel({ repo: REPO, number: 12, label: ".." })).rejects.toThrow("invalid label");
    await expect(client.getIssue({ repo: REPO, number: 0 })).rejects.toThrow("invalid issue number");
    await expect(client.permission({ repo: REPO, login: "a/b" })).rejects.toThrow("invalid login");
    await expect(issues(fetch, {}).login()).rejects.toThrow("GITHUB_TOKEN is not set");
    expect(calls).toHaveLength(0);
  });

  it("refuses a PR read as an issue", async () => {
    const { fetch } = scripted(json(apiIssue({ pull_request: { url: "x" } })));
    await expect(issues(fetch).getIssue({ repo: REPO, number: 12 })).rejects.toThrow("not an issue");
  });

  it("reads an issue", async () => {
    const { fetch, calls } = scripted(json(apiIssue()));
    expect(await issues(fetch).getIssue({ repo: REPO, number: 12 })).toEqual({
      number: 12, url: `https://github.com/${REPO}/issues/12`, title: "zstd-jni: advisory waiting for its fix", body: "body", state: "open", stateReason: null, author: "leanish", labels: ["take-early"],
    });
    expect(calls[0]!.url).toBe(`https://api.github.com/repos/${REPO}/issues/12`);
  });

  it("removes a label, and takes a 404 for removed only when the issue reads without it", async () => {
    const { fetch, calls } = scripted(
      new Response(null, { status: 204 }),
      json({ message: "Label does not exist" }, 404),
      json(apiIssue({ labels: [] })),
      json({ message: "Not Found" }, 404),
      json(apiIssue()),
      json({ message: "Not Found" }, 404),
      json({ message: "Not Found" }, 404),
    );
    const client = issues(fetch);
    await client.removeLabel({ repo: REPO, number: 12, label: "take early/now" });
    expect([calls[0]!.init.method, calls[0]!.url]).toEqual(["DELETE", `https://api.github.com/repos/${REPO}/issues/12/labels/take%20early%2Fnow`]);
    await client.removeLabel({ repo: REPO, number: 12, label: "take-early" });
    // Still on the issue after a 404: not removed.
    await expect(client.removeLabel({ repo: REPO, number: 12, label: "take-early" })).rejects.toThrow("HTTP 404");
    // A wrong issue or a repository the token can't see: not removed either.
    await expect(client.removeLabel({ repo: REPO, number: 99, label: "take-early" })).rejects.toThrow("HTTP 404");
  });

  it("treats a non-collaborator as no permission, and refuses what isn't one", async () => {
    const { fetch } = scripted(
      json({ message: "Forbidden" }, 403),
      json({ message: "Not Found" }, 404),
      json({ permission: "write", role_name: "maintain" }),
      json({ permission: "write", role_name: "release-manager" }),
      json({ permission: "admin", role_name: "custom" }),
      json({ permission: "read", role_name: "triage" }),
      json({ role_name: "custom" }),
      json({ message: "rate limit" }, 403, { "x-ratelimit-remaining": "0" }),
    );
    const client = issues(fetch);
    await expect(client.removeLabel({ repo: REPO, number: 12, label: "take-early" })).rejects.toThrow("forbidden (HTTP 403)");
    expect(await client.permission({ repo: REPO, login: "stranger" })).toBe("none");
    expect(await client.permission({ repo: REPO, login: "leanish" })).toBe("maintain");
    expect(await client.permission({ repo: REPO, login: "leanish" })).toBe("write");
    expect(await client.permission({ repo: REPO, login: "leanish" })).toBe("admin");
    expect(await client.permission({ repo: REPO, login: "leanish" })).toBe("triage");
    await expect(client.permission({ repo: REPO, login: "leanish" })).rejects.toThrow("malformed permission");
    const limited = client.permission({ repo: REPO, login: "leanish" });
    await expect(limited).rejects.toBeInstanceOf(GitHubApiError);
    await expect(limited).rejects.toThrow("rate limited");
  });

  it("reads the token's login and rejects malformed answers", async () => {
    const { fetch } = scripted(json({ login: "leanish" }), json({ login: 5 }), json(apiIssue({ state: "merged" })), new Response("not json"));
    const client = issues(fetch);
    expect(await client.login()).toBe("leanish");
    await expect(client.login()).rejects.toThrow("malformed user");
    await expect(client.getIssue({ repo: REPO, number: 12 })).rejects.toThrow("malformed issue");
    await expect(client.getIssue({ repo: REPO, number: 12 })).rejects.toThrow("response is not JSON");
  });

  it("names the operation and status, never the token, when the network fails", async () => {
    const { fetch } = scripted(new TypeError("fetch failed"));
    const failure = issues(fetch).getIssue({ repo: REPO, number: 12 });
    await expect(failure).rejects.toThrow("GitHub getIssue failed: TypeError");
    await expect(failure).rejects.not.toThrow(TOKEN);
  });
});
