import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { exitCode, type SetupResult } from "../src/contracts.ts";
import { fixtureCleanup, fixtureScope, gateCallers, type FixtureCleanupOptions } from "../src/fixture-cleanup.ts";
import type { GitHubApi, GitHubReply } from "../src/github.ts";
import { object } from "../src/github.ts";

const OWNER = "acme";
const REPO = `${OWNER}/supply-chain_TEST_one`;
const OTHER = `${OWNER}/supply-chain_TEST_two`;
const OLD = "1".repeat(40);
const NEW = "2".repeat(40);
const ZERO = "0".repeat(40);
const sha1 = (value: string) => createHash("sha1").update(value).digest("hex");

const workflow = (ref: string, comment = `# v0.6.1`, node = "v4") => [
  "name: supply-chain",
  "on: [pull_request]",
  "jobs:",
  "  setup:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  `      - uses: actions/setup-node@${node}`,
  "  supply-chain:",
  `    uses: leanish/leanish-development/.github/workflows/supply-chain.yml@${ref} ${comment}`,
  "",
].join("\n");
const WORKFLOW = ".github/workflows/supply-chain.yml";
const MAIN_FILES = { [WORKFLOW]: workflow(OLD), "package-lock.json": '{"lockfileVersion":3}\n', "README.md": "fixture\n" };

interface File { readonly text: string; readonly mode: string }
interface Pull {
  number: number; state: "open" | "closed"; merged_at: string | null; created_at: string; body: string | null;
  labels: Array<{ name: string }>; head: { ref: string; sha: string; repo: { full_name: string } | null }; base: { ref: string; sha: string };
}
interface Repo {
  nodeId: string; defaultBranch: string; commits: Map<string, Map<string, File>>; branches: Map<string, string>; pulls: Pull[];
  comments: Array<{ number: number; body: string }>;
}

/** No network: commits, trees, blobs, branches and PRs, with `updateRefs` checking `beforeOid` like GitHub does. */
class FakeFixtures implements GitHubApi {
  readonly calls: Array<{ method: string; path: string; body?: unknown }> = [];
  readonly repos = new Map<string, Repo>();
  readonly truncated = new Set<string>();
  readonly rateLimited = new Set<string>();
  readonly failing = new Set<string>();
  commentStatus = 201;
  commentRateLimited = false;
  /** Replaces the GraphQL reply, to model GitHub's other answers. */
  graphqlReply: GitHubReply | undefined;
  compareFiles: unknown[] | undefined;
  /** Runs right before the PR read that precedes acting, or right before a branch deletion. */
  beforeRead: ((path: string) => void) | undefined;
  beforeDelete: ((repo: Repo, branch: string) => void) | undefined;
  #clock = 0;

  repo(name: string, files: Record<string, string> = MAIN_FILES): Repo {
    const repo: Repo = { nodeId: `R_${name}`, defaultBranch: "main", commits: new Map(), branches: new Map(), pulls: [], comments: [] };
    this.repos.set(name, repo);
    repo.branches.set("main", this.commit(repo, files));
    return repo;
  }

  commit(repo: Repo, files: Record<string, string | File>): string {
    const tree = new Map(Object.entries(files).map(([path, value]) => [path, typeof value === "string" ? { text: value, mode: "100644" } : value]));
    const commit = sha1(`commit ${this.#clock++} ${JSON.stringify([...tree])}`);
    repo.commits.set(commit, tree);
    return commit;
  }

  /** A PR from `branch` whose head is main's files with `changes` applied (undefined removes a file). */
  pull(name: string, branch: string, changes: Record<string, string | File | undefined>, extra: Partial<Pull> & { tool?: "bump-it" | "secure-it" | "none" } = {}): Pull {
    const repo = this.repos.get(name)!;
    const base = repo.branches.get("main")!;
    const files: Record<string, string | File> = Object.fromEntries(repo.commits.get(base)!);
    for (const [path, value] of Object.entries(changes)) {
      if (value === undefined) delete files[path]; else files[path] = value;
    }
    const head = this.commit(repo, files);
    repo.branches.set(branch, head);
    const tool = extra.tool ?? "bump-it";
    const pr: Pull = {
      number: repo.pulls.length + 1, state: "open", merged_at: null, created_at: `2026-10-${String(10 + repo.pulls.length).padStart(2, "0")}T00:00:00Z`,
      body: tool === "none" ? "a person's PR" : `plan\n<!-- leanish:${tool} -->\n`, labels: [],
      head: { ref: branch, sha: head, repo: { full_name: name } }, base: { ref: "main", sha: base }, ...extra,
    };
    repo.pulls.push(pr);
    return pr;
  }

  writes(): Array<{ method: string; path: string; body?: unknown }> {
    return this.calls.filter((call) => call.method !== "GET");
  }

  async request(method: string, path: string, payload?: unknown): Promise<GitHubReply> {
    this.calls.push({ method, path, body: payload });
    const ok = (body?: unknown, status = 200): GitHubReply => ({ status, body });
    if (path === "graphql") return this.#graphql(object(payload));
    const [route, query] = path.split("?");
    const params = new URLSearchParams(query);
    const match = /^repos\/([^/]+\/[^/]+)(?:\/(.*))?$/.exec(route!);
    const name = match![1]!;
    const rest = match![2];
    if (this.rateLimited.has(name)) return { status: 403, body: { message: "rate limit" }, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1790000000" } };
    if (this.failing.has(name)) return ok({ message: "boom" }, 500);
    const repo = this.repos.get(name);
    if (repo === undefined) return ok({ message: "Not Found" }, 404);
    const page = (items: unknown[]) => {
      const number = Number(params.get("page") ?? "1");
      const size = Number(params.get("per_page") ?? "30");
      return ok(items.slice((number - 1) * size, number * size));
    };
    if (method === "GET" && rest === undefined) return ok({ node_id: repo.nodeId, default_branch: repo.defaultBranch });
    if (method === "GET" && rest === "pulls") {
      const head = params.get("head");
      const state = params.get("state");
      return page(repo.pulls.filter((pr) => (state === "all" || pr.state === state) && (head === null || `${OWNER}:${pr.head.ref}` === head)));
    }
    const number = /^pulls\/(\d+)$/.exec(rest ?? "")?.[1];
    if (number !== undefined) {
      const pr = repo.pulls.find((entry) => entry.number === Number(number))!;
      if (method === "GET") {
        this.beforeRead?.(path);
        return ok(structuredClone(pr));
      }
      if (method === "PATCH") { pr.state = "closed"; return ok(pr); }
    }
    const commented = /^issues\/(\d+)\/comments$/.exec(rest ?? "")?.[1];
    if (method === "POST" && commented !== undefined) {
      if (this.commentRateLimited) return { status: 403, body: { message: "secondary rate limit" }, headers: { "retry-after": "60" } };
      if (this.commentStatus >= 300) return ok({ message: "no" }, this.commentStatus);
      repo.comments.push({ number: Number(commented), body: String(object(payload)["body"]) });
      return ok({}, 201);
    }
    if (method === "GET" && rest === "branches") return page([...repo.branches].map(([branch, commit]) => ({ name: branch, commit: { sha: commit } })));
    const compared = /^compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(rest ?? "");
    if (method === "GET" && compared !== null) {
      const [, base, head] = compared;
      return ok({ merge_base_commit: { sha: base }, files: this.compareFiles ?? diff(repo.commits.get(base!)!, repo.commits.get(head!)!) });
    }
    const treed = /^git\/trees\/([0-9a-f]{40})$/.exec(rest ?? "")?.[1];
    if (method === "GET" && treed !== undefined) {
      const files = repo.commits.get(treed)!;
      return ok({ truncated: this.truncated.has(treed), tree: [...files].map(([file, { text, mode }]) => ({ path: file, mode, type: "blob", sha: sha1(`blob ${text}`) })) });
    }
    const blob = /^git\/blobs\/([0-9a-f]{40})$/.exec(rest ?? "")?.[1];
    if (method === "GET" && blob !== undefined) {
      const text = [...repo.commits.values()].flatMap((files) => [...files.values()]).find((file) => sha1(`blob ${file.text}`) === blob)!.text;
      return ok({ encoding: "base64", content: Buffer.from(text).toString("base64") });
    }
    const ref = /^git\/ref\/heads\/(.+)$/.exec(rest ?? "")?.[1];
    if (method === "GET" && ref !== undefined) {
      // GitHub takes the branch raw or percent-encoded.
      const head = repo.branches.get(decodeURIComponent(ref));
      return head === undefined ? ok({ message: "Not Found" }, 404) : ok({ object: { sha: head } });
    }
    throw new Error(`unexpected ${method} ${path}`);
  }

  #graphql(payload: Record<string, unknown>): GitHubReply {
    const variables = object(payload["variables"]);
    const repo = [...this.repos.values()].find((entry) => entry.nodeId === variables["repositoryId"])!;
    const [update] = variables["refUpdates"] as Array<{ name: string; beforeOid: string; afterOid: string; force: boolean }>;
    const branch = update!.name.replace(/^refs\/heads\//, "");
    this.beforeDelete?.(repo, branch);
    if (this.graphqlReply !== undefined) return this.graphqlReply;
    if (update!.afterOid !== ZERO || repo.branches.get(branch) !== update!.beforeOid) {
      return { status: 200, body: { data: { updateRefs: null }, errors: [{ type: "STALE_DATA", message: "ref moved" }] } };
    }
    repo.branches.delete(branch);
    return { status: 200, body: { data: { updateRefs: { clientMutationId: null } } } };
  }
}

function diff(before: Map<string, File>, after: Map<string, File>): unknown[] {
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  return paths.flatMap((filename) => {
    const was = before.get(filename);
    const now = after.get(filename);
    if (was === undefined) return [{ filename, status: "added" }];
    if (now === undefined) return [{ filename, status: "removed" }];
    if (was.text !== now.text) return [{ filename, status: "modified" }];
    return was.mode !== now.mode ? [{ filename, status: "changed" }] : [];
  });
}

const config = (repos: ReadonlyArray<string>) => [
  "repos:", ...repos.flatMap((repo) => [`  - repo: ${repo}`, "    branch: main"]),
  "agent:", "  codingAgent: codex", "  model: m", "  effort: high",
  "commitIdentity:", "  name: n", "  email: n@example.com", "",
].join("\n");
const files = (bumpIt: ReadonlyArray<string>, secureIt = bumpIt) => new Map([["/b.yaml", config(bumpIt)], ["/s.yaml", config(secureIt)]]);

async function run(fake: FakeFixtures, options: Partial<FixtureCleanupOptions> = {}, configs = files([REPO])) {
  const emitted: SetupResult[] = [];
  const results = await fixtureCleanup(
    { bumpItConfig: "/b.yaml", secureItConfig: "/s.yaml", repo: undefined, apply: false, ...options },
    (entry) => emitted.push(entry), fake, async (path) => configs.get(path)!, "/home/test",
  );
  expect(emitted).toEqual(results);
  return { results, exit: exitCode(results), rows: results.filter((entry) => entry.step !== "summary"), summary: results.at(-1)! };
}

describe("gate caller masking", () => {
  it("masks only the ref and a version comment of the gate's own caller", () => {
    const before = gateCallers(workflow(OLD))!;
    const after = gateCallers(workflow(NEW, "# v0.7.0"))!;
    expect(before.refs).toEqual([OLD]);
    expect(after.refs).toEqual([NEW]);
    expect(after.masked).toBe(before.masked);
  });

  it("keeps any other comment text in the comparison", () => {
    expect(gateCallers(workflow(NEW, "# pinned by hand"))!.masked).not.toBe(gateCallers(workflow(OLD, "# v0.6.1"))!.masked);
  });

  it("ignores another workflow of the same repository, a `uses:` inside a script and quoted callers' quotes", () => {
    const other = "jobs:\n  x:\n    uses: leanish/leanish-development/.github/workflows/other.yml@abc # v1\n";
    expect(gateCallers(other)!.refs).toEqual([]);
    const script = "jobs:\n  x:\n    steps:\n      - run: |\n          echo uses: leanish/leanish-development/.github/workflows/supply-chain.yml@abc\n";
    expect(gateCallers(script)!.refs).toEqual([]);
    const quoted = `jobs:\n  x:\n    uses: "LeaNish/leanish-development/.github/workflows/supply-chain.yml@${OLD}" # v0.6.1\n`;
    expect(gateCallers(quoted)!.refs).toEqual([OLD]);
  });

  it("refuses invalid YAML", () => {
    expect(gateCallers("jobs: [\n")).toBeUndefined();
  });
});

describe("fixture scope", () => {
  const read = (configs: Map<string, string>) => async (path: string) => configs.get(path)!;
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

describe("fixture cleanup of open PRs", () => {
  it("plans closing a dependency PR in a dry run without writing", async () => {
    const fake = new FakeFixtures();
    fake.repo(REPO);
    fake.pull(REPO, "bump-it/2026-10-18-routine", { "package-lock.json": '{"lockfileVersion":3,"x":1}\n' });
    const { rows, summary, exit } = await run(fake);
    expect(rows).toEqual([expect.objectContaining({ step: "pull", status: "needs-confirmation", data: expect.objectContaining({ classification: "other", action: "close", tool: "bump-it" }) })]);
    expect(summary).toMatchObject({ status: "needs-confirmation", message: expect.stringContaining("--apply") });
    expect(exit).toBe(2);
    expect(fake.writes()).toEqual([]);
  });

  it("closes, explains and deletes the branch with GitHub's beforeOid check when applying", async () => {
    const fake = new FakeFixtures();
    const repo = fake.repo(REPO);
    const pr = fake.pull(REPO, "secure-it/2026-10-18-security", { "package-lock.json": "{}\n" }, { tool: "secure-it" });
    const { rows, exit } = await run(fake, { apply: true });
    expect(rows).toEqual([expect.objectContaining({ status: "changed", data: expect.objectContaining({ tool: "secure-it", deletion: "deleted", commented: true }) })]);
    expect(exit).toBe(0);
    expect(repo.pulls[0]!.state).toBe("closed");
    expect(repo.comments).toEqual([{ number: 1, body: expect.stringContaining("fixture-cleanup") }]);
    expect(repo.branches.has(pr.head.ref)).toBe(false);
    const mutation = fake.calls.find((call) => call.path === "graphql")!;
    expect(object(mutation.body)["variables"]).toEqual({ repositoryId: repo.nodeId, refUpdates: [{ name: `refs/heads/${pr.head.ref}`, beforeOid: pr.head.sha, afterOid: ZERO, force: true }] });
  });

  it("keeps a gate-only upgrade open, recognized by its label alone", async () => {
    const fake = new FakeFixtures();
    fake.repo(REPO);
    fake.pull(REPO, "bump-it/2026-10-18-leanish-leanish-development-major", { [WORKFLOW]: workflow(NEW, "# v0.7.0") }, { body: null, labels: [{ name: "leanish:bump-it" }] });
    const { rows, exit } = await run(fake, { apply: true });
    expect(rows).toEqual([expect.objectContaining({ status: "already-done", data: expect.objectContaining({ classification: "gate-upgrade", action: "keep" }) })]);
    expect(exit).toBe(0);
    expect(fake.writes()).toEqual([]);
  });

  it.each([
    ["the gate and setup-node in the same workflow", { [WORKFLOW]: workflow(NEW, "# v0.7.0", "v5") }],
    ["the gate and a lockfile", { [WORKFLOW]: workflow(NEW, "# v0.7.0"), "package-lock.json": "{}\n" }],
    ["the gate to a tag instead of a SHA", { [WORKFLOW]: workflow("v0.7.0", "") }],
    ["the gate with its workflow made executable", { [WORKFLOW]: { text: workflow(NEW, "# v0.7.0"), mode: "100755" } }],
    ["the gate and a renamed second workflow", { [WORKFLOW]: workflow(NEW, "# v0.7.0"), "README.md": undefined, ".github/workflows/readme.yml": "fixture\n" }],
  ])("closes a mixed PR moving %s and asks for a gate-only repin", async (_case, changes) => {
    const fake = new FakeFixtures();
    fake.repo(REPO);
    fake.pull(REPO, "bump-it/2026-10-18-routine", changes);
    const { rows, summary, exit } = await run(fake, { apply: true });
    expect(rows).toEqual([expect.objectContaining({ status: "changed", data: expect.objectContaining({ classification: "mixed" }) })]);
    expect(summary).toMatchObject({ status: "needs-confirmation", data: expect.objectContaining({ repinsNeeded: [REPO] }) });
    expect(exit).toBe(2);
  });

  it("treats a workflow PR that doesn't move the gate as other, also with invalid YAML", async () => {
    const fake = new FakeFixtures();
    fake.repo(REPO);
    fake.pull(REPO, "bump-it/2026-10-18-actions-setup-node-major", { [WORKFLOW]: workflow(OLD, "# v0.6.1", "v5") });
    fake.pull(REPO, "bump-it/2026-10-18-broken", { [WORKFLOW]: "jobs: [\n" });
    const { rows } = await run(fake);
    expect(rows.map((row) => row.data?.["classification"])).toEqual(["other", "other"]);
  });

  it.each([
    ["a person's PR", { tool: "none" as const }, "bump-it/2026-10-18-routine"],
    ["a branch without the tool's date prefix", {}, "bump-it/routine"],
    ["another base branch", { base: { ref: "release", sha: "" } }, "bump-it/2026-10-18-routine"],
    ["a fork's head", { head: { ref: "bump-it/2026-10-18-routine", sha: "", repo: { full_name: "fork/supply-chain_TEST_one" } } }, "bump-it/2026-10-18-routine"],
    ["the other tool's marker", { tool: "secure-it" as const }, "bump-it/2026-10-18-routine"],
  ])("leaves %s alone", async (_case, extra, branch) => {
    const fake = new FakeFixtures();
    fake.repo(REPO);
    const pr = fake.pull(REPO, branch, { "package-lock.json": "{}\n" }, extra as Partial<Pull>);
    if (pr.base.sha === "") pr.base.sha = fake.repos.get(REPO)!.branches.get("main")!;
    if (pr.head.sha === "") pr.head.sha = fake.repos.get(REPO)!.branches.get(branch)!;
    const { rows } = await run(fake, { apply: true });
    expect(rows.filter((row) => row.step === "pull")).toEqual([expect.objectContaining({ status: "already-done", data: expect.objectContaining({ reason: "not-owned", action: "none" }) })]);
    expect(fake.calls.filter((call) => call.method === "PATCH" || call.path === "graphql")).toEqual([]);
  });

  it("still deletes the branch when the explanation comment fails", async () => {
    const fake = new FakeFixtures();
    const repo = fake.repo(REPO);
    fake.pull(REPO, "bump-it/2026-10-18-routine", { "package-lock.json": "{}\n" });
    fake.commentStatus = 403;
    const { rows } = await run(fake, { apply: true });
    expect(rows).toEqual([expect.objectContaining({ status: "changed", data: expect.objectContaining({ commented: false, deletion: "deleted" }) })]);
    expect(repo.branches.has("bump-it/2026-10-18-routine")).toBe(false);
  });

  it("keeps a branch that moved before its deletion, and a rerun leaves it for a person", async () => {
    const fake = new FakeFixtures();
    const repo = fake.repo(REPO);
    fake.pull(REPO, "bump-it/2026-10-18-routine", { "package-lock.json": "{}\n" });
    const pushed = fake.commit(repo, MAIN_FILES);
    fake.beforeDelete = (target, branch) => target.branches.set(branch, pushed);
    const first = await run(fake, { apply: true });
    expect(first.rows).toEqual([expect.objectContaining({ status: "blocked", data: expect.objectContaining({ deletion: "moved" }) })]);
    expect(repo.branches.get("bump-it/2026-10-18-routine")).toBe(pushed);
    fake.beforeDelete = undefined;
    const second = await run(fake, { apply: true });
    expect(second.rows).toEqual([expect.objectContaining({ step: "branch", status: "blocked", message: expect.stringContaining("moved after its PR #1 was closed") })]);
  });

  it("reports a branch already gone as done", async () => {
    const fake = new FakeFixtures();
    fake.repo(REPO);
    fake.pull(REPO, "bump-it/2026-10-18-routine", { "package-lock.json": "{}\n" });
    fake.beforeDelete = (target, branch) => target.branches.delete(branch);
    const { rows, exit } = await run(fake, { apply: true });
    expect(rows).toEqual([expect.objectContaining({ status: "changed", data: expect.objectContaining({ deletion: "missing" }) })]);
    expect(exit).toBe(0);
  });

  it("reclassifies from the PR as read right before acting", async () => {
    const fake = new FakeFixtures();
    const repo = fake.repo(REPO);
    const pr = fake.pull(REPO, "bump-it/2026-10-18-leanish-leanish-development-major", { [WORKFLOW]: workflow(NEW, "# v0.7.0") });
    // Between listing and the fresh read, the tool pushes a lockfile change too: no longer a gate-only upgrade.
    fake.beforeRead = () => {
      const head = fake.commit(repo, { ...Object.fromEntries(repo.commits.get(pr.head.sha)!), "package-lock.json": "{}\n" });
      repo.branches.set(pr.head.ref, head);
      pr.head.sha = head;
      fake.beforeRead = undefined;
    };
    const { rows } = await run(fake, { apply: true });
    expect(rows).toEqual([expect.objectContaining({ status: "changed", data: expect.objectContaining({ classification: "mixed", head: pr.head.sha, deletion: "deleted" }) })]);
  });

  it("skips a PR closed between listing and acting", async () => {
    const fake = new FakeFixtures();
    const repo = fake.repo(REPO);
    fake.pull(REPO, "bump-it/2026-10-18-routine", { "package-lock.json": "{}\n" });
    fake.beforeRead = () => { repo.pulls[0]!.state = "closed"; };
    const { rows } = await run(fake, { apply: true });
    expect(rows[0]).toMatchObject({ step: "pull", status: "already-done", data: { reason: "closed" } });
    expect(fake.calls.filter((call) => call.method === "PATCH")).toEqual([]);
  });

  it("blocks a PR without closing it on truncated evidence", async () => {
    const fake = new FakeFixtures();
    const repo = fake.repo(REPO);
    const pr = fake.pull(REPO, "bump-it/2026-10-18-routine", { "package-lock.json": "{}\n" });
    fake.truncated.add(pr.head.sha);
    const blocked = expect.objectContaining({ step: "pull", status: "blocked", data: expect.objectContaining({ number: 1, reason: "incomplete-evidence" }) });
    expect((await run(fake, { apply: true })).rows).toEqual([blocked]);
    fake.truncated.clear();
    fake.compareFiles = Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}`, status: "modified" }));
    expect((await run(fake, { apply: true })).rows).toEqual([blocked]);
    expect(repo.pulls[0]!.state).toBe("open");
  });

  it("keeps the repin signal and the next PRs when a later PR fails", async () => {
    const fake = new FakeFixtures();
    const repo = fake.repo(REPO);
    fake.pull(REPO, "bump-it/2026-10-18-routine", { [WORKFLOW]: workflow(NEW, "# v0.7.0"), "package-lock.json": "{}\n" });
    const broken = fake.pull(REPO, "secure-it/2026-10-18-security", { "package-lock.json": '{"a":1}\n' }, { tool: "secure-it" });
    fake.pull(REPO, "bump-it/2026-10-18-glob-major", { "package-lock.json": '{"b":1}\n' });
    fake.truncated.add(broken.head.sha);
    const { rows, summary, exit } = await run(fake, { apply: true });
    expect(rows.map((row) => [row.step, row.status, row.data?.["number"]])).toEqual([["pull", "changed", 1], ["pull", "blocked", 2], ["pull", "changed", 3]]);
    expect(summary.data).toMatchObject({ repinsNeeded: [REPO] });
    expect(exit).toBe(1);
    expect(repo.pulls.map((pr) => pr.state)).toEqual(["closed", "open", "closed"]);
  });

  it("reports a PR closed before a rate limit hit its comment, keeps its repin, and stops", async () => {
    const fake = new FakeFixtures();
    const repo = fake.repo(REPO);
    fake.repo(OTHER);
    fake.pull(REPO, "bump-it/2026-10-18-routine", { [WORKFLOW]: workflow(NEW, "# v0.7.0"), "package-lock.json": "{}\n" });
    fake.commentRateLimited = true;
    const { rows, summary } = await run(fake, { apply: true }, files([REPO, OTHER]));
    expect(rows).toEqual([expect.objectContaining({ step: "pull", status: "blocked", data: expect.objectContaining({ number: 1, reason: "rate-limited" }) })]);
    expect(summary.data).toMatchObject({ repinsNeeded: [REPO] });
    expect(repo.pulls[0]!.state).toBe("closed");
    expect(fake.calls.some((call) => call.path.startsWith(`repos/${OTHER}`))).toBe(false);
  });

  it("is idempotent: a second run finds nothing to clean", async () => {
    const fake = new FakeFixtures();
    fake.repo(REPO);
    fake.pull(REPO, "bump-it/2026-10-18-routine", { "package-lock.json": "{}\n" });
    await run(fake, { apply: true });
    const again = await run(fake, { apply: true });
    expect(again.rows).toEqual([]);
    expect(again.summary).toMatchObject({ status: "already-done", message: "Nothing to clean" });
  });
});

describe("fixture cleanup of branches left by closed PRs", () => {
  function closedPull(fake: FakeFixtures, branch: string, extra: Partial<Pull> & { tool?: "bump-it" | "secure-it" | "none" } = {}): Pull {
    const pr = fake.pull(REPO, branch, { "package-lock.json": "{}\n" }, extra);
    pr.state = "closed";
    return pr;
  }

  it("deletes the branch of a tool PR closed unmerged, also across many pages of branches", async () => {
    const fake = new FakeFixtures();
    const repo = fake.repo(REPO);
    for (let i = 0; i < 120; i++) repo.branches.set(`topic-${i}`, repo.branches.get("main")!);
    closedPull(fake, "secure-it/2026-10-14-security", { tool: "secure-it" });
    const dry = await run(fake);
    expect(dry.rows).toEqual([expect.objectContaining({ step: "branch", status: "needs-confirmation", data: expect.objectContaining({ action: "delete", number: 1 }) })]);
    expect(fake.writes()).toEqual([]);
    const applied = await run(fake, { apply: true });
    expect(applied.rows).toEqual([expect.objectContaining({ step: "branch", status: "changed", data: expect.objectContaining({ deletion: "deleted" }) })]);
    expect(repo.branches.has("secure-it/2026-10-14-security")).toBe(false);
  });

  it("keeps a merged PR's branch", async () => {
    const fake = new FakeFixtures();
    const repo = fake.repo(REPO);
    closedPull(fake, "bump-it/2026-10-18-leanish-leanish-development-major", { merged_at: "2026-10-18T12:59:00Z" });
    const { rows, exit } = await run(fake, { apply: true });
    expect(rows).toEqual([expect.objectContaining({ status: "already-done", data: expect.objectContaining({ reason: "its latest PR #1 was merged" }) })]);
    expect(exit).toBe(0);
    expect(repo.branches.has("bump-it/2026-10-18-leanish-leanish-development-major")).toBe(true);
  });

  it.each([
    ["no PR", (fake: FakeFixtures) => { const repo = fake.repos.get(REPO)!; repo.branches.set("bump-it/2026-10-14-routine", repo.branches.get("main")!); }, "no PR was ever opened from it"],
    ["a person's latest PR", (fake: FakeFixtures) => { closedPull(fake, "bump-it/2026-10-14-routine"); closedPull(fake, "bump-it/2026-10-14-routine", { tool: "none", created_at: "2026-10-30T00:00:00Z" }); }, "isn't the tool's"],
    ["a push after the PR closed", (fake: FakeFixtures) => { const repo = fake.repos.get(REPO)!; closedPull(fake, "bump-it/2026-10-14-routine"); repo.branches.set("bump-it/2026-10-14-routine", fake.commit(repo, MAIN_FILES)); }, "moved after its PR #1 was closed"],
  ])("keeps a tool-named branch with %s for a person", async (_case, arrange, reason) => {
    const fake = new FakeFixtures();
    fake.repo(REPO);
    arrange(fake);
    const { rows, exit } = await run(fake, { apply: true });
    expect(rows).toEqual([expect.objectContaining({ step: "branch", status: "blocked", data: expect.objectContaining({ reason: expect.stringContaining(reason) }) })]);
    expect(exit).toBe(1);
    expect(fake.calls.filter((call) => call.path === "graphql")).toEqual([]);
  });

  it("rechecks the branch's PRs right before deleting it", async () => {
    const fake = new FakeFixtures();
    const repo = fake.repo(REPO);
    closedPull(fake, "bump-it/2026-10-14-routine");
    let listings = 0;
    const request = fake.request.bind(fake);
    fake.request = async (method, path, body) => {
      if (method === "GET" && path.includes("state=all") && ++listings === 2) repo.pulls[0]!.state = "open";
      return request(method, path, body);
    };
    const { rows } = await run(fake, { apply: true });
    expect(rows).toEqual([expect.objectContaining({ step: "branch", status: "blocked", data: expect.objectContaining({ reason: "changed" }) })]);
    expect(repo.branches.has("bump-it/2026-10-14-routine")).toBe(true);
  });
});

describe("fixture cleanup failures", () => {
  it("stops every repository at GitHub's rate limit", async () => {
    const fake = new FakeFixtures();
    fake.repo(REPO);
    fake.repo(OTHER);
    fake.rateLimited.add(REPO);
    const { rows, summary, exit } = await run(fake, { apply: true }, files([REPO, OTHER]));
    expect(rows).toEqual([expect.objectContaining({ step: "repository", status: "blocked", message: expect.stringContaining("rate limit"), data: { repo: REPO, reason: "rate-limited" } })]);
    expect(summary).toMatchObject({ status: "blocked", data: expect.objectContaining({ notRun: [OTHER] }) });
    expect(exit).toBe(1);
    expect(fake.calls.some((call) => call.path.startsWith(`repos/${OTHER}`))).toBe(false);
  });

  it("stops at GraphQL's rate limit after closing, with the PR reported", async () => {
    const fake = new FakeFixtures();
    const repo = fake.repo(REPO);
    fake.pull(REPO, "bump-it/2026-10-18-routine", { "package-lock.json": "{}\n" });
    fake.graphqlReply = { status: 200, body: { data: null, errors: [{ type: "RATE_LIMITED", message: "slow down" }] } };
    const { rows } = await run(fake, { apply: true });
    expect(rows).toEqual([expect.objectContaining({ step: "pull", status: "blocked", data: expect.objectContaining({ reason: "rate-limited" }) })]);
    expect(repo.branches.has("bump-it/2026-10-18-routine")).toBe(true);
  });

  it("doesn't count a GraphQL reply without errors but without an update as a deletion", async () => {
    const fake = new FakeFixtures();
    fake.repo(REPO);
    fake.pull(REPO, "bump-it/2026-10-18-routine", { "package-lock.json": "{}\n" });
    fake.graphqlReply = { status: 200, body: { data: { updateRefs: null } } };
    const { rows } = await run(fake, { apply: true });
    expect(rows).toEqual([expect.objectContaining({ step: "pull", status: "blocked", message: expect.stringContaining("GitHub refused deleting") })]);
  });

  it("isolates another failure to its repository", async () => {
    const fake = new FakeFixtures();
    fake.repo(REPO);
    fake.repo(OTHER);
    fake.pull(OTHER, "bump-it/2026-10-18-routine", { "package-lock.json": "{}\n" });
    fake.failing.add(REPO);
    const { rows } = await run(fake, { apply: true }, files([REPO, OTHER]));
    expect(rows.map((row) => [row.step, row.status])).toEqual([["repository", "blocked"], ["pull", "changed"]]);
  });

  it("restricts a run to --repo", async () => {
    const fake = new FakeFixtures();
    fake.repo(REPO);
    fake.repo(OTHER);
    await run(fake, { repo: OTHER }, files([REPO, OTHER]));
    expect(fake.calls.every((call) => call.path.startsWith(`repos/${OTHER}`))).toBe(true);
  });
});
