import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { ConsoleLogger } from "@leanish/agent-runtime/logger/console-logger";
import type { GitHubPullRequest } from "@leanish/agent-runtime/types/clients";
import type { WorkingCopy } from "@leanish/agent-runtime/types/working-copy";
import { InMemoryWorkspace } from "@leanish/agent-runtime/working-copy/in-memory-workspace";
import type { GradleInventory } from "@leanish/gate/gradle";
import type { SecurityFix } from "@leanish/gate/candidates";
import { FLOORS_PATH, parseFloors } from "@leanish/gate/floors";
import { selectRemovals, withoutFloorRecords } from "../src/floor-removal.ts";
import type { Tree } from "@leanish/gate/tree";
import { assertAgentWorkspace, type ToolRunContext } from "@leanish/tool-runtime/command";
import { retargetRepository } from "@leanish/tool-runtime/test/retarget-repository";
import { runCompare } from "@leanish/gate/gate";
import { parseToolConfig } from "@leanish/tool-runtime/config";
import { MemoryJournal } from "@leanish/tool-runtime/test/memory-journal";
import { branchFor, stateOf, withMarker } from "@leanish/tool-runtime/own-pr";
import { BASE_SHA, FakeGitHub, GREEN, HEAD_SHA, ownPr, PUSHED_SHA, RED } from "@leanish/tool-runtime/test/fake-github";
import { planOf, planSection, withPlanSection } from "../src/plan-block.ts";
import { type ChangePlan, planFor, type SecurityUnit } from "../src/plan.ts";
import { verifyPlan, type VerifyInputs } from "../src/verify.ts";
import { computedNpmProblems } from "@leanish/tool-runtime/npm-file-checks";
import { materializeInCopy } from "../src/npm-materialize.ts";
import { preservedFloors } from "../src/floor-checks.ts";
import { defaultDeps, heldClaims, retirementOf, RULES, type SecureItDeps, secureIt, unitOf } from "../src/secure-it.ts";

// Keep local security verification real; replace only the external scan.
vi.mock("@leanish/gate/gate", async (original) => ({ ...await original<object>(), runCompare: vi.fn() }));

/** The verification snapshot the fakes hand back, and its tree (publication must stage it). */
const SNAPSHOT = "5".repeat(40);
const SNAPSHOT_TREE = "7".repeat(40);

const REPO = "leanish/widget";
const NOW = new Date("2026-10-07T06:00:00Z");
const CONFIG = parseToolConfig(
  "secure-it",
  `repos: [{ repo: ${REPO} }]
agent: { codingAgent: codex, model: sol, effort: medium }
secrets: { write: w, read: r }
commitIdentity: { name: leanish, email: leanish@example.com }
dirs: { state: /tmp/state, cache: /tmp/cache }
`,
  "agent.yaml",
);

const LOCK = JSON.stringify({
  lockfileVersion: 3,
  packages: { "": { name: "widget", dependencies: { vite: "^8.3.0" } }, "node_modules/vite": { version: "8.3.1" }, "node_modules/left-pad": { version: "1.0.0" } },
});

function tree(id: string, files: Record<string, string> = { "package-lock.json": LOCK }): Tree {
  return { id, read: async (path) => files[path], list: async (dir) => Object.keys(files).filter((path) => path.startsWith(`${dir}/`)) };
}

function vite(overrides: Partial<SecurityFix> = {}): SecurityFix {
  return {
    ecosystem: "npm",
    name: "vite",
    from: "8.3.1",
    locations: ["node_modules/vite"],
    targets: ["GHSA-rq7h-c2jc-7f22"],
    unfixable: [],
    malicious: false,
    severity: "MODERATE",
    to: { version: "8.3.3", line: "8", aged: true, major: false, blockers: [] },
    problem: undefined,
    ...overrides,
  };
}

const APPLIED = { outcome: "applied", summary: "moved vite", publication: { title: "moving vite to 8.3.3", body: "Fixes three dev-server advisories.", commitMessage: "moving vite to 8.3.3" } };

interface Harness {
  readonly context: ToolRunContext;
  readonly deps: SecureItDeps;
  readonly github: FakeGitHub;
  readonly workspace: InMemoryWorkspace;
  readonly agentCalls: Array<{ entrypoint: string; input: Record<string, unknown> }>;
  readonly written: string[];
  readonly reverted: string[];
  readonly journal: MemoryJournal;
}

function harness(options: { prs?: GitHubPullRequest[]; fixes?: SecurityFix[]; answer?: unknown; problems?: string[]; baseSha?: string; files?: Record<string, string>; links?: string[] } = {}): Harness {
  const github = new FakeGitHub(...(options.prs ?? []));
  const workspace = new InMemoryWorkspace();
  const workingCopy: WorkingCopy = { projectId: REPO, path: "/synthetic/leanish/widget", branch: "main", headSha: options.baseSha ?? BASE_SHA, gitDir: "/synthetic/.git" };
  const agentCalls: Harness["agentCalls"] = [];
  const written: string[] = [];
  const reverted: string[] = [];
  const journal = new MemoryJournal();
  const context: ToolRunContext = {
    config: CONFIG,
    repo: { repo: REPO, branch: undefined },
    base: "main",
    github,
    workspace,
    workingCopy,
    logger: new ConsoleLogger({ minLevel: "error" }),
    now: NOW,
    releaseAgeDays: 7,
    releaseAgeExclude: [],
    readToken: "read-token",
    fetch: globalThis.fetch,
    isolation: {},
    agent: (async (call: { entrypoint: string; input: Record<string, unknown> }) => {
      agentCalls.push(call);
      return options.answer ?? APPLIED;
    }) as ToolRunContext["agent"],
  };
  const deps: SecureItDeps = {
    publicationParent: async (_wc, prepared) => prepared,
    fileState: async (_wc, path) => ({ path, sha256: null, executable: false, index: "" }),
    requiredNpm: async (_base, plan) => plan,
    materializeNpm: async () => new Map(),
    floorProbe: async () => ({ files: new Map(), findings: [], problems: [] }),
    gate: async () => ({ run: async () => ({ code: 0, stdout: "", stderr: "" }), fetch: async () => ({ ok: false, status: 404, headers: { get: () => null }, json: async () => ({}), text: async () => "" }), now: () => NOW, osvScanner: "osv-scanner", githubToken: "read-token" }),
    gradle: () => ({ ofCommit: async () => undefined, ofWorkingTree: async () => undefined }),
    trees: { commit: async (_wc, sha) => tree(sha, options.files), working: () => tree("worktree", options.files) },
    npm: async () => ({ code: 0, stdout: "11.20.0\n", stderr: "" }),
    candidates: async () => ({ fixes: options.fixes ?? [vite()], incomplete: [], gaps: [], osvScannerVersion: "2.6.0" }),
    verify: async () => options.problems ?? [],
    snapshot: async () => SNAPSHOT,
    candidateTree: async () => SNAPSHOT_TREE,
    changedBetween: async () => ["package.json", "package-lock.json"],
    linkProblems: async () => (options.links ?? []).map((path) => `the edit made ${path} a symbolic link: verification can't check what's behind one`),
    journal: () => journal,
    writeFile: async (_wc, path, content) => {
      written.push(`${path}=${content}`);
    },
    revert: async (_wc, sha) => {
      reverted.push(sha);
      return ["package-lock.json"];
    },
  };
  return { context, deps, github, workspace, agentCalls, written, reverted, journal };
}

function leftPad(overrides: Partial<SecurityFix> = {}): SecurityFix {
  return vite({ name: "left-pad", from: "1.0.0", locations: ["node_modules/left-pad"], severity: "LOW", to: { version: "1.0.1", line: "1", aged: true, major: false, blockers: [] }, ...overrides });
}

async function batchPr(fixes: SecurityFix[], overrides: Partial<GitHubPullRequest> = {}): Promise<GitHubPullRequest> {
  const plan = await planFor(fixes, { named: undefined, lockfiles: new Map([["package-lock.json", JSON.parse(LOCK)]]), gradle: undefined, tagCommit: async () => undefined });
  return ownPr({ headRef: `secure-it/2026-10-05-${plan.topic}`, body: withMarker(RULES, `Fixes security findings.\n\n${planSection(plan)}`, { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }), ...overrides });
}

async function vitePr(overrides: Partial<GitHubPullRequest> = {}, fix = vite()): Promise<GitHubPullRequest> {
  return batchPr([fix], overrides);
}

describe("secure-it run", () => {
  it("declares the tool-written floors file when npm writes it before a planned Gradle floor addition", async () => {
    const h = harness({ fixes: [vite(), vite({ ecosystem: "Maven", name: "g:lib", from: "1.0", locations: [":runtimeClasspath"], to: { version: "1.1", line: "1", aged: true, major: false, blockers: [] } })] });
    const inventory: GradleInventory = { schemaVersion: 3, tree: "base", builds: [{ build: ".", configurations: [{ id: ":runtimeClasspath", kind: "project", declared: [], resolved: [{ group: "g", name: "lib", version: "1.0" }], unresolved: [], error: undefined }] }] };
    const result = await secureIt({ ...h.deps, gradle: () => ({ ofCommit: async () => inventory, ofWorkingTree: async () => inventory }), materializeNpm: async () => new Map([[FLOORS_PATH, '{"floors":[]}']]) }).run(h.context);
    expect(result, JSON.stringify(result)).toMatchObject({ outcome: "published" });
    expect(h.agentCalls).toMatchObject([{ input: { toolWritten: [FLOORS_PATH], moves: expect.arrayContaining([expect.objectContaining({ mechanism: "gradle-floor" })]) } }]);
  });
  it.each(["clean", "untracked", "merged-edit", "dependencies-only"] as const)("reviews a real conflicted merge with production agent inputs: %s", async (problem) => {
    const root = await mkdtemp(fileURLToPath(new URL("../../.resolve-test-", import.meta.url)));
    try {
      const path = ".github/workflows/supply-chain.yml";
      const name = "leanish/leanish-development";
      const workflow = (sha: string, tag: string) => `on: push\njobs:\n  gate:\n    uses: ${name}/.github/workflows/supply-chain.yml@${sha} # ${tag}\n`;
      const fix = vite({ ecosystem: "GitHub Actions", name, from: "v0.4.0", locations: [path], to: { version: "v0.6.0", line: "0.6", aged: true, major: true, blockers: [] } });
      const unit = { kind: "major" as const, topic: `${name}-major` };
      const branch = branchFor(RULES, NOW, unit.topic);
      const lock = (side: string) => JSON.stringify({ name: side, lockfileVersion: 3, packages: {} }) + "\n";
      const codeConflict = problem !== "dependencies-only";
      const fixture = await retargetRepository(root, REPO, branch, {
        [path]: workflow("a".repeat(40), "v0.4.0"), "app.ts": "original\n", "package-lock.json": lock("original"), "README.md": "original\n",
      }, { [path]: workflow("1".repeat(40), "v0.6.0"), "package-lock.json": lock("PR"), ...(codeConflict ? { "app.ts": "PR\n" } : {}) }, {
        "app.ts": "base\n", "package-lock.json": lock("base"), "README.md": "cleanly merged\n",
      });
      const { workingCopy: wc, git, oldHead, oldBase, baseSha } = fixture;
      const previous = await planFor([fix], { named: undefined, lockfiles: new Map(), gradle: undefined, tagCommit: async () => "1".repeat(40) }, unit);
      const pr = ownPr({ headRef: branch, labels: [RULES.label], headSha: oldHead, body: withMarker(RULES, planSection(previous), { head: oldHead, base: oldBase, adaptations: 0 }) });
      const h = harness({ prs: [pr], fixes: [fix] });
      h.workspace.prepareBranch = fixture.workspace.prepareBranch.bind(fixture.workspace);
      h.workspace.publishBranch = fixture.publishBranch;
      const actual = defaultDeps();
      let invoked = false;
      const agent: ToolRunContext["agent"] = async (call) => {
        expect(call.input).toMatchObject({ mode: "resolve", toolWritten: [] });
        expect(call.restoredFiles).toMatchObject([{ path: "package-lock.json", sha256: expect.any(String), index: expect.any(String) }]);
        expect((call.input as { conflicted?: string[] }).conflicted ?? []).toEqual(codeConflict ? ["app.ts"] : []);
        expect(git("rev-parse", "HEAD")).toBe(oldHead);
        expect(git("rev-parse", "MERGE_HEAD")).toBe(baseSha);
        expect(await readFile(join(wc.path, "package-lock.json"), "utf8")).toBe(lock("base"));
        expect(await readFile(join(wc.path, "README.md"), "utf8")).toBe("cleanly merged\n");
        if (problem === "untracked") await writeFile(join(wc.path, "scratch.txt"), "undeclared\n");
        if (problem === "merged-edit") await writeFile(join(wc.path, "README.md"), "undeclared\n");
        await assertAgentWorkspace(wc, call.input, call.restoredFiles);
        invoked = true;
        if (codeConflict) await writeFile(join(wc.path, "app.ts"), "resolved\n");
        return h.context.agent(call);
      };
      const result = await secureIt({ ...h.deps, trees: actual.trees, writeFile: actual.writeFile, fileState: actual.fileState, publicationParent: actual.publicationParent,
        gate: async (context) => ({ ...await h.deps.gate(context), fetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ object: { type: "commit", sha: "1".repeat(40) } }), text: async () => "" }) }),
        snapshot: actual.snapshot, candidateTree: actual.candidateTree, changedBetween: actual.changedBetween, linkProblems: actual.linkProblems,
      }).review({ ...h.context, workingCopy: wc, agent });
      if (problem === "untracked" || problem === "merged-edit") {
        expect(result, JSON.stringify(result)).toMatchObject({ reviewed: [{ outcome: "error", detail: expect.stringContaining(`undeclared changes against HEAD: ${problem === "untracked" ? "scratch.txt" : "README.md"}`) }] });
        expect(invoked).toBe(false);
        expect(fixture.publications).toEqual([]);
      } else {
        expect(result, JSON.stringify(result)).toMatchObject({ reviewed: [{ outcome: "rebased" }] });
        expect(invoked).toBe(true);
        expect(fixture.publications).toHaveLength(1);
        const published = fixture.publications[0]!;
        expect(git("rev-parse", `${published.sha}^{tree}`)).toBe(await actual.candidateTree(wc));
        expect(git("show", "-s", "--format=%P", published.sha).split(" ")).toEqual([oldHead, baseSha]);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it.each(["run", "review"] as const)("retargets an open major from a clean base in %s, dropping old adaptations and publishing the verified tree on the PR history", async (command) => {
    const root = await mkdtemp(fileURLToPath(new URL("../../.secure-retarget-test-", import.meta.url)));
    try {
      const path = ".github/workflows/supply-chain.yml";
      const name = "leanish/leanish-development";
      const workflow = (sha: string, tag: string) => `on: push\njobs:\n  gate:\n    uses: ${name}/.github/workflows/supply-chain.yml@${sha} # ${tag}\n`;
      const baseFiles = { [path]: workflow("a".repeat(40), "v0.4.0"), "EXPECTED.md": "base expectations\n", "README.md": "base docs\n" };
      const fix = vite({ ecosystem: "GitHub Actions", name, from: "v0.4.0", locations: [path], to: { version: "v0.6.0", line: "0.6", aged: true, major: true, blockers: [] } });
      const unit = { kind: "major" as const, topic: `${name}-major` };
      const branch = branchFor(RULES, NOW, unit.topic);
      const fixture = await retargetRepository(root, REPO, branch, baseFiles, {
        [path]: workflow("b".repeat(40), "v0.5.2"), "EXPECTED.md": "old adaptation\n", "README.md": "old adaptation\n",
      }, command === "review");
      const { workingCopy: wc, git, oldHead, oldBase, baseSha } = fixture;
      const previous = await planFor([{ ...fix, to: { ...fix.to!, version: "v0.5.2" } }], { named: undefined, lockfiles: new Map(), gradle: undefined, tagCommit: async () => "b".repeat(40) }, unit);
      const pr = ownPr({ headRef: branch, headSha: oldHead, body: withMarker(RULES, planSection(previous), { head: oldHead, base: oldBase, adaptations: 0 }) });
      const h = harness({ prs: [pr], fixes: [fix] });
      h.workspace.prepareBranch = fixture.workspace.prepareBranch.bind(fixture.workspace);
      h.workspace.publishBranch = fixture.publishBranch;
      const actual = defaultDeps();
      const verified: VerifyInputs[] = [];
      const deps: SecureItDeps = { ...h.deps, publicationParent: actual.publicationParent, trees: actual.trees, revert: actual.revert, snapshot: actual.snapshot, candidateTree: actual.candidateTree, changedBetween: actual.changedBetween, linkProblems: actual.linkProblems,
        gate: async (context) => ({ ...await h.deps.gate(context), fetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ object: { type: "commit", sha: "1".repeat(40) } }), text: async () => "" }) }),
        verify: async (input) => { verified.push(input); return verifyPlan(input); },
      };
      const agent: ToolRunContext["agent"] = async (call) => {
        await assertAgentWorkspace(wc, call.input);
        expect(git("rev-parse", "HEAD")).toBe(baseSha);
        expect(git("diff", "--cached", "--name-only")).toBe("");
        expect(git("diff", "--name-only")).toBe("");
        for (const [path, text] of Object.entries(baseFiles)) expect(await readFile(join(wc.path, path), "utf8")).toBe(text);
        expect(call.input).toMatchObject({ mode: "apply", moves: [{ from: "v0.4.0", to: "v0.6.0" }], toolWritten: [] });
        await writeFile(join(wc.path, path), workflow("1".repeat(40), "v0.6.0"));
        await writeFile(join(wc.path, "EXPECTED.md"), "fresh adaptation\n");
        return h.context.agent(call);
      };
      vi.mocked(runCompare).mockReset().mockResolvedValue({ headFindings: [], failures: [], warnings: [], notes: [], gaps: [], osvScannerVersion: "2.6.0", configText: undefined, group: (id: string) => id, cooldown: { evaluated: true, releaseAgeDays: 7, held: [] } });
      const result = await secureIt(deps)[command]({ ...h.context, workingCopy: wc, agent });
      expect(result, JSON.stringify(result)).toMatchObject(command === "run" ? { units: [{ outcome: "updated" }] } : { reviewed: [{ outcome: "rebased" }] });
      expect(h.agentCalls).toHaveLength(1);
      expect(verified).toHaveLength(1);
      expect(verified[0]!.base.id).toBe(baseSha);
      expect(await verified[0]!.head.read("README.md")).toBe(baseFiles["README.md"]);
      expect(await verified[0]!.head.read("EXPECTED.md")).toBe("fresh adaptation\n");
      expect(runCompare).toHaveBeenCalledOnce();
      expect(fixture.publications).toHaveLength(1);
      const published = fixture.publications[0]!;
      expect(git("rev-parse", `${published.sha}^{tree}`)).toBe(await actual.candidateTree(wc));
      expect(git("show", "-s", "--format=%P", published.sha).split(" ")).toEqual(command === "review" ? [oldHead, baseSha] : [oldHead]);
      expect(planOf(h.github.prs.get(pr.number)!.body)?.moves).toMatchObject([{ from: "v0.4.0", to: "v0.6.0" }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("writes computed npm before the agent and protects it through verification", async () => {
    const h = harness();
    const files = new Map([["package-lock.json", "computed lock"], ["package.json", "computed manifest"]]);
    let checked = false;
    const deps = {
      ...h.deps,
      materializeNpm: async () => files,
      verify: async (inputs: VerifyInputs) => {
        expect(inputs.npmFiles).toEqual(files);
        checked = true;
        return [];
      },
    };
    const context = { ...h.context, agent: (async (call: { input: Record<string, unknown> }) => {
      expect(h.written).toEqual(["package-lock.json=computed lock", "package.json=computed manifest"]);
      expect(call.input["toolWritten"]).toEqual(["package-lock.json", "package.json"]);
      return APPLIED;
    }) as ToolRunContext["agent"] };
    expect(await secureIt(deps).run(context)).toMatchObject({ outcome: "published" });
    expect(checked).toBe(true);
  });

  it("preserves a major's existing manifest adaptation when rewriting exact npm fields", async () => {
    const major = vite({ to: { version: "9.0.0", line: "9", aged: true, major: true, blockers: [] } });
    const h = harness({ fixes: [major] });
    const planned = '{"dependencies":{"vite":"^9.0.0"}}';
    const current = '{"dependencies":{"vite":"^9.0.0"},"scripts":{"test":"adapted-check"}}';
    const deps = { ...h.deps, materializeNpm: async () => new Map([["package.json", planned]]),
      trees: { ...h.deps.trees, working: () => tree("worktree", { "package.json": current }) } };
    expect(await secureIt(deps).run(h.context)).toMatchObject({ outcome: "published" });
    expect(h.written).toContain(`package.json=${current}`);
  });

  it("reports unsupported npm materialization without running the agent or publishing", async () => {
    const h = harness();
    const result = await secureIt({ ...h.deps, materializeNpm: async () => { throw new Error("unsupported npm peer placement"); } }).run(h.context);
    expect(JSON.stringify(result)).toContain("unsupported npm peer placement");
    expect(h.agentCalls).toEqual([]);
    expect(h.github.prs.size).toBe(0);
  });

  it("recomputes and republishes a legacy journal head without same-plan suppression", async () => {
    const pr = await vitePr({ headSha: "9".repeat(40) });
    const h = harness({ prs: [pr] });
    h.workspace.setRemoteHead(pr.headRef, pr.headSha);
    await h.journal.pushed(REPO, pr.number, { head: pr.headSha, base: BASE_SHA });
    expect(await secureIt(h.deps).run(h.context)).toMatchObject({ outcome: "updated", pullRequest: pr.url });
    expect(h.reverted).toEqual([BASE_SHA]);
    expect(h.agentCalls).toHaveLength(1);
    expect((await h.journal.last(REPO, pr.number))?.publication?.body).toBe(h.github.prs.get(pr.number)?.body);
  });
  it("plans companions before invoking the agent and reports a blocked set while applying the rest", async () => {
    const h = harness({ fixes: [vite(), leftPad()] });
    const found = await h.deps.candidates(tree(BASE_SHA), await h.deps.gate(h.context), {});
    const peers = { resolve: async () => ({ additions: [{ name: "@vitest/ui", from: "4.1.7", to: "4.1.11", line: "4", aged: true,
      locations: ["node_modules/@vitest/ui"], declarations: [] }], blocked: [], sets: [["vite", "@vitest/ui"]] }) };
    const deps = { ...h.deps, candidates: async () => ({ ...found, npmPeers: peers }) };
    expect(await secureIt(deps).run(h.context)).toMatchObject({ outcome: "published" });
    expect(h.agentCalls[0]?.input["moves"]).toEqual(expect.arrayContaining([expect.objectContaining({ name: "@vitest/ui", to: "4.1.11" })]));
    expect(planOf(h.github.prs.get(42)!.body)?.coupled).toEqual([["npm|vite", "npm|@vitest/ui"]]);
    const blocked = harness({ fixes: [vite(), leftPad()] });
    const blockedDeps = { ...blocked.deps, candidates: async () => ({ ...found, npmPeers: { resolve: async () => ({ additions: [], sets: [],
      blocked: [{ moves: [{ name: "vite", from: "8.3.1", to: "8.3.3", locations: ["node_modules/vite"] }], reason: "peer set has no aged compatible version" }] }) } }) };
    expect(await secureIt(blockedDeps).run(blocked.context)).toMatchObject({ outcome: "published", waiting: ["peer set has no aged compatible version"] });
    expect(blocked.agentCalls[0]?.input["moves"]).toMatchObject([{ name: "left-pad" }]);
  });

  it("batches non-major packages, verifies them, and opens one security PR carrying the plan", async () => {
    const h = harness({ fixes: [vite(), vite({ name: "left-pad", from: "1.0.0", locations: ["node_modules/left-pad"], severity: "LOW", to: { version: "1.0.1", line: "1", aged: true, major: false, blockers: [] } })] });
    const result = await secureIt(h.deps).run(h.context);
    expect(result).toMatchObject({ outcome: "published", pullRequest: "https://github.com/leanish/widget/pull/42" });
    expect(h.agentCalls).toHaveLength(1);
    expect(h.agentCalls[0]).toMatchObject({ entrypoint: "secure-it", input: { mode: "apply", today: "2026-10-07", moves: [{ name: "vite", to: "8.3.3", mechanism: "npm-direct" }, { name: "left-pad", to: "1.0.1" }] } });
    const pr = h.github.prs.get(42)!;
    expect(pr).toMatchObject({ headRef: "secure-it/2026-10-07-security", isDraft: true, title: "moving vite to 8.3.3" });
    expect(planOf(pr.body)?.moves.map((move) => move.name)).toEqual(["vite", "left-pad"]);
    expect(stateOf(pr.body)).toEqual({ head: PUSHED_SHA, base: BASE_SHA, adaptations: 0 });
  });

  it("rewrites an open PR's notes when the same plan now explains itself differently, without a commit or the agent", async () => {
    const plan = await planFor([vite()], { named: undefined, lockfiles: new Map([["package-lock.json", JSON.parse(LOCK)]]), gradle: undefined, tagCommit: async () => undefined });
    const stale = ownPr({ headRef: `secure-it/2026-10-05-${plan.topic}`, body: withMarker(RULES, `Fixes security findings.\n\n${planSection({ ...plan, notes: ["an outdated reason"] })}`, { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }) });
    const h = harness({ prs: [stale] });
    expect(await secureIt(h.deps).run(h.context)).toMatchObject({ outcome: "already-open", pullRequest: "https://github.com/leanish/widget/pull/7" });
    const body = h.github.prs.get(7)!.body;
    expect(body).not.toContain("an outdated reason");
    expect(body).toContain("Fixes security findings.");
    expect(stateOf(body)).toEqual({ head: HEAD_SHA, base: BASE_SHA, adaptations: 0 });
    expect([h.agentCalls, h.workspace.publications]).toEqual([[], []]);
  });

  it("leaves the same plan's open PR to its review tick, and reconciles one whose plan changed while it's still the tool's", async () => {
    const same = harness({ prs: [await vitePr()] });
    expect(await secureIt(same.deps).run(same.context)).toMatchObject({ outcome: "already-open", pullRequest: "https://github.com/leanish/widget/pull/7" });
    expect(same.agentCalls).toEqual([]);

    const changed = harness({ prs: [await vitePr({}, vite({ to: { version: "8.3.2", line: "8", aged: true, major: false, blockers: [] } }))] });
    changed.workspace.setRemoteHead("secure-it/2026-10-05-security", HEAD_SHA);
    expect(await secureIt(changed.deps).run(changed.context)).toMatchObject({ outcome: "updated", pullRequest: "https://github.com/leanish/widget/pull/7" });
    // The base merged in and the old plan's edits reverted before the agent applies the new one.
    expect(changed.reverted).toEqual([BASE_SHA]);
    expect(changed.agentCalls.map((call) => call.input["mode"])).toEqual(["apply"]);
    expect(planOf(changed.github.prs.get(7)!.body)?.moves[0]?.to).toBe("8.3.3");
  });

  it("stops reconciling when the default branch moved while the run computed its plan", async () => {
    const h = harness({ prs: [await vitePr({}, vite({ to: { version: "8.3.2", line: "8", aged: true, major: false, blockers: [] } }))] });
    h.workspace.setRemoteHead("secure-it/2026-10-05-security", HEAD_SHA);
    const prepare = h.workspace.prepareBranch.bind(h.workspace);
    h.workspace.prepareBranch = async (workingCopy, args) => prepare({ ...workingCopy, headSha: "f".repeat(40) }, args);
    expect(await secureIt(h.deps).run(h.context)).toMatchObject({ outcome: "failed", detail: expect.stringContaining("the default branch moved while secure-it ran") });
    expect(h.reverted).toEqual([]);
    expect(h.agentCalls).toEqual([]);
  });

  it("doesn't take a PR someone else pushed to as covering the same plan", async () => {
    const h = harness({ prs: [await vitePr({ headSha: "9".repeat(40) })] });
    expect(await secureIt(h.deps).run(h.context)).toMatchObject({ outcome: "published" });
    expect(h.github.prs.get(42)?.headRef).toBe("secure-it/2026-10-07-security");
  });

  it("opens a separate PR for a changed plan when someone else pushed to the package's PR", async () => {
    const older = vite({ to: { version: "8.3.2", line: "8", aged: true, major: false, blockers: [] } });
    const h = harness({ prs: [await vitePr({ headSha: "9".repeat(40), headRef: "secure-it/2026-10-07-security" }, older)] });
    expect(await secureIt(h.deps).run(h.context)).toMatchObject({ outcome: "published" });
    expect(h.github.prs.get(42)?.headRef).toBe("secure-it/2026-10-07-security-2");
    expect(h.github.prs.get(7)?.headSha).toBe("9".repeat(40));
  });

  it("publishes nothing when verification fails, the agent can't apply, nothing is fixable, or the inventory is incomplete", async () => {
    const failing = harness({ problems: ["vite at node_modules/vite is 8.3.2, not 8.3.3"] });
    expect(await secureIt(failing.deps).run(failing.context)).toMatchObject({ outcome: "verification-failed", problems: ["vite at node_modules/vite is 8.3.2, not 8.3.3"] });
    expect(failing.github.calls.some((call) => call.startsWith("createPullRequest"))).toBe(false);

    const linked = harness({ links: ["package-lock.json"] });
    expect(await secureIt(linked.deps).run(linked.context)).toMatchObject({
      outcome: "verification-failed",
      problems: [expect.stringContaining("the edit made package-lock.json a symbolic link")],
    });
    expect(linked.github.calls.some((call) => call.startsWith("createPullRequest"))).toBe(false);

    const refused = harness({ answer: { outcome: "cannot-apply", summary: "the override would break the build" } });
    expect(await secureIt(refused.deps).run(refused.context)).toMatchObject({ outcome: "cannot-apply", summary: "the override would break the build" });

    const stuck = harness({ fixes: [vite({ to: undefined, problem: "no version above 8.3.1 fixes GHSA-x" })] });
    expect(await secureIt(stuck.deps).run(stuck.context)).toMatchObject({ outcome: "nothing-to-fix", waiting: ["vite@8.3.1: no version above 8.3.1 fixes GHSA-x"] });

    const incomplete = harness();
    const deps = { ...incomplete.deps, candidates: async () => ({ fixes: [vite()], incomplete: ["Gradle :runtimeClasspath couldn't resolve x"], gaps: [], osvScannerVersion: "2.6.0" }) };
    expect(await secureIt(deps).run(incomplete.context)).toMatchObject({ outcome: "incomplete", incomplete: ["Gradle :runtimeClasspath couldn't resolve x"] });
    expect(incomplete.agentCalls).toEqual([]);
  });

  it("expands an existing batch by reconcile-by-revert rather than opening another package PR", async () => {
    const h = harness({ prs: [await vitePr()], fixes: [vite(), leftPad()] });
    h.workspace.setRemoteHead("secure-it/2026-10-05-security", HEAD_SHA);
    expect(await secureIt(h.deps).run(h.context)).toMatchObject({ outcome: "updated" });
    expect(h.agentCalls).toHaveLength(1);
    expect(h.agentCalls[0]?.input).toMatchObject({ moves: [{ name: "vite" }, { name: "left-pad" }] });
    expect(h.workspace.publications).toHaveLength(1);
    expect(h.reverted).toEqual([BASE_SHA]);
    expect(planOf(h.github.prs.get(7)!.body)?.packages).toEqual(["npm|left-pad", "npm|vite"]);
  });

  it("reports blocked packages once when an identical batch is already open", async () => {
    const h = harness({ prs: [await batchPr([vite(), leftPad()])], fixes: [vite({ name: "blocked", severity: "CRITICAL", to: undefined, problem: "identity break" }), leftPad(), vite()] });
    expect(await secureIt(h.deps).run(h.context)).toMatchObject({ outcome: "already-open", waiting: ["blocked@8.3.1: identity break"] });
    expect(h.agentCalls).toEqual([]);
    expect(h.workspace.publications).toEqual([]);
  });

  it("recognises an identical owned suffixed batch", async () => {
    const h = harness({ prs: [await vitePr({ headRef: "secure-it/2026-10-05-security-2" })] });
    expect(await secureIt(h.deps).run(h.context)).toMatchObject({ outcome: "already-open" });
    expect(h.agentCalls).toEqual([]);
  });

  it("keeps malware together and does not bypass its already-open group", async () => {
    const malware = vite({ malicious: true });
    const other = vite({ name: "left-pad", from: "1.0.0", locations: ["node_modules/left-pad"], to: { version: "1.0.1", line: "1", aged: true, major: false, blockers: [] } });
    const h = harness({ prs: [await vitePr({ headRef: "secure-it/2026-10-05-malware" }, malware)], fixes: [other, malware] });
    expect(await secureIt(h.deps).run(h.context)).toMatchObject({ outcome: "already-open", packages: ["npm|vite"] });
    expect(h.agentCalls).toEqual([]);
    expect(h.workspace.publications).toEqual([]);
  });

  it("checks exclusion support before the agent, and leaves publication untouched on old npm", async () => {
    const h = harness();
    const calls: ReadonlyArray<string>[] = [];
    const deps = { ...h.deps, npm: async (_context: ToolRunContext, args: ReadonlyArray<string>) => {
      calls.push(args);
      return { code: 0, stdout: "11.14.1", stderr: "" };
    } };
    expect(await secureIt(deps).run(h.context)).toMatchObject({ outcome: "failed", detail: expect.stringContaining("require npm >= 11.17.0 (min-release-age-exclude: left-pad, vite)") });
    expect(calls).toEqual([["--version"]]);
    expect(h.agentCalls).toEqual([]);
    expect(h.workspace.publications).toEqual([]);
  });

  it("exempts an unrelated young locked version while keeping an aged security target exact", async () => {
    const h = harness();
    const gate = await h.deps.gate(h.context);
    const npm: string[][] = [];
    const deps = { ...h.deps, gate: async () => ({ ...gate, fetch: async (url: string) => ({ ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ time: String(url).endsWith("left-pad") ? { "1.0.0": "2026-10-06T00:00:00Z" } : { "8.3.1": "2026-09-01T00:00:00Z", "8.3.3": "2026-09-01T00:00:00Z" }, versions: {} }), text: async () => "" }) }),
      npm: async (_context: ToolRunContext, args: ReadonlyArray<string>) => { npm.push([...args]); return { code: 0, stdout: "11.20.0", stderr: "" }; } };
    const context = { ...h.context, agent: (async (call: { entrypoint: string; input: Record<string, unknown> }) => {
      if (!(call.input["npmAgeExclusions"] as string[]).includes("left-pad")) throw new Error("notarget: locked left-pad is too young");
      return h.context.agent(call);
    }) as ToolRunContext["agent"] };
    expect(await secureIt(deps).run(context)).toMatchObject({ outcome: "published" });
    expect(h.agentCalls[0]?.input).toMatchObject({ npmAgeExclusions: ["left-pad"], moves: [expect.objectContaining({ name: "vite", to: "8.3.3" })] });
    expect(npm).toEqual([["--version"]]);
    const old = harness();
    expect(await secureIt({ ...deps, npm: async () => ({ code: 0, stdout: "11.14.1", stderr: "" }) }).run(old.context)).toMatchObject({ outcome: "failed", detail: expect.stringContaining("min-release-age-exclude: left-pad") });
    expect(old.agentCalls).toEqual([]);
    expect(old.workspace.publications).toEqual([]);
  });

  it("passes a young target exclusion while preserving own scopes and the sandbox's age", async () => {
    const h = harness();
    const gate = await h.deps.gate(h.context);
    const deps = { ...h.deps, gate: async () => ({ ...gate, fetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ time: { "8.3.3": "2026-10-06T00:00:00Z" }, versions: {} }), text: async () => "" }) }) };
    const install = (exclusions: ReadonlyArray<string>) => {
      if (!exclusions.includes("vite")) throw new Error("notarget: vite target is too young");
      if (exclusions.includes("other")) throw new Error("unplanned package was excluded");
    };
    expect(() => install([])).toThrow("notarget");
    const context = { ...h.context, releaseAgeExclude: ["@leanish/*"], agent: (async (call: { entrypoint: string; input: Record<string, unknown> }) => {
      install(call.input["npmAgeExclusions"] as ReadonlyArray<string>);
      return h.context.agent(call);
    }) as ToolRunContext["agent"] };
    expect(await secureIt(deps).run(context)).toMatchObject({ outcome: "published" });
    expect(h.agentCalls[0]?.input).toMatchObject({ npmAgeExclusions: ["@leanish/*", "left-pad", "vite"] });
    expect(context.releaseAgeDays).toBe(7);
    expect(context.releaseAgeExclude).toEqual(["@leanish/*"]);
  });

  it("needs no newer npm when targets and base copies are aged and there are no own scopes", async () => {
    const h = harness();
    const gate = await h.deps.gate(h.context);
    const deps = { ...h.deps, gate: async () => ({ ...gate, fetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ time: { "8.3.3": "2026-09-01T00:00:00Z", "8.3.1": "2026-09-01T00:00:00Z", "1.0.0": "2026-09-01T00:00:00Z" }, versions: {} }), text: async () => "" }) }),
      npm: async () => { throw new Error("npm version must not be checked"); } };
    expect(await secureIt(deps).run(h.context)).toMatchObject({ outcome: "published" });
    expect(h.agentCalls[0]?.input["npmAgeExclusions"]).toEqual([]);
  });

  it("opens a routine batch and each major separately from the same base", async () => {
    const major = vite({ to: { version: "9.0.1", line: "9", aged: true, major: true, blockers: [] } });
    const h = harness({ fixes: [major, leftPad()] });
    const result = await secureIt(h.deps).run(h.context);
    expect(result).toMatchObject({ outcome: "completed", units: [{ topic: "security", outcome: "published" }, { topic: "vite-major", outcome: "published" }] });
    expect(h.agentCalls.map((call) => (call.input["moves"] as Array<{ major: boolean }>).map((move) => move.major))).toEqual([[false], [true]]);
    expect(h.workspace.publications.map((entry) => [entry.prepared.branch, entry.prepared.baseSha])).toEqual([
      ["secure-it/2026-10-07-security", BASE_SHA], ["secure-it/2026-10-07-vite-major", BASE_SHA],
    ]);
  });

  it("recognises a major PR by its recorded unit, not a branch topic another package can share", async () => {
    const majorOf = (name: string) => vite({ name, locations: [`node_modules/${name}`], to: { version: "9.0.1", line: "9", aged: true, major: true, blockers: [] } });
    const other = await batchPr([majorOf("@scope/foo")], { headRef: "secure-it/2026-10-05-scope-foo-major" });
    const h = harness({ prs: [other], fixes: [majorOf("scope-foo")] });
    expect(await secureIt(h.deps).run(h.context)).toMatchObject({ units: [{ topic: "scope-foo-major", outcome: "published" }] });
    expect(h.github.prs.get(7)?.headSha).toBe(HEAD_SHA);
    expect(h.workspace.publications.map((entry) => entry.prepared.branch)).toEqual(["secure-it/2026-10-07-scope-foo-major"]);
  });

  it("recognises its numbered PR for a long topic, whose branch was cut to fit the number", async () => {
    const name = `pkg-${"x".repeat(70)}`;
    const major = vite({ name, locations: [`node_modules/${name}`], to: { version: "9.0.1", line: "9", aged: true, major: true, blockers: [] } });
    const numbered = await batchPr([major], { headRef: `secure-it/2026-10-05-${`${name}-major`.slice(0, 58)}-2` });
    const h = harness({ prs: [numbered], fixes: [major] });
    expect(await secureIt(h.deps).run(h.context)).toMatchObject({ units: [{ topic: `${name}-major`, outcome: "already-open" }] });
    expect(h.workspace.publications).toHaveLength(0);
  });

  it("leaves an identical routine to review while still publishing a needed major", async () => {
    const major = vite({ to: { version: "9.0.1", line: "9", aged: true, major: true, blockers: [] } });
    const h = harness({ prs: [await batchPr([leftPad()])], fixes: [major, leftPad()] });
    expect(await secureIt(h.deps).run(h.context)).toMatchObject({
      units: [{ topic: "security", outcome: "already-open" }, { topic: "vite-major", outcome: "published" }],
    });
    expect(h.agentCalls).toHaveLength(1);
    expect(h.workspace.publications).toHaveLength(1);
    expect(h.github.prs.get(7)?.headSha).toBe(HEAD_SHA);
  });

  it("continues to a major when the routine fails, and leaves legacy package PRs to review", async () => {
    const previous = await vitePr();
    const legacy = { ...planOf(previous.body)!, kind: undefined, topic: "vite" };
    const h = harness({ prs: [{ ...previous, headRef: "secure-it/2026-10-05-vite", body: withMarker(RULES, planSection(legacy), { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }) }],
      fixes: [vite(), leftPad({ to: { version: "2.0.0", line: "2", aged: true, major: true, blockers: [] } })] });
    const deps = { ...h.deps, verify: async (input: VerifyInputs) => input.plan.kind === "routine" ? ["unattributed policy failure"] : [] };
    expect(await secureIt(deps).run(h.context)).toMatchObject({ units: [{ outcome: "verification-failed" }, { topic: "left-pad-major", outcome: "published" }] });
    expect(h.github.prs.get(7)?.headSha).toBe(HEAD_SHA);
    expect(h.workspace.publications).toHaveLength(1);
  });

  it("combines npm, Gradle and action fixes in the routine", async () => {
    const action = vite({ ecosystem: "GitHub Actions", name: "actions/checkout", from: "v4.2.2", locations: [".github/workflows/ci.yml"], to: { version: "v4.2.3", line: "4", aged: true, major: false, blockers: [] } });
    const maven = vite({ ecosystem: "Maven", name: "g:lib", from: "1.0", locations: [":runtimeClasspath"], to: { version: "1.1", line: "1", aged: true, major: false, blockers: [] } });
    const inventory: GradleInventory = { schemaVersion: 1, tree: "base", builds: [{ build: ".", configurations: [{ id: ":runtimeClasspath", kind: "project", declared: [{ group: "g", name: "lib", version: "1.0", reason: undefined }], resolved: [{ group: "g", name: "lib", version: "1.0" }], unresolved: [], error: undefined }] }] };
    const h = harness({ fixes: [vite(), action, maven] });
    const env = await h.deps.gate(h.context);
    const deps = { ...h.deps, gradle: () => ({ ofCommit: async () => inventory, ofWorkingTree: async () => inventory }),
      gate: async () => ({ ...env, fetch: async (url: string) => url.includes("/git/ref/tags/")
        ? { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ object: { type: "commit", sha: HEAD_SHA } }), text: async () => "" }
        : env.fetch(url) }) };
    expect(await secureIt(deps).run(h.context)).toMatchObject({ outcome: "published", packages: ["GitHub Actions|actions/checkout", "Maven|g:lib", "npm|vite"] });
    expect(h.agentCalls).toHaveLength(1);
    expect(h.workspace.publications).toHaveLength(1);
    expect(planOf(h.github.prs.get(42)!.body)?.moves.find((move) => move.name === "actions/checkout")?.commitSha).toBe(HEAD_SHA);
  });

  it("reports a fix of a strictly pinned Gradle coordinate as blocked, and gives the agent only the rest", async () => {
    const maven = (name: string) => vite({ ecosystem: "Maven", name, from: "1.0", locations: [":runtimeClasspath"], to: { version: "1.1", line: "1", aged: true, major: false, blockers: [] } });
    const declared = [{ group: "g", name: "lib", version: "1.0", reason: undefined }, { group: "g", name: "pinned", version: "1.0", reason: undefined, strict: true as const }];
    const inventory: GradleInventory = { schemaVersion: 3, tree: "base", builds: [{ build: ".", configurations: [{ id: ":runtimeClasspath", kind: "project", declared,
      resolved: declared.map(({ group, name, version }) => ({ group, name, version })), unresolved: [], error: undefined }] }] };
    const h = harness({ fixes: [vite(), maven("g:lib"), maven("g:pinned")] });
    const deps = { ...h.deps, gradle: () => ({ ofCommit: async () => inventory, ofWorkingTree: async () => inventory }) };
    expect(await secureIt(deps).run(h.context)).toMatchObject({ outcome: "published", packages: ["Maven|g:lib", "npm|vite"],
      blocked: [{ packages: ["Maven|g:pinned"], reasons: [expect.stringContaining("g:pinned is pinned with strictly(...) at :runtimeClasspath")] }] });
    expect(h.agentCalls.map((call) => (call.input["moves"] as Array<{ name: string }>).map((move) => move.name).sort())).toEqual([["g:lib", "vite"]]);
  });

  it("asks the agent again with the refusal and publishes the second attempt when it passes", async () => {
    const h = harness({ fixes: [vite()] });
    let attempts = 0;
    const refusal = "compare: tools.jackson:jackson-bom@3.2.4 was published 2026-10-18T22:36:10.000Z (4.8 days ago, under 7)";
    const deps = { ...h.deps, verify: async () => (++attempts === 1 ? [refusal] : []) };
    expect(await secureIt(deps).run(h.context)).toMatchObject({ outcome: "published", rejected: [refusal] });
    expect(h.agentCalls.map((call) => [call.input["mode"], call.input["rejected"]])).toEqual([["apply", undefined], ["apply", [refusal]]]);
    expect(h.reverted).toEqual([BASE_SHA]);
    expect(h.workspace.publications).toHaveLength(1);
  });

  it("stops at the second attempt's cannot-apply, keeping the first refusal", async () => {
    const h = harness({ fixes: [vite()], problems: ["vite at node_modules/vite is 8.3.2, not 8.3.3"] });
    let calls = 0;
    const context = { ...h.context, agent: (async () => (++calls === 1 ? APPLIED : { outcome: "cannot-apply", summary: "the floor needs a parent move" })) as ToolRunContext["agent"] };
    expect(await secureIt(h.deps).run(context)).toMatchObject({
      outcome: "verification-failed", rejected: ["vite at node_modules/vite is 8.3.2, not 8.3.3"],
      problems: ["vite at node_modules/vite is 8.3.2, not 8.3.3", "asked again with that refusal, the agent couldn't apply: the floor needs a parent move"],
    });
    expect(calls).toBe(2);
    expect(h.workspace.publications).toEqual([]);
  });

  it("keeps the first refusal when the second attempt throws", async () => {
    const h = harness({ fixes: [vite()], problems: ["vite at node_modules/vite is 8.3.2, not 8.3.3"] });
    let calls = 0;
    const context = { ...h.context, agent: (async () => {
      if (++calls === 1) return APPLIED;
      throw new Error("agent crashed");
    }) as ToolRunContext["agent"] };
    expect(await secureIt(h.deps).run(context)).toMatchObject({
      outcome: "verification-failed", rejected: ["vite at node_modules/vite is 8.3.2, not 8.3.3"],
      problems: ["vite at node_modules/vite is 8.3.2, not 8.3.3", "asked again with that refusal, the attempt failed: agent crashed"],
    });
  });

  it.each([
    ["can't apply", async () => ({ outcome: "cannot-apply", summary: "the floor needs a parent move" })],
    ["throws", async () => {
      throw new Error("agent crashed");
    }],
  ])("still reduces from the first refusal when the second attempt %s", async (_case, second) => {
    const refusal = "compare: new: left-pad@1.0.1: GHSA-new has no exception";
    const h = harness({ fixes: [vite(), leftPad()] });
    const verified: string[] = [];
    const deps = { ...h.deps, verify: async (input: VerifyInputs) => {
      verified.push(input.plan.packages.join(","));
      return input.plan.packages.includes("npm|left-pad") ? [refusal] : [];
    } };
    const asked: unknown[] = [];
    let calls = 0;
    const context = { ...h.context, agent: (async (request: Parameters<ToolRunContext["agent"]>[0]) => {
      asked.push((request.input as Record<string, unknown>)["rejected"]);
      return ++calls === 2 ? second() : h.context.agent(request);
    }) as ToolRunContext["agent"] };
    expect(await secureIt(deps).run(context)).toMatchObject({
      outcome: "published", packages: ["npm|vite"], rejected: [refusal], leftOut: [{ moves: [{ name: "left-pad" }], problems: [refusal] }],
    });
    // The reduced plan starts from the base without the refusal, and publishes only after its own verification.
    expect(asked).toEqual([undefined, [refusal], undefined]);
    expect(h.reverted).toEqual([BASE_SHA, BASE_SHA]);
    expect(verified).toEqual(["npm|left-pad,npm|vite", "npm|vite"]);
    expect(h.workspace.publications).toHaveLength(1);
  });

  it.each([
    ["can't apply", "cannot-apply", [], "retry could not apply: no room"],
    ["throws", "throw", [], "retry failed: agent crashed"],
    ["leaves problems", "applied", ["vite at node_modules/vite is 8.3.2, not 8.3.3"], "vite at node_modules/vite is 8.3.2, not 8.3.3"],
    ["can't evaluate the cooldown", "applied", "unevaluated", "the cooldown can't be evaluated: base's settings don't parse"],
  ] as const)("keeps why asking again stopped when the reduced attempt %s", async (_case, reduced, reducedProblems, problem) => {
    const refusal = "compare: new: left-pad@1.0.1: GHSA-new has no exception";
    const h = harness({ fixes: [vite(), leftPad()] });
    const deps = { ...h.deps, verify: async (input: VerifyInputs) => {
      if (input.plan.packages.includes("npm|left-pad")) return [refusal];
      if (reducedProblems !== "unevaluated") return [...reducedProblems];
      input.cooldown?.({ evaluated: false, reason: "base's settings don't parse" });
      return [];
    } };
    let calls = 0;
    const context = { ...h.context, agent: (async (request: Parameters<ToolRunContext["agent"]>[0]) => {
      if (++calls === 2) return { outcome: "cannot-apply", summary: "the floor needs a parent move" };
      if (calls === 3 && reduced === "cannot-apply") return { outcome: "cannot-apply", summary: "no room" };
      if (calls === 3 && reduced === "throw") throw new Error("agent crashed");
      return h.context.agent(request);
    }) as ToolRunContext["agent"] };
    expect(await secureIt(deps).run(context)).toMatchObject({
      outcome: "verification-failed", rejected: [refusal],
      problems: [problem, "asked again with that refusal, the agent couldn't apply: the floor needs a parent move"],
    });
    expect(calls).toBe(3);
    expect(h.workspace.publications).toEqual([]);
  });

  it("keeps the first refusal when the reduced attempt throws", async () => {
    const h = harness({ fixes: [vite(), leftPad()], problems: ["compare: new: left-pad@1.0.1: GHSA-new has no exception"] });
    let calls = 0;
    const context = { ...h.context, agent: (async () => {
      if (++calls <= 2) return APPLIED;
      throw new Error("agent crashed");
    }) as ToolRunContext["agent"] };
    expect(await secureIt(h.deps).run(context)).toMatchObject({
      outcome: "verification-failed", rejected: ["compare: new: left-pad@1.0.1: GHSA-new has no exception"], problems: ["retry failed: agent crashed"],
    });
    expect(calls).toBe(3);
  });

  it("retries a failed batch from base once without named package groups and discloses them", async () => {
    const h = harness({ fixes: [vite(), leftPad()] });
    const sequence: string[] = [];
    const deps = { ...h.deps, verify: async (input: VerifyInputs) => {
      sequence.push(`verify:${input.plan.packages.join(",")}`);
      return input.plan.packages.includes("npm|left-pad") ? ["compare: new: left-pad@1.0.1: GHSA-new has no exception"] : [];
    }, revert: async (wc: WorkingCopy, sha: string) => {
      sequence.push(`revert:${sha}`);
      return h.deps.revert(wc, sha);
    } };
    expect(await secureIt(deps).run(h.context)).toMatchObject({
      outcome: "published", packages: ["npm|vite"], leftOut: [{ moves: [{ name: "left-pad" }], problems: [expect.stringContaining("GHSA-new")] }],
      rejected: ["compare: new: left-pad@1.0.1: GHSA-new has no exception"],
    });
    // The same plan once more with the refusal, then the reduced one from the last problems.
    expect(sequence).toEqual(["verify:npm|left-pad,npm|vite", `revert:${BASE_SHA}`, "verify:npm|left-pad,npm|vite", `revert:${BASE_SHA}`, "verify:npm|vite"]);
    expect(h.agentCalls.map((call) => (call.input["moves"] as Array<{ name: string }>).map((move) => move.name))).toEqual([["vite", "left-pad"], ["vite", "left-pad"], ["vite"]]);
    expect(h.agentCalls.map((call) => call.input["rejected"])).toEqual([undefined, ["compare: new: left-pad@1.0.1: GHSA-new has no exception"], undefined]);
    const pr = h.github.prs.get(42)!;
    expect(pr.body).toContain("Left out after verification failed");
    expect(pr.body).toContain("left-pad");
    expect(planOf(pr.body)?.packages).toEqual(["npm|vite"]);
    expect(planOf(pr.body)?.leftOut?.[0]?.moves[0]?.name).toBe("left-pad");
    expect(h.workspace.publications).toHaveLength(1);
  });

  it("does not retry a second time or guess a parent for an induced/global failure", async () => {
    const h = harness({ fixes: [vite(), leftPad()] });
    let attempts = 0;
    const deps = { ...h.deps, verify: async () => ++attempts <= 2 ? ["left-pad at node_modules/left-pad is 1.0.2, not 1.0.1"] : ["vite at node_modules/vite is 8.3.2, not 8.3.3"] };
    expect(await secureIt(deps).run(h.context)).toMatchObject({ outcome: "verification-failed", leftOut: [{ moves: [{ name: "left-pad" }] }], named: [{ moves: [{ name: "left-pad" }] }, { moves: [{ name: "vite" }] }] });
    expect(h.agentCalls).toHaveLength(3);
    expect(h.workspace.publications).toEqual([]);
    const unknown = harness({ fixes: [vite(), leftPad()], problems: ["compare: new: induced@1.0.1: GHSA-new has no exception"] });
    expect(await secureIt(unknown.deps).run(unknown.context)).toMatchObject({ outcome: "verification-failed", named: [{ moves: [] }] });
    // Asked once more with the refusal; no reduction guesses a parent.
    expect(unknown.agentCalls).toHaveLength(2);
    expect(unknown.reverted).toHaveLength(1);
  });

  it("does not shrink malware after verification fails", async () => {
    const h = harness({ fixes: [vite({ malicious: true }), leftPad({ malicious: true })], problems: ["compare: new: left-pad@1.0.1: MAL-bad has no exception"] });
    expect(await secureIt(h.deps).run(h.context)).toMatchObject({ outcome: "verification-failed", topic: "malware", leftOut: [] });
    // The whole plan once more with the refusal, never a smaller one.
    expect(h.agentCalls.map((call) => (call.input["moves"] as unknown[]).length)).toEqual([2, 2]);
    expect(h.workspace.publications).toEqual([]);
  });

  it("sets no per-call effort for a major: the config's applies to every call", async () => {
    const h = harness({ fixes: [vite({ to: { version: "9.0.1", line: "9", aged: true, major: true, blockers: [] } })] });
    await secureIt(h.deps).run(h.context);
    expect(h.agentCalls[0]).not.toHaveProperty("effort");
  });
});

describe("secure-it review", () => {
  const NEW_BASE = "f".repeat(40);

  it("writes a clean same-plan rebase's real materialization and preserves floor history without an agent", async () => {
    const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
    const root = { dependencies: { parent: "^1.0.0" } };
    const packages = { "": root, "node_modules/parent": { version: "1.0.0", dependencies: { vite: "8.3.1", child: "^1" } }, "node_modules/vite": { version: "8.3.1" }, "node_modules/child": { version: "1.0.0" } };
    const baseFiles: Record<string, string> = { "package.json": json(root), "package-lock.json": json({ lockfileVersion: 3, packages }) };
    const fix = vite();
    const plan = await planFor([fix], { named: undefined, lockfiles: new Map([["package-lock.json", JSON.parse(baseFiles["package-lock.json"]!)]]), gradle: undefined, tagCommit: async () => undefined });
    expect(plan.moves[0]?.mechanism).toBe("npm-override");
    const floor = { ecosystem: "npm", package: "vite", version: "8.3.3", declaredIn: "package.json", selector: [["vite"]], purpose: "security", advisories: fix.targets, reason: "Original PR security reason", added: "2026-10-05" };
    const compatibility = { ecosystem: "Maven", package: "a:b", version: "1.0.0", declaredIn: "build.gradle", selector: [":runtimeClasspath"], purpose: "compatibility", advisories: [], reason: "Keep compatible APIs", added: "2026-09-01" };
    baseFiles[FLOORS_PATH] = json({ floors: [compatibility] });
    const current: Record<string, string> = { ...baseFiles,
      "package.json": json({ ...root, overrides: { vite: "8.3.3" } }),
      "package-lock.json": json({ packages: { ...packages, "node_modules/vite": { version: "8.3.3" } } }),
      [FLOORS_PATH]: json({ floors: [floor, compatibility] }),
    };
    const pr = ownPr({ headRef: "secure-it/2026-10-05-security", body: withMarker(RULES, planSection(plan), { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }) });
    const h = harness({ prs: [pr], baseSha: NEW_BASE, files: baseFiles, fixes: [fix] });
    h.workspace.setRemoteHead(pr.headRef, HEAD_SHA);
    const dir = await mkdtemp(join(process.cwd(), ".review-materialize-"));
    try {
      for (const [path, text] of Object.entries(baseFiles)) {
        await mkdir(join(dir, path, ".."), { recursive: true });
        await writeFile(join(dir, path), text);
      }
      const base = tree(NEW_BASE, baseFiles);
      let verifications = 0;
      const deps: SecureItDeps = {
        ...h.deps,
        // The verification snapshot holds the working tree as it is then.
        trees: { commit: async (_wc, sha) => (sha === SNAPSHOT ? tree(SNAPSHOT, { ...current }) : base), working: () => tree("merged", current) },
        materializeNpm: async (context, source, recomputed, exclude) => materializeInCopy(context, dir, source, recomputed, exclude, async (cwd, args) => {
          if (args[0] === "--version") return { code: 0, stdout: "11.19.1", stderr: "" };
          const manifest = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
          await writeFile(join(cwd, "package-lock.json"), json({ packages: { ...packages, "": manifest, "node_modules/vite": { version: "8.3.3" }, "node_modules/child": { version: "1.1.0" } } }));
          return { code: 0, stdout: "", stderr: "" };
        }),
        writeFile: async (_wc, path, text) => { current[path] = text; },
        verify: async (inputs) => {
          verifications++;
          return [...await computedNpmProblems(inputs.npmFiles, inputs.head, false, inputs.base, await h.deps.changedBetween(h.context.workingCopy, NEW_BASE, SNAPSHOT)),
            ...await preservedFloors(inputs.plan, inputs.base, inputs.head, {})];
        },
      };
      expect(await secureIt(deps).review(h.context)).toMatchObject({ reviewed: [{ number: pr.number, outcome: "rebased" }] });
      expect(verifications).toBe(1);
      expect(JSON.parse(current["package-lock.json"]!).packages["node_modules/child"].version).toBe("1.1.0");
      expect(JSON.parse(current[FLOORS_PATH]!).floors).toEqual([floor, compatibility]);
      expect(h.agentCalls).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("recomputes on the moved base: retires a PR whose fix the base already has, before any agent", async () => {
    const fixedOnBase = harness({ prs: [await vitePr()], baseSha: NEW_BASE, fixes: [] });
    fixedOnBase.workspace.setRemoteHead("secure-it/2026-10-05-security", HEAD_SHA);
    expect(await secureIt(fixedOnBase.deps).review(fixedOnBase.context)).toMatchObject({ reviewed: [{ number: 7, outcome: "retired" }] });
    expect(fixedOnBase.github.prs.get(7)?.state).toBe("closed");
    expect(fixedOnBase.agentCalls).toEqual([]);

    // Fixes remain on the new base, but the re-applied edit doesn't verify: an error, never a quiet retirement.
    const lost = harness({ prs: [await vitePr()], baseSha: NEW_BASE, problems: ["vite at node_modules/vite is 8.3.1, not 8.3.3"] });
    lost.workspace.setRemoteHead("secure-it/2026-10-05-security", HEAD_SHA);
    expect(await secureIt(lost.deps).review(lost.context)).toMatchObject({ reviewed: [{ number: 7, outcome: "error", detail: expect.stringContaining("after merging the default branch") }] });
    expect(lost.github.prs.get(7)?.state).toBe("open");

    const merged = harness({ prs: [await vitePr()], baseSha: NEW_BASE });
    merged.workspace.setRemoteHead("secure-it/2026-10-05-security", HEAD_SHA);
    expect(await secureIt(merged.deps).review(merged.context)).toMatchObject({ reviewed: [{ number: 7, outcome: "rebased" }] });
    expect(stateOf(merged.github.prs.get(7)!.body)).toEqual({ head: PUSHED_SHA, base: NEW_BASE, adaptations: 0 });
    expect(merged.agentCalls).toEqual([]);
  });

  it("reconciles a PR whose plan the moved base changed: reverted to the base, the new plan applied and recorded", async () => {
    const h = harness({ prs: [await vitePr()], baseSha: NEW_BASE, fixes: [vite({ to: { version: "8.3.4", line: "8", aged: true, major: false, blockers: [] } })] });
    h.workspace.setRemoteHead("secure-it/2026-10-05-security", HEAD_SHA);
    h.workspace.setPrepareConflict("secure-it/2026-10-05-security");
    expect(await secureIt(h.deps).review(h.context)).toMatchObject({ reviewed: [{ number: 7, outcome: "rebased" }] });
    // Reverting resolves the conflicts too: nothing is taken file by file, and the agent applies on the base.
    expect(h.reverted).toEqual([NEW_BASE]);
    expect(h.written).toEqual([]);
    expect(h.agentCalls.map((call) => call.input["mode"])).toEqual(["apply"]);
    expect(h.agentCalls[0]?.input["npmAgeExclusions"]).toEqual(["left-pad", "vite"]);
    const pr = h.github.prs.get(7)!;
    expect(pr.title).toBe("moving vite to 8.3.3");
    expect(planOf(pr.body)?.moves[0]?.to).toBe("8.3.4");
    expect(pr.body.match(/What secure-it moved/g)).toHaveLength(1);
  });

  it("takes the base's side of a conflicted lockfile and has the agent re-apply, or resolve code conflicts", async () => {
    const h = harness({ prs: [await vitePr()], baseSha: NEW_BASE });
    h.workspace.setRemoteHead("secure-it/2026-10-05-security", HEAD_SHA);
    h.workspace.setPrepareConflict("secure-it/2026-10-05-security");
    expect(await secureIt(h.deps).review(h.context)).toMatchObject({ reviewed: [{ number: 7, outcome: "rebased" }] });
    expect(h.written).toEqual([`package-lock.json=${LOCK}`]);
    expect(h.agentCalls.map((call) => call.input["mode"])).toEqual(["resolve"]);
    expect(h.agentCalls[0]?.input["npmAgeExclusions"]).toEqual(["left-pad", "vite"]);
  });

  it("recomputes the whole routine on a moved base, adding new packages and retiring old fixes", async () => {
    const h = harness({ prs: [await vitePr()], baseSha: NEW_BASE, fixes: [leftPad()] });
    h.workspace.setRemoteHead("secure-it/2026-10-05-security", HEAD_SHA);
    expect(await secureIt(h.deps).review(h.context)).toMatchObject({ reviewed: [{ outcome: "rebased" }] });
    expect(h.reverted).toEqual([NEW_BASE]);
    expect(planOf(h.github.prs.get(7)!.body)?.packages).toEqual(["npm|left-pad"]);
    expect(h.agentCalls[0]?.input).toMatchObject({ moves: [{ name: "left-pad" }] });
  });

  it("reviews only a major's package and retires it when only non-major work remains", async () => {
    const major = vite({ to: { version: "9.0.1", line: "9", aged: true, major: true, blockers: [] } });
    const h = harness({ prs: [await vitePr({}, major)], baseSha: NEW_BASE, fixes: [major, leftPad()] });
    h.workspace.setRemoteHead("secure-it/2026-10-05-vite-major", HEAD_SHA);
    expect(await secureIt(h.deps).review(h.context)).toMatchObject({ reviewed: [{ outcome: "rebased" }] });
    expect(planOf(h.github.prs.get(7)!.body)?.packages).toEqual(["npm|vite"]);
    const retired = harness({ prs: [await vitePr({}, major)], baseSha: NEW_BASE, fixes: [vite(), leftPad()] });
    retired.workspace.setRemoteHead("secure-it/2026-10-05-vite-major", HEAD_SHA);
    expect(await secureIt(retired.deps).review(retired.context)).toMatchObject({ reviewed: [{ outcome: "retired" }] });
    expect(retired.agentCalls).toEqual([]);
  });

  it("retries a rebased routine and records omissions in its updated plan", async () => {
    const h = harness({ prs: [await vitePr()], baseSha: NEW_BASE, fixes: [vite(), leftPad()] });
    h.workspace.setRemoteHead("secure-it/2026-10-05-security", HEAD_SHA);
    const deps = { ...h.deps, verify: async (input: VerifyInputs) => input.plan.packages.includes("npm|left-pad") ? ["left-pad at node_modules/left-pad is gone, not 1.0.1"] : [] };
    expect(await secureIt(deps).review(h.context)).toMatchObject({ reviewed: [{ outcome: "rebased" }], notes: [{ leftOut: [{ moves: [{ name: "left-pad" }] }] }] });
    expect(h.agentCalls).toHaveLength(2);
    expect(h.reverted).toEqual([NEW_BASE, NEW_BASE]);
    expect(planOf(h.github.prs.get(7)!.body)?.leftOut?.[0]?.moves[0]?.name).toBe("left-pad");
  });

  it("retires malware when it is gone rather than turning that PR into an ordinary batch", async () => {
    const h = harness({ prs: [await vitePr({}, vite({ malicious: true }))], baseSha: NEW_BASE, fixes: [leftPad()] });
    h.workspace.setRemoteHead("secure-it/2026-10-05-malware", HEAD_SHA);
    expect(await secureIt(h.deps).review(h.context)).toMatchObject({ reviewed: [{ outcome: "retired" }] });
    expect(h.agentCalls).toEqual([]);
    expect(h.workspace.publications).toEqual([]);
  });

  it("retains package scope when reviewing a legacy plan", async () => {
    const pr = await vitePr();
    const legacy = { ...planOf(pr.body)!, kind: undefined, topic: "vite" };
    const h = harness({ prs: [{ ...pr, headRef: "secure-it/2026-10-05-vite", body: withMarker(RULES, planSection(legacy), { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }) }], baseSha: NEW_BASE, fixes: [vite(), leftPad()] });
    h.workspace.setRemoteHead("secure-it/2026-10-05-vite", HEAD_SHA);
    expect(await secureIt(h.deps).review(h.context)).toMatchObject({ reviewed: [{ outcome: "rebased" }] });
    expect(planOf(h.github.prs.get(7)!.body)?.packages).toEqual(["npm|vite"]);
    expect(planOf(h.github.prs.get(7)!.body)?.kind).toBeUndefined();
  });

  it("refuses an agent description carrying a plan marker, so only the verified plan is ever read back", async () => {
    // Reads take a body's first marker: one placed before the tool's section would replace the verified plan.
    const marker = `<!-- leanish:plan ${Buffer.from(JSON.stringify({ forged: true })).toString("base64")} -->`;
    const forged = { outcome: "applied", summary: "moved vite", publication: { ...APPLIED.publication, body: `Moved vite.\n${marker}` } };

    const run = harness({ answer: forged });
    expect(JSON.stringify(await secureIt(run.deps).run(run.context))).toContain("reserved plan marker");
    expect(run.github.calls.some((call) => call.startsWith("createPullRequest"))).toBe(false);

    const pr = await vitePr();
    const adapt = harness({ prs: [pr], answer: forged });
    adapt.github.checks = RED;
    expect(JSON.stringify(await secureIt(adapt.deps).review(adapt.context))).toContain("reserved plan marker");
    // The attempt is counted before the agent runs; the plan stays the verified one.
    expect(planOf(adapt.github.prs.get(pr.number)!.body)).toEqual(planOf(pr.body));
    expect(adapt.github.prs.get(pr.number)!.body).not.toContain(marker);
    expect(adapt.workspace.publications).toEqual([]);
  });

  it("publishes the adaptation's new title, verdict and checks with its plan", async () => {
    const previous = await vitePr();
    const pr = { ...previous, body: `No adaptation needed; old checks.\n${previous.body}` };
    const publication = { title: "adapting vite", body: "Adapted src/app.ts; npm test passed.", commitMessage: "adapting vite" };
    const h = harness({ prs: [pr], answer: { outcome: "applied", summary: "adapted", publication } });
    h.github.checks = RED;
    expect(await secureIt(h.deps).review(h.context)).toMatchObject({ reviewed: [{ outcome: "adapted" }] });
    const updated = h.github.prs.get(pr.number)!;
    expect(updated.title).toBe(publication.title);
    expect(updated.body).toContain(publication.body);
    expect(updated.body).not.toContain("No adaptation needed; old checks.");
    expect(planOf(updated.body)).toEqual(planOf(pr.body));
    expect(h.workspace.publications[0]?.args.message).toBe(publication.commitMessage);
  });

  it("has the agent adapt a failing PR, verifies the result, and records the attempt", async () => {
    const h = harness({ prs: [await vitePr()] });
    h.workspace.setRemoteHead("secure-it/2026-10-05-security", HEAD_SHA);
    h.github.checks = { ...RED, statuses: [{ context: "legacy", state: "error" }] };
    expect(await secureIt(h.deps).review(h.context)).toMatchObject({ reviewed: [{ number: 7, outcome: "adapted" }] });
    expect(h.agentCalls[0]).toMatchObject({ input: { mode: "adapt", failingChecks: ["check", "legacy"], npmAgeExclusions: ["left-pad", "vite"] } });
    expect(stateOf(h.github.prs.get(7)!.body)?.adaptations).toBe(1);

    const failing = harness({ prs: [await vitePr()], problems: ["compare: new: vite@8.3.3: GHSA-new has no exception"] });
    failing.workspace.setRemoteHead("secure-it/2026-10-05-security", HEAD_SHA);
    failing.github.checks = RED;
    expect(await secureIt(failing.deps).review(failing.context)).toMatchObject({ reviewed: [{ number: 7, outcome: "error", detail: expect.stringContaining("doesn't verify") }] });
    expect(stateOf(failing.github.prs.get(7)!.body)?.adaptations).toBe(1);
    // An adaptation isn't restarted from the base with the refusal: that would lose it.
    expect(failing.agentCalls.map((call) => call.input["rejected"])).toEqual([undefined]);
  });
});

const FLOOR_RAW = { ecosystem: "npm", package: "left-pad", version: "1.0.0", declaredIn: "package.json", selector: ["left-pad"], purpose: "security", advisories: ["CVE-2026-12345"], reason: "fixed", added: "2026-10-01" };
function removalFixture(ecosystem = "npm") {
  const raw = ecosystem === "npm" ? FLOOR_RAW : { ...FLOOR_RAW, ecosystem: "Maven", package: "g:lib", version: "1.0", declaredIn: "build.gradle.kts", selector: [":runtimeClasspath"] };
  const record = JSON.stringify({ floors: [raw] });
  const selected = parseFloors(JSON.parse(record));
  const files = new Map([[FLOORS_PATH, withoutFloorRecords(record, selected)]]);
  if (ecosystem === "npm") {
    files.set("package.json", "{}");
    files.set("package-lock.json", LOCK);
  }
  const base = { "package-lock.json": LOCK, [FLOORS_PATH]: record, [raw.declaredIn]: ecosystem === "npm" ? '{"overrides":{"left-pad":"1.0.0"}}' : "dependencies {}" };
  const probe = async () => ({ files, findings: [], problems: [] });
  const computed = () => selectRemovals(selected, probe, (text) => createHash("sha256").update(text).digest("hex"));
  return { base, files, probe, computed };
}

async function removalPr(f: ReturnType<typeof removalFixture>, overrides: Partial<GitHubPullRequest> = {}): Promise<GitHubPullRequest> {
  const { plan } = await f.computed();
  return ownPr({ headRef: "secure-it/2026-10-05-floor-removal", labels: [RULES.label],
    body: withMarker(RULES, planSection(plan!), { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }), ...overrides });
}

describe("secure-it floor-removal units", () => {
  it("opens an independent tool-written npm removal PR when there are no findings, without a model", async () => {
    const f = removalFixture();
    const h = harness({ fixes: [], files: f.base });
    let proofs = 0;
    const result = await secureIt({ ...h.deps, floorProbe: async () => { proofs++; return f.probe(); } }).run(h.context);
    expect(result).toMatchObject({ outcome: "published", topic: "floor-removal", units: [{ outcome: "published" }] });
    expect(proofs).toBe(2);
    expect(h.agentCalls).toEqual([]);
    expect(h.workspace.publications).toHaveLength(1);
    expect(h.written).toEqual(expect.arrayContaining([...f.files].map(([path, content]) => `${path}=${content}`)));
    const pr = [...h.github.prs.values()][0]!;
    expect(pr.headRef).toBe("secure-it/2026-10-07-floor-removal");
    expect(planOf(pr.body)?.kind).toBe("floor-removal");
  });
  it("runs alongside the ordinary security batch and cannot be blocked by its open PR", async () => {
    const f = removalFixture();
    const h = harness({ files: f.base });
    expect(await secureIt({ ...h.deps, floorProbe: f.probe }).run(h.context)).toMatchObject({ outcome: "completed", units: [{ topic: "security", outcome: "published" }, { topic: "floor-removal", outcome: "published" }] });
    expect(h.agentCalls).toHaveLength(1);
    expect(h.workspace.publications).toHaveLength(2);
  });
  it("never offers a floor the build pins with strictly(...) for removal", async () => {
    const f = removalFixture("Maven");
    const inventory: GradleInventory = { schemaVersion: 3, tree: "base", builds: [{ build: ".", configurations: [{ id: ":runtimeClasspath", kind: "project",
      declared: [{ group: "g", name: "lib", version: "1.0", reason: "CVE-2026-12345: fixed", strict: true }], resolved: [{ group: "g", name: "lib", version: "1.0" }], unresolved: [], error: undefined }] }] };
    const h = harness({ fixes: [], files: f.base });
    const floorProbe = async () => { throw new Error("must not probe a strictly pinned floor"); };
    const result = await secureIt({ ...h.deps, floorProbe, gradle: () => ({ ofCommit: async () => inventory, ofWorkingTree: async () => inventory }) }).run(h.context);
    expect(result).toMatchObject({ units: [{ topic: "floor-removal", outcome: "nothing-to-remove", notes: [expect.stringContaining("g:lib is pinned with strictly(...) at :runtimeClasspath")] }] });
    expect(h.workspace.publications).toEqual([]);
  });
  it("keeps malware priority and never probes removals while any malicious package remains", async () => {
    const f = removalFixture();
    const h = harness({ files: f.base, fixes: [vite({ malicious: true, to: undefined, problem: "no clean version" })] });
    const floorProbe = async () => { throw new Error("must not probe floors"); };
    expect(await secureIt({ ...h.deps, floorProbe }).run(h.context)).toMatchObject({ outcome: "nothing-to-fix", units: [] });
    expect(h.workspace.publications).toEqual([]);
  });
  it("rewrites an open removal PR's notes when they changed, keeping its commits", async () => {
    const f = removalFixture();
    const { plan } = await f.computed();
    const pr = await removalPr(f, { body: withMarker(RULES, planSection({ ...plan!, floorRemoval: { ...plan!.floorRemoval!, notes: ["an outdated reason"] } }), { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }) });
    const h = harness({ fixes: [], files: f.base, prs: [pr] });
    expect(await secureIt({ ...h.deps, floorProbe: f.probe }).run(h.context)).toMatchObject({ outcome: "already-open" });
    expect(h.github.prs.get(pr.number)!.body).not.toContain("an outdated reason");
    expect(h.workspace.publications).toEqual([]);
  });

  it("suppresses a recognised identical removal and updates a changed plan by reverting", async () => {
    const f = removalFixture();
    const pr = await removalPr(f);
    const h = harness({ fixes: [], files: f.base, prs: [pr] });
    expect(await secureIt({ ...h.deps, floorProbe: f.probe }).run(h.context)).toMatchObject({ outcome: "already-open" });
    expect(h.workspace.publications).toEqual([]);
    const changed = harness({ fixes: [], files: f.base, prs: [pr] });
    const newFiles = new Map(f.files);
    newFiles.set("package-lock.json", "new exact bytes");
    expect(await secureIt({ ...changed.deps, floorProbe: async () => ({ files: newFiles, findings: [], problems: [] }) }).run(changed.context)).toMatchObject({ outcome: "updated" });
    expect(changed.reverted).toEqual([BASE_SHA]);
    expect(changed.agentCalls).toEqual([]);
  });
  it("leaves a human-pushed removal PR alone and opens a separate suffixed branch", async () => {
    const f = removalFixture();
    const pr = await removalPr(f, { headRef: "secure-it/2026-10-07-floor-removal", headSha: PUSHED_SHA });
    const h = harness({ fixes: [], files: f.base, prs: [pr] });
    expect(await secureIt({ ...h.deps, floorProbe: f.probe }).run(h.context)).toMatchObject({ outcome: "published" });
    expect(h.workspace.publications[0]?.prepared.branch).toBe("secure-it/2026-10-07-floor-removal-2");
    expect(h.github.prs.get(pr.number)?.headSha).toBe(PUSHED_SHA);
  });
  it("uses the agent only for the selected Gradle declarations and never publishes a failed verification", async () => {
    const f = removalFixture("Maven");
    const h = harness({ fixes: [], files: f.base });
    expect(await secureIt({ ...h.deps, floorProbe: f.probe }).run(h.context)).toMatchObject({ outcome: "published" });
    expect(h.agentCalls).toMatchObject([{ input: { moves: [], floorRemovals: [{ package: "g:lib", version: "1.0", declaredIn: "build.gradle.kts", locations: [":runtimeClasspath"] }], toolWritten: [FLOORS_PATH] } }]);
    const failed = harness({ fixes: [], files: f.base, problems: ["floor declaration remains"] });
    expect(await secureIt({ ...failed.deps, floorProbe: f.probe }).run(failed.context)).toMatchObject({ outcome: "verification-failed", problems: ["floor declaration remains"] });
    expect(failed.workspace.publications).toEqual([]);
    expect(failed.agentCalls).toHaveLength(1);
  });
  it("reports unavailable proofs instead of publishing or losing an existing PR during review", async () => {
    const f = removalFixture();
    const blocked = async () => { throw new Error("unlocked resolution unavailable"); };
    const h = harness({ fixes: [], files: f.base });
    expect(await secureIt({ ...h.deps, floorProbe: blocked }).run(h.context)).toMatchObject({ outcome: "nothing-to-remove", notes: [expect.stringContaining("unlocked resolution unavailable")] });
    const pr = await removalPr(f);
    const moved = harness({ fixes: [], files: f.base, prs: [pr], baseSha: "f".repeat(40) });
    expect(await secureIt({ ...moved.deps, floorProbe: blocked }).review(moved.context)).toMatchObject({ reviewed: [{ outcome: "error", detail: expect.stringContaining("keeping the PR") }] });
    expect(moved.github.prs.get(pr.number)?.state).toBe("open");
    expect(moved.workspace.publications).toEqual([]);
  });
  it("recomputes jointly and republishes on a new base; retires only when the floors already disappeared", async () => {
    const f = removalFixture();
    const pr = await removalPr(f);
    const h = harness({ fixes: [], files: f.base, prs: [pr], baseSha: "f".repeat(40) });
    expect(await secureIt({ ...h.deps, floorProbe: f.probe }).review(h.context)).toMatchObject({ reviewed: [{ outcome: "rebased" }] });
    expect(h.reverted).toEqual(["f".repeat(40)]);
    expect(h.agentCalls).toEqual([]);
    const retired = harness({ fixes: [], prs: [pr], files: { ...f.base, [FLOORS_PATH]: '{"floors":[]}' }, baseSha: "f".repeat(40) });
    expect(await secureIt({ ...retired.deps, floorProbe: f.probe }).review(retired.context)).toMatchObject({ reviewed: [{ outcome: "retired" }] });
  });
  it("does not let failed CI adapt the proof or invoke an agent", async () => {
    const f = removalFixture();
    const h = harness({ fixes: [], files: f.base, prs: [await removalPr(f)] });
    h.github.checks = RED;
    expect(await secureIt({ ...h.deps, floorProbe: f.probe }).review(h.context)).toMatchObject({ reviewed: [{ outcome: "adaptation-unchanged" }] });
    expect(h.agentCalls).toEqual([]);
    expect(h.workspace.publications).toEqual([]);
  });
});

describe("the cooldown hold", () => {
  const YOUNG_VITE = () => vite({ to: { version: "8.3.3", line: "8", aged: false, major: false, blockers: [] } });
  const HELD = {
    ecosystem: "npm" as const, name: "vite", version: "8.3.3", replaced: ["8.3.1"],
    published: "2026-10-06T00:00:00.000Z", eligibleAt: "2026-10-13T00:00:00.000Z", justification: "security-fix" as const,
  };
  /** The comparison holds `vite` in the plan that moves it, nothing elsewhere. */
  const holdingVerify = async (inputs: VerifyInputs) => {
    inputs.cooldown?.({ evaluated: true, releaseAgeDays: 7, held: inputs.plan.packages.includes("npm|vite") ? [HELD] : [] });
    return [];
  };

  it("keeps a held PR's cooldown warning and hold when rewriting its notes", async () => {
    const plan = await planFor([vite()], { named: undefined, lockfiles: new Map([["package-lock.json", JSON.parse(LOCK)]]), gradle: undefined, tagCommit: async () => undefined });
    const held = { ...plan, notes: ["an outdated reason"], cooldown: [{ ...HELD, signals: [] }] };
    const h = harness({ prs: [ownPr({ headRef: `secure-it/2026-10-05-${plan.topic}`, body: withMarker(RULES, withPlanSection("Fixes vite.", held), { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }) })] });
    expect(await secureIt(h.deps).run(h.context)).toMatchObject({ outcome: "already-open" });
    const body = h.github.prs.get(7)!.body;
    expect(body).not.toContain("an outdated reason");
    expect(body).toContain("Release-age cooldown bypassed.");
    expect(planOf(body)?.cooldown).toEqual(held.cooldown);
  });

  it("opens young fixes in a held PR of their own, warned, while the aged ones go out as usual", async () => {
    const h = harness({ fixes: [YOUNG_VITE(), leftPad()] });
    const result = await secureIt({ ...h.deps, verify: holdingVerify }).run(h.context);
    expect(result).toMatchObject({ outcome: "completed", units: [{ topic: "security", outcome: "published" }, { topic: "security-cooldown-vite", outcome: "published" }] });
    expect(h.agentCalls.map((call) => (call.input["moves"] as Array<{ name: string }>).map((move) => move.name))).toEqual([["left-pad"], ["vite"]]);
    const [aged, held] = [...h.github.prs.values()];
    expect(aged!.body).not.toContain("[!WARNING]");
    expect(planOf(aged!.body)?.cooldown).toBeUndefined();
    expect(held!.body.startsWith("<!-- secure-it cooldown warning -->\n> [!WARNING]\n> **Release-age cooldown bypassed.**")).toBe(true);
    expect(held!.body).toContain("> | npm `vite` | 8.3.1 → 8.3.3 | 2026-10-06 00:00 | 2026-10-13 00:00 | the security fix the version rule picks | registry metadata unreadable |");
    expect(held!.isDraft).toBe(true);
    expect(planOf(held!.body)?.cooldown).toEqual([{ ...HELD, signals: ["registry metadata unreadable"] }]);
  });

  it("records where the advisories behind a held fix appear, and opens the warning with it", async () => {
    const h = harness({ fixes: [vite()] });
    const targeted = { ...HELD, targets: [{ name: "vite", bundled: false, replaced: ["8.3.1"], proposed: ["8.3.3"], groups: [{ ids: ["GHSA-vite-0001"], replaced: ["8.3.1"] }] }] };
    const verify = async (inputs: VerifyInputs) => {
      inputs.cooldown?.({ evaluated: true, releaseAgeDays: 7, held: [targeted] });
      return [];
    };
    expect(await secureIt({ ...h.deps, verify }).run(h.context)).toMatchObject({ outcome: "published" });
    const body = h.github.prs.get(42)!.body;
    const [hold] = planOf(body)!.cooldown!;
    // The harness answers every lookup with a 404: checked and not found, never failed.
    expect(hold!.evidence).toMatchObject({ collectedAt: NOW.toISOString(), targets: [{ name: "vite", groups: [{ ids: ["GHSA-vite-0001"], sources: [
      { source: "repository", lookup: "incomplete" }, { source: "github", lookup: "checked", records: [] }, { source: "osv", lookup: "checked", records: [] },
    ] }] }] });
    expect(body).toContain("> **The reviewed advisories read after the comparison don't back this fix as the comparison did.**");
    expect(body).toContain("> | ⚠ GHSA-vite-0001 | `vite` 8.3.1 → 8.3.3 | couldn't be fully checked: its source repository can't be found: registry lookup of vite@8.3.1 failed with HTTP 404 | not found | not found |");
  });

  it("holds whatever the comparison holds, even in a PR planned as aged", async () => {
    const h = harness({ fixes: [vite()] });
    expect(await secureIt({ ...h.deps, verify: holdingVerify }).run(h.context)).toMatchObject({ topic: "security", outcome: "published" });
    expect(planOf(h.github.prs.get(42)!.body)?.cooldown).toHaveLength(1);
  });

  it("doesn't publish when the comparison couldn't evaluate the cooldown", async () => {
    const h = harness();
    const verify = async (inputs: VerifyInputs) => {
      inputs.cooldown?.({ evaluated: false, reason: "base's settings don't parse" });
      return [];
    };
    expect(await secureIt({ ...h.deps, verify }).run(h.context)).toMatchObject({ outcome: "verification-failed", problems: ["the cooldown can't be evaluated: base's settings don't parse"] });
    expect(h.github.prs.size).toBe(0);
  });

  it("moves a fix whose required dependency is young into the held PR, with its coupled packages", async () => {
    const h = harness({ fixes: [vite(), leftPad()] });
    const requiredNpm: SecureItDeps["requiredNpm"] = async (_base, plan) => plan.packages.includes("npm|vite")
      ? { ...plan, requiredNpm: [{ exempt: true, name: "postcss", version: "8.5.29", root: { name: "vite", version: "8.3.3", path: "node_modules/vite" } }] as never }
      : plan;
    const result = await secureIt({ ...h.deps, requiredNpm, verify: holdingVerify }).run(h.context);
    expect(result).toMatchObject({ units: [{ topic: "security", packages: ["npm|left-pad"] }, { topic: "security-cooldown-vite", packages: ["npm|vite"] }] });
  });

  it("holds an aged fix with the aged fix it requires when that one requires a young dependency", async () => {
    // As requiredNpmPlan proves it (npm-required-plan.test.ts, chainBatch): vite requires left-pad's fix, which requires young c,
    // so both roots carry an exempt target for c.
    const h = harness({ fixes: [vite(), leftPad()] });
    const target = (root: string, version: string, path: string) => ({ exempt: true, name: "c", version: "1.0.1", root: { name: root, version, path } });
    const requiredNpm: SecureItDeps["requiredNpm"] = async (_base, plan) => ({ ...plan, requiredNpm: [
      ...plan.packages.includes("npm|vite") ? [target("vite", "8.3.3", "node_modules/vite")] : [],
      ...plan.packages.includes("npm|left-pad") ? [target("left-pad", "1.0.1", "node_modules/left-pad")] : [],
    ] as never });
    const result = await secureIt({ ...h.deps, requiredNpm, verify: holdingVerify }).run(h.context);
    expect(result).toMatchObject({ units: [{ topic: "security-cooldown-left-pad", packages: ["npm|left-pad", "npm|vite"] }] });
  });

  it("keeps a coupling planning discovers in the held unit: a root that needs another root's fix", async () => {
    // vite's young requirement moves it to a held unit; planning found it needs left-pad's fix too.
    const h = harness({ fixes: [vite(), leftPad()] });
    const requiredNpm: SecureItDeps["requiredNpm"] = async (_base, plan) => plan.packages.includes("npm|vite") && plan.packages.includes("npm|left-pad")
      ? { ...plan, coupled: [["npm|vite", "npm|left-pad"]], requiredNpm: [{ exempt: true, name: "postcss", version: "8.5.29", root: { name: "vite", version: "8.3.3", path: "node_modules/vite" } }] as never }
      : plan;
    const result = await secureIt({ ...h.deps, requiredNpm, verify: holdingVerify }).run(h.context);
    expect(result).toMatchObject({ units: [{ topic: "security-cooldown-left-pad", packages: ["npm|left-pad", "npm|vite"] }] });
  });

  it("doesn't hold an aged fix because it shares an aged companion with a held one", async () => {
    // Only vite's requirement of c is young; left-pad's is aged, so left-pad goes out with the aged batch.
    const h = harness({ fixes: [vite(), leftPad()] });
    const target = (root: string, version: string, exempt: boolean) => ({ exempt, name: "c", version: "1.0.1", root: { name: root, version, path: `node_modules/${root}` } });
    const requiredNpm: SecureItDeps["requiredNpm"] = async (_base, plan) => ({ ...plan, requiredNpm: [
      ...plan.packages.includes("npm|vite") ? [target("vite", "8.3.3", true)] : [],
      ...plan.packages.includes("npm|left-pad") ? [target("left-pad", "1.0.1", false)] : [],
    ] as never });
    const result = await secureIt({ ...h.deps, requiredNpm, verify: holdingVerify }).run(h.context);
    expect(result).toMatchObject({ units: [{ topic: "security", packages: ["npm|left-pad"] }, { topic: "security-cooldown-vite", packages: ["npm|vite"] }] });
  });

  const YOUNG_PAD = () => leftPad({ to: { version: "1.0.1", line: "1", aged: false, major: false, blockers: [] } });

  it("opens one held PR per young fix that can be separated, so none waits for another", async () => {
    const h = harness({ fixes: [YOUNG_VITE(), YOUNG_PAD()] });
    const result = await secureIt({ ...h.deps, verify: holdingVerify }).run(h.context);
    expect(result).toMatchObject({ outcome: "completed", units: [
      { topic: "security-cooldown-left-pad", packages: ["npm|left-pad"], outcome: "published" },
      { topic: "security-cooldown-vite", packages: ["npm|vite"], outcome: "published" },
    ] });
    const prs = [...h.github.prs.values()];
    expect(prs.map((pr) => [pr.headRef, planOf(pr.body)?.members])).toEqual([
      ["secure-it/2026-10-07-security-cooldown-left-pad", ["npm|left-pad"]],
      ["secure-it/2026-10-07-security-cooldown-vite", ["npm|vite"]],
    ]);
  });

  it("reuses v0.7's single held PR for the unit holding its lowest package, and opens the other", async () => {
    const legacy = await planFor([YOUNG_PAD(), YOUNG_VITE()], { named: undefined, lockfiles: new Map([["package-lock.json", JSON.parse(LOCK)]]), gradle: undefined, tagCommit: async () => undefined },
      { kind: "routine", topic: "security-cooldown" });
    const { members: _members, ...recorded } = legacy;
    const pr = ownPr({ headRef: "secure-it/2026-10-05-security-cooldown", body: withMarker(RULES, withPlanSection("Fixes both.", recorded), { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }) });
    const h = harness({ prs: [pr], fixes: [YOUNG_VITE(), YOUNG_PAD()] });
    h.workspace.setRemoteHead(pr.headRef, HEAD_SHA);
    expect(await secureIt({ ...h.deps, verify: holdingVerify }).run(h.context)).toMatchObject({ units: [
      { topic: "security-cooldown-left-pad", outcome: "updated", pullRequest: "https://github.com/leanish/widget/pull/7" },
      { topic: "security-cooldown-vite", outcome: "published" },
    ] });
    expect(planOf(h.github.prs.get(7)!.body)).toMatchObject({ topic: "security-cooldown-left-pad", members: ["npm|left-pad"] });
  });

  it("doesn't claim a held PR someone pushed to, so the PR it opens instead is reused on the next run", async () => {
    const plan = await planFor([YOUNG_VITE()], { named: undefined, lockfiles: new Map([["package-lock.json", JSON.parse(LOCK)]]), gradle: undefined, tagCommit: async () => undefined },
      { kind: "routine", topic: "security-cooldown-vite" });
    const pushed = ownPr({ headRef: "secure-it/2026-10-05-security-cooldown-vite", headSha: "9".repeat(40), body: withMarker(RULES, withPlanSection("Fixes vite.", plan), { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }) });
    const h = harness({ prs: [pushed], fixes: [YOUNG_VITE()] });
    expect(await secureIt({ ...h.deps, verify: holdingVerify }).run(h.context)).toMatchObject({ topic: "security-cooldown-vite", outcome: "published" });
    expect(h.github.prs.size).toBe(2);
    expect(await secureIt({ ...h.deps, verify: holdingVerify }).run(h.context)).toMatchObject({ topic: "security-cooldown-vite", outcome: "already-open" });
    expect(h.github.prs.size).toBe(2);
  });

  const heldPlan = (fix: SecurityFix) => planFor([fix], { named: undefined, lockfiles: new Map([["package-lock.json", JSON.parse(LOCK)]]), gradle: undefined, tagCommit: async () => undefined },
    { kind: "routine", topic: `security-cooldown-${fix.name}` });

  it("doesn't claim a held PR a person marked ready: the unit keeps a PR of its own", async () => {
    const plan = await heldPlan(YOUNG_VITE());
    const taken = ownPr({ headRef: "secure-it/2026-10-05-security-cooldown-vite", isDraft: false,
      body: withMarker(RULES, withPlanSection("Fixes vite.", { ...plan, cooldown: [{ ...HELD, signals: [] }] }), { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }) });
    const h = harness({ prs: [taken], fixes: [YOUNG_VITE()] });
    expect(await secureIt({ ...h.deps, verify: holdingVerify }).run(h.context)).toMatchObject({ topic: "security-cooldown-vite", outcome: "published" });
    expect(h.github.prs.get(7)!.body).toBe(taken.body);
  });

  it("claims by the plan the journal published when the body lags behind the head", async () => {
    // #7's body still records left-pad's plan at an older head; the journal holds vite's plan at its current head.
    const stale = await heldPlan(YOUNG_PAD());
    const current = withMarker(RULES, withPlanSection("Fixes vite.", await heldPlan(YOUNG_VITE())), { head: PUSHED_SHA, base: BASE_SHA, adaptations: 0 });
    const pr = ownPr({ headRef: "secure-it/2026-10-05-security-cooldown-vite", headSha: PUSHED_SHA, body: withMarker(RULES, withPlanSection("Fixes left-pad.", stale), { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }) });
    const h = harness({ prs: [pr], fixes: [YOUNG_VITE(), YOUNG_PAD()] });
    await h.journal.pushed(REPO, 7, { head: PUSHED_SHA, base: BASE_SHA, publication: { title: "moving vite", body: current, adaptations: 0 } });
    expect(await secureIt({ ...h.deps, verify: holdingVerify }).run(h.context)).toMatchObject({ units: [
      { topic: "security-cooldown-left-pad", outcome: "published" },
      { topic: "security-cooldown-vite", outcome: "already-open", pullRequest: "https://github.com/leanish/widget/pull/7" },
    ] });
  });

  it("gives two held units whose topics cut to one branch name a branch each", async () => {
    const lock = JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "widget" }, "node_modules/a/b": { version: "1.0.0" }, "node_modules/a-b": { version: "1.0.0" } } });
    const young = (name: string) => leftPad({ name, locations: [`node_modules/${name}`], to: { version: "1.0.1", line: "1", aged: false, major: false, blockers: [] } });
    // Synthetic names: `a/b` and `a-b` both cut to the branch topic `security-cooldown-a-b`.
    const h = harness({ fixes: [young("a/b"), young("a-b")], files: { "package-lock.json": lock } });
    expect(await secureIt({ ...h.deps, verify: holdingVerify }).run(h.context)).toMatchObject({ outcome: "completed" });
    expect([...h.github.prs.values()].map((pr) => pr.headRef)).toEqual(["secure-it/2026-10-07-security-cooldown-a-b", "secure-it/2026-10-07-security-cooldown-a-b-2"]);
  });

  it("keeps a waiting held PR a draft on green CI, and retires it once everything has aged", async () => {
    const plan = await planFor([YOUNG_VITE()], { named: undefined, lockfiles: new Map([["package-lock.json", JSON.parse(LOCK)]]), gradle: undefined, tagCommit: async () => undefined },
      { kind: "routine", topic: "security-cooldown" });
    const heldPr = (eligibleAt: string) => ownPr({
      headRef: "secure-it/2026-10-05-security-cooldown",
      body: withMarker(RULES, withPlanSection("Fixes vite.", { ...plan, cooldown: [{ ...HELD, eligibleAt, signals: [] }] }), { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }),
    });
    const waiting = harness({ prs: [heldPr("2026-10-13T00:00:00.000Z")] });
    waiting.github.checks = GREEN;
    expect(await secureIt(waiting.deps).review(waiting.context)).toMatchObject({ reviewed: [{ number: 7, outcome: "held" }] });
    expect(waiting.github.prs.get(7)?.isDraft).toBe(true);
    const aged = harness({ prs: [heldPr("2026-10-07T05:00:00.000Z")] });
    expect(await secureIt(aged.deps).review(aged.context)).toMatchObject({ reviewed: [{ number: 7, outcome: "graduated" }] });
    expect(aged.github.prs.get(7)?.state).toBe("closed");
    expect(aged.agentCalls).toEqual([]);
  });

  it("keeps a held PR on a moved base when its aged fix still requires a young dependency", async () => {
    const plan = await planFor([vite()], { named: undefined, lockfiles: new Map([["package-lock.json", JSON.parse(LOCK)]]), gradle: undefined, tagCommit: async () => undefined },
      { kind: "routine", topic: "security-cooldown" });
    const pr = ownPr({
      headRef: "secure-it/2026-10-05-security-cooldown",
      body: withMarker(RULES, withPlanSection("Fixes vite.", { ...plan, cooldown: [{ ...HELD, signals: [] }] }), { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }),
    });
    const h = harness({ prs: [pr], baseSha: "f".repeat(40), fixes: [vite()] });
    h.workspace.setRemoteHead(pr.headRef, HEAD_SHA);
    let requiredPlanned = 0;
    const requiredNpm: SecureItDeps["requiredNpm"] = async (_base, planned) => {
      requiredPlanned++;
      return planned.packages.includes("npm|vite")
        ? { ...planned, requiredNpm: [{
          exempt: true, name: "postcss", version: "8.5.29", path: "node_modules/postcss", lockfile: "package-lock.json", key: "postcss", range: "^8.5.29",
          reason: "vite@8.3.3 requires postcss ^8.5.29", parent: { name: "vite", version: "8.3.3", path: "node_modules/vite" }, root: { name: "vite", version: "8.3.3", path: "node_modules/vite" },
        }] }
        : planned;
    };
    expect(await secureIt({ ...h.deps, requiredNpm, verify: holdingVerify }).review(h.context)).toMatchObject({ reviewed: [{ number: 7, outcome: "rebased" }] });
    expect(requiredPlanned).toBeGreaterThan(0);
    expect(h.github.prs.get(7)?.state).not.toBe("closed");
    expect(planOf(h.github.prs.get(7)!.body)?.cooldown).toHaveLength(1);
  });

  it("refuses a held PR whose recorded hold doesn't read", async () => {
    const plan = await planFor([YOUNG_VITE()], { named: undefined, lockfiles: new Map([["package-lock.json", JSON.parse(LOCK)]]), gradle: undefined, tagCommit: async () => undefined });
    const body = withMarker(RULES, withPlanSection("Fixes vite.", { ...plan, cooldown: [{ ...HELD, eligibleAt: "soon", signals: [] }] }), { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 });
    const h = harness({ prs: [ownPr({ headRef: "secure-it/2026-10-05-security", body })] });
    h.github.checks = GREEN;
    expect(await secureIt(h.deps).review(h.context)).toMatchObject({ reviewed: [{ number: 7, outcome: "error" }] });
    expect(h.github.prs.get(7)?.isDraft).toBe(true);
  });
});

describe("which open PR a held unit is", () => {
  const unit = (...names: string[]): SecurityUnit => ({ kind: "routine", topic: `security-cooldown-${names[0]}`, held: true, work: names.map((name) => vite({ name })) });
  const recorded = (number: number, packages: string[], members?: string[]): GitHubPullRequest => {
    const plan: ChangePlan = { kind: "routine", topic: "security-cooldown-x", malware: false, packages, ...(members === undefined ? {} : { members }), moves: [], severity: undefined };
    return ownPr({ number, body: withMarker(RULES, withPlanSection("Held.", plan), { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }) });
  };

  it("matches by the unit's own packages, so a companion a plan added doesn't take another unit's PR", () => {
    // PR 7 is a's, with companion c in its packages; b's unit planned c too but holds only b.
    expect(heldClaims([unit("b"), unit("a")], [recorded(7, ["npm|a", "npm|c"], ["npm|a"])])).toEqual(new Map([["security-cooldown-a", 7]]));
  });

  it("gives the strongest overlap first across units, then the lowest shared package, then the lower PR", () => {
    const claims = heldClaims([unit("c"), unit("b", "d")], [recorded(7, ["npm|a", "npm|b", "npm|c"]), recorded(8, ["npm|b", "npm|d"], ["npm|b", "npm|d"])]);
    expect(claims).toEqual(new Map([["security-cooldown-b", 8], ["security-cooldown-c", 7]]));
    expect(heldClaims([unit("c"), unit("b")], [recorded(9, ["npm|a", "npm|b", "npm|c"])])).toEqual(new Map([["security-cooldown-b", 9]]));
  });

  it("reviews a held PR as the unit a run would give it, so two PRs never stand for one unit", () => {
    // #10 shares a and b with the first unit; #11 shares b with it too, but c only with the second.
    const units = [unit("a", "b"), unit("c")];
    const own = [recorded(10, ["npm|a", "npm|b", "npm|c"]), recorded(11, ["npm|b", "npm|c"])];
    const claims = heldClaims(units, own);
    expect(own.map((pr) => unitOf(planOf(pr.body)!, units, claims, pr.number)?.topic)).toEqual(["security-cooldown-a", "security-cooldown-c"]);
    expect(unitOf(planOf(own[1]!.body)!, [unit("d")], heldClaims([unit("d")], own), 11)).toBeUndefined();
  });

  it("says why a held PR is retired: its work went to other PRs, or none of it is held any more", () => {
    const units = [unit("a", "b"), unit("c")];
    const own = [recorded(10, ["npm|a", "npm|b"]), recorded(11, ["npm|c"]), recorded(12, ["npm|a", "npm|c"])];
    const claims = heldClaims(units, own);
    expect(unitOf(planOf(own[2]!.body)!, units, claims, 12)).toBeUndefined();
    expect(retirementOf(planOf(own[2]!.body)!, units, claims, 12)).toBe("The remaining overlapping held work is assigned to #10, #11; this draft is superseded.");
    expect(retirementOf(planOf(own[2]!.body)!, [unit("d")], new Map(), 12)).toBe("None of this draft's fixes is held on the default branch any more; a run plans whatever still needs fixing. Blocked fixes are reported by secure-it.");
    // Held work no open PR claims yet is still held: a run opens a PR for it.
    expect(retirementOf(planOf(own[2]!.body)!, units, new Map([["security-cooldown-a", 10]]), 12)).toBe("The remaining overlapping held work is assigned to #10, and a run opens a PR for the rest; this draft is superseded.");
    expect(retirementOf(planOf(own[2]!.body)!, units, new Map(), 12)).toBe("The overlapping held work isn't assigned to an open PR yet; a run opens one for it, so this draft is superseded.");
    const routine: ChangePlan = { kind: "routine", topic: "security", malware: false, packages: ["npm|a"], moves: [], severity: undefined };
    expect(retirementOf(routine, [], new Map(), 13)).toBe("No actionable fixes remain for this security unit on the default branch. Blocked fixes are reported by secure-it.");
  });

  it("reviews the other kinds by topic, as before", () => {
    const plan: ChangePlan = { kind: "routine", topic: "security", malware: false, packages: ["npm|a"], moves: [], severity: undefined };
    const aged: SecurityUnit = { kind: "routine", topic: "security", work: [vite({ name: "a" })] };
    expect(unitOf(plan, [unit("a"), aged], new Map([["security-cooldown-a", 7]]), 7)).toBe(aged);
  });
});
