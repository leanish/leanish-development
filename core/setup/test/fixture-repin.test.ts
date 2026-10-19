import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { exitCode, type SetupResult } from "../src/contracts.ts";
import { fixtureRepin, gateCallers, repinned, type FixtureRepinOptions } from "../src/fixture-repin.ts";
import type { GitHubApi, GitHubReply } from "../src/github.ts";
import { object } from "../src/github.ts";

const OWNER = "acme";
const REPO = `${OWNER}/supply-chain_TEST_one`;
const OTHER = `${OWNER}/supply-chain_TEST_two`;
const OLD = "1".repeat(40);
const NEW = "2".repeat(40);
const RELEASE = { tag: "v0.7.0", sha: NEW };
const WORKFLOW = ".github/workflows/supply-chain.yml";
const BRANCH = "fixture-repin/v0.7.0";
const sha1 = (value: string) => createHash("sha1").update(value).digest("hex");
const caller = (ref: string, comment = "# v0.6.1") => `    uses: leanish/leanish-development/.github/workflows/supply-chain.yml@${ref} ${comment}`.trimEnd();
const workflow = (ref: string, comment?: string) => [
  "name: supply-chain", "on:", "  pull_request:", "permissions:", "  contents: read", "jobs:", "  supply-chain:", caller(ref, comment), "    with:", "      java: '25'", "",
].join("\n");

interface Commit { readonly parent: string | undefined; readonly files: ReadonlyMap<string, string> }

/** No network: commits, branches, contents with blob-SHA preconditions, compare and PRs. */
class FakeFixture implements GitHubApi {
  readonly calls: Array<{ method: string; path: string; body?: unknown }> = [];
  readonly commits = new Map<string, Commit>();
  readonly branches = new Map<string, string>();
  readonly pulls: Array<{ number: number; head: string; base: string; title: string; body: string }> = [];
  /** Runs right after the contents write lands, to model a concurrent push. */
  afterPut: (() => void) | undefined;
  #clock = 0;

  constructor(text: string) {
    this.branches.set("main", this.commit(undefined, new Map([[WORKFLOW, text], ["README.md", "fixture\n"]])));
  }

  commit(parent: string | undefined, files: ReadonlyMap<string, string>): string {
    const id = sha1(`commit ${this.#clock++}`);
    this.commits.set(id, { parent, files });
    return id;
  }

  text(branch = "main"): string {
    return this.commits.get(this.branches.get(branch)!)!.files.get(WORKFLOW)!;
  }

  writes(): Array<{ method: string; path: string }> {
    return this.calls.filter((call) => call.method !== "GET");
  }

  async request(method: string, path: string, payload?: unknown): Promise<GitHubReply> {
    this.calls.push({ method, path, body: payload });
    const ok = (body?: unknown, status = 200): GitHubReply => ({ status, body });
    const [route, query] = path.split("?");
    const params = new URLSearchParams(query);
    const [, name, rest] = /^repos\/([^/]+\/[^/]+)(?:\/(.*))?$/.exec(route!)!;
    if (name !== REPO && name !== OTHER) return ok({ message: "Not Found" }, 404);
    const body = payload === undefined ? {} : object(payload);
    if (method === "GET" && rest === undefined) return ok({ default_branch: "main" });
    const ref = /^git\/ref\/heads\/(.+)$/.exec(rest ?? "")?.[1];
    if (method === "GET" && ref !== undefined) {
      const head = this.branches.get(decodeURIComponent(ref));
      return head === undefined ? ok({ message: "Not Found" }, 404) : ok({ object: { sha: head } });
    }
    if (method === "POST" && rest === "git/refs") {
      const branch = String(body["ref"]).replace(/^refs\/heads\//, "");
      if (this.branches.has(branch)) return ok({ message: "Reference already exists" }, 422);
      this.branches.set(branch, String(body["sha"]));
      return ok({}, 201);
    }
    if (rest === `contents/${WORKFLOW}`) {
      if (method === "GET") {
        const text = this.commits.get(params.get("ref")!)?.files.get(WORKFLOW);
        if (text === undefined) return ok({ message: "Not Found" }, 404);
        return ok({ type: "file", encoding: "base64", sha: sha1(`blob ${text}`), content: Buffer.from(text, "utf8").toString("base64") });
      }
      if (method === "PUT") {
        const branch = String(body["branch"]);
        const parent = this.branches.get(branch)!;
        const files = new Map(this.commits.get(parent)!.files);
        if (sha1(`blob ${files.get(WORKFLOW)}`) !== body["sha"]) return ok({ message: "does not match" }, 409);
        files.set(WORKFLOW, Buffer.from(String(body["content"]), "base64").toString("utf8"));
        this.branches.set(branch, this.commit(parent, files));
        this.afterPut?.();
        return ok({}, 200);
      }
    }
    const compared = /^compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(rest ?? "");
    if (method === "GET" && compared !== null) {
      const [, base, head] = compared;
      const chain: string[] = [];
      for (let at: string | undefined = head; at !== undefined && at !== base; at = this.commits.get(at)?.parent) chain.push(at);
      const reached = chain.length === 0 || this.commits.get(chain.at(-1)!)?.parent === base;
      const before = this.commits.get(base!)!.files;
      const after = this.commits.get(head!)!.files;
      const files = [...new Set([...before.keys(), ...after.keys()])].flatMap((filename) =>
        before.get(filename) === after.get(filename) ? [] : [{ filename, status: before.has(filename) && after.has(filename) ? "modified" : "added" }]);
      return ok({ ahead_by: chain.length, behind_by: reached ? 0 : 1, files });
    }
    if (rest === "pulls") {
      if (method === "GET") return ok(this.pulls.filter((pr) => `${OWNER}:${pr.head}` === params.get("head")).map((pr) => ({ number: pr.number, base: { ref: pr.base }, html_url: `https://github.com/${REPO}/pull/${pr.number}` })));
      const pr = { number: this.pulls.length + 1, head: String(body["head"]), base: String(body["base"]), title: String(body["title"]), body: String(body["body"]) };
      this.pulls.push(pr);
      return ok({ number: pr.number, html_url: `https://github.com/${REPO}/pull/${pr.number}` }, 201);
    }
    throw new Error(`unexpected ${method} ${path}`);
  }
}

const config = (repos: ReadonlyArray<string>) => [
  "repos:", ...repos.flatMap((repo) => [`  - repo: ${repo}`, "    branch: main"]),
  "agent:", "  codingAgent: codex", "  model: m", "  effort: high",
  "commitIdentity:", "  name: n", "  email: n@example.com", "",
].join("\n");
const configs = new Map([["/b.yaml", config([REPO])], ["/s.yaml", config([REPO])]]);

async function run(fake: FakeFixture, options: Partial<FixtureRepinOptions> = {}) {
  const emitted: SetupResult[] = [];
  const results = await fixtureRepin({ bumpItConfig: "/b.yaml", secureItConfig: "/s.yaml", repo: undefined, release: "v0.7.0", apply: false, ...options },
    (entry) => emitted.push(entry), fake, async (path) => configs.get(path)!, "/home/test", async () => RELEASE);
  expect(emitted).toEqual(results);
  return { exit: exitCode(results), rows: results.filter((entry) => entry.step !== "summary"), summary: results.at(-1)! };
}

describe("gate caller rewrite", () => {
  it("changes only each caller's ref and version comment, keeping a BOM, CRLF line ends and quotes", () => {
    const text = `\uFEFF${workflow(OLD).replaceAll("\n", "\r\n")}`;
    const quoted = text.replace(`supply-chain.yml@${OLD}`, `supply-chain.yml@${OLD}"`).replace("uses: leanish", 'uses: "leanish');
    expect(repinned(text, RELEASE)).toBe(text.replace(`@${OLD} # v0.6.1`, `@${NEW} # v0.7.0`));
    expect(repinned(quoted, RELEASE)).toBe(quoted.replace(`@${OLD}" # v0.6.1`, `@${NEW}" # v0.7.0`));
  });

  it("rewrites every caller, and adds the version comment where there was none", () => {
    const text = `jobs:\n  a:\n${caller(OLD)}\n  b:\n${caller(OLD, "")}\n`;
    expect(repinned(text, RELEASE)).toBe(`jobs:\n  a:\n${caller(NEW, "# v0.7.0")}\n  b:\n${caller(NEW, "# v0.7.0")}\n`);
  });

  it.each([
    ["no caller", "jobs:\n  x:\n    uses: leanish/leanish-development/.github/workflows/other.yml@abc # v1\n", "has no gate caller"],
    ["an escaped '@'", `jobs:\n  x:\n    uses: "leanish/leanish-development/.github/workflows/supply-chain.yml\\x40${OLD}" # v0.6.1\n`, "can't be edited in place"],
    ["invalid YAML", "jobs: [\n", "isn't valid YAML"],
    ["another comment", workflow(OLD, "# pinned by hand"), "a comment other than its version"],
  ])("refuses a workflow with %s", (_case, text, message) => {
    expect(() => repinned(text, RELEASE)).toThrow(message);
  });

  it("keeps the spacing before an existing comment", () => {
    expect(repinned(workflow(OLD, "    # v0.6.1"), RELEASE)).toBe(workflow(NEW, "    # v0.7.0"));
  });

  it.each([
    ["a block-scalar caller", `jobs:\n  x:\n    uses: >-\n      leanish/leanish-development/.github/workflows/supply-chain.yml@${OLD}\n\n`],
    ["an aliased caller next to a plain one", `refs:\n  g: &g leanish/leanish-development/.github/workflows/supply-chain.yml@${OLD}\njobs:\n  a:\n${caller(OLD)}\n  b:\n    uses: *g\n`],
  ])("refuses %s rather than rewriting part of it", (_case, text) => {
    expect(() => repinned(text, RELEASE)).toThrow("can't be edited in place");
  });

  it("doesn't count a `uses:` inside a script as a caller", () => {
    expect(gateCallers("jobs:\n  x:\n    steps:\n      - run: |\n          echo uses: leanish/leanish-development/.github/workflows/supply-chain.yml@abc\n")!.callers).toEqual([]);
  });
});

describe("fixture repin", () => {
  it("refuses any release but the highest stable one", async () => {
    await expect(run(new FakeFixture(workflow(OLD)), { release: "v0.6.2" })).rejects.toThrow("--release must be the highest stable release, v0.7.0");
  });

  it("plans the PR in a dry run without writing", async () => {
    const fake = new FakeFixture(workflow(OLD));
    const { rows, exit } = await run(fake);
    expect(rows).toEqual([expect.objectContaining({ status: "needs-confirmation", data: expect.objectContaining({ branch: BRANCH, release: "v0.7.0", sha: NEW }) })]);
    expect(exit).toBe(2);
    expect(fake.writes()).toEqual([]);
  });

  it("opens one PR whose only change is the caller line", async () => {
    const fake = new FakeFixture(workflow(OLD));
    const { rows, summary, exit } = await run(fake, { apply: true });
    expect(rows).toEqual([expect.objectContaining({ status: "changed", data: expect.objectContaining({ reason: "pr-opened", pr: `https://github.com/${REPO}/pull/1` }) })]);
    expect(fake.text(BRANCH)).toBe(workflow(NEW, "# v0.7.0"));
    expect(fake.text("main")).toBe(workflow(OLD));
    expect(fake.pulls).toEqual([expect.objectContaining({ head: BRANCH, base: "main", title: "moving the supply-chain gate to v0.7.0" })]);
    expect(summary).toMatchObject({ status: "changed" });
    expect(exit).toBe(0);
  });

  it("does nothing where the caller already has the SHA and its version comment", async () => {
    const fake = new FakeFixture(workflow(NEW, "# v0.7.0"));
    const { rows, exit } = await run(fake, { apply: true });
    expect(rows).toEqual([expect.objectContaining({ status: "already-done", data: expect.objectContaining({ reason: "pinned" }) })]);
    expect(exit).toBe(0);
    expect(fake.writes()).toEqual([]);
  });

  it("still repins a caller at the SHA with the wrong version comment", async () => {
    const fake = new FakeFixture(workflow(NEW, "# v0.6.1"));
    await run(fake, { apply: true });
    expect(fake.text(BRANCH)).toBe(workflow(NEW, "# v0.7.0"));
  });

  it("resumes from a branch left without a commit, from a commit without a PR, and with the PR already open", async () => {
    const empty = new FakeFixture(workflow(OLD));
    empty.branches.set(BRANCH, empty.branches.get("main")!);
    expect((await run(empty, { apply: true })).rows[0]).toMatchObject({ status: "changed", data: { reason: "pr-opened" } });
    expect(empty.text(BRANCH)).toBe(workflow(NEW, "# v0.7.0"));

    const committed = new FakeFixture(workflow(OLD));
    await run(committed, { apply: true });
    committed.pulls.length = 0;
    const puts = committed.calls.filter((call) => call.method === "PUT").length;
    expect((await run(committed, { apply: true })).rows[0]).toMatchObject({ status: "changed", data: { reason: "pr-opened" } });
    expect(committed.calls.filter((call) => call.method === "PUT").length).toBe(puts);

    expect((await run(committed, { apply: true })).rows[0]).toMatchObject({ status: "changed", data: { reason: "pr-exists" } });
    expect(committed.pulls).toHaveLength(1);
  });

  it("blocks on a repin branch carrying anything else", async () => {
    const fake = new FakeFixture(workflow(OLD));
    const main = fake.branches.get("main")!;
    fake.branches.set(BRANCH, fake.commit(main, new Map([...fake.commits.get(main)!.files, ["README.md", "changed\n"]])));
    const { rows, exit } = await run(fake, { apply: true });
    expect(rows).toEqual([expect.objectContaining({ status: "blocked", data: expect.objectContaining({ reason: "foreign-branch" }) })]);
    expect(exit).toBe(1);
    expect(fake.pulls).toEqual([]);
  });

  it("blocks without a PR when someone pushes to the branch right after the commit", async () => {
    const fake = new FakeFixture(workflow(OLD));
    fake.afterPut = () => {
      const head = fake.branches.get(BRANCH)!;
      fake.branches.set(BRANCH, fake.commit(head, new Map([...fake.commits.get(head)!.files, ["README.md", "sneaky\n"]])));
    };
    expect((await run(fake, { apply: true })).rows[0]).toMatchObject({ status: "blocked", data: { reason: "foreign-branch" } });
    expect(fake.pulls).toEqual([]);
  });

  it("blocks the repository when the workflow changed between reading and writing it", async () => {
    const fake = new FakeFixture(workflow(OLD));
    const request = fake.request.bind(fake);
    fake.request = async (method, path, body) => {
      if (method === "PUT") {
        const main = fake.branches.get(BRANCH)!;
        fake.branches.set(BRANCH, fake.commit(main, new Map([...fake.commits.get(main)!.files, [WORKFLOW, `${workflow(OLD)}# edited\n`]])));
      }
      return request(method, path, body);
    };
    const { rows } = await run(fake, { apply: true });
    expect(rows[0]).toMatchObject({ step: "repository", status: "blocked", message: expect.stringContaining("HTTP 409") });
    expect(fake.pulls).toEqual([]);
  });

  it("blocks a repository whose workflow isn't valid UTF-8, without writing", async () => {
    const fake = new FakeFixture(workflow(OLD));
    const request = fake.request.bind(fake);
    fake.request = async (method, path, body) => {
      const reply = await request(method, path, body);
      return path.includes("/contents/") && method === "GET" ? { ...reply, body: { ...object(reply.body), content: Buffer.from([0x6f, 0xff]).toString("base64") } } : reply;
    };
    const { rows } = await run(fake, { apply: true });
    expect(rows[0]).toMatchObject({ status: "blocked", data: { reason: "incomplete-evidence" } });
    expect(fake.writes()).toEqual([]);
  });
});
