import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { GitHubApiError } from "@leanish/agent-runtime/github/github-client";
import { ConsoleLogger } from "@leanish/agent-runtime/logger/console-logger";
import type { GitHubPullRequest } from "@leanish/agent-runtime/types/clients";
import type { WorkingCopy } from "@leanish/agent-runtime/types/working-copy";
import { InMemoryWorkspace } from "@leanish/agent-runtime/working-copy/in-memory-workspace";
import { ActionsGitHub } from "@leanish/gate/actions-github";
import { located, readInventory, sourcesOf } from "@leanish/gate/inventory";
import { versionKey } from "@leanish/gate/package-version";
import { type Advisory, Snapshot } from "@leanish/gate/snapshot";
import { gradleResolutionProblems, type GradleInventory } from "@leanish/gate/gradle";
import type { AdvisoryEvidence } from "@leanish/gate/advisory-evidence";
import { securityCandidates, type SecurityFix } from "@leanish/gate/candidates";
import type { NpmPeerPlanner } from "@leanish/gate/npm-peers";
import { FLOORS_PATH, parseFloors } from "@leanish/gate/floors";
import { selectRemovals, withoutFloorRecords } from "../src/floor-removal.ts";
import type { Tree } from "@leanish/gate/tree";
import { assertAgentWorkspace, type ToolRunContext } from "@leanish/tool-runtime/command";
import { retargetRepository } from "@leanish/tool-runtime/test/retarget-repository";
import { readScanState, readSettings, runCompare, type GateEnvironment } from "@leanish/gate/gate";
import { ISSUE_LABEL, ISSUE_WRITER, recordOf } from "../src/issue-text.ts";
import type { Attempt, IssueRecord, ObservedFinding } from "../src/issue-model.ts";
import { decisionMoves } from "../src/issue-assessment.ts";
import { recoverAttempts } from "../src/issue-attempts.ts";
import { reviewExecution, trackedIssueOf } from "../src/issue-review.ts";
import { fakeFetch } from "@leanish/gate/test/fake-fetch";
import { archive, manifest, serving } from "@leanish/gate/test/tarballs";
import { parseToolConfig } from "@leanish/tool-runtime/config";
import { MemoryJournal } from "@leanish/tool-runtime/test/memory-journal";
import { branchFor, stateOf, withMarker } from "@leanish/tool-runtime/own-pr";
import { BASE_SHA, FakeGitHub, GREEN, HEAD_SHA, ownPr, PUSHED_SHA, RED } from "@leanish/tool-runtime/test/fake-github";
import { FakeIssues } from "@leanish/tool-runtime/test/fake-issues";
import { cooldownWarning, planOf, planSection, withPlanSection } from "../src/plan-block.ts";
import { EVIDENCE_DIFFERS, EVIDENCE_LEFT_OUT } from "../src/advisory-notice.ts";
import { type ChangePlan, planFor } from "../src/plan.ts";
import { referencePlan, verifyPlan, type VerifyInputs } from "../src/verify.ts";
import { referenceProblems } from "@leanish/tool-runtime/gradle-reference";
import { computedNpmProblems } from "@leanish/tool-runtime/npm-file-checks";
import { materializeInCopy } from "../src/npm-materialize.ts";
import { requiredNpmPlan } from "../src/npm-required-plan.ts";
import { environment, OLD, postcss, securityBatch } from "@leanish/gate/test/required-fixture";
import { preservedFloors } from "../src/floor-checks.ts";
import type { ScanState } from "@leanish/gate/gate";
import { defaultDeps, type ExecutionTarget, RULES, type SecureItDeps, secureIt } from "../src/secure-it.ts";

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

/** Scan observations are independent of the fixes a candidate planner happens to return. */
const VITE_FINDING: ObservedFinding = { ecosystem: "npm", name: "vite", ids: ["GHSA-rq7h-c2jc-7f22"], versions: ["8.3.1"], reviewed: true, malicious: false, severity: "MODERATE" };

async function scanFixture(base: Tree, env: GateEnvironment, gradle: Parameters<SecureItDeps["scan"]>[2], observations: ReadonlyArray<ObservedFinding>): Promise<ScanState> {
  const settings = await readSettings(base);
  const inventory = await readInventory(base, await sourcesOf(base, settings.config), { gradle: gradle.head });
  const packages = located(inventory);
  const advisories = new Map<string, Advisory[]>(packages.map((pkg) => [versionKey(pkg), []]));
  for (const finding of observations) {
    for (const version of finding.versions) {
      const key = versionKey({ ...finding, version });
      advisories.set(key, [...advisories.get(key) ?? [], { id: finding.ids[0]!, ids: finding.ids, source: finding.reviewed ? "osv" : "repository", malicious: finding.malicious, severity: finding.severity, summary: undefined }]);
    }
  }
  return { settings, inventory, packages,
    resolutions: new Map(), github: new ActionsGitHub(env.fetch, env.githubToken), snapshot: new Snapshot(advisories, [], NOW), osvScannerVersion: "2.6.0" };
}

function harness(options: { prs?: GitHubPullRequest[]; fixes?: SecurityFix[]; observations?: ReadonlyArray<ObservedFinding>; candidateNotes?: string[]; answer?: unknown; problems?: string[]; baseSha?: string; files?: Record<string, string>; links?: string[] } = {}): Harness {
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
    issues: new FakeIssues(),
    workspace,
    workingCopy,
    logger: new ConsoleLogger({ minLevel: "error" }),
    now: NOW,
    releaseAgeDays: 7,
    releaseAgeExclude: [],
    readToken: "read-token",
    fetch: globalThis.fetch,
    isolation: { readDenied: [], env: {}, buildCacheRoot: "/tmp/secure-it-cache" },
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
    scan: (base, env, gradle) => scanFixture(base, env, gradle, options.observations ?? [VITE_FINDING]),
    npm: async () => ({ code: 0, stdout: "11.20.0\n", stderr: "" }),
    candidates: async () => ({ fixes: options.fixes ?? [vite()], incomplete: [], gaps: [], notes: options.candidateNotes ?? [], osvScannerVersion: "2.6.0" }),
    verify: async () => options.problems ?? [],
    disposition: async () => ({ kind: "proceed" }),
    clock: () => NOW,
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

/** Publishable young decisions must first be shown by a run and then authorized by the owner. */
async function grantWaiting(tool: ReturnType<typeof secureIt>, h: Harness, names?: ReadonlyArray<string>): Promise<void> {
  await tool.run(h.context);
  const issues = h.context.issues as FakeIssues;
  const waiting = [...issues.issues.values()].filter((issue) => {
    const record = recordOf(issue.body);
    return issue.state === "open" && record?.subject.kind === "decision" && issue.body.includes("**Waiting for the release-age wait.**")
      && (names === undefined || record.subject.moves.some((move) => names.includes(move.name)));
  });
  expect(waiting.length).toBeGreaterThan(0);
  issues.permissions.set("owner", "admin");
  for (const issue of waiting) {
    expect(recordOf(issue.body)!.shown?.young.length).toBeGreaterThan(0);
    issues.comment(issue.number, "owner", "take-early: tested this exact decision");
    issues.label(issue.number, "owner", "take-early");
  }
}

function trackedRecord(h: Harness, number = 42): IssueRecord {
  const pr = h.github.prs.get(number)!;
  const issue = trackedIssueOf(pr.body);
  expect(issue).toBeDefined();
  const record = recordOf((h.context.issues as FakeIssues).issues.get(issue!)!.body)!;
  expect(record.subject.kind).toBe("decision");
  return record;
}

/** A current ordinary PR and the decision issue it tracks. */
async function track(h: Harness): Promise<void> {
  const issues = h.context.issues as FakeIssues;
  for (const pr of h.github.prs.values()) {
    const plan = planOf(pr.body);
    if (plan === undefined || plan.kind === "floor-removal") continue;
    const number = trackedIssueOf(pr.body);
    if (number !== undefined && recordOf(issues.issues.get(number)?.body ?? "") !== undefined) continue;
    const subject = { kind: "decision" as const, moves: decisionMoves(plan) };
    const record: IssueRecord = { version: 1, subject, openedAt: BASE_SHA, findings: [], absences: [], attempts: [] };
    const body = ISSUE_WRITER.render({ subject, findings: [], status: { kind: "eligible", trusted: [] } }, record, BASE_SHA).body;
    if (number !== undefined) {
      issues.issues.set(number, { number, url: `https://github.com/acme/widget/issues/${number}`, title: "secure-it: fix", body, state: "open", stateReason: null, author: "leanish", labels: [ISSUE_LABEL] });
    } else {
      const issue = await issues.createIssue({ repo: REPO, title: "secure-it: fix", body, labels: [ISSUE_LABEL] });
      h.github.prs.set(pr.number, { ...pr, body: `Tracks #${issue.number}.\n\n${pr.body}` });
    }
  }
}

function leftPad(overrides: Partial<SecurityFix> = {}): SecurityFix {
  return vite({ name: "left-pad", from: "1.0.0", locations: ["node_modules/left-pad"], severity: "LOW", to: { version: "1.0.1", line: "1", aged: true, major: false, blockers: [] }, ...overrides });
}

function requirement(name: string, version: string, rootName: string, rootVersion: string, exempt = true) {
  const root = { name: rootName, version: rootVersion, path: `node_modules/${rootName}` };
  return { name, version, exempt, path: `node_modules/${name}`, lockfile: "package-lock.json", key: name, range: version, reason: `required by ${rootName}`, parent: root, root };
}

async function batchPr(fixes: SecurityFix[], overrides: Partial<GitHubPullRequest> = {}): Promise<GitHubPullRequest> {
  const plan = await planFor(fixes, { named: undefined, lockfiles: new Map([["package-lock.json", JSON.parse(LOCK)]]), gradle: undefined, tagCommit: async () => undefined });
  return ownPr({ headRef: branchFor(RULES, new Date("2026-10-05T00:00:00Z"), plan.topic), body: withMarker(RULES, `Fixes security findings.\n\n${planSection(plan)}`, { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }), ...overrides });
}

async function vitePr(overrides: Partial<GitHubPullRequest> = {}, fix = vite()): Promise<GitHubPullRequest> {
  return batchPr([fix], overrides);
}

/** A direct-peer planner that blocks vite's set, as one whose checks failed (`undecided`) or as refused; other moves pass. */
function blockingVite(reason: string, undecided: boolean): NpmPeerPlanner {
  return {
    resolve: async (moves) => {
      const stuck = moves.filter((move) => move.name === "vite");
      return { additions: [], sets: [], blocked: stuck.length === 0 ? [] : [{ moves: stuck, reason, ...(undecided ? { undecided: true as const } : {}) }] };
    },
  };
}

/** A failed direct-peer identity read, as the gate's planner reports the set it blocks. */
const PEER_UNDECIDED = "no safe aged compatible direct-peer set for vite@8.3.3: @vitejs/plugin@2.0.1: attestation lookup failed with HTTP 503; no eligible compatible combination satisfies all peer ranges";

describe("secure-it run", () => {
  it("doesn't publish a young carrier fixing only its own advisories as a bundle fix when a repository-only finding preserves carrier identity", async () => {
    const versions = ["1.0.0", "1.0.1", "1.0.2"];
    const brace = (version: string) => version === "1.0.1" ? "5.0.12" : "5.0.9";
    const tarball = (version: string) => `https://registry.npmjs.org/carrier/-/carrier-${version}.tgz`;
    const archives = Object.fromEntries(versions.map((version) => [version, archive([
      { path: "package/package.json", body: manifest("carrier", version, { bundleDependencies: ["brace"] }) },
      { path: "package/node_modules/brace/package.json", body: manifest("brace", brace(version)) },
    ])]));
    const files = (version: string) => {
      const root = { name: "app", dependencies: { carrier: `^${version}` } };
      return { "package.json": JSON.stringify(root), "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: {
        "": root,
        "node_modules/carrier": { version, resolved: tarball(version), integrity: archives[version]!.integrity, bundleDependencies: ["brace"], dependencies: { brace: brace(version) } },
        "node_modules/carrier/node_modules/brace": { version: brace(version), inBundle: true },
      } }) };
    };
    const base = tree(BASE_SHA, files("1.0.0"));
    const head = tree(SNAPSHOT, files("1.0.2"));
    const env: GateEnvironment = {
      now: () => NOW, osvScanner: "osv-scanner", githubToken: undefined,
      fetchArchive: serving(Object.fromEntries(versions.map((version) => [tarball(version), archives[version]!.bytes]))),
      fetch: fakeFetch({
        ...Object.fromEntries(versions.map((version) => [`https://registry.npmjs.org/carrier/${version}`, { body: {} }])),
        "https://registry.npmjs.org/brace/5.0.12": { body: {} },
        "https://registry.npmjs.org/carrier": { body: {
          time: Object.fromEntries(versions.map((version) => [version, version === "1.0.2" ? "2026-10-06T00:00:00Z" : OLD])),
          versions: Object.fromEntries(versions.map((version) => [version, { _npmUser: { name: "maintainer" }, dependencies: { brace: brace(version) }, dist: { integrity: archives[version]!.integrity, tarball: tarball(version) } }])),
        } },
        "https://registry.npmjs.org/brace/5.0.9": { body: { repository: "github:acme/brace" } },
        "https://api.github.com/repos/acme/brace/security-advisories?state=published&per_page=100": { body: [
          { ghsa_id: "GHSA-brace-repo", state: "published", vulnerabilities: [{ package: { ecosystem: "npm", name: "brace" }, vulnerable_version_range: "= 5.0.9" }] },
        ] },
      }),
      run: async (command, args) => {
        if (command !== "osv-scanner") throw new Error(`unexpected command: ${command}`);
        if (args[0] === "--version") return { code: 0, stdout: "osv-scanner version: 2.6.0\n", stderr: "" };
        const scanned = JSON.parse(await readFile(args[args.indexOf("--lockfile") + 1]!.replace(/^osv-scanner:/, ""), "utf8")) as {
          results: Array<{ packages: Array<{ package: { name: string; version: string } }> }>;
        };
        const affected: Record<string, string[]> = { "carrier@1.0.0": ["GHSA-own"], "brace@5.0.12": ["GHSA-added"] };
        const packages = scanned.results[0]!.packages.map(({ package: pkg }) => ({ package: pkg,
          vulnerabilities: (affected[`${pkg.name}@${pkg.version}`] ?? []).map((id) => ({ id, summary: id })),
        }));
        return { code: 1, stdout: JSON.stringify({ results: [{ packages }] }), stderr: "" };
      },
    };
    const found = await securityCandidates(base, env);
    expect(found.fixes.find((fix) => fix.name === "carrier")).toMatchObject({ targets: ["GHSA-own"], carries: [], to: { version: "1.0.2", aged: false } });
    const h = harness();
    const actual = await vi.importActual<typeof import("@leanish/gate/gate")>("@leanish/gate/gate");
    vi.mocked(runCompare).mockImplementation(actual.runCompare);
    try {
      const tool = secureIt({ ...h.deps, gate: async () => env, scan: readScanState, candidates: async () => found, verify: verifyPlan,
        materializeNpm: async () => new Map(Object.entries(files("1.0.2"))),
        trees: { commit: async (_wc, sha) => sha === BASE_SHA ? base : head, working: () => head },
      });
      await grantWaiting(tool, h);
      const result = await tool.run(h.context);
      expect(result).toMatchObject({ outcome: "verification-failed", problems: [expect.stringContaining("1.0.1 fixes GHSA-own too and is at least 7 days old")] });
      expect(h.github.prs.size).toBe(0);
      expect(h.workspace.pushes).toEqual([]);
    } finally {
      vi.mocked(runCompare).mockReset();
    }
  });

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
      await track(h);
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
  it.each(["run", "review"] as const)("retargets an open major from a clean base in %s, deferring changed review decisions and publishing the verified tree from a run", async (command) => {
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
      if (command === "review") {
        await track(h);
        expect(await secureIt(deps).review({ ...h.context, workingCopy: wc, agent })).toMatchObject({ reviewed: [{ outcome: "deferred" }] });
        expect(h.agentCalls).toEqual([]);
        expect(fixture.publications).toEqual([]);
        expect(h.github.prs.get(7)!.headSha).toBe(oldHead);
      }
      const result = await secureIt(deps).run({ ...h.context, workingCopy: wc, agent });
      expect(result, JSON.stringify(result)).toMatchObject({ units: [{ outcome: "updated" }] });
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
  it("matches a PR by the plan the journal saved for its head, not its stale body, and repairs it as it uses it", async () => {
    const current = await vitePr();
    // #7's body still records a held plan at an older head; the journal saved this unit's plan for its current head.
    const stale = await planFor([leftPad()], { named: undefined, lockfiles: new Map([["package-lock.json", JSON.parse(LOCK)]]), gradle: undefined, tagCommit: async () => undefined },
      { kind: "routine", topic: "security-young-npm|left-pad" });
    const pr = { ...current, headSha: PUSHED_SHA, body: withMarker(RULES, withPlanSection("Fixes left-pad.", stale), { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }) };
    const h = harness({ prs: [pr] });
    const body = withMarker(RULES, current.body, { head: PUSHED_SHA, base: BASE_SHA, adaptations: 0 });
    await h.journal.pushed(REPO, 7, { head: PUSHED_SHA, base: BASE_SHA, publication: { title: "moving vite to 8.3.3", body, adaptations: 0 } });
    expect(await secureIt(h.deps).run(h.context)).toMatchObject({ outcome: "already-open", pullRequest: pr.url });
    expect(h.github.prs.get(7)).toMatchObject({ title: "moving vite to 8.3.3", body });
    expect([h.agentCalls, h.workspace.preparations]).toEqual([[], []]);
  });

  it("repairs only the PR a unit reuses, never another match", async () => {
    const stale = (overrides: Partial<GitHubPullRequest>) => vitePr({ headSha: PUSHED_SHA, ...overrides }, vite({ to: { version: "8.3.2", line: "8", aged: true, major: false, blockers: [] } }));
    const prs = [await stale({}), await stale({ number: 8, nodeId: "PR_node8", url: "u8", headRef: "secure-it/2026-10-05-security-2" })];
    const h = harness({ prs });
    h.workspace.setRemoteHead(prs[0]!.headRef, PUSHED_SHA);
    for (const pr of prs) {
      await h.journal.pushed(REPO, pr.number, { head: PUSHED_SHA, base: BASE_SHA, publication: { title: pr.title, body: withMarker(RULES, pr.body, { head: PUSHED_SHA, base: BASE_SHA, adaptations: 0 }), adaptations: 0 } });
    }
    expect(await secureIt(h.deps).run(h.context)).toMatchObject({ outcome: "updated", pullRequest: prs[0]!.url });
    expect(h.github.calls.filter((call) => call.startsWith("updatePullRequest"))).toEqual(["updatePullRequest 7", "updatePullRequest 7"]);
    expect(h.github.prs.get(8)).toEqual(prs[1]);
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
    const stale = ownPr({ headRef: branchFor(RULES, new Date("2026-10-05T00:00:00Z"), plan.topic), body: withMarker(RULES, `Fixes security findings.\n\n${planSection({ ...plan, notes: ["an outdated reason"] })}`, { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }) });
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

  it("opens a separate PR for a changed plan when someone else pushed to the package's PR", async () => {
    const older = vite({ to: { version: "8.3.2", line: "8", aged: true, major: false, blockers: [] } });
    const h = harness({ prs: [await vitePr({ headSha: "9".repeat(40), headRef: "secure-it/2026-10-07-security" }, older)] });
    expect(await secureIt(h.deps).run(h.context)).toMatchObject({ outcome: "published" });
    expect(h.github.prs.get(42)?.headRef).toBe("secure-it/2026-10-07-security-2");
    expect(h.github.prs.get(7)?.headSha).toBe("9".repeat(40));
  });

  it("reports reconciliation notes when the reviewed ranges leave nothing to fix", async () => {
    const notes = ["GHSA-netty: its reviewed ranges clear this version; the reviewed ranges apply"];
    const h = harness({ fixes: [], observations: [], candidateNotes: notes });
    expect(await secureIt(h.deps).run(h.context)).toMatchObject({ outcome: "nothing-to-fix", notes });
    expect(h.agentCalls).toEqual([]);
  });

  it("reads the tree's scan state once and plans candidates on that same state", async () => {
    const h = harness();
    const state = { marker: "the run's one scan" } as unknown as ScanState;
    const seen: unknown[] = [];
    const scan = vi.fn(async () => state);
    const deps = { ...h.deps, scan, candidates: async (...args: Parameters<SecureItDeps["candidates"]>) => {
      seen.push(args[3]);
      return h.deps.candidates(...args);
    } };
    // That state isn't a real scan, so the issues can't be synced from it: nothing executes, and the run says why.
    expect(await secureIt(deps).run(h.context)).toMatchObject({ outcome: "deferred", reason: expect.stringContaining("the issues couldn't be synced") });
    expect(seen).toEqual([state]);
    expect(scan).toHaveBeenCalledOnce();
    expect(h.agentCalls).toHaveLength(0);
  });

  it("stops a failed scan before candidates, floor proofs or execution", async () => {
    const h = harness({ files: removalFixture().base });
    const scan = vi.fn(async () => { throw new Error("scanner unavailable"); });
    const candidates = vi.fn(h.deps.candidates);
    const floorProbe = vi.fn(h.deps.floorProbe);
    const verify = vi.fn(h.deps.verify);
    await expect(secureIt({ ...h.deps, scan, candidates, floorProbe, verify }).run(h.context)).rejects.toThrow("scanner unavailable");
    expect(scan).toHaveBeenCalledOnce();
    expect(candidates).not.toHaveBeenCalled();
    expect(floorProbe).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect([h.agentCalls, h.written, h.workspace.preparations, h.workspace.publications]).toEqual([[], [], [], []]);
    expect((h.context.issues as FakeIssues).issues.size).toBe(0);
  });

  it("publishes trusted young work as a draft tracking its eligible issue without asking for a grant", async () => {
    const name = "@acme/lib";
    // The gate marks a trusted ordinary target eligible even while its registry date is young.
    const h = harness({ fixes: [vite({ name, locations: [`node_modules/${name}`] })],
      observations: [{ ...VITE_FINDING, name }], files: {
        "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: { [name]: "^8.3.0" } }, [`node_modules/${name}`]: { version: "8.3.1" } } }),
        ".github/supply-chain.json": JSON.stringify({ trustedPackages: { npm: { scopes: ["@acme"] } } }),
      } });
    const env = await h.deps.gate(h.context);
    const gate = async () => ({ ...env, fetch: fakeFetch({ "https://registry.npmjs.org/@acme%2flib": { body: { time: { "8.3.3": "2026-10-06T00:00:00Z" }, versions: { "8.3.3": {} } } } }) });
    const issues = h.context.issues as FakeIssues;
    const permission = vi.spyOn(issues, "permission");
    expect(await secureIt({ ...h.deps, gate }).run(h.context)).toMatchObject({ outcome: "published" });
    const record = trackedRecord(h);
    expect(record.attempts).toEqual([]);
    expect(record.grant).toBeUndefined();
    const issue = issues.issues.get(trackedIssueOf(h.github.prs.get(42)!.body)!)!;
    expect(issue.body).toContain("Trusted-package exception");
    expect(issue.body).not.toContain("**Waiting for the release-age wait.**");
    expect(permission).not.toHaveBeenCalled();
    expect(h.github.prs.get(42)!.isDraft).toBe(true);
    expect(planOf(h.github.prs.get(42)!.body)?.cooldown ?? []).toEqual([]);
  });

  describe("issue flow", () => {
    const GHSA = "GHSA-rq7h-c2jc-7f22";
    /** A real scan of the harness lockfile: osv-scanner reports vite@8.3.1, and the registry dates vite 8.3.3. */
    const scanned = (published: string): GateEnvironment => ({
      now: () => NOW, osvScanner: "osv-scanner", githubToken: undefined,
      fetch: fakeFetch({
        "https://registry.npmjs.org/vite": { body: { time: { "8.3.1": OLD, "8.3.3": published }, versions: { "8.3.1": {}, "8.3.3": {} } } },
        // No source repository: no repository advisories to read.
        "https://registry.npmjs.org/vite/8.3.1": { body: {} },
        "https://registry.npmjs.org/left-pad/1.0.0": { body: {} },
      }),
      run: async (command, args) => {
        if (command !== "osv-scanner") throw new Error(`unexpected command: ${command}`);
        if (args[0] === "--version") return { code: 0, stdout: "osv-scanner version: 2.6.0\n", stderr: "" };
        const input = JSON.parse(await readFile(args[args.indexOf("--lockfile") + 1]!.replace(/^osv-scanner:/, ""), "utf8")) as {
          results: Array<{ packages: Array<{ package: { name: string; version: string } }> }>;
        };
        const packages = input.results[0]!.packages.map(({ package: pkg }) => ({ package: pkg,
          vulnerabilities: pkg.name === "vite" && pkg.version === "8.3.1" ? [{ id: GHSA, summary: "dev server reads files", affected: [{ package: { ecosystem: "npm", name: "vite" }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "8.3.3" }] }] }] }] : [],
        }));
        return { code: 1, stdout: JSON.stringify({ results: [{ packages }] }), stderr: "" };
      },
    });
    const young = vite({ to: { version: "8.3.3", line: "8", aged: false, major: false, blockers: [] } });
    const flow = (h: Harness, published = "2026-10-05T00:00:00Z") => secureIt({ ...h.deps, gate: async () => scanned(published), scan: readScanState });
    const issuesOf = (h: Harness) => h.context.issues as FakeIssues;

    it("opens an issue for a young fix and runs nothing until the wait ends, then leaves the issue alone", async () => {
      const h = harness({ fixes: [young] });
      const verify = vi.fn(h.deps.verify);
      const tool = secureIt({ ...h.deps, gate: async () => scanned("2026-10-05T00:00:00Z"), scan: readScanState, verify });
      expect(await tool.run(h.context)).toMatchObject({ outcome: "deferred", reason: "waiting for the release-age wait (#1)" });
      const issue = issuesOf(h).issues.get(1)!;
      expect(recordOf(issue.body)).toMatchObject({ subject: { kind: "decision", moves: [{ name: "vite", from: "8.3.1", to: "8.3.3" }] }, attempts: [] });
      expect(issue.body).toContain("2026-10-12");
      expect(h.agentCalls).toEqual([]);
      expect(h.workspace.preparations).toEqual([]);
      expect(h.written).toEqual([]);
      expect(verify).not.toHaveBeenCalled();
      expect(h.github.calls.some((call) => call.startsWith("createPullRequest"))).toBe(false);
      issuesOf(h).calls.length = 0;
      expect(await tool.run(h.context)).toMatchObject({ outcome: "deferred" });
      expect(issuesOf(h).calls).toEqual([]);
    });

    it("fixes a decision past the wait right away, tracked by its issue", async () => {
      const h = harness();
      expect(await flow(h, OLD).run(h.context)).toMatchObject({ outcome: "published" });
      expect(recordOf(issuesOf(h).issues.get(1)!.body)).toMatchObject({ subject: { kind: "decision" }, attempts: [] });
      expect(h.agentCalls).toHaveLength(1);
    });

    it("shows a PR carrying part of the decision (a retry reduced it) as that decision's PR, which the run then redoes whole", async () => {
      const h = harness({ prs: [await vitePr()], fixes: [vite(), leftPad()] });
      h.workspace.setRemoteHead("secure-it/2026-10-05-security", HEAD_SHA);
      expect(await flow(h, OLD).run(h.context)).toMatchObject({ outcome: "updated", number: 7 });
      const issue = issuesOf(h).issues.get(1)!;
      expect(recordOf(issue.body)!.subject).toMatchObject({ kind: "decision", moves: [{ name: "vite" }, { name: "left-pad" }] });
      expect(issue.body).toContain("**In progress:** #7.");
      expect(issue.body).not.toContain("**Ready.**");
    });

    it("never names a PR someone else pushed to as the decision's, even one recording exactly its moves", async () => {
      for (const fixes of [[vite()], [vite(), leftPad()]]) {
        const h = harness({ prs: [await vitePr({ headSha: "9".repeat(40) })], fixes });
        expect(await flow(h, OLD).run(h.context)).toMatchObject({ outcome: "published", number: 42 });
        expect(issuesOf(h).issues.get(1)!.body).toContain("**Ready.**");
        expect(h.github.prs.get(7)?.headSha).toBe("9".repeat(40));
        expect(h.github.prs.get(42)?.headRef).toBe("secure-it/2026-10-07-security");
        trackedRecord(h);
      }
    });

    it("defers a floor removal too when the issues didn't settle this run", async () => {
      const f = removalFixture();
      const h = harness({ fixes: [young], files: f.base });
      // Every issue the sync opens is gone when read back, so the rounds run out without settling.
      const issues = issuesOf(h);
      const create = issues.createIssue.bind(issues);
      issues.createIssue = async (args) => {
        const issue = await create(args);
        issues.issues.delete(issue.number);
        return issue;
      };
      let proofs = 0;
      const deps = { ...h.deps, floorProbe: async () => { proofs++; return f.probe(); }, gate: async () => scanned("2026-10-05T00:00:00Z"), scan: readScanState };
      const result = await secureIt(deps).run(h.context);
      expect(result).toMatchObject({ units: expect.arrayContaining([{ topic: "floor-removal", outcome: "deferred", reason: "the issues didn't settle this run" }]) });
      expect(proofs).toBe(0);
      expect(h.workspace.publications).toHaveLength(0);
    });

    it("takes a young decision early on a writer's reason and label, recording one attempt before anything runs", async () => {
      const h = harness({ fixes: [young] });
      await flow(h).run(h.context);
      issuesOf(h).permissions.set("owner", "admin");
      issuesOf(h).comment(1, "owner", "take-early: the dev server is exposed on our staging host");
      issuesOf(h).label(1, "owner", "take-early");
      expect(await flow(h).run(h.context)).toMatchObject({ outcome: "published", number: 42 });
      const labeled = issuesOf(h).events.get(1)!.find((event) => event.event === "labeled")!;
      const branch = `secure-it/2026-10-07-take-early-${labeled.id}`;
      const record = recordOf(issuesOf(h).issues.get(1)!.body)!;
      expect(record).toMatchObject({ grant: { labelEventId: labeled.id, reasonCommentId: expect.any(Number) }, attempts: [{ branch, pr: 42 }] });
      expect(record.attempts[0]!.outcome).toBeUndefined();
      expect(h.github.prs.get(42)).toMatchObject({ headRef: branch, body: expect.stringContaining("Tracks #1, taken early.") });
      expect(h.agentCalls).toHaveLength(1);
    });

    it("keeps an early attempt running on the PR it opened when a later publication step fails", async () => {
      const h = harness({ fixes: [young] });
      await flow(h).run(h.context);
      issuesOf(h).permissions.set("owner", "admin");
      issuesOf(h).comment(1, "owner", "take-early: urgent");
      issuesOf(h).label(1, "owner", "take-early");
      // Not a GitHub API error, so labelling doesn't absorb it: the run fails after the PR exists.
      h.github.fail("addLabels", new Error("socket hang up") as never);
      expect(await flow(h).run(h.context)).toMatchObject({ outcome: "failed", detail: "socket hang up" });
      const record = recordOf(issuesOf(h).issues.get(1)!.body)!;
      expect(record.attempts).toMatchObject([{ pr: 42 }]);
      expect(record.attempts[0]!.outcome).toBeUndefined();
    });

    it("retires a PR taken early once its versions aged before planning that work afresh, so no second PR opens beside it", async () => {
      const h = harness({ fixes: [young] });
      // The comparison holds vite 8.3.3 while it's young, and nothing once it aged.
      const holding = (young: boolean) => async (inputs: VerifyInputs) => {
        inputs.cooldown?.({ evaluated: true, releaseAgeDays: 7, held: young ? [{ ecosystem: "npm", name: "vite", version: "8.3.3", replaced: ["8.3.1"], published: "2026-10-05T00:00:00.000Z", eligibleAt: "2026-10-12T00:00:00.000Z", justification: "security-fix" }] : [] });
        return [];
      };
      const tool = (fixes: SecurityFix[]) => secureIt({ ...h.deps, gate: async () => scanned("2026-10-05T00:00:00Z"), scan: readScanState, verify: holding(fixes.some((fix) => fix.to?.aged === false)),
        candidates: async () => ({ fixes, incomplete: [], gaps: [], notes: [], osvScannerVersion: "2.6.0" }) });
      await tool([young]).run(h.context);
      issuesOf(h).permissions.set("owner", "admin");
      issuesOf(h).comment(1, "owner", "take-early: urgent");
      issuesOf(h).label(1, "owner", "take-early");
      expect(await tool([young]).run(h.context)).toMatchObject({ outcome: "published", number: 42 });
      // A week later vite 8.3.3 is past the wait: the run comes before any review.
      const later = { ...h.context, now: new Date("2026-10-14T06:00:00Z") };
      expect(await tool([vite()]).run(later)).toMatchObject({ outcome: "published" });
      expect(h.github.prs.get(42)?.state).toBe("closed");
      expect([...h.github.prs.values()].filter((pr) => pr.state === "open")).toHaveLength(1);
      expect(recordOf(issuesOf(h).issues.get(1)!.body)!.attempts).toMatchObject([{ pr: 42, outcome: "pr-closed" }]);
    });

    it("goes on with the run when retiring an aged early PR fails, leaving that PR as it is", async () => {
      const h = harness({ fixes: [young] });
      const holding = (young: boolean) => async (inputs: VerifyInputs) => {
        inputs.cooldown?.({ evaluated: true, releaseAgeDays: 7, held: young ? [{ ecosystem: "npm", name: "vite", version: "8.3.3", replaced: ["8.3.1"], published: "2026-10-05T00:00:00.000Z", eligibleAt: "2026-10-12T00:00:00.000Z", justification: "security-fix" }] : [] });
        return [];
      };
      const tool = (fixes: SecurityFix[]) => secureIt({ ...h.deps, gate: async () => scanned("2026-10-05T00:00:00Z"), scan: readScanState, verify: holding(fixes.some((fix) => fix.to?.aged === false)),
        candidates: async () => ({ fixes, incomplete: [], gaps: [], notes: [], osvScannerVersion: "2.6.0" }) });
      await tool([young]).run(h.context);
      issuesOf(h).permissions.set("owner", "admin");
      issuesOf(h).comment(1, "owner", "take-early: urgent");
      issuesOf(h).label(1, "owner", "take-early");
      expect(await tool([young]).run(h.context)).toMatchObject({ outcome: "published", number: 42 });
      const later = { ...h.context, now: new Date("2026-10-14T06:00:00Z") };
      // A week later, a rate limit while closing the aged draft still stops the run.
      h.github.fail("closePullRequest", new GitHubApiError("closePullRequest", "rate limited", 403) as never);
      await expect(tool([vite()]).run(later)).rejects.toThrow("rate limited");
      expect(h.github.prs.get(42)?.state).toBe("open");
      // Closing it fails another way (someone pushed to it meanwhile, say): the run goes on, the PR as it is, and vite's
      // unit waits rather than open a second PR beside it.
      h.github.fail("closePullRequest", new Error("the PR's head moved") as never);
      expect(await tool([vite()]).run(later)).toMatchObject({ outcome: "deferred", reason: "a PR taken early for its packages couldn't be retired this run" });
      expect(h.github.prs.get(42)?.state).toBe("open");
      expect([...h.github.prs.values()].filter((pr) => pr.state === "open")).toHaveLength(1);
      expect(recordOf(issuesOf(h).issues.get(1)!.body)!.attempts[0]!.outcome).toBeUndefined();
      // The next run, the close goes through but its comment fails: the PR is closed all the same, and its attempt ends.
      h.github.fail("createComment", new Error("socket hang up") as never);
      await expect(tool([vite()]).run(later)).resolves.toBeDefined();
      expect(h.github.prs.get(42)?.state).toBe("closed");
      expect(recordOf(issuesOf(h).issues.get(1)!.body)!.attempts).toMatchObject([{ pr: 42, outcome: "pr-closed" }]);
    });

    it("keeps an early attempt running on its published PR when recording that PR fails once", async () => {
      const h = harness({ fixes: [young] });
      await flow(h).run(h.context);
      issuesOf(h).permissions.set("owner", "admin");
      issuesOf(h).comment(1, "owner", "take-early: urgent");
      issuesOf(h).label(1, "owner", "take-early");
      // The attempt is recorded, the PR published, then the write attaching it fails once.
      const update = issuesOf(h).updateIssue.bind(issuesOf(h));
      let writes = 0;
      issuesOf(h).updateIssue = async (args) => {
        if (args.state === undefined && ++writes === 2) throw new Error("issue write timed out");
        return update(args);
      };
      expect(await flow(h).run(h.context)).toMatchObject({ outcome: "failed", detail: "issue write timed out" });
      const record = recordOf(issuesOf(h).issues.get(1)!.body)!;
      expect(record.attempts).toMatchObject([{ pr: 42 }]);
      expect(record.attempts[0]!.outcome).toBeUndefined();
    });

    it("settles an attempt and returns its label even when this run's sync superseded its issue", async () => {
      const h = harness({ fixes: [young] });
      const holding = (held: boolean) => async (inputs: VerifyInputs) => {
        inputs.cooldown?.({ evaluated: true, releaseAgeDays: 7, held: held ? [{ ecosystem: "npm", name: "vite", version: "8.3.3", replaced: ["8.3.1"], published: "2026-10-05T00:00:00.000Z", eligibleAt: "2026-10-12T00:00:00.000Z", justification: "security-fix" }] : [] });
        return [];
      };
      const tool = (fixes: SecurityFix[]) => secureIt({ ...h.deps, gate: async () => scanned("2026-10-05T00:00:00Z"), scan: readScanState, verify: holding(fixes.some((fix) => fix.to?.aged === false)),
        candidates: async () => ({ fixes, incomplete: [], gaps: [], notes: [], osvScannerVersion: "2.6.0" }) });
      await tool([young]).run(h.context);
      issuesOf(h).permissions.set("owner", "admin");
      issuesOf(h).comment(1, "owner", "take-early: urgent");
      issuesOf(h).label(1, "owner", "take-early");
      await tool([young]).run(h.context);
      // Aged, vite joins left-pad's routine fix: another decision, so issue #1 is superseded in the same run.
      await tool([vite(), leftPad()]).run({ ...h.context, now: new Date("2026-10-14T06:00:00Z") });
      expect(issuesOf(h).issues.get(1)).toMatchObject({ state: "closed", labels: [ISSUE_LABEL] });
      expect(recordOf(issuesOf(h).issues.get(1)!.body)!.attempts).toMatchObject([{ pr: 42, outcome: "pr-closed" }]);
    });

    it("says once that a label on a superseded issue authorizes nothing, and runs nothing for it", async () => {
      const h = harness({ fixes: [young] });
      const tool = (fixes: SecurityFix[]) => secureIt({ ...h.deps, gate: async () => scanned("2026-10-05T00:00:00Z"), scan: readScanState,
        candidates: async () => ({ fixes, incomplete: [], gaps: [], notes: [], osvScannerVersion: "2.6.0" }) });
      await tool([young]).run(h.context);
      // A newer young version: another decision, so #1 is superseded by #2.
      await tool([vite({ to: { version: "8.3.4", line: "8", aged: false, major: false, blockers: [] } })]).run(h.context);
      expect(issuesOf(h).issues.get(1)?.state).toBe("closed");
      issuesOf(h).permissions.set("owner", "admin");
      issuesOf(h).comment(1, "owner", "take-early: urgent");
      issuesOf(h).label(1, "owner", "take-early");
      const later = vite({ to: { version: "8.3.4", line: "8", aged: false, major: false, blockers: [] } });
      await tool([later]).run(h.context);
      await tool([later]).run(h.context);
      const notices = issuesOf(h).comments.get(1)!.filter((comment) => comment.body.startsWith("secure-it won't take this early"));
      expect(notices.map((comment) => comment.body)).toEqual([expect.stringContaining("secure-it won't take this early: the issue is closed.")]);
      expect(h.agentCalls).toEqual([]);
    });

    /** Issue #1 as a take-early grant left it, with `attempt` recorded (a run that crashed before settling it). */
    const granted = async (h: Harness, attempt: (labelEventId: number) => Attempt) => {
      await flow(h).run(h.context);
      issuesOf(h).permissions.set("owner", "admin");
      const reason = issuesOf(h).comment(1, "owner", "take-early: the dev server is exposed on our staging host");
      issuesOf(h).label(1, "owner", "take-early");
      const labeled = issuesOf(h).events.get(1)!.find((event) => event.event === "labeled")!;
      const issue = issuesOf(h).issues.get(1)!;
      const grant = { labelEventId: labeled.id, reasonCommentId: reason.id, actor: "owner", at: labeled.createdAt, young: [{ ecosystem: "npm" as const, name: "vite", version: "8.3.3" }] };
      issuesOf(h).issues.set(1, { ...issue, body: ISSUE_WRITER.withRecord(issue.body, { ...recordOf(issue.body)!, grant, attempts: [attempt(labeled.id)] }) });
      return `secure-it/2026-10-07-take-early-${labeled.id}`;
    };
    const started = (branch: (id: number) => string) => (id: number): Attempt => ({ id: `${id}-1`, grantEventId: id, branch: branch(id), startedAt: NOW.toISOString() });

    it("ends an attempt a crash left without a PR as interrupted, and doesn't run it again on the same label", async () => {
      const h = harness({ fixes: [young] });
      await granted(h, started((id) => `secure-it/2026-10-07-take-early-${id}`));
      expect(await flow(h).run(h.context)).toMatchObject({ outcome: "deferred", reason: "take-early refused on #1: this label's attempt has ended; a new reason and label authorize another" });
      expect(recordOf(issuesOf(h).issues.get(1)!.body)!.attempts).toMatchObject([{ outcome: "interrupted" }]);
      expect(h.agentCalls).toEqual([]);
    });

    it("reuses an early PR a crash left unattached to its attempt in the same run that recovers it", async () => {
      const h = harness({ fixes: [young] });
      const branch = await granted(h, started((id) => `secure-it/2026-10-07-take-early-${id}`));
      const pr = await batchPr([young], { headRef: branch });
      const tracked = { ...pr, body: `Tracks #1, taken early.\n\n${pr.body}` };
      h.github.prs.set(7, tracked);
      h.workspace.setRemoteHead(branch, HEAD_SHA);
      expect(await flow(h).run(h.context)).toMatchObject({ outcome: "already-open", pullRequest: pr.url });
      expect(recordOf(issuesOf(h).issues.get(1)!.body)!.attempts).toMatchObject([{ pr: 7 }]);
      expect(recordOf(issuesOf(h).issues.get(1)!.body)!.attempts[0]!.outcome).toBeUndefined();
      expect(h.github.prs.get(7)).toEqual(tracked);
      expect(h.workspace.preparations).toEqual([]);
      expect(h.workspace.publications).toEqual([]);
      expect(h.agentCalls).toEqual([]);
    });

    it("recovers a merged PR a crash left unattached, even after its branch was deleted", async () => {
      const h = harness({ fixes: [young] });
      const branch = await granted(h, started((id) => `secure-it/2026-10-07-take-early-${id}`));
      h.github.prs.set(7, ownPr({ number: 7, headRef: branch, state: "closed", merged: true }));
      await flow(h).run(h.context);
      expect(recordOf(issuesOf(h).issues.get(1)!.body)!.attempts).toMatchObject([{ pr: 7, outcome: "pr-merged" }]);
      expect(h.agentCalls).toEqual([]);
    });

    it("ends an attempt whose PR was closed unmerged, and takes the label it consumed off the issue", async () => {
      const h = harness({ fixes: [young] });
      const branch = await granted(h, (id) => ({ ...started(() => "")(id), branch: `secure-it/2026-10-07-take-early-${id}`, pr: 7 }));
      h.github.prs.set(7, ownPr({ number: 7, headRef: branch, state: "closed", merged: false }));
      await flow(h).run(h.context);
      expect(recordOf(issuesOf(h).issues.get(1)!.body)!.attempts).toMatchObject([{ pr: 7, outcome: "pr-closed" }]);
      expect(issuesOf(h).issues.get(1)!.labels).not.toContain("take-early");
      expect(h.agentCalls).toEqual([]);
    });

    it("defers a decision whose verification finds a young version planning didn't choose, without retrying the agent", async () => {
      const h = harness();
      const held = { ecosystem: "Maven" as const, name: "g:transitive", version: "2.0.1", replaced: ["2.0.0"], published: "2026-10-06T00:00:00Z", eligibleAt: "2026-10-13T00:00:00Z", justification: "unjustified" as const };
      const deps = { ...h.deps, gate: async () => scanned(OLD), scan: readScanState, verify: async (inputs: VerifyInputs) => {
        inputs.cooldown?.({ evaluated: true, releaseAgeDays: 7, held: [held] });
        return [];
      } };
      expect(await secureIt(deps).run(h.context)).toMatchObject({ outcome: "deferred", reason: "verification found young versions its issue #1 doesn't allow: g:transitive@2.0.1" });
      await secureIt(deps).run(h.context);
      expect(issuesOf(h).comments.get(1)!.map((comment) => comment.body)).toEqual([expect.stringContaining("young versions it didn't plan: `g:transitive@2.0.1`")]);
      expect(h.agentCalls).toHaveLength(2);
      expect(h.github.calls.some((call) => call.startsWith("createPullRequest"))).toBe(false);
    });

    it("stops at a failed verification that also holds an unplanned young version, without asking the agent again", async () => {
      const h = harness();
      const held = { ecosystem: "Maven" as const, name: "g:transitive", version: "2.0.1", replaced: ["2.0.0"], published: "2026-10-06T00:00:00Z", eligibleAt: "2026-10-13T00:00:00Z", justification: "unjustified" as const };
      const deps = { ...h.deps, gate: async () => scanned(OLD), scan: readScanState, verify: async (inputs: VerifyInputs) => {
        inputs.cooldown?.({ evaluated: true, releaseAgeDays: 7, held: [held] });
        return ["compare: g:transitive@2.0.1 is younger than the wait"];
      } };
      expect(await secureIt(deps).run(h.context)).toMatchObject({ outcome: "deferred", reason: "verification found young versions its issue #1 doesn't allow: g:transitive@2.0.1" });
      expect(h.agentCalls).toHaveLength(1);
    });

    it("keeps a decision's issue open, and the run's issues synced, when that unit can't be planned this run", async () => {
      const h = harness({ fixes: [young] });
      await flow(h).run(h.context);
      const failing = secureIt({ ...h.deps, gate: async () => scanned("2026-10-05T00:00:00Z"), scan: readScanState, requiredNpm: async () => {
        throw new Error("registry 502");
      } });
      expect(await failing.run(h.context)).toMatchObject({ outcome: "failed", detail: "registry 502" });
      expect(issuesOf(h).issues.get(1)?.state).toBe("open");
      expect(h.agentCalls).toEqual([]);
    });

    it("tracks young npm work whose grouping a failed aged plan leaves unknown by package, not as a decision", async () => {
      // The aged plan decides which of its roots join the young work; without it the young decision isn't known yet,
      // so its finding stays tracked unassessed, like any unit that can't be planned.
      const h = harness({ fixes: [young, leftPad()] });
      let agedPlans = 0;
      const failing = secureIt({ ...h.deps, gate: async () => scanned("2026-10-05T00:00:00Z"), scan: readScanState, requiredNpm: async (_base, plan) => {
        if (plan.topic === "security") {
          agedPlans++;
          throw new Error("registry 502");
        }
        return plan;
      } });
      expect(await failing.run(h.context)).toMatchObject({ units: expect.arrayContaining([
        expect.objectContaining({ topic: "security", outcome: "failed", detail: "registry 502" }),
        expect.objectContaining({ topic: "security-young-npm|vite", outcome: "failed", detail: expect.stringContaining("the aged unit's plan, which decides which of its fixes join held work, failed") }),
      ]) });
      const issues = [...issuesOf(h).issues.values()];
      expect(issues.map((issue) => recordOf(issue.body)?.subject)).toEqual([{ kind: "package", ecosystem: "npm", name: "vite" }]);
      expect(issues[0]!.body).toContain("no fix was planned for it this run");
      expect(agedPlans).toBe(1);
      expect(h.agentCalls).toEqual([]);
    });

    it("ends an early attempt the agent couldn't apply, so the same label never runs it twice", async () => {
      const h = harness({ fixes: [young], answer: { outcome: "cannot-apply", summary: "no" } });
      await flow(h).run(h.context);
      issuesOf(h).permissions.set("owner", "admin");
      issuesOf(h).comment(1, "owner", "take-early: urgent");
      issuesOf(h).label(1, "owner", "take-early");
      expect(await flow(h).run(h.context)).toMatchObject({ outcome: "cannot-apply" });
      expect(recordOf(issuesOf(h).issues.get(1)!.body)!.attempts).toMatchObject([{ outcome: "agent-refused" }]);
      expect(await flow(h).run(h.context)).toMatchObject({ outcome: "deferred" });
      expect(h.agentCalls).toHaveLength(1);
    });

    it("refuses a label from someone without write access, saying so on the issue once", async () => {
      const h = harness({ fixes: [young] });
      await flow(h).run(h.context);
      issuesOf(h).permissions.set("visitor", "read");
      issuesOf(h).comment(1, "visitor", "take-early: please");
      issuesOf(h).label(1, "visitor", "take-early");
      expect(await flow(h).run(h.context)).toMatchObject({ outcome: "deferred", reason: "take-early refused on #1: whoever added the label has no write access" });
      await flow(h).run(h.context);
      const notices = issuesOf(h).comments.get(1)!.filter((comment) => comment.author === "leanish");
      expect(notices.map((comment) => comment.body)).toEqual([expect.stringContaining("secure-it won't take this decision early: whoever added the label has no write access.")]);
      expect(h.agentCalls).toEqual([]);
    });

    it("runs nothing when the write PAT can't write issues, and says what to fix", async () => {
      const h = harness();
      issuesOf(h).forbidden.add("createIssue");
      expect(await flow(h, OLD).run(h.context)).toMatchObject({ outcome: "deferred", reason: expect.stringContaining("the write PAT needs Issues: read and write") });
      expect(h.agentCalls).toEqual([]);
    });
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
    const quiet = await secureIt(stuck.deps).run(stuck.context);
    expect(quiet).toMatchObject({ outcome: "nothing-to-fix", waiting: ["vite@8.3.1: no version above 8.3.1 fixes GHSA-x"] });
    // A refusal is no error; an identity check that failed is one, reported while the other fix still goes out.
    expect(quiet).not.toHaveProperty("errors");
    const undecidedProblem = "vite@8.3.1's publisher identity can't be decided: attestation lookup failed with HTTP 503";
    const broken = harness({ fixes: [vite({ to: undefined, problem: undecidedProblem, undecided: true }), leftPad()] });
    expect(await secureIt(broken.deps).run(broken.context)).toMatchObject({
      errors: [undecidedProblem], waiting: [`vite@8.3.1: ${undecidedProblem}`], units: [{ outcome: "published" }],
    });

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

  it("still updates a PR that moves no undecided package while another's publisher identity can't be decided", async () => {
    const problem = "rollup@3.0.0's publisher identity can't be decided: attestation lookup failed with HTTP 503";
    const rollup = vite({ name: "rollup", from: "3.0.0", locations: ["node_modules/rollup"], to: undefined, problem, undecided: true });
    const h = harness({ prs: [await vitePr()], fixes: [vite(), leftPad(), rollup] });
    h.workspace.setRemoteHead("secure-it/2026-10-05-security", HEAD_SHA);
    expect(await secureIt(h.deps).run(h.context)).toMatchObject({ outcome: "updated", errors: [problem] });
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

  it("passes a young target exclusion while preserving trusted scopes and the sandbox's age", async () => {
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

  it("needs no newer npm when targets and base copies are aged and there are no trusted scopes", async () => {
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

  it("keeps a PR that moves a package whose publisher identity can't be decided now, while another unit still publishes", async () => {
    const problem = "left-pad@1.0.0's publisher identity can't be decided: attestation lookup failed with HTTP 503";
    const rollup = vite({ name: "rollup", from: "3.0.0", locations: ["node_modules/rollup"], to: { version: "4.0.1", line: "4", aged: true, major: true, blockers: [] } });
    const pr = await batchPr([vite(), leftPad()]);
    const h = harness({ prs: [pr], fixes: [vite(), leftPad({ to: undefined, problem, undecided: true }), rollup] });
    h.workspace.setRemoteHead(pr.headRef, HEAD_SHA);
    // Without the check, the routine would rewrite #7 to move vite alone, as if left-pad needed no fix any more.
    expect(await secureIt(h.deps).run(h.context)).toMatchObject({
      errors: [problem],
      units: [
        { topic: "security", outcome: "failed", detail: "npm left-pad's publisher identity can't be decided; keeping the PR" },
        { topic: "rollup-major", outcome: "published" },
      ],
    });
    expect(h.github.prs.get(7)).toEqual(pr);
    expect(h.workspace.preparations.map((entry) => entry.args.branch)).toEqual(["secure-it/2026-10-07-rollup-major"]);
    expect(h.workspace.publications.map((entry) => entry.prepared.branch)).toEqual(["secure-it/2026-10-07-rollup-major"]);
    expect(h.workspace.deletions).toEqual([]);
    expect(h.agentCalls.map((call) => (call.input["moves"] as Array<{ name: string }>).map((move) => move.name))).toEqual([["rollup"]]);
  });

  it("keeps a PR that moves a carrier whose reads failed, reporting an error while another unit still publishes", async () => {
    const problem = "left-pad@1.0.0's bundle can't be read: left-pad@1.0.0: GET https://registry.npmjs.org/left-pad/-/left-pad-1.0.0.tgz answered HTTP 503";
    const rollup = vite({ name: "rollup", from: "3.0.0", locations: ["node_modules/rollup"], to: { version: "4.0.1", line: "4", aged: true, major: true, blockers: [] } });
    const pr = await batchPr([vite(), leftPad()]);
    const h = harness({ prs: [pr], fixes: [vite(), leftPad({ to: undefined, problem, undecided: true, carries: [] }), rollup] });
    h.workspace.setRemoteHead(pr.headRef, HEAD_SHA);
    expect(await secureIt(h.deps).run(h.context)).toMatchObject({
      errors: [problem],
      waiting: [`left-pad@1.0.0: ${problem}`],
      units: [
        { topic: "security", outcome: "failed", detail: "npm left-pad's carrier move can't be decided; keeping the PR" },
        { topic: "rollup-major", outcome: "published" },
      ],
    });
    expect(h.github.prs.get(7)).toEqual(pr);
    expect(h.workspace.publications.map((entry) => entry.prepared.branch)).toEqual(["secure-it/2026-10-07-rollup-major"]);
  });

  it("names every cause when a package's publisher identity and its direct-peer set both can't be decided", async () => {
    const problem = "left-pad@1.0.0's publisher identity can't be decided: attestation lookup failed with HTTP 503";
    // other still moves, so the routine runs and meets #7, which records vite and left-pad.
    const fixes = [vite(), leftPad({ to: undefined, problem, undecided: true }), vite({ name: "other", from: "1.0.0", locations: ["node_modules/other"] })];
    const pr = await batchPr([vite(), leftPad()]);
    const h = harness({ prs: [pr], fixes });
    h.workspace.setRemoteHead(pr.headRef, HEAD_SHA);
    // vite's set, which takes left-pad in, can't be decided either.
    const peers: NpmPeerPlanner = { resolve: async (moves) => ({ additions: [], sets: [["vite", "left-pad"]],
      blocked: [{ moves: moves.filter((move) => move.name === "vite"), reason: PEER_UNDECIDED, undecided: true }] }) };
    const deps = { ...h.deps, candidates: async () => ({ fixes, incomplete: [], gaps: [], osvScannerVersion: "2.6.0", npmPeers: peers }) };
    expect(await secureIt(deps).run(h.context)).toMatchObject({
      errors: [problem, PEER_UNDECIDED],
      outcome: "failed", detail: "npm vite's direct-peer set can't be decided; keeping the PR; npm left-pad's publisher identity and direct-peer set can't be decided; keeping the PR",
    });
    expect(h.github.prs.get(7)).toEqual(pr);
  });

  it("keeps a PR that moves a package whose direct-peer set can't be decided, reporting an error while another unit still publishes", async () => {
    const rollup = vite({ name: "rollup", from: "3.0.0", locations: ["node_modules/rollup"], to: { version: "4.0.1", line: "4", aged: true, major: true, blockers: [] } });
    const fixes = [vite(), leftPad(), rollup];
    const pr = await batchPr([vite(), leftPad()]);
    const run = async (undecided: boolean) => {
      const h = harness({ prs: [pr], fixes });
      h.workspace.setRemoteHead(pr.headRef, HEAD_SHA);
      const deps = { ...h.deps, candidates: async () => ({ fixes, incomplete: [], gaps: [], osvScannerVersion: "2.6.0", npmPeers: blockingVite(PEER_UNDECIDED, undecided) }) };
      return { h, result: await secureIt(deps).run(h.context) };
    };
    // Without the check, the routine would rewrite #7 to move left-pad alone, as if vite needed no fix any more.
    const failed = await run(true);
    expect(failed.result).toMatchObject({
      errors: [PEER_UNDECIDED],
      waiting: [PEER_UNDECIDED],
      units: [
        { topic: "security", outcome: "failed", detail: "npm vite's direct-peer set can't be decided; keeping the PR" },
        { topic: "rollup-major", outcome: "published" },
      ],
    });
    expect(failed.h.github.prs.get(7)).toEqual(pr);
    expect(failed.h.workspace.publications.map((entry) => entry.prepared.branch)).toEqual(["secure-it/2026-10-07-rollup-major"]);
    // A set the rules refuse reports as before: waiting, no error, and the routine moves the rest.
    const refused = await run(false);
    expect(refused.result).toMatchObject({ waiting: [PEER_UNDECIDED], units: [{ topic: "security", outcome: "updated" }, { topic: "rollup-major", outcome: "published" }] });
    expect(refused.result).not.toHaveProperty("errors");
  });

  it("continues to a major when the routine fails", async () => {
    const h = harness({ fixes: [vite(), leftPad({ to: { version: "2.0.0", line: "2", aged: true, major: true, blockers: [] } })] });
    const deps = { ...h.deps, verify: async (input: VerifyInputs) => input.plan.kind === "routine" ? ["unattributed policy failure"] : [] };
    expect(await secureIt(deps).run(h.context)).toMatchObject({ units: [{ outcome: "verification-failed" }, { topic: "left-pad-major", outcome: "published" }] });
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
    ["can't evaluate the cooldown", "applied", "unevaluated", "the cooldown can't be evaluated: legacy report"],
  ] as const)("keeps why asking again stopped when the reduced attempt %s", async (_case, reduced, reducedProblems, problem) => {
    const refusal = "compare: new: left-pad@1.0.1: GHSA-new has no exception";
    const h = harness({ fixes: [vite(), leftPad()] });
    const deps = { ...h.deps, verify: async (input: VerifyInputs) => {
      if (input.plan.packages.includes("npm|left-pad")) return [refusal];
      if (reducedProblems !== "unevaluated") return [...reducedProblems];
      input.cooldown?.({ evaluated: false, reason: "legacy report" });
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
    expect(pr.body).toContain("- npm `left-pad` `1.0.0` → `1.0.1`: omitted");
    expect(pr.body).toContain("  - `compare: new: left-pad@1.0.1: GHSA-new has no exception`");
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
    await track(h);
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
    await track(fixedOnBase);
    fixedOnBase.workspace.setRemoteHead("secure-it/2026-10-05-security", HEAD_SHA);
    expect(await secureIt(fixedOnBase.deps).review(fixedOnBase.context)).toMatchObject({ reviewed: [{ number: 7, outcome: "retired" }] });
    expect(fixedOnBase.github.prs.get(7)?.state).toBe("closed");
    expect(fixedOnBase.agentCalls).toEqual([]);

    // Fixes remain on the new base, but the re-applied edit doesn't verify: an error, never a quiet retirement.
    const lost = harness({ prs: [await vitePr()], baseSha: NEW_BASE, problems: ["vite at node_modules/vite is 8.3.1, not 8.3.3"] });
    await track(lost);
    lost.workspace.setRemoteHead("secure-it/2026-10-05-security", HEAD_SHA);
    expect(await secureIt(lost.deps).review(lost.context)).toMatchObject({ reviewed: [{ number: 7, outcome: "error", detail: expect.stringContaining("after merging the default branch") }] });
    expect(lost.github.prs.get(7)?.state).toBe("open");

    const merged = harness({ prs: [await vitePr()], baseSha: NEW_BASE });
    await track(merged);
    merged.workspace.setRemoteHead("secure-it/2026-10-05-security", HEAD_SHA);
    expect(await secureIt(merged.deps).review(merged.context)).toMatchObject({ reviewed: [{ number: 7, outcome: "rebased" }] });
    expect(stateOf(merged.github.prs.get(7)!.body)).toEqual({ head: PUSHED_SHA, base: NEW_BASE, adaptations: 0 });
    expect(merged.agentCalls).toEqual([]);
  });

  it("takes the base's side of a conflicted lockfile and has the agent re-apply, or resolve code conflicts", async () => {
    const h = harness({ prs: [await vitePr()], baseSha: NEW_BASE });
    await track(h);
    h.workspace.setRemoteHead("secure-it/2026-10-05-security", HEAD_SHA);
    h.workspace.setPrepareConflict("secure-it/2026-10-05-security");
    expect(await secureIt(h.deps).review(h.context)).toMatchObject({ reviewed: [{ number: 7, outcome: "rebased" }] });
    expect(h.written).toEqual([`package-lock.json=${LOCK}`]);
    expect(h.agentCalls.map((call) => call.input["mode"])).toEqual(["resolve"]);
    expect(h.agentCalls[0]?.input["npmAgeExclusions"]).toEqual(["left-pad", "vite"]);
  });

  it("reviews only a major's package and retires it when only non-major work remains", async () => {
    const major = vite({ to: { version: "9.0.1", line: "9", aged: true, major: true, blockers: [] } });
    const h = harness({ prs: [await vitePr({}, major)], baseSha: NEW_BASE, fixes: [major, leftPad()] });
    await track(h);
    h.workspace.setRemoteHead("secure-it/2026-10-05-vite-major", HEAD_SHA);
    expect(await secureIt(h.deps).review(h.context)).toMatchObject({ reviewed: [{ outcome: "rebased" }] });
    expect(planOf(h.github.prs.get(7)!.body)?.packages).toEqual(["npm|vite"]);
    const retired = harness({ prs: [await vitePr({}, major)], baseSha: NEW_BASE, fixes: [vite(), leftPad()] });
    await track(retired);
    retired.workspace.setRemoteHead("secure-it/2026-10-05-vite-major", HEAD_SHA);
    expect(await secureIt(retired.deps).review(retired.context)).toMatchObject({ reviewed: [{ outcome: "retired" }] });
    expect(retired.agentCalls).toEqual([]);
  });

  it("doesn't rebase a tracked major whose recomputation now takes a young version, saying so on its issue", async () => {
    const major = vite({ to: { version: "9.0.1", line: "9", aged: true, major: true, blockers: [] } });
    const previous = await vitePr({}, major);
    const pr = { ...previous, body: `Fixes vite.\n\nTracks #1.\n${previous.body}` };
    // The same decision (the move to 9.0.1), whose version now counts as young on the new base.
    const younger = vite({ to: { version: "9.0.1", line: "9", aged: false, major: true, blockers: [] } });
    const h = harness({ prs: [pr], baseSha: NEW_BASE, fixes: [younger] });
    h.workspace.setRemoteHead("secure-it/2026-10-05-vite-major", HEAD_SHA);
    const issues = h.context.issues as FakeIssues;
    issues.issues.set(1, { number: 1, url: "https://github.com/acme/widget/issues/1", title: "secure-it: vite", body: "## secure-it", state: "open", stateReason: null, author: "leanish", labels: [ISSUE_LABEL] });
    await track(h);
    expect(await secureIt(h.deps).review(h.context)).toMatchObject({ reviewed: [{ number: 7, outcome: "deferred" }] });
    expect(h.agentCalls).toEqual([]);
    expect(h.workspace.publications).toEqual([]);
    expect(issues.comments.get(1)!.map((comment) => comment.body)).toEqual([expect.stringContaining("would take young versions no grant covers: `vite@9.0.1`")]);
  });

  it("never rebases a tracked PR into another decision: the next run moves it through that decision's issue", async () => {
    const major = vite({ to: { version: "9.0.1", line: "9", aged: true, major: true, blockers: [] } });
    const previous = await vitePr({}, major);
    const pr = { ...previous, body: `Fixes vite.\n\nTracks #1.\n${previous.body}` };
    const issue = { number: 1, url: "https://github.com/acme/widget/issues/1", title: "secure-it: vite", body: "## secure-it", state: "open" as const, stateReason: null, author: "leanish", labels: [ISSUE_LABEL] };
    const review = async (to: string) => {
      const h = harness({ prs: [pr], baseSha: NEW_BASE, fixes: [vite({ to: { version: to, line: "9", aged: true, major: true, blockers: [] } })] });
      h.workspace.setRemoteHead("secure-it/2026-10-05-vite-major", HEAD_SHA);
      const issues = h.context.issues as FakeIssues;
      issues.issues.set(1, issue);
      await track(h);
      return { h, issues, result: await secureIt(h.deps).review(h.context) };
    };
    // #1 tracks the move to 9.0.1: on the new base the PR would move to 9.0.2, another decision.
    const changed = await review("9.0.2");
    expect(changed.result).toMatchObject({ reviewed: [{ number: 7, outcome: "deferred" }] });
    expect(changed.h.workspace.publications).toEqual([]);
    expect(changed.h.github.prs.get(7)!.body).toBe(pr.body);
    expect(changed.issues.comments.get(1)!.map((comment) => comment.body)).toEqual([expect.stringContaining("a different decision than this issue tracks")]);
    // The same decision on the new base rebases as before, still tracking #1.
    const same = await review("9.0.1");
    expect(same.result).toMatchObject({ reviewed: [{ number: 7, outcome: "rebased" }] });
    expect(same.h.github.prs.get(7)!.body).toContain("Tracks #1.");
    // Routine targets and membership change through a run too, never by rewriting the reviewed decision.
    for (const fixes of [[vite({ to: { version: "8.3.4", line: "8", aged: true, major: false, blockers: [] } })], [leftPad()], [vite(), leftPad()]]) {
      const h = harness({ prs: [await vitePr()], baseSha: NEW_BASE, fixes });
      await track(h);
      const before = h.github.prs.get(7)!;
      h.workspace.setRemoteHead(before.headRef, before.headSha);
      const tool = secureIt(h.deps);
      expect(await tool.review(h.context)).toMatchObject({ reviewed: [{ outcome: "deferred" }] });
      expect(h.github.prs.get(7)).toEqual(before);
      expect(h.agentCalls).toEqual([]);
      expect(h.workspace.publications).toEqual([]);
      expect(await tool.run(h.context)).toMatchObject({ outcome: "updated", number: 7 });
      expect(h.reverted).toEqual([NEW_BASE]);
      expect(trackedRecord(h, 7).subject).toEqual({ kind: "decision", moves: fixes.map((fix) => ({ ecosystem: fix.ecosystem, name: fix.name, from: fix.from, to: fix.to!.version })) });
    }
  });

  it("retries a rebased routine and records omissions in its updated plan", async () => {
    const h = harness({ prs: [await batchPr([vite(), leftPad()])], baseSha: NEW_BASE, fixes: [vite(), leftPad()] });
    await track(h);
    h.workspace.setRemoteHead("secure-it/2026-10-05-security", HEAD_SHA);
    const deps = { ...h.deps, verify: async (input: VerifyInputs) => input.plan.packages.includes("npm|left-pad") ? ["left-pad at node_modules/left-pad is gone, not 1.0.1"] : [] };
    expect(await secureIt(deps).review(h.context)).toMatchObject({ reviewed: [{ outcome: "rebased" }], notes: [{ leftOut: [{ moves: [{ name: "left-pad" }] }] }] });
    expect(h.agentCalls).toHaveLength(1);
    expect(h.reverted).toEqual([NEW_BASE]);
    expect(planOf(h.github.prs.get(7)!.body)?.leftOut?.[0]?.moves[0]?.name).toBe("left-pad");
  });

  it("retires malware when it is gone rather than turning that PR into an ordinary batch", async () => {
    const h = harness({ prs: [await vitePr({}, vite({ malicious: true }))], baseSha: NEW_BASE, fixes: [leftPad()] });
    await track(h);
    h.workspace.setRemoteHead("secure-it/2026-10-05-malware", HEAD_SHA);
    expect(await secureIt(h.deps).review(h.context)).toMatchObject({ reviewed: [{ outcome: "retired" }] });
    expect(h.agentCalls).toEqual([]);
    expect(h.workspace.publications).toEqual([]);
  });

  const undecidedProblem = (name: string, from: string) => `${name}@${from}'s publisher identity can't be decided: attestation lookup failed with HTTP 503`;
  const undecided = (fix: SecurityFix): SecurityFix => ({ ...fix, to: undefined, problem: undecidedProblem(fix.name, fix.from), undecided: true });
  it.each([
    // Without the guard: retired, its fix read as one the base no longer needs.
    { which: "its own", malware: false, fixes: () => [undecided(vite())], detail: undecidedProblem("vite", "8.3.1") },
    // Without the guard: rebased, as if nothing were in doubt.
    { which: "another's", malware: false, fixes: () => [vite(), undecided(leftPad())], detail: undecidedProblem("left-pad", "1.0.0") },
    // Without the guard: the malware PR retired, its malware read as gone.
    { which: "its malware", malware: true, fixes: () => [undecided(vite({ malicious: true })), leftPad()], detail: undecidedProblem("vite", "8.3.1") },
  ])("keeps a PR, untouched, while a fix's publisher identity can't be decided on the new base: $which", async ({ malware, fixes, detail }) => {
    const pr = malware ? await vitePr({ headRef: "secure-it/2026-10-05-malware" }, vite({ malicious: true })) : await vitePr();
    const h = harness({ prs: [pr], baseSha: NEW_BASE, fixes: fixes() });
    await track(h);
    const tracked = h.github.prs.get(7);
    h.workspace.setRemoteHead(pr.headRef, HEAD_SHA);
    h.github.branches.add(pr.headRef);
    expect(await secureIt(h.deps).review(h.context)).toMatchObject({ reviewed: [
      { number: 7, outcome: "error", detail: `a fix can't be decided on the new base; keeping the PR: ${detail}` },
    ] });
    expect(h.github.prs.get(7)).toEqual(tracked);
    expect(h.github.branches.has(pr.headRef)).toBe(true);
    expect(h.github.calls.filter((call) => call.startsWith("closePullRequest") || call.startsWith("updatePullRequest"))).toEqual([]);
    expect([h.workspace.deletions, h.workspace.publications, h.agentCalls, h.reverted]).toEqual([[], [], [], []]);
  });

  it.each([
    // Without the guard: retired, its carrier fix read as one the base no longer needs.
    { which: "a carrier's bundle", fixes: () => [vite({ carries: [], to: undefined, problem: "vite@8.3.1's bundle can't be read: GET answered HTTP 503", undecided: true })], peers: undefined, detail: "a fix can't be decided on the new base; keeping the PR: vite@8.3.1's bundle can't be read: GET answered HTTP 503" },
    // Without the guard: rebased onto left-pad alone, as if vite's move were no longer needed.
    { which: "a direct-peer set", fixes: () => [vite(), leftPad()], peers: blockingVite(PEER_UNDECIDED, true), detail: `a direct-peer set can't be decided on the new base; keeping the PR: ${PEER_UNDECIDED}` },
  ])("keeps a PR, untouched, while $which can't be decided on the new base", async ({ fixes, peers, detail }) => {
    const pr = await batchPr([vite(), leftPad()]);
    const h = harness({ prs: [pr], baseSha: NEW_BASE });
    await track(h);
    const tracked = h.github.prs.get(7);
    h.workspace.setRemoteHead(pr.headRef, HEAD_SHA);
    h.github.branches.add(pr.headRef);
    const deps = { ...h.deps, candidates: async () => ({ fixes: fixes(), incomplete: [], gaps: [], osvScannerVersion: "2.6.0", ...(peers === undefined ? {} : { npmPeers: peers }) }) };
    expect(await secureIt(deps).review(h.context)).toMatchObject({ reviewed: [{ number: 7, outcome: "error", detail }] });
    expect(h.github.prs.get(7)).toEqual(tracked);
    expect(h.github.branches.has(pr.headRef)).toBe(true);
    expect(h.github.calls.filter((call) => call.startsWith("closePullRequest") || call.startsWith("updatePullRequest"))).toEqual([]);
    expect([h.workspace.deletions, h.workspace.publications, h.agentCalls, h.reverted]).toEqual([[], [], [], []]);
  });



  it.each(["plan", "state"] as const)("refuses an agent description carrying a %s marker", async (kind) => {
    const marker = kind === "plan"
      ? `<!-- leanish:plan ${Buffer.from(JSON.stringify({ forged: true })).toString("base64")} -->`
      : `<!-- leanish:state head=${HEAD_SHA} base=${BASE_SHA} adaptations=0 -->`;
    const forged = { outcome: "applied", summary: "moved vite", publication: { ...APPLIED.publication, body: `Moved vite.\n${marker}` } };

    const run = harness({ answer: forged });
    expect(JSON.stringify(await secureIt(run.deps).run(run.context))).toContain(`reserved ${kind} marker`);
    expect(run.github.calls.some((call) => call.startsWith("createPullRequest"))).toBe(false);

    const pr = await vitePr();
    const adapt = harness({ prs: [pr], answer: forged });
    await track(adapt);
    adapt.github.checks = RED;
    expect(JSON.stringify(await secureIt(adapt.deps).review(adapt.context))).toContain(`reserved ${kind} marker`);
    // The attempt is counted before the agent runs; the plan stays the verified one.
    expect(planOf(adapt.github.prs.get(pr.number)!.body)).toEqual(planOf(pr.body));
    expect(adapt.github.prs.get(pr.number)!.body).not.toContain(marker);
    expect(adapt.workspace.publications).toEqual([]);
  });

  it("asks before an adaptation, and a deferred one runs no agent", async () => {
    const pr = await vitePr();
    const h = harness({ prs: [pr] });
    await track(h);
    h.github.checks = RED;
    const deps = { ...h.deps, disposition: async (target: ExecutionTarget) => (target.kind === "review" ? { kind: "defer" as const, reason: "no" } : { kind: "proceed" as const }) };
    expect(await secureIt(deps).review(h.context)).toMatchObject({ reviewed: [{ outcome: "deferred" }] });
    expect(h.agentCalls).toHaveLength(0);
  });

  it("counts an adaptation whose agent ran even when only its reduced retry is deferred", async () => {
    const pr = await batchPr([vite(), leftPad()]);
    const h = harness({ prs: [pr], problems: ["vite at node_modules/vite is 8.3.2, not 8.3.3"] });
    await track(h);
    h.github.checks = RED;
    const deps = { ...h.deps, disposition: async (target: ExecutionTarget) => (target.kind === "retry" ? { kind: "defer" as const, reason: "no" } : { kind: "proceed" as const }) };
    expect(await secureIt(deps).review(h.context)).toMatchObject({ reviewed: [{ outcome: "adaptation-unchanged", detail: "attempt 1 of 2" }] });
    expect(h.agentCalls).toHaveLength(1);
    expect(stateOf(h.github.prs.get(pr.number)!.body)?.adaptations).toBe(1);
  });

  it("publishes the adaptation's new title, verdict and checks with its plan", async () => {
    const previous = await vitePr();
    const pr = { ...previous, body: `No adaptation needed; old checks.\n${previous.body}` };
    const publication = { title: "adapting vite", body: "Adapted src/app.ts; npm test passed.", commitMessage: "adapting vite" };
    const h = harness({ prs: [pr], answer: { outcome: "applied", summary: "adapted", publication } });
    await track(h);
    h.github.checks = RED;
    expect(await secureIt(h.deps).review(h.context)).toMatchObject({ reviewed: [{ outcome: "adapted" }] });
    const updated = h.github.prs.get(pr.number)!;
    expect(updated.title).toBe(publication.title);
    expect(updated.body).toContain(publication.body);
    expect(updated.body).not.toContain("No adaptation needed; old checks.");
    expect(planOf(updated.body)).toEqual(planOf(pr.body));
    expect(h.workspace.publications[0]?.args.message).toBe(publication.commitMessage);
  });

  it("keeps a tracked PR's issue line through an adaptation, and defuses the agent's closing keywords", async () => {
    const previous = await vitePr();
    const pr = { ...previous, body: `Fixes vite.\n\nTracks #3.\n${previous.body}` };
    const publication = { title: "adapting vite, fixes #3", body: "Adapted src/app.ts.\n\nFixes #3.\nTracks #9.", commitMessage: "adapting vite\n\ncloses #3" };
    const h = harness({ prs: [pr], answer: { outcome: "applied", summary: "adapted", publication } });
    await track(h);
    h.github.checks = RED;
    expect(await secureIt(h.deps).review(h.context)).toMatchObject({ reviewed: [{ outcome: "adapted" }] });
    const updated = h.github.prs.get(pr.number)!;
    expect(updated.title).toBe("adapting vite, fixes `#3`");
    expect(updated.body).toContain("Adapted src/app.ts.\n\nFixes `#3`.\n\nTracks #3.");
    expect(updated.body).not.toContain("Tracks #9.");
    expect(h.workspace.publications[0]?.args.message).toBe("adapting vite\n\ncloses `#3`");
  });

  it("doesn't publish a tracked PR's adaptation that holds a young version no grant covers, and says so on its issue", async () => {
    const previous = await vitePr();
    const publication = { title: "adapting vite", body: "Adapted.", commitMessage: "adapting vite" };
    const held = { ecosystem: "npm" as const, name: "esbuild", version: "0.30.1", replaced: ["0.30.0"], published: "2026-10-06T00:00:00.000Z", eligibleAt: "2026-10-13T00:00:00.000Z", justification: "unjustified" as const };
    // A recorded hold is evidence from an older comparison, never this ordinary PR's authorization.
    const recorded = { ...planOf(previous.body)!, cooldown: [{ ...held, eligibleAt: "2026-10-01T00:00:00.000Z", signals: [] }] };
    const pr = { ...previous, body: withMarker(RULES, withPlanSection("Fixes vite.\n\nTracks #3.", recorded), { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }) };
    const h = harness({ prs: [pr], answer: { outcome: "applied", summary: "adapted", publication } });
    await track(h);
    h.github.checks = RED;
    const issues = h.context.issues as FakeIssues;
    const verify = async (inputs: VerifyInputs) => {
      inputs.cooldown?.({ evaluated: true, releaseAgeDays: 7, held: [held] });
      return [];
    };
    // The agent ran, so the attempt counts; nothing is pushed.
    expect(await secureIt({ ...h.deps, verify }).review(h.context)).toMatchObject({ reviewed: [{ number: 7, outcome: "adaptation-unchanged" }] });
    expect(h.workspace.publications).toEqual([]);
    expect(issues.comments.get(3)!.map((comment) => comment.body)).toEqual([expect.stringContaining("secure-it didn't update #7: on the new base, verification found young versions no grant covers: `esbuild@0.30.1`")]);
  });

  it("has the agent adapt a failing PR, verifies the result, and records the attempt", async () => {
    const h = harness({ prs: [await vitePr()] });
    await track(h);
    h.workspace.setRemoteHead("secure-it/2026-10-05-security", HEAD_SHA);
    h.github.checks = { ...RED, statuses: [{ context: "legacy", state: "error" }] };
    expect(await secureIt(h.deps).review(h.context)).toMatchObject({ reviewed: [{ number: 7, outcome: "adapted" }] });
    expect(h.agentCalls[0]).toMatchObject({ input: { mode: "adapt", failingChecks: ["check", "legacy"], npmAgeExclusions: ["left-pad", "vite"] } });
    expect(h.github.calls.filter((call) => call.startsWith("headChecks "))).toHaveLength(1);
    expect(stateOf(h.github.prs.get(7)!.body)?.adaptations).toBe(1);

    const failing = harness({ prs: [await vitePr()], problems: ["compare: new: vite@8.3.3: GHSA-new has no exception"] });
    await track(failing);
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
    const h = harness({ fixes: [], observations: [], files: f.base });
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
    expect(trackedIssueOf(pr.body)).toBeUndefined();
    expect((h.context.issues as FakeIssues).issues.size).toBe(0);
  });
  it("defers a floor removal too when the run's issues couldn't be synced: such a run executes nothing", async () => {
    const f = removalFixture();
    const h = harness({ fixes: [], observations: [], files: f.base });
    let proofs = 0;
    // A state that isn't a real scan: the issues can't be synced from it.
    const deps = { ...h.deps, scan: async () => ({ marker: "not a scan" }) as unknown as ScanState, floorProbe: async () => { proofs++; return f.probe(); } };
    expect(await secureIt(deps).run(h.context)).toMatchObject({ outcome: "deferred", topic: "floor-removal", reason: expect.stringContaining("the issues couldn't be synced") });
    expect(proofs).toBe(0);
    expect(h.workspace.publications).toHaveLength(0);
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
    const h = harness({ fixes: [], observations: [], files: f.base });
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
    const h = harness({ fixes: [], observations: [], files: f.base, prs: [pr] });
    expect(await secureIt({ ...h.deps, floorProbe: f.probe }).run(h.context)).toMatchObject({ outcome: "already-open" });
    expect(h.github.prs.get(pr.number)!.body).not.toContain("an outdated reason");
    expect(h.workspace.publications).toEqual([]);
  });

  it("suppresses a recognised identical removal and updates a changed plan by reverting", async () => {
    const f = removalFixture();
    const pr = await removalPr(f);
    const h = harness({ fixes: [], observations: [], files: f.base, prs: [pr] });
    expect(await secureIt({ ...h.deps, floorProbe: f.probe }).run(h.context)).toMatchObject({ outcome: "already-open" });
    expect(h.workspace.publications).toEqual([]);
    const changed = harness({ fixes: [], observations: [], files: f.base, prs: [pr] });
    const newFiles = new Map(f.files);
    newFiles.set("package-lock.json", "new exact bytes");
    expect(await secureIt({ ...changed.deps, floorProbe: async () => ({ files: newFiles, findings: [], problems: [] }) }).run(changed.context)).toMatchObject({ outcome: "updated" });
    expect(changed.reverted).toEqual([BASE_SHA]);
    expect(changed.agentCalls).toEqual([]);
  });
  it("leaves a human-pushed removal PR alone and opens a separate suffixed branch", async () => {
    const f = removalFixture();
    const pr = await removalPr(f, { headRef: "secure-it/2026-10-07-floor-removal", headSha: PUSHED_SHA });
    const h = harness({ fixes: [], observations: [], files: f.base, prs: [pr] });
    expect(await secureIt({ ...h.deps, floorProbe: f.probe }).run(h.context)).toMatchObject({ outcome: "published" });
    expect(h.workspace.publications[0]?.prepared.branch).toBe("secure-it/2026-10-07-floor-removal-2");
    expect(h.github.prs.get(pr.number)?.headSha).toBe(PUSHED_SHA);
  });
  it("uses the agent only for the selected Gradle declarations and never publishes a failed verification", async () => {
    const f = removalFixture("Maven");
    const inventory: GradleInventory = { schemaVersion: 3, tree: BASE_SHA, builds: [{ build: ".", configurations: [{ id: ":runtimeClasspath", kind: "project", error: undefined, unresolved: [], declared: [], resolved: [] }] }] };
    const gradle: SecureItDeps["gradle"] = () => ({ ofCommit: async () => inventory, ofWorkingTree: async () => inventory });
    const h = harness({ fixes: [], observations: [], files: f.base });
    expect(await secureIt({ ...h.deps, gradle, floorProbe: f.probe }).run(h.context)).toMatchObject({ outcome: "published" });
    expect(h.agentCalls).toMatchObject([{ input: { moves: [], floorRemovals: [{ package: "g:lib", version: "1.0", declaredIn: "build.gradle.kts", locations: [":runtimeClasspath"] }], toolWritten: [FLOORS_PATH] } }]);
    const failed = harness({ fixes: [], observations: [], files: f.base, problems: ["floor declaration remains"] });
    expect(await secureIt({ ...failed.deps, gradle, floorProbe: f.probe }).run(failed.context)).toMatchObject({ outcome: "verification-failed", problems: ["floor declaration remains"] });
    expect(failed.workspace.publications).toEqual([]);
    expect(failed.agentCalls).toHaveLength(1);
  });
  it("reports unavailable proofs instead of publishing or losing an existing PR during review", async () => {
    const f = removalFixture();
    const blocked = async () => { throw new Error("unlocked resolution unavailable"); };
    const h = harness({ fixes: [], observations: [], files: f.base });
    expect(await secureIt({ ...h.deps, floorProbe: blocked }).run(h.context)).toMatchObject({ outcome: "nothing-to-remove", notes: [expect.stringContaining("unlocked resolution unavailable")] });
    const pr = await removalPr(f);
    const moved = harness({ fixes: [], observations: [], files: f.base, prs: [pr], baseSha: "f".repeat(40) });
    expect(await secureIt({ ...moved.deps, floorProbe: blocked }).review(moved.context)).toMatchObject({ reviewed: [{ outcome: "error", detail: expect.stringContaining("keeping the PR") }] });
    expect(moved.github.prs.get(pr.number)?.state).toBe("open");
    expect(moved.workspace.publications).toEqual([]);
  });
  it("recomputes jointly and republishes on a new base; retires only when the floors already disappeared", async () => {
    const f = removalFixture();
    const pr = await removalPr(f);
    const h = harness({ fixes: [], observations: [], files: f.base, prs: [pr], baseSha: "f".repeat(40) });
    expect(await secureIt({ ...h.deps, floorProbe: f.probe }).review(h.context)).toMatchObject({ reviewed: [{ outcome: "rebased" }] });
    expect(h.reverted).toEqual(["f".repeat(40)]);
    expect(h.agentCalls).toEqual([]);
    const retired = harness({ fixes: [], observations: [], prs: [pr], files: { ...f.base, [FLOORS_PATH]: '{"floors":[]}' }, baseSha: "f".repeat(40) });
    expect(await secureIt({ ...retired.deps, floorProbe: f.probe }).review(retired.context)).toMatchObject({ reviewed: [{ outcome: "retired" }] });
  });
  it("does not let failed CI adapt the proof or invoke an agent", async () => {
    const f = removalFixture();
    const h = harness({ fixes: [], observations: [], files: f.base, prs: [await removalPr(f)] });
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

  /** The tool's issues as a run reads them (`syncIssues`'s tracked list), without an assessment. */
  async function syncedIssues(h: Harness) {
    const issues = h.context.issues as FakeIssues;
    return [...issues.issues.values()].map((issue) => ({ number: issue.number, state: issue.state, body: issue.body, record: recordOf(issue.body)!, reopened: false, labels: issue.labels }));
  }

  /**
   * `pr` as a take-early attempt published it: tracking its issue, which records the label, the reason and the attempt
   * this PR runs, so review goes on with it while its versions are young.
   */
  async function early(h: Harness, pr: GitHubPullRequest, granted?: Array<{ ecosystem: "npm" | "Maven"; name: string; version: string; eligibleAt: string }>): Promise<GitHubPullRequest> {
    const issues = h.context.issues as FakeIssues;
    const plan = planOf(pr.body)!;
    const young = granted ?? (plan.cooldown ?? []).map(({ ecosystem, name, version, eligibleAt }) => ({ ecosystem, name, version, eligibleAt }));
    const subject = { kind: "decision" as const, moves: decisionMoves(plan) };
    const record: IssueRecord = { version: 1, subject, openedAt: BASE_SHA, findings: [], absences: [], attempts: [] };
    const issue = await issues.createIssue({ repo: REPO, title: "secure-it: vite", body: ISSUE_WRITER.render({ subject, findings: [], status: { kind: "waiting", young } }, record, BASE_SHA).body, labels: [ISSUE_LABEL] });
    issues.permissions.set("owner", "admin");
    const reason = issues.comment(issue.number, "owner", "take-early: tested");
    issues.label(issue.number, "owner", "take-early");
    const labeled = issues.events.get(issue.number)!.find((event) => event.event === "labeled")!;
    const grant = { labelEventId: labeled.id, reasonCommentId: reason.id, actor: "owner", at: labeled.createdAt, young: young.map(({ ecosystem, name, version }) => ({ ecosystem, name, version })) };
    const attempt = { id: `${labeled.id}-1`, grantEventId: labeled.id, branch: pr.headRef, startedAt: NOW.toISOString(), pr: pr.number };
    issues.issues.set(issue.number, { ...issues.issues.get(issue.number)!, body: ISSUE_WRITER.withRecord(issue.body, { ...record, grant, attempts: [attempt] }) });
    const tracked = { ...pr, body: `Tracks #${issue.number}.\n\n${pr.body}` };
    h.github.prs.set(tracked.number, tracked);
    return tracked;
  }

  it("keeps a held PR's cooldown warning and hold when rewriting its notes", async () => {
    const plan = await planFor([YOUNG_VITE()], { named: undefined, lockfiles: new Map([["package-lock.json", JSON.parse(LOCK)]]), gradle: undefined, tagCommit: async () => undefined }, { kind: "routine", topic: "security-young-npm|vite" });
    const held = { ...plan, notes: ["an outdated reason"], cooldown: [{ ...HELD, signals: [] }] };
    const h = harness({ fixes: [YOUNG_VITE()], prs: [ownPr({ headRef: branchFor(RULES, new Date("2026-10-05T00:00:00Z"), plan.topic), body: withMarker(RULES, withPlanSection("Fixes vite.", held), { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }) })] });
    await early(h, h.github.prs.get(7)!);
    expect(await secureIt(h.deps).run(h.context)).toMatchObject({ outcome: "already-open" });
    const body = h.github.prs.get(7)!.body;
    expect(body).not.toContain("an outdated reason");
    expect(body).toContain("Release-age cooldown bypassed.");
    expect(planOf(body)?.cooldown).toEqual(held.cooldown);
    expect(trackedRecord(h, 7).grant?.young).toEqual([{ ecosystem: "npm", name: "vite", version: "8.3.3" }]);
  });

  it("rewrites a held PR's notes without its evidence when the new notes leave no room for it", async () => {
    // 180 advisory groups of hashes fit the section beside one note; 8K of new notes don't, even compressed.
    const hex = (seed: string) => createHash("sha256").update(seed).digest("hex");
    const evidence: AdvisoryEvidence = { collectedAt: "2026-10-06T12:00:00.000Z", targets: [{ ecosystem: "npm", name: "vite", bundled: false, replaced: ["8.3.1"], proposed: ["8.3.3"],
      groups: Array.from({ length: 180 }, (_, i) => {
        const found = { id: `GHSA-${hex(`${i}`).slice(0, 14)}`, aliases: Array.from({ length: 4 }, (_, j) => hex(`${i}-${j}`)), withdrawn: false, namesPackage: true,
          declaredFixes: ["8.3.3"], verdicts: { "8.3.1": "affected" as const, "8.3.3": "not-affected" as const } };
        return { ids: [found.id], replaced: ["8.3.1"], sources: (["repository", "github", "osv"] as const).map((source) => ({ source, lookup: "checked" as const, records: [found] })) };
      }) }] };
    const plan = await planFor([YOUNG_VITE()], { named: undefined, lockfiles: new Map([["package-lock.json", JSON.parse(LOCK)]]), gradle: undefined, tagCommit: async () => undefined }, { kind: "routine", topic: "security-young-npm|vite" });
    const held = { ...plan, notes: ["an outdated reason"], cooldown: [{ ...HELD, signals: [], evidence }] };
    const published = withPlanSection("Fixes vite.", held);
    expect(planOf(published)?.cooldown?.[0]?.evidence).toEqual(evidence);
    const notes = Array.from({ length: 128 }, (_, i) => `vite@8.3.3 note ${i}: ${hex(`note-${i}`)}`);
    const requiredNpm: SecureItDeps["requiredNpm"] = async (_base, planned) => ({ ...planned, notes });
    const h = harness({ fixes: [YOUNG_VITE()], prs: [ownPr({ headRef: branchFor(RULES, new Date("2026-10-05T00:00:00Z"), plan.topic), body: withMarker(RULES, published, { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }) })] });
    await early(h, h.github.prs.get(7)!);
    expect(await secureIt({ ...h.deps, requiredNpm }).run(h.context)).toMatchObject({ outcome: "already-open" });
    const body = h.github.prs.get(7)!.body;
    expect(body).not.toContain("an outdated reason");
    expect(planOf(body)).toMatchObject({ notes, cooldown: [{ ...HELD, signals: [], evidenceFailure: EVIDENCE_LEFT_OUT }] });
    expect(planOf(body)?.cooldown?.[0]?.evidence).toBeUndefined();
    expect(trackedRecord(h, 7).grant?.young).toEqual([{ ecosystem: "npm", name: "vite", version: "8.3.3" }]);
  });

  it("opens young fixes in a held PR of their own, warned, while the aged ones go out as usual", async () => {
    const h = harness({ fixes: [YOUNG_VITE(), leftPad()] });
    const tool = secureIt({ ...h.deps, verify: holdingVerify });
    await grantWaiting(tool, h, ["vite"]);
    expect(h.agentCalls.map((call) => call.input["moves"])).toMatchObject([[{ name: "left-pad" }]]);
    expect(h.github.prs.size).toBe(1);
    const result = await tool.run(h.context);
    expect(result).toMatchObject({ outcome: "completed", units: [{ topic: "security", outcome: "already-open" }, { topic: "security-young-npm|vite", outcome: "published" }] });
    expect(h.agentCalls.map((call) => (call.input["moves"] as Array<{ name: string }>).map((move) => move.name))).toEqual([["left-pad"], ["vite"]]);
    const [aged, held] = [...h.github.prs.values()];
    expect(aged!.body).not.toContain("[!WARNING]");
    expect(planOf(aged!.body)?.cooldown).toBeUndefined();
    expect(held!.body.startsWith("<!-- secure-it cooldown warning -->\n> [!WARNING]\n> **Release-age cooldown bypassed.**")).toBe(true);
    expect(held!.body).toContain("> | npm `vite` | `8.3.1` → `8.3.3` | 2026-10-06 00:00 | 2026-10-13 00:00 | the security fix the version rule picks | `registry metadata unreadable` |");
    expect(held!.isDraft).toBe(true);
    expect(planOf(held!.body)?.cooldown).toEqual([{ ...HELD, signals: ["registry metadata unreadable"] }]);
    expect(trackedRecord(h, aged!.number).attempts).toEqual([]);
    expect(trackedRecord(h, held!.number).attempts).toMatchObject([{ pr: held!.number }]);
  });

  it("records where the advisories behind a held fix appear, and opens the warning with it", async () => {
    const h = harness({ fixes: [YOUNG_VITE()] });
    const targeted = { ...HELD, targets: [{ name: "vite", bundled: false, replaced: ["8.3.1"], proposed: ["8.3.3"], groups: [{ ids: ["GHSA-vite-0001"], replaced: ["8.3.1"] }] }] };
    const verify = async (inputs: VerifyInputs) => {
      inputs.cooldown?.({ evaluated: true, releaseAgeDays: 7, held: [targeted] });
      return [];
    };
    const tool = secureIt({ ...h.deps, verify });
    await grantWaiting(tool, h);
    expect(await tool.run(h.context)).toMatchObject({ outcome: "published" });
    trackedRecord(h);
    const body = h.github.prs.get(42)!.body;
    const [hold] = planOf(body)!.cooldown!;
    // The harness answers every lookup with a 404: checked and not found, never failed.
    expect(hold!.evidence).toMatchObject({ collectedAt: NOW.toISOString(), targets: [{ name: "vite", groups: [{ ids: ["GHSA-vite-0001"], sources: [
      { source: "repository", lookup: "incomplete" }, { source: "github", lookup: "checked", records: [] }, { source: "osv", lookup: "checked", records: [] },
    ] }] }] });
    expect(body).toContain("> **Some advisories recorded for these held fixes are not backed by reviewed records as read now.**");
    expect(body).toContain("> | ⚠ `GHSA-vite-0001` | `vite` `8.3.1` → `8.3.3` | couldn't be fully checked: `its source repository can't be found: registry lookup of vite@8.3.1 failed with HTTP 404` | not found | not found |");
  });

  it("still opens a held draft with its targets when its evidence leaves the body over GitHub's limit, without the evidence", async () => {
    // 60 advisory groups: with their evidence the plan's block takes ~32K characters, without it ~6K, beside a 40K description.
    const hex = (seed: string) => createHash("sha256").update(seed).digest("hex");
    const groups = Array.from({ length: 60 }, (_, i) => ({ ids: [`GHSA-${hex(`${i}`).slice(0, 14)}`], replaced: ["8.3.1"] }));
    const targeted = { ...HELD, targets: [{ name: "vite", bundled: false, replaced: ["8.3.1"], proposed: ["8.3.3"], groups }] };
    const verify = async (inputs: VerifyInputs) => {
      inputs.cooldown?.({ evaluated: true, releaseAgeDays: 7, held: [targeted] });
      return [];
    };
    const h = harness({ fixes: [YOUNG_VITE()], answer: { ...APPLIED, publication: { ...APPLIED.publication, body: "x".repeat(40_000) } } });
    const tool = secureIt({ ...h.deps, verify });
    await grantWaiting(tool, h);
    expect(await tool.run(h.context)).toMatchObject({ outcome: "published" });
    trackedRecord(h);
    const pr = h.github.prs.get(42)!;
    expect(pr.isDraft).toBe(true);
    expect(pr.body.length).toBeLessThanOrEqual(65_536);
    const [hold] = planOf(pr.body)!.cooldown!;
    expect(hold).toMatchObject({ targets: targeted.targets, evidenceFailure: EVIDENCE_LEFT_OUT });
    expect(hold!.evidence).toBeUndefined();
    expect(pr.body).toContain(`\`vite\`@\`8.3.3\`: \`${EVIDENCE_LEFT_OUT}\``);
  });

  it("publishes and refreshes a large held body, including changed notes and a review rebase", async () => {
    // 400 short temp paths, each growing into `<local path>` when published, beside a long description: composed near the
    // 61,440 target, the published body passes the target and still fits GitHub's 65,536.
    const hex = (seed: string) => createHash("sha256").update(seed).digest("hex");
    const groups = Array.from({ length: 60 }, (_, i) => ({ ids: [`GHSA-${hex(`${i}`).slice(0, 14)}`], replaced: ["8.3.1"] }));
    const targeted = { ...HELD, targets: [{ name: "vite", bundled: false, replaced: ["8.3.1"], proposed: ["8.3.3"], groups }] };
    const verify = async (inputs: VerifyInputs) => {
      inputs.cooldown?.({ evaluated: true, releaseAgeDays: 7, held: [targeted] });
      return [];
    };
    const description = `${"/tmp/x ".repeat(400)}${"x".repeat(51_000)}`;
    const h = harness({ fixes: [YOUNG_VITE()], answer: { ...APPLIED, publication: { ...APPLIED.publication, body: description } } });
    const tool = secureIt({ ...h.deps, verify });
    await grantWaiting(tool, h);
    expect(await tool.run(h.context)).toMatchObject({ outcome: "published" });
    trackedRecord(h);
    const pr = h.github.prs.get(42)!;
    expect(pr.body.match(/<local path>/g)).toHaveLength(400);
    expect(pr.body.length).toBeGreaterThan(61_440);
    expect(pr.body.length).toBeLessThanOrEqual(65_536);
    expect(planOf(pr.body)!.cooldown![0]).toMatchObject({ targets: targeted.targets });
    const calls = h.github.calls.length;
    expect(await tool.run(h.context)).toMatchObject({ outcome: "already-open" });
    expect(h.github.calls.slice(calls).some((call) => call.startsWith("updatePullRequest"))).toBe(false);
    expect(h.github.prs.get(42)!.body).toBe(pr.body);
    const notes = ["vite@8.3.3 now has an updated explanation"];
    const requiredNpm: SecureItDeps["requiredNpm"] = async (_base, plan) => ({ ...plan, notes });
    const changed = secureIt({ ...h.deps, verify, requiredNpm });
    expect(await changed.run(h.context)).toMatchObject({ outcome: "already-open" });
    const refreshed = h.github.prs.get(42)!;
    expect(planOf(refreshed.body)?.notes).toEqual(notes);
    expect(refreshed.body.length).toBeGreaterThan(61_440);
    h.workspace.setRemoteHead(refreshed.headRef, refreshed.headSha);
    const movedBase = { ...h.context, workingCopy: { ...h.context.workingCopy, headSha: "f".repeat(40) } };
    expect(await changed.review(movedBase)).toMatchObject({ reviewed: [{ number: 42, outcome: "rebased" }] });
    expect(h.github.prs.get(42)!.body.length).toBeLessThanOrEqual(65_536);
    expect(planOf(h.github.prs.get(42)!.body)?.notes).toEqual(notes);
  });

  it.each(["run", "review"] as const)("cuts fresh agent text on a %s update before its marker would exceed the client limit", async (command) => {
    const groups = Array.from({ length: 60 }, (_, i) => ({ ids: [`GHSA-${createHash("sha256").update(`${i}`).digest("hex").slice(0, 14)}`], replaced: ["8.3.1"] }));
    const targeted = { ...HELD, targets: [{ name: "vite", bundled: false, replaced: ["8.3.1"], proposed: ["8.3.3"], groups }] };
    const verify = async (inputs: VerifyInputs) => {
      inputs.cooldown?.({ evaluated: true, releaseAgeDays: 7, held: [targeted] });
      return [];
    };
    // Collect the same evidence as the update, then choose a description whose full warning fits raw but not marked.
    const seed = harness({ fixes: [YOUNG_VITE()] });
    const seedTool = secureIt({ ...seed.deps, verify });
    await grantWaiting(seedTool, seed);
    expect(await seedTool.run(seed.context)).toMatchObject({ outcome: "published" });
    const planned = planOf(seed.github.prs.get(42)!.body)!;
    const full = (description: string) => `${cooldownWarning(planned.cooldown!)!}\n\n${description}\n\n${planSection(planned)}`;
    const description = "x".repeat(65_500 - full("").length);
    expect(full(description)).toHaveLength(65_500);
    expect(withMarker(RULES, full(description), { head: PUSHED_SHA, base: BASE_SHA, adaptations: 0 }).length).toBeGreaterThan(65_536);
    // Fresh advisory metadata changes the plan digest, but not the exact moves the issue authorizes.
    const previous = { ...planned, moves: planned.moves.map((move) => ({ ...move, advisories: ["GHSA-old"] })) };
    const stale = ownPr({ headRef: "secure-it/2026-10-05-security-young-npm-vite", body: withMarker(RULES, withPlanSection("Fixes vite.", previous), { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }) });
    const h = harness({ prs: [stale], fixes: [YOUNG_VITE()], answer: { ...APPLIED, publication: { ...APPLIED.publication, body: description } } });
    h.workspace.setRemoteHead(stale.headRef, stale.headSha);
    await early(h, stale);
    const tool = secureIt({ ...h.deps, verify });
    if (command === "run") {
      expect(await tool.run(h.context)).toMatchObject({ outcome: "updated" });
    } else {
      expect(await tool.review({ ...h.context, workingCopy: { ...h.context.workingCopy, headSha: "f".repeat(40) } }))
        .toMatchObject({ reviewed: [{ number: 7, outcome: "rebased" }] });
    }
    const body = h.github.prs.get(7)!.body;
    expect(body.length).toBeLessThanOrEqual(65_536);
    expect(body).toContain("rows are left out");
    expect(planOf(body)?.cooldown?.[0]?.evidence).toBeDefined();
    trackedRecord(h, 7);
  });

  it("records the evidence of a required version that fixes advisories itself, so the warning checks it too", async () => {
    const h = harness({ fixes: [YOUNG_VITE()] });
    const target = (name: string, from: string, to: string, id: string) => ({ name, bundled: false, replaced: [from], proposed: [to], groups: [{ ids: [id], replaced: [from] }] });
    const required = { ...HELD, name: "postcss", version: "8.5.29", replaced: ["8.5.28"], justification: "required" as const, targets: [target("postcss", "8.5.28", "8.5.29", "GHSA-postcss-0001")] };
    const verify = async (inputs: VerifyInputs) => {
      inputs.cooldown?.({ evaluated: true, releaseAgeDays: 7, held: [{ ...HELD, targets: [target("vite", "8.3.1", "8.3.3", "GHSA-vite-0001")] }, required] });
      return [];
    };
    const requiredNpm: SecureItDeps["requiredNpm"] = async (_base, plan) => ({ ...plan, requiredNpm: [requirement("postcss", "8.5.29", "vite", "8.3.3")] });
    const tool = secureIt({ ...h.deps, requiredNpm, verify });
    await grantWaiting(tool, h);
    expect(await tool.run(h.context)).toMatchObject({ outcome: "published" });
    expect(trackedRecord(h).grant?.young.map((pkg) => pkg.name)).toEqual(["vite", "postcss"]);
    const body = h.github.prs.get(42)!.body;
    expect(planOf(body)!.cooldown![1]!.evidence).toMatchObject({ targets: [{ name: "postcss", groups: [{ ids: ["GHSA-postcss-0001"] }] }] });
    expect(body).toContain("| ⚠ `GHSA-postcss-0001` | `postcss` `8.5.28` → `8.5.29` |");
    expect(body).toContain(`> ${EVIDENCE_DIFFERS}`);
  });

  it("doesn't publish when the comparison couldn't evaluate the cooldown", async () => {
    const h = harness();
    const verify = async (inputs: VerifyInputs) => {
      inputs.cooldown?.({ evaluated: false, reason: "legacy report" });
      return [];
    };
    expect(await secureIt({ ...h.deps, verify }).run(h.context)).toMatchObject({ outcome: "verification-failed", problems: ["the cooldown can't be evaluated: legacy report"] });
    expect(h.github.prs.size).toBe(0);
  });

  const requiredVerify: SecureItDeps["verify"] = async (inputs) => {
    inputs.cooldown?.({ evaluated: true, releaseAgeDays: 7, held: (inputs.plan.requiredNpm ?? []).filter((target) => target.exempt)
      .map((target) => ({ ...HELD, name: target.name, version: target.version, justification: "required" as const })) });
    return [];
  };

  it("moves a fix whose required dependency is young into the held PR, with its coupled packages", async () => {
    const h = harness({ fixes: [vite(), leftPad()] });
    const requiredNpm: SecureItDeps["requiredNpm"] = async (_base, plan) => plan.packages.includes("npm|vite")
      ? { ...plan, requiredNpm: [requirement("postcss", "8.5.29", "vite", "8.3.3")] }
      : plan;
    const tool = secureIt({ ...h.deps, requiredNpm, verify: requiredVerify });
    await grantWaiting(tool, h, ["vite"]);
    const result = await tool.run(h.context);
    expect(result).toMatchObject({ units: [{ topic: "security", packages: ["npm|left-pad"], outcome: "already-open" }, { topic: "security-young-npm|vite", packages: ["npm|vite"], outcome: "published" }] });
    const young = [...(h.context.issues as FakeIssues).issues.values()].map((issue) => recordOf(issue.body)!).find((record) => record.grant !== undefined)!;
    expect(young.grant!.young).toEqual([{ ecosystem: "npm", name: "postcss", version: "8.5.29" }]);
  });

  it("holds an aged fix with the aged fix it requires when that one requires a young dependency", async () => {
    // As requiredNpmPlan proves it (npm-required-plan.test.ts, chainBatch): vite requires left-pad's fix, which requires young c,
    // so both roots carry an exempt target for c.
    const h = harness({ fixes: [vite(), leftPad()] });
    const target = (root: string, version: string) => requirement("c", "1.0.1", root, version);
    const requiredNpm: SecureItDeps["requiredNpm"] = async (_base, plan) => ({ ...plan, requiredNpm: [
      ...plan.packages.includes("npm|vite") ? [target("vite", "8.3.3")] : [],
      ...plan.packages.includes("npm|left-pad") ? [target("left-pad", "1.0.1")] : [],
    ] });
    const tool = secureIt({ ...h.deps, requiredNpm, verify: requiredVerify });
    await grantWaiting(tool, h, ["vite"]);
    const result = await tool.run(h.context);
    expect(result).toMatchObject({ units: [{ topic: "security-young-npm|left-pad", packages: ["npm|left-pad", "npm|vite"], outcome: "published" }] });
    expect(trackedRecord(h).subject).toMatchObject({ moves: expect.arrayContaining([{ ecosystem: "npm", name: "vite", from: "8.3.1", to: "8.3.3" }, { ecosystem: "npm", name: "left-pad", from: "1.0.0", to: "1.0.1" }]) });
    const young = [...(h.context.issues as FakeIssues).issues.values()].map((issue) => recordOf(issue.body)!).find((record) => record.grant !== undefined)!;
    expect(young.grant!.young).toEqual([{ ecosystem: "npm", name: "c", version: "1.0.1" }]);
  });

  it("keeps a coupling planning discovers in the held unit: a root that needs another root's fix", async () => {
    // vite's young requirement moves it to a held unit; planning found it needs left-pad's fix too.
    const h = harness({ fixes: [vite(), leftPad()] });
    const requiredNpm: SecureItDeps["requiredNpm"] = async (_base, plan) => plan.packages.includes("npm|vite") && plan.packages.includes("npm|left-pad")
      ? { ...plan, coupled: [["npm|vite", "npm|left-pad"]], requiredNpm: [requirement("postcss", "8.5.29", "vite", "8.3.3")] }
      : plan;
    const tool = secureIt({ ...h.deps, requiredNpm, verify: requiredVerify });
    await grantWaiting(tool, h, ["vite"]);
    const result = await tool.run(h.context);
    expect(result).toMatchObject({ units: [{ topic: "security-young-npm|left-pad", packages: ["npm|left-pad", "npm|vite"], outcome: "published" }] });
    expect(trackedRecord(h).subject).toMatchObject({ moves: expect.arrayContaining([{ ecosystem: "npm", name: "vite", from: "8.3.1", to: "8.3.3" }, { ecosystem: "npm", name: "left-pad", from: "1.0.0", to: "1.0.1" }]) });
    const young = [...(h.context.issues as FakeIssues).issues.values()].map((issue) => recordOf(issue.body)!).find((record) => record.grant !== undefined)!;
    expect(young.grant!.young).toEqual([{ ecosystem: "npm", name: "postcss", version: "8.5.29" }]);
  });

  it("doesn't hold an aged fix because it shares an aged companion with a held one", async () => {
    // Only vite's requirement of c is young; left-pad's is aged, so left-pad goes out with the aged batch.
    const h = harness({ fixes: [vite(), leftPad()] });
    const target = (root: string, version: string, exempt: boolean) => requirement("c", "1.0.1", root, version, exempt);
    const requiredNpm: SecureItDeps["requiredNpm"] = async (_base, plan) => ({ ...plan, requiredNpm: [
      ...plan.packages.includes("npm|vite") ? [target("vite", "8.3.3", true)] : [],
      ...plan.packages.includes("npm|left-pad") ? [target("left-pad", "1.0.1", false)] : [],
    ] });
    const tool = secureIt({ ...h.deps, requiredNpm, verify: requiredVerify });
    await grantWaiting(tool, h, ["vite"]);
    const result = await tool.run(h.context);
    expect(result).toMatchObject({ units: [{ topic: "security", packages: ["npm|left-pad"], outcome: "already-open" }, { topic: "security-young-npm|vite", packages: ["npm|vite"], outcome: "published" }] });
    const young = [...(h.context.issues as FakeIssues).issues.values()].map((issue) => recordOf(issue.body)!).find((record) => record.grant !== undefined)!;
    expect(young.grant!.young).toEqual([{ ecosystem: "npm", name: "c", version: "1.0.1" }]);
  });

  /** Base declarations are independent to the planner; Gradle refuses either half of this aligned pair. */
  function heldGradle(options: { independent?: boolean; single?: boolean; extra?: boolean; broken?: "throw" | "missing" | "unresolved" | "declarations"; ignored?: string[] } = {}) {
    const allNames = ["a", "b", ...options.extra ? ["c"] : []];
    const fixes = allNames.slice(0, options.single ? 1 : allNames.length).map((name) => vite({ ecosystem: "Maven", name: `g:${name}`, from: "1.0.0", locations: [":runtimeClasspath"],
      to: { version: "1.0.1", line: "1", aged: false, major: false, blockers: [] } }));
    const files = { "build.gradle": `dependencies { ${allNames.map((name) => `implementation "g:${name}:1.0.0"`).join("; ")} }`,
      ...options.ignored === undefined ? {} : { ".github/supply-chain.json": JSON.stringify({ gradle: { ignoreConfigurations: options.ignored } }) } };
    const base: GradleInventory = { schemaVersion: 3, tree: BASE_SHA, builds: [{ build: ".", configurations: [{ id: ":runtimeClasspath", kind: "project", error: undefined, unresolved: [],
      declared: allNames.map((name) => ({ group: "g", name, version: "1.0.0", reason: undefined })),
      resolved: allNames.map((name) => ({ group: "g", name, version: "1.0.0" })),
    }] }] };
    const h = harness({ fixes, files });
    const probes: string[][] = [];
    const inventories: ReturnType<SecureItDeps["gradle"]> = {
      ofWorkingTree: async () => base,
      ofCommit: async (_tree, change) => {
        if (change?.transform === undefined) return base;
        const { moves } = change.transform.content("/fixture") as { moves: Array<{ name: string; to: string }> };
        const names = moves.map((move) => move.name).sort();
        probes.push(names);
        if (options.broken === "throw" && names.includes("g:a")) throw new Error("reference unavailable");
        if (options.broken === "missing" && names.includes("g:a")) return undefined;
        const failed = options.independent !== true && names.includes("g:a") !== names.includes("g:b");
        return { ...base, builds: [{ build: ".", configurations: base.builds[0]!.configurations.map((configuration) => ({ ...configuration,
          error: failed ? "conflict between g:b:1.0.0 and g:b:1.0.1" : undefined,
          unresolved: options.broken === "unresolved" && names.includes("g:a") ? [{ requested: "g:a:1.0.1", failure: "not found" }] : [],
          declared: configuration.declared.map((entry) => names.includes(`g:${entry.name}`) && !(options.broken === "declarations" && entry.name === "a")
            ? { ...entry, version: "1.0.1", moved: true as const } : entry),
        })) }] };
      },
    };
    const verify: SecureItDeps["verify"] = async (inputs) => {
      if (inputs.reference === undefined) return ["no Gradle reference"];
      const planned = referencePlan(inputs.plan, inputs.gradle.base);
      const problems = [...planned.problems, ...referenceProblems(inputs.gradle.base, inputs.reference, planned.moves, planned.floors), ...gradleResolutionProblems(inputs.reference, options.ignored ?? [])];
      if (problems.length === 0) inputs.cooldown?.({ evaluated: true, releaseAgeDays: 7, held: inputs.plan.moves.map((move) => ({ ...HELD, ecosystem: "Maven", name: move.name, version: move.to, replaced: [move.from] })) });
      return problems;
    };
    const fixtureTree = (id: string): Tree => ({ ...tree(id, files), list: async () => Object.keys(files) });
    const deps: SecureItDeps = { ...h.deps, gradle: () => inventories, verify,
      trees: { commit: async (_wc, sha) => fixtureTree(sha), working: () => fixtureTree("worktree") } };
    return { ...h, base, fixes, probes, deps };
  }

  it("ends an early attempt when its execution reference fails", async () => {
    const h = heldGradle({ independent: true, broken: "throw" });
    const issues = h.context.issues as FakeIssues;
    const observed: string[] = [];
    const started = (step: string) => {
      const records = [...issues.issues.values()].flatMap((issue) => recordOf(issue.body)?.attempts ?? []);
      expect(records).toHaveLength(1);
      expect(records[0]!.outcome).toBeUndefined();
      observed.push(step);
    };
    const prepare = h.workspace.prepareBranch.bind(h.workspace);
    h.workspace.prepareBranch = async (...args) => { started("branch"); return prepare(...args); };
    const inventories = h.deps.gradle(h.context);
    const gradle: SecureItDeps["gradle"] = () => ({ ...inventories, ofCommit: async (tree, change) => {
      if (change?.transform !== undefined) started("reference");
      return inventories.ofCommit(tree, change);
    } });
    // Decisions still get issues when the scan observes no findings.
    const deps = { ...h.deps, gradle, scan: async (scanned: Tree) => ({ settings: await readSettings(scanned), packages: [] }) as unknown as ScanState };
    expect(await secureIt(deps).run(h.context)).toMatchObject({ units: [{ outcome: "deferred" }, { outcome: "deferred" }] });
    expect(observed).toEqual([]);
    expect([...issues.issues.values()].every((issue) => recordOf(issue.body)!.attempts.length === 0)).toBe(true);
    const [ga] = [...issues.issues.values()].filter((issue) => recordOf(issue.body)?.subject.kind === "decision"
      && JSON.stringify(recordOf(issue.body)!.subject).includes("g:a"));
    issues.permissions.set("owner", "admin");
    issues.comment(ga!.number, "owner", "take-early: urgent");
    issues.label(ga!.number, "owner", "take-early");
    expect(await secureIt(deps).run(h.context)).toMatchObject({ units: [{ topic: "security-young-Maven|g:a", outcome: "verification-failed", problems: ["the plan's Gradle reference can't be built: reference unavailable"] }, { outcome: "deferred" }] });
    expect(recordOf(issues.issues.get(ga!.number)!.body)!.attempts).toMatchObject([{ outcome: "failed" }]);
    expect(observed).toEqual(["branch", "reference", "reference"]);
    expect(h.agentCalls).toHaveLength(2);
    expect(h.workspace.publications).toEqual([]);
  });

  it.each(["branch", "files"] as const)("records one early attempt before %s execution and ends it on failure", async (step) => {
    const h = harness({ fixes: [YOUNG_VITE()] });
    const issues = h.context.issues as FakeIssues;
    const started = () => {
      const attempts = recordOf(issues.issues.get(1)!.body)!.attempts;
      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.outcome).toBeUndefined();
    };
    const prepare = h.workspace.prepareBranch.bind(h.workspace);
    h.workspace.prepareBranch = async (...args) => {
      started();
      if (step === "branch") throw new Error("branch unavailable");
      return prepare(...args);
    };
    const tool = secureIt({ ...h.deps, materializeNpm: async () => {
      started();
      return new Map([["package-lock.json", LOCK]]);
    }, writeFile: async () => { started(); throw new Error("files unavailable"); } });
    await grantWaiting(tool, h);
    expect(recordOf(issues.issues.get(1)!.body)!.attempts).toEqual([]);
    expect(h.workspace.preparations).toEqual([]);
    expect(await tool.run(h.context)).toMatchObject({ outcome: "failed", detail: `${step} unavailable` });
    expect(recordOf(issues.issues.get(1)!.body)!.attempts).toMatchObject([{ outcome: "failed" }]);
    expect(h.agentCalls).toEqual([]);
    expect(h.workspace.publications).toEqual([]);
  });

  it.each(["aged", "major", "malware"] as const)("resolves only verification references for %s units, jointly except for majors", async (kind) => {
    const h = heldGradle({ independent: true });
    const fixes = h.fixes.map((fix) => ({ ...fix, malicious: kind === "malware", to: { ...fix.to!, aged: true, major: kind === "major" } }));
    const found = await h.deps.candidates(tree(BASE_SHA), await h.deps.gate(h.context), {});
    await secureIt({ ...h.deps, candidates: async () => ({ ...found, fixes }) }).run(h.context);
    expect(h.probes).toEqual(kind === "major" ? [["g:a"], ["g:b"]] : [["g:a", "g:b"]]);
  });

  it("keeps independent held Gradle fixes apart", async () => {
    const h = heldGradle({ independent: true });
    const tool = secureIt(h.deps);
    await grantWaiting(tool, h, ["g:a"]);
    expect(h.agentCalls).toEqual([]);
    expect(await tool.run(h.context)).toMatchObject({ units: [
      { topic: "security-young-Maven|g:a", outcome: "published" }, { topic: "security-young-Maven|g:b", outcome: "deferred" },
    ] });
    expect(trackedRecord(h).subject).toMatchObject({ moves: [{ name: "g:a" }] });
    expect(h.agentCalls).toHaveLength(1);
  });

  it("publishes the healthy young Gradle decision when another fails final verification", async () => {
    const h = heldGradle({ independent: true });
    const verify: SecureItDeps["verify"] = async (inputs) => inputs.plan.packages.includes("Maven|g:a")
      ? ["g:a's edited declaration does not verify"] : h.deps.verify(inputs);
    const tool = secureIt({ ...h.deps, verify });
    await grantWaiting(tool, h);
    expect(await tool.run(h.context)).toMatchObject({ units: [
      { topic: "security-young-Maven|g:a", outcome: "verification-failed", problems: ["g:a's edited declaration does not verify"] },
      { topic: "security-young-Maven|g:b", outcome: "published" },
    ] });
    expect(h.github.prs.size).toBe(1);
    expect(trackedRecord(h).subject).toMatchObject({ moves: [{ name: "g:b" }] });
    const failed = [...(h.context.issues as FakeIssues).issues.values()].map((issue) => recordOf(issue.body)!)
      .find((record) => record.subject.kind === "decision" && record.subject.moves.some((move) => move.name === "g:a"))!;
    expect(failed.attempts).toMatchObject([{ outcome: "failed" }]);
  });

  it.each([
    ["unresolved", [":runtimeClasspath"], "published"],
    ["unresolved", [":testRuntimeClasspath"], "verification-failed"],
    ["declarations", [":runtimeClasspath"], "verification-failed"],
  ] as const)("checks a single young Gradle decision with %s and ignored %j at verification", async (broken, ignored, outcome) => {
    const h = heldGradle({ single: true, independent: true, broken, ignored: [...ignored] });
    const tool = secureIt(h.deps);
    await grantWaiting(tool, h);
    const result = await tool.run(h.context);
    expect(result).toMatchObject({ outcome });
    expect(h.agentCalls.length).toBeGreaterThan(0);
    if (outcome === "published") {
      expect(trackedRecord(h).subject).toMatchObject({ moves: [{ name: "g:a" }] });
    } else {
      expect(result).toMatchObject({ problems: expect.arrayContaining([expect.stringContaining(broken === "unresolved" ? "not found" : "g:a")]) });
      expect(h.github.prs.size).toBe(0);
      const decision = [...(h.context.issues as FakeIssues).issues.values()].map((issue) => recordOf(issue.body)!).find((record) => record.subject.kind === "decision")!;
      expect(decision.attempts).toMatchObject([{ outcome: "failed" }]);
    }
  });

  async function seedSplitGradlePrs(h: ReturnType<typeof heldGradle>): Promise<void> {
    for (const [i, fix] of h.fixes.entries()) {
      const topic = fix.to!.aged ? "security" : `security-young-${fix.ecosystem}|${fix.name}`;
      const plan = await planFor([fix], { lockfiles: new Map(), gradle: h.base, named: () => true, tagCommit: async () => undefined }, { kind: "routine", topic });
      // A held one as take-early published it: holding its own young versions, tracking its issue's grant.
      const held = fix.to!.aged ? plan : { ...plan, cooldown: plan.moves.map((move) => ({ ...HELD, ecosystem: "Maven" as const, name: move.name, version: move.to, replaced: [move.from], signals: [] })) };
      const pr = ownPr({ number: i + 7, nodeId: `node${i + 7}`, url: `https://github.com/leanish/widget/pull/${i + 7}`, headRef: branchFor(RULES, new Date("2026-10-05T00:00:00Z"), topic), body: withMarker(RULES, withPlanSection("Fixes one.", held), { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }) });
      h.github.prs.set(pr.number, fix.to!.aged ? pr : await early(h, pr));
      h.workspace.setRemoteHead(pr.headRef, pr.headSha);
    }
    await track(h);
  }


  it("rebases an aged PR and the other held PR while one held PR reports its Gradle execution error", async () => {
    const h = heldGradle({ independent: true, extra: true });
    const fixes = h.fixes.map((fix) => fix.name === "g:c" ? { ...fix, to: { ...fix.to!, aged: true } } : fix);
    await seedSplitGradlePrs({ ...h, fixes });
    const failing = h.github.prs.get(7);
    const found = await h.deps.candidates(tree(BASE_SHA), await h.deps.gate(h.context), {});
    const inventories = h.deps.gradle(h.context);
    let attempts = 0;
    const gradle: SecureItDeps["gradle"] = () => ({ ...inventories, ofCommit: async (tree, change) => {
      if (change?.transform !== undefined && attempts++ === 0) throw new Error("transient Gradle failure");
      return inventories.ofCommit(tree, change);
    } });
    const tool = secureIt({ ...h.deps, gradle, verify: async (inputs) => inputs.plan.topic === "security" ? [] : h.deps.verify(inputs), candidates: async () => ({ ...found, fixes }) });
    expect(await tool.review({ ...h.context, workingCopy: { ...h.context.workingCopy, headSha: "f".repeat(40) } })).toMatchObject({ reviewed: [
      { number: 7, outcome: "error", detail: expect.stringContaining("transient Gradle failure") },
      { number: 8, outcome: "rebased" },
      { number: 9, outcome: "rebased" },
    ] });
    expect(h.github.prs.get(7)).toEqual(failing);
    expect(h.github.prs.get(9)?.state).toBe("open");
    expect(h.workspace.pushes).toHaveLength(2);
    expect(h.workspace.deletions).toEqual([]);
    // Each authorized PR resolves only its own verification reference.
    expect(h.probes).toEqual([["g:b"], ["g:c"]]);
  });

  it("keeps two split held Gradle PRs apart on a moved base when their references only resolve together", async () => {
    const h = heldGradle();
    await seedSplitGradlePrs(h);
    const before = [...h.github.prs.values()];
    expect(await secureIt(h.deps).review({ ...h.context, workingCopy: { ...h.context.workingCopy, headSha: "f".repeat(40) } })).toMatchObject({ reviewed: [
      { number: 7, outcome: "error", detail: expect.stringContaining("conflict between g:b:1.0.0 and g:b:1.0.1") },
      { number: 8, outcome: "error", detail: expect.stringContaining("conflict between g:b:1.0.0 and g:b:1.0.1") },
    ] });
    expect([...h.github.prs.values()]).toEqual(before);
    expect(h.agentCalls).toEqual([]);
    expect(h.workspace.publications).toEqual([]);
    expect(h.probes).toEqual([["g:a"], ["g:b"]]);
  });

  it("doesn't execute a PR's work once its grant is withdrawn, while reviewing another PR taken early", async () => {
    const h = heldGradle({ independent: true });
    await seedSplitGradlePrs(h);
    // #8's label (on its issue, #2) is removed: its work no longer runs early, whichever PR review looks at.
    await (h.context.issues as FakeIssues).removeLabel({ repo: REPO, number: 2, label: "take-early" });
    expect(await secureIt(h.deps).review({ ...h.context, workingCopy: { ...h.context.workingCopy, headSha: "f".repeat(40) } })).toMatchObject({ reviewed: [
      { number: 7, outcome: "rebased" },
      { number: 8, outcome: "left-alone" },
    ] });
    // Only #7's final verification; never g:b's.
    expect(h.probes.every((names) => !names.includes("g:b"))).toBe(true);
  });


  const YOUNG_PAD = () => leftPad({ to: { version: "1.0.1", line: "1", aged: false, major: false, blockers: [] } });

  it("keeps whole-plan feedback in one early attempt and refuses to execute a reduced decision", async () => {
    const induced = { ...vite(), induced: [{ name: "g:young", version: "2.0.0" }] };
    const h = harness({ fixes: [induced, leftPad()] });
    const refusal = "compare: new: left-pad@1.0.1: GHSA-new has no exception";
    const tool = secureIt({ ...h.deps, verify: async () => [refusal] });
    await grantWaiting(tool, h);
    const issues = h.context.issues as FakeIssues;
    const decision = [...issues.issues.values()].find((issue) => recordOf(issue.body)?.subject.kind === "decision")!;
    expect(await tool.run(h.context)).toMatchObject({ outcome: "deferred", reason: "a decision taken early is retried whole or not at all" });
    expect(h.agentCalls.map((call) => (call.input["moves"] as Array<{ name: string }>).map((move) => move.name).sort())).toEqual([["left-pad", "vite"], ["left-pad", "vite"]]);
    expect(h.agentCalls.map((call) => call.input["rejected"])).toEqual([undefined, [refusal]]);
    expect(h.github.prs.size).toBe(0);
    expect(recordOf(issues.issues.get(decision.number)!.body)!.attempts).toMatchObject([{ outcome: "deferred" }]);
    expect([...issues.issues.values()].filter((issue) => recordOf(issue.body)?.subject.kind === "decision")).toHaveLength(1);
  });

  it("opens one held PR per young fix that can be separated, so none waits for another", async () => {
    const h = harness({ fixes: [YOUNG_VITE(), YOUNG_PAD()] });
    const tool = secureIt({ ...h.deps, verify: holdingVerify });
    await grantWaiting(tool, h);
    expect(h.github.prs.size).toBe(0);
    const result = await tool.run(h.context);
    expect(result).toMatchObject({ outcome: "completed", units: [
      { topic: "security-young-npm|left-pad", packages: ["npm|left-pad"], outcome: "published" },
      { topic: "security-young-npm|vite", packages: ["npm|vite"], outcome: "published" },
    ] });
    const prs = [...h.github.prs.values()];
    expect(new Set(prs.map((pr) => pr.headRef)).size).toBe(2);
    expect(prs.map((pr) => trackedRecord(h, pr.number).subject)).toMatchObject([
      { moves: [{ name: "left-pad" }] }, { moves: [{ name: "vite" }] },
    ]);
    for (const pr of prs) expect(trackedRecord(h, pr.number).attempts).toMatchObject([{ branch: pr.headRef, pr: pr.number }]);
  });

  /** Planning a held unit that holds one of vite and left-pad without the other fails: each keeps the other's old requirement. */
  const apartFails: SecureItDeps["requiredNpm"] = async (_base, plan) => {
    const separate = plan.topic !== "security";
    if (separate && plan.packages.includes("npm|vite") !== plan.packages.includes("npm|left-pad")) throw new Error(`${plan.topic} keeps the other root's requirement`);
    return plan;
  };

  it("fails each young fix that can't be planned apart on its own, rather than joining them", async () => {
    const h = harness({ fixes: [YOUNG_VITE(), YOUNG_PAD()] });
    const result = await secureIt({ ...h.deps, requiredNpm: apartFails, verify: holdingVerify }).run(h.context);
    expect(result).toMatchObject({ units: [
      { topic: "security-young-npm|left-pad", outcome: "failed", detail: "security-young-npm|left-pad keeps the other root's requirement" },
      { topic: "security-young-npm|vite", outcome: "failed", detail: "security-young-npm|vite keeps the other root's requirement" },
    ] });
    expect(h.github.prs.size).toBe(0);
  });

  it.each([false, true])("fails two young roots that each require one exact companion, each alone, as planning proves it (aged companion: %s)", async (aged) => {
    // securityBatch: vite and bundler 8.3.3 each require postcss 8.5.29 exactly, and 8.3.2 requires 8.5.28 exactly, so
    // requiredNpmPlan can plan neither while the other stays at 8.3.2; they wait until both age into the aged batch.
    const batch = securityBatch();
    const registry = environment({ ...batch, docs: aged ? { ...batch.docs, postcss: { ...postcss, time: { ...postcss.time, "8.5.29": OLD } } } : batch.docs });
    const young = (name: string) => vite({ name, from: "8.3.2", locations: [`node_modules/${name}`], to: { version: "8.3.3", line: "8", aged: false, major: false, blockers: [] } });
    const h = harness({ fixes: [young("vite"), young("bundler")], files: batch.base });
    const requiredNpm: SecureItDeps["requiredNpm"] = (base, plan) => requiredNpmPlan(base, plan, registry.env);
    const result = await secureIt({ ...h.deps, requiredNpm, verify: holdingVerify }).run(h.context);
    expect(result).toMatchObject({ units: [{ topic: "security-young-npm|bundler", outcome: "failed" }, { topic: "security-young-npm|vite", outcome: "failed" }] });
    expect(h.github.prs.size).toBe(0);
  });

  it("fails a young fix and the aged fix its young requirement held, each alone, when they can't be planned apart", async () => {
    // left-pad is aged, but its young requirement c holds it; then it can't be planned without vite, nor vite without it.
    const h = harness({ fixes: [YOUNG_VITE(), leftPad()] });
    const young = { exempt: true, name: "c", version: "1.0.1", root: { name: "left-pad", version: "1.0.1", path: "node_modules/left-pad" } };
    const requiredNpm: SecureItDeps["requiredNpm"] = async (base, plan, env) => {
      const planned = await apartFails(base, plan, env);
      return plan.packages.includes("npm|left-pad") ? { ...planned, requiredNpm: [young] as never } : planned;
    };
    const result = await secureIt({ ...h.deps, requiredNpm, verify: holdingVerify }).run(h.context);
    expect(result).toMatchObject({ units: [{ topic: "security-young-npm|left-pad", outcome: "failed" }, { topic: "security-young-npm|vite", outcome: "failed" }] });
    expect(h.github.prs.size).toBe(0);
  });

  it("fails only the held fix that can't be planned apart; the others open on their own", async () => {
    // vite needs left-pad's fix; v0.8's fallback, v0.7's single held batch, used to gather all three.
    const other = leftPad({ name: "other", locations: ["node_modules/other"], to: { version: "1.0.1", line: "1", aged: false, major: false, blockers: [] } });
    const h = harness({ fixes: [YOUNG_VITE(), YOUNG_PAD(), other] });
    const requiredNpm: SecureItDeps["requiredNpm"] = async (_base, plan) => {
      if (plan.packages.includes("npm|vite") && !plan.packages.includes("npm|left-pad")) throw new Error("vite needs left-pad's fix");
      return plan;
    };
    const tool = secureIt({ ...h.deps, requiredNpm, verify: holdingVerify });
    await grantWaiting(tool, h);
    expect(await tool.run(h.context)).toMatchObject({ units: [
      { topic: "security-young-npm|left-pad", packages: ["npm|left-pad"], outcome: "published" },
      { topic: "security-young-npm|other", packages: ["npm|other"], outcome: "published" },
      { topic: "security-young-npm|vite", outcome: "failed", detail: "vite needs left-pad's fix" },
    ] });
  });

  it("keeps the other young decisions and PRs when a transient planning failure leaves one unassessed", async () => {
    const other = leftPad({ name: "other", locations: ["node_modules/other"], to: { version: "1.0.1", line: "1", aged: false, major: false, blockers: [] } });
    const h = harness({ fixes: [YOUNG_VITE(), YOUNG_PAD(), other], observations: [VITE_FINDING, { ...VITE_FINDING, name: "left-pad", versions: ["1.0.0"] }, { ...VITE_FINDING, name: "other", versions: ["1.0.0"] }] });
    const tool = secureIt({ ...h.deps, verify: holdingVerify });
    await grantWaiting(tool, h);
    await tool.run(h.context);
    const prs = [...h.github.prs.values()];
    const others = prs.filter((pr) => !planOf(pr.body)!.packages.includes("npm|left-pad"));
    let failures = 1;
    const requiredNpm: SecureItDeps["requiredNpm"] = async (_base, plan) => {
      if (plan.packages.includes("npm|left-pad") && failures-- > 0) throw new Error("registry 502");
      return plan;
    };
    const result = await secureIt({ ...h.deps, requiredNpm, verify: holdingVerify }).run(h.context);
    expect(result).toMatchObject({ units: [
      { topic: "security-young-npm|left-pad", outcome: "already-open" },
      { topic: "security-young-npm|other", outcome: "already-open" },
      { topic: "security-young-npm|vite", outcome: "already-open" },
    ] });
    for (const pr of others) expect(h.github.prs.get(pr.number)).toEqual(pr);
    expect(h.github.prs.size).toBe(3);
    const issues = h.context.issues as FakeIssues;
    const unassessed = [...issues.issues.values()].find((issue) => {
      const subject = recordOf(issue.body)!.subject;
      return subject.kind === "package" && subject.name === "left-pad";
    });
    expect(unassessed?.body).toContain("no fix was planned for it this run");
    for (const pr of prs) expect(issues.issues.get(trackedIssueOf(pr.body)!)!.state).toBe("open");
    expect(prs.map((pr) => h.github.prs.get(pr.number)!.state)).toEqual(["open", "open", "open"]);
  });

  it("keeps a held PR on a failed aged plan rather than retiring it against a grouping without it", async () => {
    const pr = ownPr({ headRef: "secure-it/2026-10-05-security-young-npm-vite",
      body: withMarker(RULES, withPlanSection("Fixes vite.", { ...await heldPlan(YOUNG_VITE()), cooldown: [{ ...HELD, signals: [] }] }), { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }) });
    const h = harness({ prs: [pr], baseSha: "f".repeat(40), fixes: [YOUNG_VITE(), leftPad()] });
    h.workspace.setRemoteHead(pr.headRef, HEAD_SHA);
    const tracked = await early(h, pr);
    const requiredNpm: SecureItDeps["requiredNpm"] = async (_base, plan) => {
      if (plan.topic === "security") throw new Error("registry 502");
      return plan;
    };
    expect(await secureIt({ ...h.deps, requiredNpm, verify: holdingVerify }).review(h.context)).toMatchObject({ reviewed: [
      { number: 7, outcome: "error", detail: expect.stringContaining("registry 502") },
    ] });
    expect(h.github.prs.get(7)).toEqual(tracked);
  });

  it("keeps a held PR whose fix has aged since when the aged plan fails, rather than retiring it", async () => {
    // No held unit remains, but had the aged plan succeeded, a young requirement could have held vite again.
    const pr = ownPr({ headRef: "secure-it/2026-10-05-security-young-npm-vite",
      body: withMarker(RULES, withPlanSection("Fixes vite.", { ...await heldPlan(YOUNG_VITE()), cooldown: [{ ...HELD, signals: [] }] }), { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }) });
    const h = harness({ prs: [pr], baseSha: "f".repeat(40), fixes: [vite(), leftPad()] });
    h.workspace.setRemoteHead(pr.headRef, HEAD_SHA);
    const tracked = await early(h, pr);
    const requiredNpm: SecureItDeps["requiredNpm"] = async (_base, plan) => {
      if (plan.topic === "security") throw new Error("registry 502");
      return plan;
    };
    expect(await secureIt({ ...h.deps, requiredNpm, verify: holdingVerify }).review(h.context)).toMatchObject({ reviewed: [
      { number: 7, outcome: "error", detail: expect.stringContaining("registry 502") },
    ] });
    expect(h.github.prs.get(7)).toEqual(tracked);
    expect(h.workspace.deletions).toEqual([]);
  });

  /** A held Gradle unit, a young npm one and an aged npm batch whose plan fails, on a base with an npm lockfile. */
  async function heldGradleBesideFailedAgedNpm(options: { seeded?: boolean } = {}) {
    const h = heldGradle({ single: true, independent: true });
    if (options.seeded) await seedSplitGradlePrs(h);
    const found = await h.deps.candidates(tree(BASE_SHA), await h.deps.gate(h.context), {});
    const withLockfile = (base: Tree): Tree => ({ ...base,
      read: async (path) => path === "package-lock.json" ? LOCK : base.read(path),
      list: async (dir) => [...await base.list(dir), "package-lock.json"],
    });
    const trees: SecureItDeps["trees"] = {
      commit: async (wc, sha) => withLockfile(await h.deps.trees.commit(wc, sha)),
      working: (wc) => withLockfile(h.deps.trees.working(wc)),
    };
    const requiredNpm: SecureItDeps["requiredNpm"] = async (base, plan, env) => {
      if (plan.topic === "security") throw new Error("registry 502");
      return h.deps.requiredNpm(base, plan, env);
    };
    const tool = secureIt({ ...h.deps, trees, requiredNpm, candidates: async () => ({ ...found, fixes: [...h.fixes, YOUNG_VITE(), leftPad()] }) });
    return { h, tool };
  }

  it("keeps a held unit without npm work running, and its PR reviewed, when the aged npm plan fails", async () => {
    const { h, tool } = await heldGradleBesideFailedAgedNpm();
    await grantWaiting(tool, h, ["g:a"]);
    expect(await tool.run(h.context)).toMatchObject({ units: [
      { topic: "security", outcome: "failed", detail: "registry 502" },
      { topic: "security-young-Maven|g:a", outcome: "published" },
      { topic: "security-young-npm|vite", outcome: "failed", detail: expect.stringContaining("the aged unit's plan") },
    ] });
    expect([...h.github.prs.values()].map((pr) => planOf(pr.body)?.packages)).toEqual([["Maven|g:a"]]);
    const seeded = await heldGradleBesideFailedAgedNpm({ seeded: true });
    expect(await seeded.tool.review({ ...seeded.h.context, workingCopy: { ...seeded.h.context.workingCopy, headSha: "f".repeat(40) } })).toMatchObject({ reviewed: [
      { number: 7, outcome: "rebased" },
    ] });
    expect(planOf(seeded.h.github.prs.get(7)!.body)?.packages).toEqual(["Maven|g:a"]);
  });

  it("keeps held units running when an aged unit without npm work can't be planned", async () => {
    const h = heldGradle({ independent: true, extra: true });
    const found = await h.deps.candidates(tree(BASE_SHA), await h.deps.gate(h.context), {});
    const fixes = h.fixes.map((fix) => fix.name === "g:c" ? { ...fix, to: { ...fix.to!, aged: true } } : fix);
    const requiredNpm: SecureItDeps["requiredNpm"] = async (base, plan, env) => {
      if (plan.topic === "security") throw new Error("actions lookup failed");
      return h.deps.requiredNpm(base, plan, env);
    };
    const tool = secureIt({ ...h.deps, requiredNpm, candidates: async () => ({ ...found, fixes }) });
    await grantWaiting(tool, h);
    expect(await tool.run(h.context)).toMatchObject({ units: [
      { topic: "security", outcome: "failed", detail: "actions lookup failed" },
      { topic: "security-young-Maven|g:a", outcome: "published" },
      { topic: "security-young-Maven|g:b", outcome: "published" },
    ] });
  });

  it("keeps a held fix that can't be planned apart from one that can, so the other still opens", async () => {
    const h = harness({ fixes: [YOUNG_VITE(), YOUNG_PAD()] });
    const requiredNpm: SecureItDeps["requiredNpm"] = async (_base, plan) => {
      if (plan.packages.includes("npm|vite")) throw new Error("vite's requirement can't be met");
      return plan;
    };
    const tool = secureIt({ ...h.deps, requiredNpm, verify: holdingVerify });
    await grantWaiting(tool, h);
    expect(await tool.run(h.context)).toMatchObject({ outcome: "completed", units: [
      { topic: "security-young-npm|left-pad", packages: ["npm|left-pad"], outcome: "published" },
      { topic: "security-young-npm|vite", outcome: "failed", detail: "vite's requirement can't be met" },
    ] });
  });

  it("keeps a held PR whose fix can't be planned apart any more, reporting its planning error", async () => {
    const pr = ownPr({ headRef: "secure-it/2026-10-05-security-young-npm-vite",
      body: withMarker(RULES, withPlanSection("Fixes vite.", { ...await heldPlan(YOUNG_VITE()), cooldown: [{ ...HELD, signals: [] }] }), { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }) });
    const h = harness({ prs: [pr], baseSha: "f".repeat(40), fixes: [YOUNG_VITE(), YOUNG_PAD()] });
    h.workspace.setRemoteHead(pr.headRef, HEAD_SHA);
    const tracked = await early(h, pr);
    expect(await secureIt({ ...h.deps, requiredNpm: apartFails, verify: holdingVerify }).review(h.context)).toMatchObject({ reviewed: [
      { number: 7, outcome: "error", detail: "security-young-npm|vite keeps the other root's requirement" },
    ] });
    expect(h.github.prs.get(7)).toEqual(tracked);
  });

  it("keeps an early PR when a package's publisher identity becomes undecided", async () => {
    const problem = "left-pad@1.0.0's publisher identity can't be decided: attestation lookup failed with HTTP 503";
    // The old grant covers both moves; the remaining vite decision needs its own authorization.
    const plan = await planFor([YOUNG_PAD(), YOUNG_VITE()], { named: undefined, lockfiles: new Map([["package-lock.json", JSON.parse(LOCK)]]), gradle: undefined, tagCommit: async () => undefined },
      { kind: "routine", topic: "security-young-npm|left-pad" });
    const pr = ownPr({ headRef: "secure-it/2026-10-05-security-young-npm-left-pad", body: withMarker(RULES, withPlanSection("Fixes both.", plan), { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }) });
    const h = harness({ prs: [pr], fixes: [YOUNG_VITE(), { ...YOUNG_PAD(), to: undefined, problem, undecided: true }] });
    h.workspace.setRemoteHead(pr.headRef, HEAD_SHA);
    const tracked = await early(h, pr, [{ ecosystem: "npm", name: "vite", version: "8.3.3", eligibleAt: HELD.eligibleAt }]);
    expect(await secureIt({ ...h.deps, verify: holdingVerify }).run(h.context)).toMatchObject({
      topic: "security-young-npm|vite", outcome: "deferred", errors: [problem],
    });
    expect(h.github.prs.get(7)).toEqual(tracked);
    expect([h.workspace.preparations, h.workspace.publications, h.workspace.deletions, h.agentCalls]).toEqual([[], [], [], []]);
  });


  it("reuses only the exact early decision when another young root shares its companion, even after its anchor changes", async () => {
    const plan = await planFor([YOUNG_VITE(), YOUNG_PAD()], { named: undefined, lockfiles: new Map([["package-lock.json", JSON.parse(LOCK)]]), gradle: undefined, tagCommit: async () => undefined },
      { kind: "routine", topic: "security-young-npm|left-pad" });
    const pr = ownPr({ body: withMarker(RULES, withPlanSection("Fixes vite with its companion.", plan), { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }) });
    const h = harness({ prs: [pr], fixes: [YOUNG_VITE(), YOUNG_PAD()] });
    const tracked = await early(h, pr, [{ ecosystem: "npm", name: "vite", version: "8.3.3", eligibleAt: HELD.eligibleAt }]);
    // Required planning adds left-pad as vite's companion; it is also an independently actionable young root.
    const requiredNpm: SecureItDeps["requiredNpm"] = async (_base, current) => current.packages.includes("npm|vite")
      ? { ...plan, topic: current.topic } : current;
    expect(await secureIt({ ...h.deps, requiredNpm }).run(h.context)).toMatchObject({ units: [
      { topic: "security-young-npm|left-pad", outcome: "deferred" },
      { topic: "security-young-npm|vite", outcome: "already-open", pullRequest: pr.url },
    ] });
    expect(h.github.prs.get(7)).toEqual(tracked);
    const records = [...(h.context.issues as FakeIssues).issues.values()].map((issue) => recordOf(issue.body)!);
    const other = records.find((record) => record.subject.kind === "decision" && record.subject.moves.length === 1)!;
    expect(other.attempts).toEqual([]);
    expect(h.workspace.preparations).toEqual([]);
    expect(h.agentCalls).toEqual([]);
  });

  it("leaves a changed early decision on review, and its grant cannot transfer to either split root on a run", async () => {
    const plan = await planFor([YOUNG_VITE(), YOUNG_PAD()], { named: undefined, lockfiles: new Map([["package-lock.json", JSON.parse(LOCK)]]), gradle: undefined, tagCommit: async () => undefined },
      { kind: "routine", topic: "security-young-npm|left-pad" });
    const pr = ownPr({ body: withMarker(RULES, withPlanSection("Fixes both.", plan), { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }) });
    const h = harness({ prs: [pr], fixes: [YOUNG_VITE(), YOUNG_PAD()] });
    const tracked = await early(h, pr, [{ ecosystem: "npm", name: "vite", version: "8.3.3", eligibleAt: HELD.eligibleAt }]);
    const tool = secureIt(h.deps);
    expect(await tool.review({ ...h.context, workingCopy: { ...h.context.workingCopy, headSha: "f".repeat(40) } })).toMatchObject({ reviewed: [
      { number: 7, outcome: "deferred" },
    ] });
    expect((h.context.issues as FakeIssues).comments.get(1)!.at(-1)!.body).toContain("different decision");
    expect(h.github.prs.get(7)).toEqual(tracked);
    expect(await tool.run(h.context)).toMatchObject({ units: [{ outcome: "deferred" }, { outcome: "deferred" }] });
    expect(h.github.prs.get(7)).toEqual(tracked);
    expect(h.workspace.publications).toEqual([]);
    expect(h.workspace.deletions).toEqual([]);
    expect(h.agentCalls).toEqual([]);
    const records = [...(h.context.issues as FakeIssues).issues.values()].map((issue) => recordOf(issue.body)!);
    expect(records.flatMap((record) => record.attempts)).toHaveLength(1);
    for (const issue of (h.context.issues as FakeIssues).issues.values()) expect(issue.body).not.toContain("**In progress:** #7");
    await grantWaiting(tool, h);
    expect(await tool.run(h.context)).toMatchObject({ units: [{ outcome: "published" }, { outcome: "published" }] });
    expect(h.github.prs.size).toBe(3);
    expect(h.github.prs.get(7)).toEqual(tracked);
    expect([42, 43].map((number) => trackedRecord(h, number).subject)).toMatchObject([
      { moves: [{ name: "left-pad" }] }, { moves: [{ name: "vite" }] },
    ]);
  });

  it("matches an early PR only when its issue records that PR as the running attempt", async () => {
    const plan = await heldPlan(YOUNG_VITE());
    const first = ownPr({ body: withMarker(RULES, withPlanSection("Fixes vite.", plan), { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }) });
    const second = { ...first, number: 8, nodeId: "node8", headRef: "secure-it/2026-10-05-take-early-1001", url: "https://github.com/leanish/widget/pull/8" };
    const h = harness({ prs: [first, second], fixes: [YOUNG_VITE()] });
    await early(h, second, [{ ecosystem: "npm", name: "vite", version: "8.3.3", eligibleAt: HELD.eligibleAt }]);
    // Both bodies name the same decision and issue, but only #8 is the recorded attempt's PR.
    const other = { ...first, body: `Tracks #1, taken early.\n\n${first.body}` };
    h.github.prs.set(7, other);
    expect(await secureIt(h.deps).run(h.context)).toMatchObject({ outcome: "already-open", pullRequest: second.url });
    expect(h.github.prs.get(7)).toEqual(other);
    expect(h.workspace.preparations).toEqual([]);
    expect(h.agentCalls).toEqual([]);
    expect(recordOf((h.context.issues as FakeIssues).issues.get(1)!.body)!.attempts).toMatchObject([{ pr: 8 }]);
  });

  it("does not transfer an early grant through a matching sanitized topic", async () => {
    const first = { ...YOUNG_VITE(), name: "@lib/a", locations: ["node_modules/@lib/a"] };
    const second = { ...first, name: "lib-a", locations: ["node_modules/lib-a"] };
    const plan = await heldPlan(first);
    const topic = `security-young-npm|${second.name}`;
    expect(branchFor(RULES, NOW, plan.topic)).toBe(branchFor(RULES, NOW, topic));
    const pr = ownPr({ body: withMarker(RULES, withPlanSection("Fixes vite.", plan), { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }) });
    const h = harness({ prs: [pr], fixes: [second] });
    const tracked = await early(h, pr, [{ ecosystem: "npm", name: first.name, version: "8.3.3", eligibleAt: HELD.eligibleAt }]);
    const tool = secureIt(h.deps);
    expect(await tool.run(h.context)).toMatchObject({ outcome: "deferred", topic });
    expect(h.github.prs.get(7)).toEqual(tracked);
    expect(h.workspace.preparations).toEqual([]);
    expect(h.agentCalls).toEqual([]);
    await grantWaiting(tool, h, [second.name]);
    expect(await tool.run(h.context)).toMatchObject({ outcome: "published", topic });
    expect(h.github.prs.get(7)).toEqual(tracked);
    expect(h.github.prs.size).toBe(2);
    expect(trackedRecord(h).subject).toMatchObject({ moves: [{ name: second.name }] });
  });

  it("retires an early PR on a moved base only when its fixes are gone, ending its attempt and returning its label", async () => {
    const plan = await heldPlan(YOUNG_VITE());
    const pr = ownPr({ body: withMarker(RULES, withPlanSection("Fixes vite.", plan), { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }) });
    const h = harness({ prs: [pr], fixes: [] });
    await early(h, pr, [{ ecosystem: "npm", name: "vite", version: "8.3.3", eligibleAt: HELD.eligibleAt }]);
    expect(await secureIt(h.deps).review({ ...h.context, workingCopy: { ...h.context.workingCopy, headSha: "f".repeat(40) } })).toMatchObject({ reviewed: [{ number: 7, outcome: "retired" }] });
    expect(h.github.prs.get(7)?.state).toBe("closed");
    expect(recordOf((h.context.issues as FakeIssues).issues.get(1)!.body)!.attempts).toMatchObject([{ outcome: "pr-closed" }]);
    expect((h.context.issues as FakeIssues).issues.get(1)!.labels).not.toContain("take-early");
    expect(h.agentCalls).toEqual([]);
    expect(h.workspace.publications).toEqual([]);
  });

  it("keeps a human-pushed early PR without starting another attempt under a new label", async () => {
    const plan = await planFor([YOUNG_VITE()], { named: undefined, lockfiles: new Map([["package-lock.json", JSON.parse(LOCK)]]), gradle: undefined, tagCommit: async () => undefined },
      { kind: "routine", topic: "security-young-npm|vite" });
    const pushed = ownPr({ headRef: "secure-it/2026-10-05-take-early-1001", headSha: "9".repeat(40), body: withMarker(RULES, withPlanSection("Fixes vite.", plan), { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }) });
    const h = harness({ prs: [pushed], fixes: [YOUNG_VITE()] });
    const protectedPr = await early(h, pushed, [{ ecosystem: "npm", name: "vite", version: "8.3.3", eligibleAt: HELD.eligibleAt }]);
    await (h.context.issues as FakeIssues).removeLabel({ repo: REPO, number: 1, label: "take-early" });
    const tool = secureIt({ ...h.deps, verify: holdingVerify });
    expect(await tool.run(h.context)).toMatchObject({ outcome: "deferred" });
    const issues = h.context.issues as FakeIssues;
    issues.comment(1, "owner", "take-early: a fresh attempt without changing the person's PR");
    issues.label(1, "owner", "take-early");
    expect(await tool.run(h.context)).toMatchObject({ outcome: "deferred", reason: expect.stringContaining("an early attempt is still running under an earlier label") });
    expect(h.github.prs.size).toBe(1);
    expect(h.github.prs.get(7)).toEqual(protectedPr);
    expect(h.workspace.publications).toEqual([]);
    expect(h.agentCalls).toEqual([]);
    expect(recordOf(issues.issues.get(1)!.body)!.attempts).toHaveLength(1);
  });

  const heldPlan = (fix: SecurityFix) => planFor([fix], { named: undefined, lockfiles: new Map([["package-lock.json", JSON.parse(LOCK)]]), gradle: undefined, tagCommit: async () => undefined },
    { kind: "routine", topic: `security-young-${fix.ecosystem}|${fix.name}` });

  it.each([false, true])("defers to the owner of an early PR marked ready with its label still on (changed metadata: %s)", async (changed) => {
    const plan = await heldPlan(YOUNG_VITE());
    const recorded = changed ? { ...plan, notes: ["an outdated reason"],
      moves: plan.moves.map((move) => ({ ...move, advisories: ["GHSA-old"] })) } : plan;
    expect(decisionMoves(recorded)).toEqual(decisionMoves(plan));
    const pr = ownPr({ headRef: "secure-it/2026-10-05-take-early-1001",
      body: withMarker(RULES, withPlanSection("Fixes vite.", recorded), { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }) });
    const h = harness({ prs: [pr], fixes: [YOUNG_VITE()] });
    const taken = { ...await early(h, pr, [{ ecosystem: "npm", name: "vite", version: "8.3.3", eligibleAt: HELD.eligibleAt }]), isDraft: false };
    h.github.prs.set(7, taken);
    const issues = h.context.issues as FakeIssues;
    const attempts = recordOf(issues.issues.get(1)!.body)!.attempts;
    const tool = secureIt({ ...h.deps, verify: holdingVerify });
    for (let run = 0; run < 2; run++) {
      expect(await tool.run(h.context)).toMatchObject({ outcome: "deferred", reason: "a person marked the early PR ready" });
      expect(h.github.prs.size).toBe(1);
      expect(h.github.prs.get(7)).toEqual(taken);
      expect(recordOf(issues.issues.get(1)!.body)!.attempts).toEqual(attempts);
      expect(recordOf(issues.issues.get(1)!.body)!.attempts).toMatchObject([{ pr: 7 }]);
      expect(recordOf(issues.issues.get(1)!.body)!.attempts[0]!.outcome).toBeUndefined();
      expect(issues.issues.get(1)!.labels).toContain("take-early");
      expect([h.workspace.preparations, h.workspace.publications, h.agentCalls, h.written, h.reverted]).toEqual([[], [], [], [], []]);
    }
  });

  it("keeps an early PR a person marked ready without starting another attempt", async () => {
    const plan = await heldPlan(YOUNG_VITE());
    const taken = ownPr({ headRef: "secure-it/2026-10-05-take-early-1001", isDraft: false,
      body: withMarker(RULES, withPlanSection("Fixes vite.", { ...plan, cooldown: [{ ...HELD, signals: [] }] }), { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }) });
    const h = harness({ prs: [taken], fixes: [YOUNG_VITE()] });
    const protectedPr = await early(h, taken, [{ ecosystem: "npm", name: "vite", version: "8.3.3", eligibleAt: HELD.eligibleAt }]);
    await (h.context.issues as FakeIssues).removeLabel({ repo: REPO, number: 1, label: "take-early" });
    const tool = secureIt({ ...h.deps, verify: holdingVerify });
    expect(await tool.run(h.context)).toMatchObject({ outcome: "deferred" });
    const issues = h.context.issues as FakeIssues;
    issues.comment(1, "owner", "take-early: a fresh attempt without changing the person's PR");
    issues.label(1, "owner", "take-early");
    expect(await tool.run(h.context)).toMatchObject({ outcome: "deferred", reason: "a person marked the early PR ready" });
    expect(h.github.prs.get(7)!.body).toBe(protectedPr.body);
    expect(h.workspace.publications).toEqual([]);
    expect(h.agentCalls).toEqual([]);
    expect(recordOf(issues.issues.get(1)!.body)!.attempts).toHaveLength(1);
  });

  it("reuses the tracked plan the journal published when the body lags behind the head", async () => {
    // #7's body still records left-pad's plan at an older head; the journal holds vite's plan at its current head.
    const stale = await heldPlan(YOUNG_PAD());
    const current = withMarker(RULES, withPlanSection("Fixes vite.", await heldPlan(YOUNG_VITE())), { head: PUSHED_SHA, base: BASE_SHA, adaptations: 0 });
    const pr = ownPr({ headRef: "secure-it/2026-10-05-security-young-npm-vite", headSha: PUSHED_SHA, body: withMarker(RULES, withPlanSection("Fixes left-pad.", stale), { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }) });
    const h = harness({ prs: [pr], fixes: [YOUNG_VITE(), YOUNG_PAD()] });
    const tracked = await early(h, { ...pr, body: current }, [{ ecosystem: "npm", name: "vite", version: "8.3.3", eligibleAt: HELD.eligibleAt }]);
    h.github.prs.set(7, pr);
    await h.journal.pushed(REPO, 7, { head: PUSHED_SHA, base: BASE_SHA, publication: { title: "moving vite", body: tracked.body, adaptations: 0 } });
    const tool = secureIt({ ...h.deps, verify: holdingVerify });
    await grantWaiting(tool, h, ["left-pad"]);
    expect(await tool.run(h.context)).toMatchObject({ units: [
      { topic: "security-young-npm|left-pad", outcome: "published" },
      { topic: "security-young-npm|vite", outcome: "already-open", pullRequest: "https://github.com/leanish/widget/pull/7" },
    ] });
    expect(h.github.prs.get(7)!.body).toContain("Tracks #1.");
    trackedRecord(h, 7);
  });

  it("restores a tracked PR whose state was removed from the journal publication, not its stale body", async () => {
    // #7's body lost its state and still lists left-pad; the journal saved vite's plan for its current head.
    const saved = withMarker(RULES, withPlanSection("Fixes vite.", await heldPlan(YOUNG_VITE())), { head: PUSHED_SHA, base: BASE_SHA, adaptations: 0 });
    const pr = ownPr({ headRef: "secure-it/2026-10-05-security-young-npm-vite", headSha: PUSHED_SHA, body: `${withPlanSection("Fixes left-pad.", await heldPlan(YOUNG_PAD()))}\n\n${RULES.marker}\n` });
    const h = harness({ prs: [pr], fixes: [YOUNG_VITE(), YOUNG_PAD()] });
    h.workspace.setRemoteHead(pr.headRef, PUSHED_SHA);
    const tracked = await early(h, { ...pr, body: saved }, [{ ecosystem: "npm", name: "vite", version: "8.3.3", eligibleAt: HELD.eligibleAt }]);
    h.github.prs.set(7, pr);
    await h.journal.pushed(REPO, 7, { head: PUSHED_SHA, base: BASE_SHA, publication: { title: "moving vite", body: tracked.body, adaptations: 0 } });
    const tool = secureIt({ ...h.deps, verify: holdingVerify });
    await grantWaiting(tool, h, ["left-pad"]);
    expect(await tool.run(h.context)).toMatchObject({ units: [
      { topic: "security-young-npm|left-pad", outcome: "published" },
      { topic: "security-young-npm|vite", outcome: "already-open", pullRequest: "https://github.com/leanish/widget/pull/7" },
    ] });
    expect(planOf(h.github.prs.get(7)!.body)).toMatchObject({ topic: "security-young-npm|vite", packages: ["npm|vite"] });
    trackedRecord(h, 7);
  });

  it("doesn't reuse an early PR whose state was removed once a person marked it ready", async () => {
    const plan = await heldPlan(YOUNG_VITE());
    const saved = withMarker(RULES, withPlanSection("Fixes vite.", { ...plan, cooldown: [{ ...HELD, signals: [] }] }), { head: PUSHED_SHA, base: BASE_SHA, adaptations: 0 });
    // Its body, without the state, no longer shows the hold.
    const taken = ownPr({ headRef: "secure-it/2026-10-05-take-early-1001", headSha: PUSHED_SHA, isDraft: false, body: `${withPlanSection("Fixes vite.", plan)}\n\n${RULES.marker}\n` });
    const h = harness({ prs: [taken], fixes: [YOUNG_VITE()] });
    h.workspace.setRemoteHead(taken.headRef, PUSHED_SHA);
    const tracked = await early(h, { ...taken, body: saved }, [{ ecosystem: "npm", name: "vite", version: "8.3.3", eligibleAt: HELD.eligibleAt }]);
    h.github.prs.set(7, taken);
    await h.journal.pushed(REPO, 7, { head: PUSHED_SHA, base: BASE_SHA, publication: { title: "moving vite", body: tracked.body, adaptations: 0 } });
    await (h.context.issues as FakeIssues).removeLabel({ repo: REPO, number: 1, label: "take-early" });
    const tool = secureIt({ ...h.deps, verify: holdingVerify });
    expect(await tool.run(h.context)).toMatchObject({ outcome: "deferred" });
    const issues = h.context.issues as FakeIssues;
    issues.comment(1, "owner", "take-early: a fresh attempt without changing the person's PR");
    issues.label(1, "owner", "take-early");
    expect(await tool.run(h.context)).toMatchObject({ outcome: "deferred", reason: "a person marked the early PR ready" });
    expect(h.github.prs.get(7)).toEqual(taken);
    expect(h.workspace.publications).toEqual([]);
    expect(h.agentCalls).toEqual([]);
    expect(recordOf(issues.issues.get(1)!.body)!.attempts).toHaveLength(1);
  });

  it("refuses to reuse a PR whose state was removed when its saved publication doesn't match, never reading its raw body", async () => {
    // As above, but the saved state's base isn't the journal's: the raw body (no hold shown) must not stand in for it.
    const plan = await heldPlan(YOUNG_VITE());
    const saved = withMarker(RULES, withPlanSection("Fixes vite.", { ...plan, cooldown: [{ ...HELD, signals: [] }] }), { head: PUSHED_SHA, base: "8".repeat(40), adaptations: 0 });
    const taken = ownPr({ headRef: "secure-it/2026-10-05-security-young-npm-vite", headSha: PUSHED_SHA, isDraft: false, body: `${withPlanSection("Fixes vite.", plan)}\n\n${RULES.marker}\n` });
    const h = harness({ prs: [taken], fixes: [YOUNG_VITE()] });
    h.workspace.setRemoteHead(taken.headRef, PUSHED_SHA);
    await h.journal.pushed(REPO, 7, { head: PUSHED_SHA, base: BASE_SHA, publication: { title: "moving vite", body: saved, adaptations: 0 } });
    expect(await secureIt({ ...h.deps, verify: holdingVerify }).run(h.context)).toMatchObject({
      topic: "security-young-npm|vite", outcome: "failed", detail: expect.stringContaining("the journal has no matching publication content"),
    });
    expect(h.github.prs.get(7)).toEqual(taken);
    expect(h.workspace.preparations).toEqual([]);
  });

  it("fails each unit, never the run, when an own PR's journal can't be read, publishing nothing on a guess", async () => {
    // #7's head moved past its recorded state, so its journal is read, and that read fails. Every unit inspects every
    // own PR before matching its plan, so even units #7 has nothing to do with fail visibly instead of guessing from
    // its stale body.
    const pr = ownPr({ headRef: "secure-it/2026-10-05-security", headSha: PUSHED_SHA, body: withMarker(RULES, "Fixes left-pad.", { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }) });
    const broken = (h: ReturnType<typeof harness>) => {
      h.journal.last = async () => { throw new Error("leanish__widget/7.json isn't a journal"); };
    };
    const both = harness({ prs: [pr], fixes: [leftPad({ name: "aged-pad" }), YOUNG_VITE()] });
    broken(both);
    expect(await secureIt({ ...both.deps, verify: holdingVerify }).run(both.context)).toMatchObject({ outcome: "completed", units: [
      { topic: "security", outcome: "failed", detail: "leanish__widget/7.json isn't a journal" },
      { topic: "security-young-npm|vite", outcome: "failed", detail: "leanish__widget/7.json isn't a journal" },
    ] });
    expect([both.agentCalls, both.workspace.preparations, both.github.prs.size]).toEqual([[], [], 1]);
    const aged = harness({ prs: [pr], fixes: [leftPad({ name: "aged-pad" })] });
    broken(aged);
    expect(await secureIt(aged.deps).run(aged.context)).toMatchObject({ topic: "security", outcome: "failed", detail: "leanish__widget/7.json isn't a journal", units: [{ topic: "security" }] });
    expect([aged.agentCalls, aged.workspace.preparations, aged.github.prs.size]).toEqual([[], [], 1]);
  });

  it("keeps a PR taken early a draft on green CI while its versions are young, and retires it once they aged, ending its attempt", async () => {
    const plan = await planFor([YOUNG_VITE()], { named: undefined, lockfiles: new Map([["package-lock.json", JSON.parse(LOCK)]]), gradle: undefined, tagCommit: async () => undefined },
      { kind: "routine", topic: "security-young-npm|vite" });
    const heldPr = (eligibleAt: string) => ownPr({
      headRef: "secure-it/2026-10-05-security-young-npm-vite",
      body: withMarker(RULES, withPlanSection("Fixes vite.", { ...plan, cooldown: [{ ...HELD, eligibleAt, signals: [] }] }), { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }),
    });
    const waiting = harness({ prs: [heldPr("2026-10-13T00:00:00.000Z")] });
    await early(waiting, heldPr("2026-10-13T00:00:00.000Z"));
    waiting.github.checks = GREEN;
    expect(await secureIt(waiting.deps).review(waiting.context)).toMatchObject({ reviewed: [{ number: 7, outcome: "held" }] });
    expect(waiting.github.prs.get(7)?.isDraft).toBe(true);
    const aged = harness({ prs: [heldPr("2026-10-07T05:00:00.000Z")] });
    await early(aged, heldPr("2026-10-07T05:00:00.000Z"));
    // The registry dates vite 8.3.3 past the wait too, so its grant has nothing young left.
    const registry = fakeFetch({ "https://registry.npmjs.org/vite": { body: { time: { "8.3.3": "2026-09-29T00:00:00.000Z" }, versions: { "8.3.3": {} } } } });
    const dated = { ...aged.deps, gate: async () => ({ ...await aged.deps.gate(aged.context), fetch: registry }) };
    const issues = aged.context.issues as FakeIssues;
    issues.forbidden.add("removeLabel");
    expect(await secureIt(dated).review({ ...aged.context, workingCopy: { ...aged.context.workingCopy, headSha: "f".repeat(40) } })).toMatchObject({ reviewed: [{ number: 7, outcome: "graduated" }] });
    expect(aged.github.prs.get(7)?.state).toBe("closed");
    expect(aged.agentCalls).toEqual([]);
    expect(aged.workspace.preparations).toEqual([]);
    expect(aged.github.calls.some((call) => call.startsWith("headChecks"))).toBe(false);
    expect(recordOf(issues.issues.get(1)!.body)!.attempts).toMatchObject([{ pr: 7, outcome: "pr-closed" }]);
    // Recovery retries the label cleanup after graduation recorded the attempt's end.
    const client = { issues, github: aged.github, repo: REPO, clean: (body: string) => body, ours: () => true };
    // The label's removal fails the first time: the attempt's end is recorded anyway, and the next recovery returns it.
    await recoverAttempts(client, await syncedIssues(aged));
    expect(recordOf(issues.issues.get(1)!.body)!.attempts).toMatchObject([{ pr: 7, outcome: "pr-closed" }]);
    expect(issues.issues.get(1)!.labels).toContain("take-early");
    issues.forbidden.delete("removeLabel");
    await recoverAttempts(client, await syncedIssues(aged));
    expect(issues.issues.get(1)!.labels).not.toContain("take-early");
    // Only the event that attempt consumed: a newer label is a new grant, and stays.
    issues.label(1, "owner", "take-early");
    await recoverAttempts(client, await syncedIssues(aged));
    expect(issues.issues.get(1)!.labels).toContain("take-early");
  });

  it("runs a PR taken early's unchanged decision on a new base only with the young versions its grant covered", async () => {
    const plan = await heldPlan(YOUNG_VITE());
    const pr = ownPr({ headRef: "secure-it/2026-10-05-security-young-npm-vite", body: withMarker(RULES, withPlanSection("Fixes vite.", { ...plan, cooldown: [{ ...HELD, signals: [] }] }), { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }) });
    const h = harness({ prs: [pr] });
    const tracked = await early(h, pr);
    const client = { issues: h.context.issues, github: h.github, repo: REPO, clean: (body: string) => body, ours: () => true, now: NOW, trusted: () => false, retire: async () => "closed" as const, eligibleAt: async () => "2026-10-13T00:00:00.000Z" };
    const previous = planOf(tracked.body)!;
    expect(await reviewExecution(client, tracked, previous, previous, ["vite@8.3.3"])).toEqual({ kind: "proceed" });
    // The same moves, but its parent probe now brings in a young version too: the label didn't cover it.
    expect(await reviewExecution(client, tracked, previous, previous, ["vite@8.3.3", "g:transitive@2.0.1"])).toEqual({
      kind: "leave", reason: "on the new base it takes young versions its `take-early` label didn't cover: g:transitive@2.0.1",
    });
  });

  it.each([true, false])("admits an early adaptation by its grant, regardless of its recorded cooldown (covered: %s)", async (covered) => {
    const plan = await heldPlan(YOUNG_VITE());
    const extra = { ...HELD, name: "esbuild", version: "0.30.1", replaced: ["0.30.0"] };
    const recorded = covered ? [] : [{ ...HELD, signals: [] }, { ...extra, signals: [] }];
    const pr = ownPr({ headRef: "secure-it/2026-10-05-security-young-npm-vite",
      body: withMarker(RULES, withPlanSection("Fixes vite.", { ...plan, cooldown: recorded }), { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }) });
    const h = harness({ prs: [pr] });
    await early(h, pr, [{ ecosystem: "npm", name: "vite", version: "8.3.3", eligibleAt: HELD.eligibleAt }]);
    h.workspace.setRemoteHead(pr.headRef, HEAD_SHA);
    h.github.checks = RED;
    const verify: SecureItDeps["verify"] = async (inputs) => {
      inputs.cooldown?.({ evaluated: true, releaseAgeDays: 7, held: [covered ? HELD : extra] });
      return [];
    };
    expect(await secureIt({ ...h.deps, verify }).review(h.context)).toMatchObject({ reviewed: [{ outcome: covered ? "adapted" : "adaptation-unchanged" }] });
    const issue = (h.context.issues as FakeIssues).issues.get(1)!;
    expect(recordOf(issue.body)!.attempts).toMatchObject([{ pr: 7 }]);
    expect(h.workspace.publications).toHaveLength(covered ? 1 : 0);
    if (covered) {
      expect(h.github.prs.get(7)!.body).toContain("Tracks #1");
      expect(planOf(h.github.prs.get(7)!.body)?.cooldown).toMatchObject([{ name: "vite" }]);
    } else {
      expect((h.context.issues as FakeIssues).comments.get(1)!.at(-1)!.body).toContain("esbuild@0.30.1");
    }
  });

  it("adapts an early PR on the grant its disposition saw, reading no issue after the agent; a label removed meanwhile leaves it next tick", async () => {
    const plan = await heldPlan(YOUNG_VITE());
    const pr = ownPr({ headRef: "secure-it/2026-10-05-security-young-npm-vite",
      body: withMarker(RULES, withPlanSection("Fixes vite.", { ...plan, cooldown: [] }), { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }) });
    const h = harness({ prs: [pr] });
    await early(h, pr, [{ ecosystem: "npm", name: "vite", version: "8.3.3", eligibleAt: HELD.eligibleAt }]);
    h.workspace.setRemoteHead(pr.headRef, HEAD_SHA);
    h.github.checks = RED;
    const issues = h.context.issues as FakeIssues;
    // The owner removes the label while the agent adapts: this tick's disposition already authorized the adaptation.
    let agentRan = false;
    let readsAfterAgent = 0;
    const getIssue = issues.getIssue.bind(issues);
    issues.getIssue = async (args) => {
      if (agentRan) readsAfterAgent++;
      return getIssue(args);
    };
    const agent: ToolRunContext["agent"] = async (call) => {
      await issues.removeLabel({ repo: REPO, number: 1, label: "take-early" });
      agentRan = true;
      return h.context.agent(call);
    };
    const verify: SecureItDeps["verify"] = async (inputs) => {
      inputs.cooldown?.({ evaluated: true, releaseAgeDays: 7, held: [HELD] });
      return [];
    };
    const tool = secureIt({ ...h.deps, verify });
    expect(await tool.review({ ...h.context, agent })).toMatchObject({ reviewed: [{ outcome: "adapted" }] });
    expect(readsAfterAgent).toBe(0);
    expect(h.workspace.publications).toHaveLength(1);
    expect(h.github.prs.get(7)!.body).toContain("Tracks #1.");
    // The next tick sees the withdrawn grant before any branch work.
    // The fakes don't move the PR's head on publication: point it at the head the tool recorded, as GitHub would.
    const published = /leanish:state head=([0-9a-f]+)/.exec(h.github.prs.get(7)!.body)![1]!;
    h.github.prs.set(7, { ...h.github.prs.get(7)!, headSha: published });
    h.workspace.setRemoteHead(pr.headRef, published);
    const preparations = h.workspace.preparations.length;
    expect(await tool.review(h.context)).toMatchObject({ reviewed: [{ number: 7, outcome: "left-alone", detail: "its `take-early` label was removed" }] });
    expect(h.workspace.preparations).toHaveLength(preparations);
    expect(h.workspace.publications).toHaveLength(1);
  });

  it.each([{ aged: false, race: false }, { aged: true, race: false }, { aged: true, race: true }])("leaves an early PR a person marked ready, including at graduation (aged: $aged, raced: $race)", async ({ aged, race }) => {
    const plan = await heldPlan(YOUNG_VITE());
    const pr = ownPr({ isDraft: race, body: withMarker(RULES, withPlanSection("Fixes vite.", { ...plan, cooldown: [{ ...HELD, signals: [] }] }), { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }) });
    const h = harness({ prs: [pr] });
    const tracked = await early(h, pr);
    if (race) h.github.before("getPullRequest", () => h.github.prs.set(7, { ...h.github.prs.get(7)!, isDraft: false }));
    const env = await h.deps.gate(h.context);
    const fetch = fakeFetch({ "https://registry.npmjs.org/vite": { body: { time: { "8.3.3": aged ? OLD : "2026-10-06T00:00:00Z" }, versions: { "8.3.3": {} } } } });
    expect(await secureIt({ ...h.deps, gate: async () => ({ ...env, fetch }) }).review(h.context)).toMatchObject({ reviewed: [{ outcome: "left-alone", detail: "a person marked the held PR ready" }] });
    expect(h.github.prs.get(7)).toEqual({ ...tracked, isDraft: false });
    expect(h.workspace.preparations).toEqual([]);
    expect(recordOf((h.context.issues as FakeIssues).issues.get(1)!.body)!.attempts).toMatchObject([{ pr: 7 }]);
  });

  it("knows a PR was taken early from its issue even when the gate held nothing in it", async () => {
    // The probe brought g:x@2 into a configuration where it's new; the gate saw it elsewhere in the repository already.
    const plan = await heldPlan(YOUNG_VITE());
    const pr = ownPr({ headRef: "secure-it/2026-10-05-security-young-npm-vite", body: withMarker(RULES, withPlanSection("Fixes vite.", plan), { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }) });
    const h = harness({ prs: [pr] });
    const tracked = await early(h, pr, [{ ecosystem: "Maven", name: "g:x", version: "2", eligibleAt: "2026-10-13T00:00:00.000Z" }]);
    await (h.context.issues as FakeIssues).removeLabel({ repo: REPO, number: 1, label: "take-early" });
    h.github.checks = GREEN;
    expect(await secureIt(h.deps).review(h.context)).toMatchObject({ reviewed: [{ number: 7, outcome: "left-alone", detail: "its `take-early` label was removed" }] });
    expect(h.github.prs.get(7)).toEqual(tracked);
  });

  it("keeps a PR taken early a draft while its granted versions are young, even when the gate held nothing in it", async () => {
    const plan = await heldPlan(YOUNG_VITE());
    const pr = ownPr({ headRef: "secure-it/2026-10-05-security-young-npm-vite", body: withMarker(RULES, withPlanSection("Fixes vite.", plan), { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }) });
    const h = harness({ prs: [pr] });
    await early(h, pr, [{ ecosystem: "Maven", name: "g:x", version: "2", eligibleAt: "2026-10-13T00:00:00.000Z" }]);
    h.github.checks = GREEN;
    expect(await secureIt(h.deps).review(h.context)).toMatchObject({ reviewed: [{ number: 7, outcome: "held", detail: "until unknown" }] });
    expect(h.github.prs.get(7)?.isDraft).toBe(true);
  });

  it("fails closed on a PR taken early whose issue is gone, even when the gate held nothing in it", async () => {
    const plan = await heldPlan(YOUNG_VITE());
    const pr = ownPr({ headRef: "secure-it/2026-10-05-security-young-npm-vite", body: withMarker(RULES, withPlanSection("Fixes vite.\n\nTracks #5, taken early.", plan), { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }) });
    const h = harness({ prs: [pr] });
    h.github.checks = GREEN;
    // Issue #5 doesn't exist (deleted): nothing confirms the attempt, and nothing says the PR is ordinary now.
    expect(await secureIt(h.deps).review(h.context)).toMatchObject({ reviewed: [{ number: 7, outcome: "left-alone", detail: "it tracks #5, which isn't this decision's issue" }] });
    expect(h.github.prs.get(7)).toEqual(pr);
  });

  it("leaves a PR taken early to the owner once its label is removed, saying so on the issue once", async () => {
    const plan = await heldPlan(YOUNG_VITE());
    const pr = ownPr({ headRef: "secure-it/2026-10-05-security-young-npm-vite", body: withMarker(RULES, withPlanSection("Fixes vite.", { ...plan, cooldown: [{ ...HELD, signals: [] }] }), { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }) });
    const h = harness({ prs: [pr] });
    const tracked = await early(h, pr);
    const issues = h.context.issues as FakeIssues;
    await issues.removeLabel({ repo: REPO, number: 1, label: "take-early" });
    h.github.checks = GREEN;
    expect(await secureIt(h.deps).review(h.context)).toMatchObject({ reviewed: [{ number: 7, outcome: "left-alone", detail: "its `take-early` label was removed" }] });
    await secureIt(h.deps).review(h.context);
    expect(issues.comments.get(1)!.filter((comment) => comment.author === "leanish").map((comment) => comment.body)).toEqual([expect.stringContaining("secure-it leaves #7 to you")]);
    expect(h.github.prs.get(7)).toEqual(tracked);
  });

  it("makes a tracked PR whose plan records no cooldown ready on green, without asking for a grant", async () => {
    // What a trusted exception's PR looks like: the gate never holds a trusted package, so nothing keeps it a draft.
    const plan = await heldPlan(YOUNG_VITE());
    const pr = ownPr({ headRef: "secure-it/2026-10-05-security", body: withMarker(RULES, withPlanSection("Fixes lib.\n\nTracks #1.", { ...plan, cooldown: [] }), { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }) });
    const h = harness({ prs: [pr], files: { "package-lock.json": LOCK } });
    await track(h);
    h.github.checks = GREEN;
    expect(await secureIt(h.deps).review(h.context)).toMatchObject({ reviewed: [{ number: 7, outcome: "marked-ready" }] });
    expect((h.context.issues as FakeIssues).calls).toEqual([]);
  });

  it("leaves version PRs without Tracks to the owner, without migration or execution", async () => {
    for (const cooldown of [[], [{ ...HELD, signals: [] }]]) for (const isDraft of [false, true]) {
      const plan = await heldPlan(YOUNG_VITE());
      const pr = ownPr({ isDraft, body: withMarker(RULES, withPlanSection("Fixes vite.", { ...plan, cooldown }), { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }) });
      const h = harness({ prs: [pr], baseSha: "f".repeat(40) });
      expect(await secureIt(h.deps).review(h.context)).toMatchObject({ reviewed: [{ outcome: "left-alone", detail: "it tracks no issue; close it by hand and run secure-it again" }] });
      expect(h.github.prs.get(7)).toEqual(pr);
      expect([h.workspace.preparations, h.workspace.publications, h.workspace.deletions, h.agentCalls]).toEqual([[], [], [], []]);
      expect((h.context.issues as FakeIssues).calls).toEqual([]);
    }
  });

  it("leaves a PR taken early to the owner when, on a moved base, its fix now requires a young dependency its grant didn't cover", async () => {
    const plan = await planFor([vite()], { named: undefined, lockfiles: new Map([["package-lock.json", JSON.parse(LOCK)]]), gradle: undefined, tagCommit: async () => undefined },
      { kind: "routine", topic: "security-young-npm|vite" });
    const pr = ownPr({
      headRef: "secure-it/2026-10-05-security-young-npm-vite",
      body: withMarker(RULES, withPlanSection("Fixes vite.", { ...plan, cooldown: [{ ...HELD, signals: [] }] }), { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }),
    });
    const h = harness({ prs: [pr], baseSha: "f".repeat(40), fixes: [vite()] });
    h.workspace.setRemoteHead(pr.headRef, HEAD_SHA);
    const tracked = await early(h, pr);
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
    expect(await secureIt({ ...h.deps, requiredNpm, verify: holdingVerify }).review(h.context)).toMatchObject({ reviewed: [{ number: 7, outcome: "deferred" }] });
    expect(requiredPlanned).toBeGreaterThan(0);
    expect(h.github.prs.get(7)).toEqual(tracked);
    expect(h.agentCalls).toEqual([]);
    expect((h.context.issues as FakeIssues).comments.get(1)!.at(-1)!.body).toContain("a different decision than the one `take-early` authorized");
  });

  it("refuses a held PR whose recorded hold doesn't read", async () => {
    const plan = await planFor([YOUNG_VITE()], { named: undefined, lockfiles: new Map([["package-lock.json", JSON.parse(LOCK)]]), gradle: undefined, tagCommit: async () => undefined });
    const body = withMarker(RULES, withPlanSection("Fixes vite.\n\nTracks #1.", { ...plan, cooldown: [{ ...HELD, eligibleAt: "soon", signals: [] }] }), { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 });
    const h = harness({ prs: [ownPr({ headRef: "secure-it/2026-10-05-security", body })] });
    await track(h);
    h.github.checks = GREEN;
    expect(await secureIt(h.deps).review(h.context)).toMatchObject({ reviewed: [{ number: 7, outcome: "error" }] });
    expect(h.github.prs.get(7)?.isDraft).toBe(true);
  });
});
