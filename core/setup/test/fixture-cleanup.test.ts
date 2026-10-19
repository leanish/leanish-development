import { describe, expect, it } from "vitest";

import { exitCode, type SetupResult } from "../src/contracts.ts";
import { fixtureCleanup, type FixtureCleanupOptions } from "../src/fixture-cleanup.ts";
import { fixtureScope } from "../src/fixtures.ts";
import type { GitHubApi, GitHubReply } from "../src/github.ts";
import { object } from "../src/github.ts";

const OWNER = "acme";
const REPO = `${OWNER}/supply-chain_TEST_one`;
const OTHER = `${OWNER}/supply-chain_TEST_two`;
const ZERO = "0".repeat(40);
const sha = (n: number) => n.toString(16).padStart(40, "a");

/** No network: branches per repository, with `updateRefs` checking every beforeOid and applying a call atomically. */
class FakeBranches implements GitHubApi {
  readonly calls: Array<{ method: string; path: string; body?: unknown }> = [];
  readonly repos = new Map<string, { nodeId: string; branches: Map<string, string> }>();
  readonly rateLimited = new Set<string>();
  readonly failing = new Set<string>();
  /** Replaces the GraphQL reply; `lose` applies the deletion, then answers 502. */
  graphql: "ok" | "rate-limited" | "lose" = "ok";
  /** Runs right before GitHub applies a deletion call. */
  beforeDelete: ((branches: Map<string, string>) => void) | undefined;
  #next = 1;

  repo(name: string, branches: ReadonlyArray<string>): Map<string, string> {
    const map = new Map(branches.map((branch) => [branch, sha(this.#next++)]));
    this.repos.set(name, { nodeId: `R_${name}`, branches: map });
    return map;
  }

  graphqlCalls(): number {
    return this.calls.filter((call) => call.path === "graphql").length;
  }

  async request(method: string, path: string, payload?: unknown): Promise<GitHubReply> {
    this.calls.push({ method, path, body: payload });
    const ok = (body?: unknown, status = 200): GitHubReply => ({ status, body });
    if (path === "graphql") return this.#updateRefs(object(payload));
    const [route, query] = path.split("?");
    const params = new URLSearchParams(query);
    const [, name, rest] = /^repos\/([^/]+\/[^/]+)(?:\/(.*))?$/.exec(route!)!;
    if (this.rateLimited.has(name!)) return { status: 403, body: { message: "rate limit" }, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1790000000" } };
    if (this.failing.has(name!)) return ok({ message: "boom" }, 500);
    const repo = this.repos.get(name!)!;
    if (method === "GET" && rest === undefined) return ok({ node_id: repo.nodeId, default_branch: "main" });
    if (method === "GET" && rest === "branches") {
      const page = Number(params.get("page") ?? "1");
      const size = Number(params.get("per_page") ?? "30");
      return ok([...repo.branches].slice((page - 1) * size, page * size).map(([branch, head]) => ({ name: branch, commit: { sha: head } })));
    }
    const ref = /^git\/ref\/heads\/(.+)$/.exec(rest ?? "")?.[1];
    if (method === "GET" && ref !== undefined) {
      const head = repo.branches.get(decodeURIComponent(ref));
      return head === undefined ? ok({ message: "Not Found" }, 404) : ok({ object: { sha: head } });
    }
    throw new Error(`unexpected ${method} ${path}`);
  }

  #updateRefs(payload: Record<string, unknown>): GitHubReply {
    if (this.graphql === "rate-limited") return { status: 200, body: { data: null, errors: [{ type: "RATE_LIMITED", message: "slow down" }] } };
    const variables = object(payload["variables"]);
    const repo = [...this.repos.values()].find((entry) => entry.nodeId === variables["repositoryId"])!;
    const updates = variables["refUpdates"] as Array<{ name: string; beforeOid: string; afterOid: string; force: boolean }>;
    this.beforeDelete?.(repo.branches);
    const names = updates.map((update) => update.name.replace(/^refs\/heads\//, ""));
    if (updates.some((update, i) => update.afterOid !== ZERO || repo.branches.get(names[i]!) !== update.beforeOid)) {
      return { status: 200, body: { data: { updateRefs: null }, errors: [{ type: "UNPROCESSABLE", message: "ref moved" }] } };
    }
    for (const branch of names) repo.branches.delete(branch);
    if (this.graphql === "lose") return { status: 502, body: { message: "bad gateway" } };
    return { status: 200, body: { data: { updateRefs: { clientMutationId: null } } } };
  }
}

const config = (repos: ReadonlyArray<string>) => [
  "repos:", ...repos.flatMap((repo) => [`  - repo: ${repo}`, "    branch: main"]),
  "agent:", "  codingAgent: codex", "  model: m", "  effort: high",
  "commitIdentity:", "  name: n", "  email: n@example.com", "",
].join("\n");
const files = (bumpIt: ReadonlyArray<string>, secureIt = bumpIt) => new Map([["/b.yaml", config(bumpIt)], ["/s.yaml", config(secureIt)]]);
const read = (configs: Map<string, string>) => async (path: string) => configs.get(path)!;

async function run(fake: FakeBranches, options: Partial<FixtureCleanupOptions> = {}, configs = files([REPO])) {
  const emitted: SetupResult[] = [];
  const results = await fixtureCleanup({ bumpItConfig: "/b.yaml", secureItConfig: "/s.yaml", repo: undefined, apply: false, ...options },
    (entry) => emitted.push(entry), fake, read(configs), "/home/test");
  expect(emitted).toEqual(results);
  return { exit: exitCode(results), rows: results.filter((entry) => entry.step !== "summary"), summary: results.at(-1)! };
}

const TOOL_BRANCHES = ["bump-it/2026-10-14-routine", "secure-it/2026-10-16-security", "bump-it/no-date", "secure-it/x"];

describe("fixture scope", () => {
  it("requires both configs to list the same repositories and branches", async () => {
    await expect(fixtureScope({ bumpItConfig: "/b.yaml", secureItConfig: "/s.yaml", repo: undefined }, read(files([REPO], [OTHER])), "/h"))
      .rejects.toThrow("must list the same repositories and branches");
  });

  it("refuses repositories that aren't supply-chain_TEST_ fixtures", async () => {
    await expect(fixtureScope({ bumpItConfig: "/b.yaml", secureItConfig: "/s.yaml", repo: undefined }, read(files(["acme/widget"])), "/h"))
      .rejects.toThrow("isn't a supply-chain_TEST_* fixture repository");
  });

  it("restricts to a listed --repo and refuses an unlisted one", async () => {
    const both = files([REPO, OTHER]);
    expect(await fixtureScope({ bumpItConfig: "/b.yaml", secureItConfig: "/s.yaml", repo: OTHER.toUpperCase() }, read(both), "/h")).toEqual([{ repo: OTHER, branch: "main" }]);
    await expect(fixtureScope({ bumpItConfig: "/b.yaml", secureItConfig: "/s.yaml", repo: `${OWNER}/supply-chain_TEST_three` }, read(both), "/h"))
      .rejects.toThrow("--repo must be one of");
  });
});

describe("fixture cleanup", () => {
  it("plans deleting every bump-it/ and secure-it/ branch, whatever its date, and nothing else, without writing", async () => {
    const fake = new FakeBranches();
    fake.repo(REPO, ["main", ...TOOL_BRANCHES, "bump-it", "fixture-repin/v0.7.0", "feature/bump-it/x", "Bump-it/upper"]);
    const { rows, summary, exit } = await run(fake);
    expect(rows.map((row) => [row.status, row.data?.["branch"]])).toEqual(TOOL_BRANCHES.map((branch) => ["needs-confirmation", branch]));
    expect(summary).toMatchObject({ status: "needs-confirmation", data: { planned: 4 } });
    expect(exit).toBe(2);
    expect(fake.calls.filter((call) => call.method !== "GET")).toEqual([]);
  });

  it("deletes them in one atomic call, each only at the head it was listed at", async () => {
    const fake = new FakeBranches();
    const branches = fake.repo(REPO, ["main", ...TOOL_BRANCHES]);
    const heads = new Map(branches);
    const { rows, summary, exit } = await run(fake, { apply: true });
    expect(rows.map((row) => [row.status, row.data?.["reason"]])).toEqual(TOOL_BRANCHES.map(() => ["changed", "deleted"]));
    expect([...branches.keys()]).toEqual(["main"]);
    expect(summary).toMatchObject({ status: "changed", data: { deleted: 4 } });
    expect(exit).toBe(0);
    const call = fake.calls.find((entry) => entry.path === "graphql")!;
    expect(object(object(call.body)["variables"])["refUpdates"]).toEqual(TOOL_BRANCHES.map((branch) => ({ name: `refs/heads/${branch}`, beforeOid: heads.get(branch), afterOid: ZERO, force: true })));
  });

  it("deletes in chunks of 25 refs", async () => {
    const fake = new FakeBranches();
    const branches = fake.repo(REPO, Array.from({ length: 30 }, (_, i) => `bump-it/b${i}`));
    const { rows } = await run(fake, { apply: true });
    expect(fake.graphqlCalls()).toBe(2);
    expect(rows.every((row) => row.status === "changed")).toBe(true);
    expect(branches.size).toBe(0);
  });

  it("keeps a whole chunk GitHub refused because one branch moved, and a rerun when idle deletes them", async () => {
    const fake = new FakeBranches();
    const branches = fake.repo(REPO, TOOL_BRANCHES);
    fake.beforeDelete = (current) => current.set(TOOL_BRANCHES[0]!, sha(999));
    const first = await run(fake, { apply: true });
    expect(first.rows.map((row) => row.data?.["reason"])).toEqual(["moved", "refused", "refused", "refused"]);
    expect(first.rows.every((row) => row.status === "blocked")).toBe(true);
    expect(first.exit).toBe(1);
    expect(branches.size).toBe(4);
    fake.beforeDelete = undefined;
    const second = await run(fake, { apply: true });
    expect(second.summary).toMatchObject({ status: "changed", data: { deleted: 4 } });
    expect(branches.size).toBe(0);
  });

  it("reports branches gone after a lost reply as clean", async () => {
    const fake = new FakeBranches();
    const branches = fake.repo(REPO, TOOL_BRANCHES);
    fake.graphql = "lose";
    const { rows, summary, exit } = await run(fake, { apply: true });
    expect(rows.map((row) => [row.status, row.data?.["reason"]])).toEqual(TOOL_BRANCHES.map(() => ["already-done", "gone"]));
    expect(summary).toMatchObject({ status: "changed", message: "Fixtures are clean" });
    expect(exit).toBe(0);
    expect(branches.size).toBe(0);
  });

  it("reports a later chunk's refusal after an earlier chunk was deleted", async () => {
    const fake = new FakeBranches();
    const names = Array.from({ length: 30 }, (_, i) => `bump-it/b${i}`);
    const branches = fake.repo(REPO, names);
    let calls = 0;
    fake.beforeDelete = (current) => { if (++calls === 2) current.set(names[29]!, sha(999)); };
    const { rows } = await run(fake, { apply: true });
    expect(rows.slice(0, 25).every((row) => row.status === "changed")).toBe(true);
    expect(rows.slice(25).map((row) => row.data?.["reason"])).toEqual(["refused", "refused", "refused", "refused", "moved"]);
    expect(branches.size).toBe(5);
  });

  it("stops at GraphQL's rate limit, listing what wasn't done and the repositories not run", async () => {
    const fake = new FakeBranches();
    const branches = fake.repo(REPO, TOOL_BRANCHES);
    fake.repo(OTHER, ["bump-it/x"]);
    fake.graphql = "rate-limited";
    const { rows, summary, exit } = await run(fake, { apply: true }, files([REPO, OTHER]));
    expect(rows.map((row) => [row.status, row.data?.["reason"]])).toEqual(TOOL_BRANCHES.map(() => ["blocked", "rate-limited"]));
    expect(summary).toMatchObject({ status: "blocked", data: { notRun: [OTHER] } });
    expect(exit).toBe(1);
    expect(branches.size).toBe(4);
    expect(fake.calls.some((call) => call.path.startsWith(`repos/${OTHER}`))).toBe(false);
  });

  it("stops at REST's rate limit", async () => {
    const fake = new FakeBranches();
    fake.repo(REPO, TOOL_BRANCHES);
    fake.repo(OTHER, ["bump-it/x"]);
    fake.rateLimited.add(REPO);
    const { rows, summary } = await run(fake, { apply: true }, files([REPO, OTHER]));
    expect(rows).toEqual([expect.objectContaining({ step: "repository", status: "blocked", data: { repo: REPO, reason: "rate-limited" } })]);
    expect(summary.data).toMatchObject({ notRun: [OTHER] });
  });

  it("isolates another failure to its repository and restricts a run to --repo", async () => {
    const fake = new FakeBranches();
    fake.repo(REPO, TOOL_BRANCHES);
    const other = fake.repo(OTHER, ["bump-it/x"]);
    fake.failing.add(REPO);
    const { rows } = await run(fake, { apply: true }, files([REPO, OTHER]));
    expect(rows.map((row) => [row.step, row.status])).toEqual([["repository", "blocked"], ["branch", "changed"]]);
    expect(other.size).toBe(0);
    const restricted = new FakeBranches();
    restricted.repo(REPO, TOOL_BRANCHES);
    restricted.repo(OTHER, ["bump-it/x"]);
    await run(restricted, { repo: OTHER }, files([REPO, OTHER]));
    expect(restricted.calls.every((call) => call.path.startsWith(`repos/${OTHER}`))).toBe(true);
  });

  it("finds nothing to clean in a clean fixture", async () => {
    const fake = new FakeBranches();
    fake.repo(REPO, ["main"]);
    const { rows, summary, exit } = await run(fake, { apply: true });
    expect(rows).toEqual([]);
    expect(summary).toMatchObject({ status: "already-done", message: "Nothing to clean" });
    expect(exit).toBe(0);
  });
});
