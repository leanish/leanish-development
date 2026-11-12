import { describe, expect, it } from "vitest";

import { GitHubApiError } from "@leanish/agent-runtime/github/github-client";
import { createGitHubIssues, type LatestClosing, MAX_ISSUE_BODY_CHARS, MAX_ISSUE_TITLE_CHARS } from "../src/github-issues.ts";

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

const typed = (type: string | null) => (type === null ? null : { __typename: type });

/** One issue's latest closing as GitHub answers it. */
const closingOf = (closer: string | null, actor: string | null = "User", id = "CE_kwDOAbc123") =>
  ({ timelineItems: { nodes: [{ id, actor: typed(actor), closer: typed(closer) }] } });

/** A GraphQL answer about the latest closing of each issue: its closer's type, or null when GitHub recorded none. */
function closings(closers: Record<number, string | null>, actor: string | null = "User"): Response {
  const repository = Object.fromEntries(Object.entries(closers).map(([number, closer]) => [`issue${number}`, closingOf(closer, actor, `CE_${number}`)]));
  return json({ data: { repository } });
}

/** The issues a person last closed, out of their latest closings. */
async function persons(answer: Promise<ReadonlyMap<number, LatestClosing>>): Promise<ReadonlySet<number>> {
  return new Set([...await answer].filter(([, closing]) => closing.byPerson).map(([number]) => number));
}

describe("latestClosings", () => {
  it("makes no request for no numbers", async () => {
    const { fetch, calls } = scripted();
    expect(await persons(issues(fetch).latestClosings({ repo: REPO, numbers: [] }))).toEqual(new Set());
    expect(calls).toEqual([]);
  });

  it.each([["Bot"], ["Mannequin"], ["Organization"], [null]])("doesn't take a closing with no closer by a %s actor for a person's", async (actor) => {
    expect(await persons(issues(scripted(closings({ 1: null }, actor)).fetch).latestClosings({ repo: REPO, numbers: [1] }))).toEqual(new Set());
  });

  it("takes only a user's closing with no closer for a person's, whatever the type of any other closer", async () => {
    const { fetch, calls } = scripted(closings({ 1: "PullRequest", 2: "Commit", 3: "ProjectV2", 4: null }));
    expect(await persons(issues(fetch).latestClosings({ repo: REPO, numbers: [1, 2, 3, 4] }))).toEqual(new Set([4]));
    expect(calls[0]!.url).toBe("https://api.github.com/graphql");
    expect(calls[0]!.init.method).toBe("POST");
    const body = JSON.parse(String(calls[0]!.init.body)) as { query: string; variables: unknown };
    expect(body.variables).toEqual({ owner: "leanish", name: "widget" });
    expect(body.query).toContain("issue4: issue(number: 4)");
    // Only the latest closing counts: a reference's after a person's, or the other way around.
    expect(body.query).toContain("timelineItems(itemTypes: [CLOSED_EVENT], last: 1)");
  });

  it("gives each closing's id, a refused one's included", async () => {
    const data = { data: { repository: { issue1: closingOf(null, "User", "CE_one"), issue2: closingOf("PullRequest", "User", "CE_two") } } };
    const answer = await issues(scripted(json({ ...data, errors: [refusal("issue1")] })).fetch).latestClosings({ repo: REPO, numbers: [1, 2] });
    expect(answer).toEqual(new Map([[1, { id: "CE_one", byPerson: false }], [2, { id: "CE_two", byPerson: false }]]));
  });

  it.each([["CE_lADOU-nJG88AAAABYFjlZM8AAAAH-Xh7JA"], ["MDExOkNsb3NlZEV2ZW50+/1="]])("reads a closing id GitHub gives: %s", async (id) => {
    const answer = { data: { repository: { issue1: closingOf(null, "User", id) } } };
    expect((await issues(scripted(json(answer)).fetch).latestClosings({ repo: REPO, numbers: [1] })).get(1)?.id).toBe(id);
  });

  it.each([[undefined], [""], [7], ["CE --> x"], ["x".repeat(201)]])("fails on a closing id it can't put in a marker: %s", async (id) => {
    const answer = { data: { repository: { issue1: { timelineItems: { nodes: [{ id, actor: typed("User"), closer: null }] } } } } };
    await expect(issues(scripted(json(answer)).fetch).latestClosings({ repo: REPO, numbers: [1] })).rejects.toThrow("malformed closing id");
  });

  it("asks about 100 issues per request, each number once", async () => {
    const numbers = Array.from({ length: 101 }, (_, i) => i + 1);
    const firstHundred = Object.fromEntries(numbers.slice(0, 100).map((number) => [number, "PullRequest"]));
    const { fetch, calls } = scripted(closings(firstHundred), closings({ 101: null }));
    expect(await persons(issues(fetch).latestClosings({ repo: REPO, numbers: [...numbers, 1] }))).toEqual(new Set([101]));
    expect(calls).toHaveLength(2);
    expect((JSON.parse(String(calls[1]!.init.body)) as { query: string }).query).toContain("issue101:");
  });

  it("fails on errors beside partial data, even for what the data does answer", async () => {
    const closing = closingOf(null);
    const partial = { data: { repository: { issue1: closing, issue2: closing } }, errors: [{ type: "FORBIDDEN" }] };
    await expect(issues(scripted(json(partial)).fetch).latestClosings({ repo: REPO, numbers: [1, 2] })).rejects.toThrow(GitHubApiError);
  });

  const refusal = (alias: string, field = "closer", type = "FORBIDDEN") =>
    ({ type, path: ["repository", alias, "timelineItems", "nodes", 0, field], message: "Resource not accessible by personal access token" });

  it("doesn't take a closer the token can't read for a person's closing, identical as its data looks, and reads on", async () => {
    // As measured with a token limited to Issues: the closer comes back null, and only the error says there is one.
    const data = { data: { repository: { issue1: closingOf(null), issue2: closingOf(null) } } };
    expect(await persons(issues(scripted(json(data)).fetch).latestClosings({ repo: REPO, numbers: [1, 2] }))).toEqual(new Set([1, 2]));
    const refused = { ...data, errors: [refusal("issue1")] };
    expect(await persons(issues(scripted(json(refused)).fetch).latestClosings({ repo: REPO, numbers: [1, 2] }))).toEqual(new Set([2]));
  });

  it.each<[string, unknown[]]>([
    ["a refusal beside another error", [refusal("issue1"), { type: "NOT_FOUND", path: ["repository", "issue2"] }]],
    ["a refusal of another field", [refusal("issue1", "actor")]],
    ["another error on the closer", [refusal("issue1", "closer", "INTERNAL")]],
    ["a refusal for an issue it didn't ask about", [refusal("issue9")]],
    ["a refusal without a path", [{ type: "FORBIDDEN" }]],
    ["an empty error list", []],
  ])("still fails on %s", async (_, errors) => {
    const answer = { data: { repository: { issue1: closingOf(null), issue2: closingOf(null) } }, errors };
    await expect(issues(scripted(json(answer)).fetch).latestClosings({ repo: REPO, numbers: [1, 2] })).rejects.toThrow(GitHubApiError);
  });

  it("matches a refusal to the batch that got it", async () => {
    const numbers = Array.from({ length: 101 }, (_, i) => i + 1);
    const firstHundred = Object.fromEntries(numbers.slice(0, 100).map((number) => [number, null]));
    const second = (alias: string) => json({ data: { repository: { issue101: closingOf(null) } }, errors: [refusal(alias)] });
    const expected = new Set(numbers.slice(0, 100));
    expect(await persons(issues(scripted(closings(firstHundred), second("issue101")).fetch).latestClosings({ repo: REPO, numbers }))).toEqual(expected);
    await expect(issues(scripted(closings(firstHundred), second("issue1")).fetch).latestClosings({ repo: REPO, numbers })).rejects.toThrow(GitHubApiError);
  });

  it("still reads a refused closing whole: a malformed actor beside it fails", async () => {
    const answer = { data: { repository: { issue1: { timelineItems: { nodes: [{ id: "CE_1", actor: {}, closer: null }] } } } }, errors: [refusal("issue1")] };
    await expect(issues(scripted(json(answer)).fetch).latestClosings({ repo: REPO, numbers: [1] })).rejects.toThrow("malformed actor");
  });

  it.each<[string, unknown, string]>([
    ["names GitHub's error types", [{ type: "FORBIDDEN", message: "secret detail" }, { type: "FORBIDDEN" }, { type: "NOT_FOUND" }], "GraphQL errors: FORBIDDEN, NOT_FOUND"],
    ["says a rate limit as every other method does", [{ type: "RATE_LIMITED" }], "rate limited"],
    ["stays generic without a usable type", [{ type: "not a type" }, null], "GraphQL errors"],
  ])("%s", async (_, errors, reason) => {
    await expect(issues(scripted(json({ errors })).fetch).latestClosings({ repo: REPO, numbers: [1] })).rejects.toMatchObject({ reason });
  });

  it("fails when a later batch does, rather than answer for the earlier ones", async () => {
    const numbers = Array.from({ length: 101 }, (_, i) => i + 1);
    const firstHundred = Object.fromEntries(numbers.slice(0, 100).map((number) => [number, "PullRequest"]));
    await expect(issues(scripted(closings(firstHundred), json({ errors: [{ type: "FORBIDDEN" }] })).fetch).latestClosings({ repo: REPO, numbers })).rejects.toThrow(GitHubApiError);
  });

  it("fails on a refusal", async () => {
    await expect(issues(scripted(json({}, 403)).fetch).latestClosings({ repo: REPO, numbers: [1] })).rejects.toMatchObject({ status: 403 });
  });

  it.each<[string, unknown]>([
    ["no data", {}],
    ["no repository", { data: { repository: null } }],
    ["a missing alias", { data: { repository: {} } }],
    ["a null issue", { data: { repository: { issue1: null } } }],
    ["no timeline", { data: { repository: { issue1: {} } } }],
    ["no closing", { data: { repository: { issue1: { timelineItems: { nodes: [] } } } } }],
    ["no closer field", { data: { repository: { issue1: { timelineItems: { nodes: [{ id: "CE_1", actor: { __typename: "User" } }] } } } } }],
    ["a closer without a type", { data: { repository: { issue1: { timelineItems: { nodes: [{ id: "CE_1", actor: { __typename: "User" }, closer: {} }] } } } } }],
    ["no actor field", { data: { repository: { issue1: { timelineItems: { nodes: [{ id: "CE_1", closer: null }] } } } } }],
    ["an actor without a type", { data: { repository: { issue1: { timelineItems: { nodes: [{ id: "CE_1", actor: {}, closer: null }] } } } } }],
    ["an actor without a type beside a closer", { data: { repository: { issue1: { timelineItems: { nodes: [{ id: "CE_1", actor: {}, closer: { __typename: "PullRequest" } }] } } } } }],
    ["a closer without a type beside a bot", { data: { repository: { issue1: { timelineItems: { nodes: [{ id: "CE_1", actor: { __typename: "Bot" }, closer: {} }] } } } } }],
  ])("fails on %s, so what it can't read never reads as a person's closing", async (_, answer) => {
    await expect(issues(scripted(json(answer)).fetch).latestClosings({ repo: REPO, numbers: [1] })).rejects.toThrow(GitHubApiError);
  });

  it("refuses an invalid number before any request", async () => {
    const { fetch, calls } = scripted();
    await expect(issues(fetch).latestClosings({ repo: REPO, numbers: [0] })).rejects.toThrow("invalid issue number");
    expect(calls).toEqual([]);
  });
});

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
    expect(calls[0]!.init.redirect).toBe("manual");
  });

  it("answers a transferred issue's redirect with its status, never following it", async () => {
    const { fetch, calls } = scripted(json({ message: "Moved Permanently", url: "https://api.github.com/repositories/1/issues/12" }, 301, { location: "https://api.github.com/repositories/1/issues/12" }));
    const read = issues(fetch).getIssue({ repo: REPO, number: 12 });
    await expect(read).rejects.toMatchObject({ status: 301, message: expect.stringContaining("moved") });
    await expect(read).rejects.toBeInstanceOf(GitHubApiError);
    expect(calls).toHaveLength(1);
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

  it("takes a title at GitHub's limit, and refuses one past it before calling GitHub", async () => {
    const refused = scripted();
    await expect(issues(refused.fetch).createIssue({ repo: REPO, title: "t".repeat(MAX_ISSUE_TITLE_CHARS + 1), body: "b", labels: [] })).rejects.toThrow("title must have");
    expect(refused.calls).toEqual([]);
    const { fetch, calls } = scripted(json(apiIssue(), 201));
    await issues(fetch).createIssue({ repo: REPO, title: "t".repeat(MAX_ISSUE_TITLE_CHARS), body: "b", labels: [] });
    expect(calls).toHaveLength(1);
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

  it("takes a label still on the issue in another casing after a 404 for not removed", async () => {
    const { fetch } = scripted(json({ message: "Not Found" }, 404), json(apiIssue({ labels: [{ name: "Take-Early" }] })));
    await expect(issues(fetch).removeLabel({ repo: REPO, number: 12, label: "take-early" })).rejects.toThrow("HTTP 404");
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
