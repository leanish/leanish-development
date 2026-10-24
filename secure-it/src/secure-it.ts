/** Security fixes and a separate proved floor-removal unit; malware first, every publication verified. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

import type { GitHubPullRequest } from "@leanish/agent-runtime/types/clients";
import type { PreparedBranch, WorkingCopy } from "@leanish/agent-runtime/types/working-copy";
import { ActionsGitHub } from "@leanish/gate/actions-github";
import type { Floor } from "@leanish/gate/floors";
import { type SecurityCandidates, type SecurityFix, securityCandidates } from "@leanish/gate/candidates";
import { type CooldownEvaluation, heldUntil } from "@leanish/gate/cooldown";
import type { NpmPeerPlanner } from "@leanish/gate/npm-peers";
import { type EvidenceOptions, heldEvidence } from "@leanish/gate/advisory-evidence";
import { type GateEnvironment, type GradleInputs, readSettings } from "@leanish/gate/gate";
import { type GradleInventory, gradleLocation, pinnedAmong, strictPinNote, strictPins } from "@leanish/gate/gradle";
import { namingFailures } from "@leanish/gate/http";
import { FileRepositoryAdvisoryCache } from "@leanish/tool-runtime/repository-advisory-cache";
import { BundleReader } from "@leanish/gate/npm-bundles";
import { NpmRegistry, releaseSignals } from "@leanish/gate/npm-registry";
import type { HeldVersion } from "@leanish/gate/release-age";
import { runProcess } from "@leanish/gate/process";
import { gitTree, type Tree, workingTree } from "@leanish/gate/tree";
import { failingCheckNames } from "@leanish/tool-runtime/ci-state";
import type { ToolHandlers, ToolRunContext } from "@leanish/tool-runtime/command";
import { FLOORS_FILE, isMechanical } from "@leanish/tool-runtime/edit-checks";
import { writeLocalFile } from "@leanish/tool-runtime/local-files";
import { gradleSourceIndex } from "@leanish/gate/gradle-sources";
import { candidateTree, changedBetween, fileState, type FileState, linkProblems, snapshotCandidate } from "@leanish/tool-runtime/git-copies";
import { referenceTransform } from "@leanish/tool-runtime/gradle-reference";
import { type GradleInventories, lockfilesOf, sandboxedGradleInventories } from "@leanish/tool-runtime/inventories";
import { FileJournal, type PublicationJournal } from "@leanish/tool-runtime/journal";
import { formatManifest } from "@leanish/tool-runtime/manifest-format";
import { NPM_DEPENDENCY_FIELDS } from "@leanish/tool-runtime/npm-file-checks";
import { requireNpmExcludes } from "@leanish/tool-runtime/npm-version";
import { runSandboxed, sandboxWritable } from "@leanish/tool-runtime/sandboxed";
import { ensureOsvScanner, verifyingRun } from "@leanish/tool-runtime/osv-scanner";
import { freeBranch, ownPullRequests, stateOf, topicOf } from "@leanish/tool-runtime/own-pr";
import { publicationParent, revertToBase } from "@leanish/tool-runtime/reconcile";
import { clearLeftoverBranch, closeAndDelete, ownOpenPullRequests, type PublicationContext, publishNew, publishUpdate, recoverPublication, rewriteText } from "@leanish/tool-runtime/publication";
import { machineRoots } from "@leanish/tool-runtime/publication-text";
import { type BaseMerge, type CooldownState, reviewOpenPullRequests, type ReviewSteps } from "@leanish/tool-runtime/review";

import { removalTransform } from "./floor-gradle.ts";
import { probeOnBase } from "./floor-probe.ts";
import { type ComputedRemoval, type RemovalProbe, floorsOf, selectRemovals } from "./floor-removal.ts";
import { reconcileNpmFloors } from "./npm-floor-history.ts";
import { materializeOnBase } from "./npm-materialize.ts";
import { withGradleParents } from "./gradle-parents.ts";
import { withParents } from "./npm-parents.ts";
import { requiredNpmPlan } from "./npm-required-plan.ts";
import { npmWindowFor } from "./npm-window.ts";
import { assertBodyFits, assertNoPlanMarker } from "@leanish/tool-runtime/plan-blocks";
import { planDigest, planOf, planSection, withPlanSection } from "./plan-block.ts";
import { type ChangePlan, coupledWork, type FixWork, heldMembers, heldUnits, isHeldTopic, packageKey, planFor, type PlannedHold, type SecurityUnit, withUnsupportedCarriers } from "./plan.ts";
import { namedProblems, retryWithoutNamed, type ProblemMoves } from "./retry.ts";
import { referencePlan, verifyPlan, type VerifyInputs } from "./verify.ts";

export const RULES = ownPullRequests("secure-it");
const SKILLS_DIR = fileURLToPath(new URL("../skills", import.meta.url));

/** What the agent answers (the skill's output schema). */
interface SkillAnswer {
  readonly outcome: "applied" | "cannot-apply";
  readonly summary: string;
  readonly publication?: { readonly title: string; readonly body: string; readonly commitMessage: string } | null;
}

/** What secure-it reaches outside its own logic; tests replace them. */
export interface SecureItDeps {
  readonly publicationParent: typeof publicationParent;
  readonly fileState: typeof fileState;
  readonly requiredNpm: typeof requiredNpmPlan;
  readonly materializeNpm: typeof materializeOnBase;
  readonly floorProbe: (context: ToolRunContext, base: Tree, floors: ReadonlyArray<Floor>, env: GateEnvironment) => Promise<RemovalProbe>;
  readonly gate: (context: ToolRunContext) => Promise<GateEnvironment>;
  readonly gradle: (context: ToolRunContext) => GradleInventories;
  readonly trees: { readonly commit: (workingCopy: WorkingCopy, sha: string) => Promise<Tree>; readonly working: (workingCopy: WorkingCopy) => Tree };
  readonly candidates: (tree: Tree, env: GateEnvironment, gradle: GradleInputs) => Promise<SecurityCandidates>;
  readonly verify: (inputs: VerifyInputs) => Promise<string[]>;
  /** Records the working tree as the verification snapshot (`snapshotCandidate`), returning its commit. */
  readonly snapshot: (workingCopy: WorkingCopy) => Promise<string>;
  /** The tree of the last snapshot, which publication must stage (`candidateTree`). */
  readonly candidateTree: (workingCopy: WorkingCopy) => Promise<string | undefined>;
  /** Every path `sha` changed relative to `base` (`changedBetween`). */
  readonly changedBetween: (workingCopy: WorkingCopy, base: string, sha: string) => Promise<string[]>;
  /** What the edit from `base` to `sha` did with links and submodules, as verification problems (`linkProblems`). */
  readonly linkProblems: (workingCopy: WorkingCopy, base: string, sha: string) => Promise<string[]>;
  readonly journal: (context: ToolRunContext) => PublicationJournal;
  /** Writes `content` at `path` (relative to the working copy): taking the base's side of a conflicted dependency file. */
  readonly writeFile: (workingCopy: WorkingCopy, path: string, content: string) => Promise<void>;
  /** npm under the same sandbox and PATH as the agent, used to check exclusion support. */
  readonly npm: (context: ToolRunContext, args: ReadonlyArray<string>) => Promise<{ code: number; stdout: string; stderr: string }>;
  /** Starts a redo detached at `baseSha`, with a clean index/worktree; returns the discarded paths. */
  readonly revert: (workingCopy: WorkingCopy, baseSha: string) => Promise<string[]>;
}

export function defaultDeps(): SecureItDeps {
  return {
    publicationParent,
    fileState,
    requiredNpm: requiredNpmPlan,
    materializeNpm: materializeOnBase,
    floorProbe: probeOnBase,
    gate: async (context) => {
      // Outside everything sandboxed commands can write, and checked right before each run.
      const writable = sandboxWritable(context);
      const osv = await ensureOsvScanner(context.config.dirs.state, writable);
      return { run: verifyingRun(runProcess, osv), fetch: namingFailures(context.fetch), now: () => new Date(), osvScanner: osv.path, githubToken: context.readToken, bundles: new BundleReader(), repositoryAdvisoryCache: new FileRepositoryAdvisoryCache(context.config.dirs.state, writable, context.readToken) };
    },
    gradle: (context) => sandboxedGradleInventories(context.isolation, context.workingCopy),
    trees: { commit: (workingCopy, sha) => gitTree(workingCopy.path, sha, runProcess, workingCopy.gitDir), working: (workingCopy) => workingTree(workingCopy.path) },
    candidates: securityCandidates,
    npm: (context, args) => runSandboxed(context.isolation, { workingCopy: context.workingCopy, command: ["npm", ...args] }),
    verify: verifyPlan,
    snapshot: (workingCopy) => snapshotCandidate(workingCopy),
    candidateTree: (workingCopy) => candidateTree(workingCopy),
    changedBetween: (workingCopy, base, sha) => changedBetween(workingCopy, base, sha),
    linkProblems: (workingCopy, base, sha) => linkProblems(workingCopy, base, sha),
    journal: (context) => new FileJournal(context.config.dirs.state),
    writeFile: (workingCopy, path, content) => writeLocalFile(workingCopy.path, path, content),
    revert: (workingCopy, baseSha) => revertToBase(workingCopy, baseSha),
  };
}

export function secureIt(deps: SecureItDeps = defaultDeps()): ToolHandlers {
  return {
    tool: "secure-it",
    skills: { dirs: [SKILLS_DIR], entrypoints: ["secure-it"], support: [] },
    run: (context) => run(context, deps),
    review: (context) => review(context, deps),
  };
}

function publicationOf(context: ToolRunContext, deps: SecureItDeps): PublicationContext {
  return {
    rules: RULES,
    github: context.github,
    workspace: context.workspace,
    logger: context.logger,
    repo: context.repo.repo,
    base: context.base,
    workingCopy: context.workingCopy,
    journal: deps.journal(context),
    localRoots: machineRoots(context.config.dirs),
    verifiedTree: () => deps.candidateTree(context.workingCopy),
    publicationParent: (prepared) => deps.publicationParent(context.workingCopy, prepared),
  };
}

interface SkillExtra {
  readonly failingChecks?: string[];
  readonly conflicted?: ReadonlyArray<string>;
  /** Why verification refused the previous attempt at this same plan. */
  readonly rejected?: ReadonlyArray<string>;
}

function skillInput(context: ToolRunContext, plan: ChangePlan, npmAgeExclusions: ReadonlyArray<string>, mode: "apply" | "adapt" | "resolve", extra: SkillExtra = {}) {
  return {
    repo: context.repo.repo,
    mode,
    today: context.now.toISOString().slice(0, 10),
    moves: plan.moves.map((move) => ({
      ecosystem: move.ecosystem,
      name: move.name,
      from: move.from,
      to: move.to,
      mechanism: move.mechanism,
      locations: [...move.locations],
      advisories: [...move.advisories],
      major: move.major,
      ...(move.commitSha === undefined ? {} : { commitSha: move.commitSha }),
      ...(move.declaredAs === undefined ? {} : { declaredAs: move.declaredAs }),
      ...(move.carries === undefined ? {} : { carries: move.carries.map((carried) => ({ ...carried, from: [...carried.from], to: [...carried.to], locations: [...carried.locations], advisories: [...carried.advisories] })) }),
    })),
    ...(plan.floorRemoval === undefined ? {} : {
      floorRemovals: plan.floorRemoval.floors.filter((floor) => floor.ecosystem === "Maven").map((floor) => ({
        ecosystem: floor.ecosystem, package: floor.package, version: floor.version, declaredIn: floor.declaredIn, locations: floor.locations, advisories: floor.advisories,
      })),
      toolWritten: plan.floorRemoval.files.map((file) => file.path),
    }),
    floorsFile: FLOORS_FILE,
    npmAgeExclusions: [...npmAgeExclusions],
    ...(extra.failingChecks === undefined ? {} : { failingChecks: extra.failingChecks }),
    ...(extra.conflicted === undefined ? {} : { conflicted: [...extra.conflicted] }),
    ...(extra.rejected === undefined ? {} : { rejected: [...extra.rejected] }),
  };
}

/** Every agent mode receives the same explicit npm window, after checking the sandbox's npm. */
async function agentInput(
  execution: Execution,
  plan: ChangePlan,
  base: Tree,
  mode: "apply" | "adapt" | "resolve",
  extra: SkillExtra = {},
  restoredFiles?: Map<string, FileState>,
) {
  const window = await prepareNpmFiles(execution, plan, base, false, restoredFiles);
  return { ...skillInput(execution.context, plan, window.exclude, mode, extra), toolWritten: [...execution.npmFiles.keys()] };
}

/** Write the recomputed npm files before either agent work or a clean, model-free rebase verification. */
async function prepareNpmFiles(execution: Execution, plan: ChangePlan, base: Tree, reconcileFloors = false, restoredFiles?: Map<string, FileState>) {
  const { context, deps, env } = execution;
  const window = await npmWindowFor(plan, context.releaseAgeDays, context.releaseAgeExclude, context.now, env.fetch, await lockfilesOf(base));
  for (const detail of window.notes) context.logger.warn("secure-it: npm release-age exclusion", { detail });
  if (plan.moves.some((move) => move.ecosystem === "npm")) {
    await requireNpmExcludes((_dir, args) => deps.npm(context, args), context.workingCopy.path, window.exclude, "young security targets or proved requirements, unreadable or young locked base versions, or own-package exclusions");
  }
  let files = await deps.materializeNpm(context, base, plan, window.exclude);
  if (reconcileFloors) files = reconcileNpmFloors(files, await deps.trees.working(context.workingCopy).read(FLOORS_FILE));
  execution.npmFiles.clear();
  for (const [path, text] of files) {
    execution.npmFiles.set(path, text);
    let output = text;
    if (path.endsWith("package.json") && plan.moves.some((move) => move.major)) {
      const current = await deps.trees.working(context.workingCopy).read(path);
      if (current !== undefined) {
        const manifest = JSON.parse(current) as Record<string, unknown>;
        const original = structuredClone(manifest);
        const planned = JSON.parse(text) as Record<string, unknown>;
        for (const field of NPM_DEPENDENCY_FIELDS) {
          if (planned[field] === undefined) delete manifest[field];
          else manifest[field] = planned[field];
        }
        output = isDeepStrictEqual(original, manifest) ? current : formatManifest(current, manifest);
      }
    }
    await deps.writeFile(context.workingCopy, path, output);
    const restored = restoredFiles?.get(path);
    if (restoredFiles !== undefined && restored !== undefined) {
      restoredFiles.set(path, { ...await deps.fileState(context.workingCopy, path), index: restored.index });
    }
  }
  return window;
}

interface Execution {
  readonly context: ToolRunContext;
  readonly deps: SecureItDeps;
  readonly env: GateEnvironment;
  readonly inventories: GradleInventories;
  readonly publication: PublicationContext;
  readonly npmFiles: Map<string, string>;
  /** Branches this run created, on top of the open PRs' ones: two units' topics can cut to the same branch name. */
  readonly branches: Set<string>;
}

interface PlanBase {
  readonly tree: Tree;
  readonly gradle: GradleInputs["head"];
}

type Content = NonNullable<SkillAnswer["publication"]>;

async function run(context: ToolRunContext, deps: SecureItDeps): Promise<Readonly<Record<string, unknown>>> {
  const env = await deps.gate(context);
  const inventories = deps.gradle(context);
  const tree = await deps.trees.commit(context.workingCopy, context.workingCopy.headSha);
  const base = { tree, gradle: await inventories.ofCommit(tree) };
  const found = await deps.candidates(tree, env, { head: base.gradle });
  const report = { gaps: found.gaps.length };
  if (found.incomplete.length > 0) return { ...report, outcome: "incomplete", incomplete: found.incomplete };
  const planned = await withParentsPlanned(found, base, env, inventories);
  const selection = await coupledWork(planned.fixes, planned.peers);
  const waiting = selection.blocked.flatMap((group) => group.reasons);

  const execution = { context, deps, env, inventories, publication: publicationOf(context, deps), npmFiles: new Map<string, string>(), branches: new Set<string>() };
  const own = await ownOpenPullRequests(context.github, RULES, context.repo.repo, context.base);
  const results: Readonly<Record<string, unknown>>[] = [];
  const units = await holdRequiredYoung(execution, selection.units, base);
  const claims = heldClaims(units, await claimable(context, execution.publication, own));
  for (const unit of units) {
    try {
      results.push(await runUnit(execution, unit, base, own, claims.get(unit.topic)));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      context.logger.warn("secure-it: a unit failed", { topic: unit.topic, error: detail });
      results.push({ topic: unit.topic, outcome: "failed", detail });
    }
  }
  if (!found.fixes.some((fix) => fix.malicious) && (await floorsOf(tree)).some((floor) => floor.purpose === "security")) {
    try {
      const removal = await computeRemoval(execution, base);
      results.push(removal.plan === undefined
        ? { topic: "floor-removal", outcome: "nothing-to-remove", notes: removal.notes }
        : await runRemoval(execution, removal, base, own));
    } catch (err) {
      results.push({ topic: "floor-removal", outcome: "failed", detail: err instanceof Error ? err.message : String(err) });
    }
  }
  if (results.length === 0) return { ...report, outcome: "nothing-to-fix", waiting, blocked: selection.blocked, units: [] };
  return { ...report, ...(results.length === 1 ? results[0]! : { outcome: "completed" }), waiting, blocked: selection.blocked, units: results };
}

/**
 * The run's fixes with their parents (`parentsFirst`), and the direct-peer planner that sees the npm parents they
 * added: a parent may need a peer of its own to move.
 */
export async function withParentsPlanned(found: SecurityCandidates, base: PlanBase, env: GateEnvironment, inventories: GradleInventories): Promise<{ readonly fixes: FixWork[]; readonly peers: NpmPeerPlanner | undefined }> {
  const fixes = await parentsFirst(found.fixes, base, env, inventories);
  const added = fixes.filter((fix) => fix.ecosystem === "npm" && fix.to !== undefined && !found.fixes.some((other) => other.ecosystem === "npm" && other.name === fix.name && other.from === fix.from));
  if (added.length === 0 || found.peersWith === undefined) return { fixes, peers: found.npmPeers };
  return { fixes, peers: await found.peersWith(added.map((fix) => ({ ecosystem: "npm" as const, name: fix.name, version: fix.to!.version }))) };
}

/**
 * Parents first, on every fix of the run before it's split into units (a parent's own fix may land in another unit
 * otherwise): npm parents where an override would be needed, Gradle parents where a floor would; then npm carriers
 * that would need an override are blocked. A Gradle fix of a strictly pinned coordinate is blocked before anything:
 * the pin is the owner's to move.
 */
async function parentsFirst(fixes: ReadonlyArray<SecurityFix>, base: PlanBase, env: GateEnvironment, inventories: GradleInventories): Promise<FixWork[]> {
  const lockfiles = await lockfilesOf(base.tree);
  const { config, exceptions } = await readSettings(base.tree);
  let work = await withParents(withStrictPinsBlocked(fixes, base.gradle), { lockfiles, env, config, exceptions });
  if (base.gradle !== undefined) {
    const sources = await gradleSourceIndex(base.tree);
    work = await withGradleParents(work, { base: base.tree, gradle: base.gradle, named: sources.named, inventories, env, config });
  }
  return withUnsupportedCarriers(work, lockfiles);
}

/**
 * An open PR of the same plan keeps its commits; its plan section is rewritten when what it says (notes) changed.
 * Only the notes come from the recomputed plan: the rest, such as the cooldown hold its verification recorded (a
 * fresh plan has none yet), stays as published.
 */
async function refreshText(execution: Execution, pr: GitHubPullRequest, plan: ChangePlan): Promise<void> {
  const previous = planOf(pr.body);
  if (previous === undefined) return;
  const refreshed = withNotesOf(previous, plan);
  if (planSection(refreshed) === planSection(previous)) return;
  await rewriteText(execution.publication, pr.number, pr.headSha, (body) => withPlanSection(body, refreshed));
}

/** `published` with `recomputed`'s notes (a floor removal's own, or the plan's). */
function withNotesOf(published: ChangePlan, recomputed: ChangePlan): ChangePlan {
  if (published.floorRemoval !== undefined && recomputed.floorRemoval !== undefined) {
    return { ...published, floorRemoval: { ...published.floorRemoval, notes: recomputed.floorRemoval.notes } };
  }
  const { notes: _published, ...rest } = published;
  return recomputed.notes === undefined ? rest : { ...rest, notes: recomputed.notes };
}

/**
 * `fixes` with each Maven fix of a coordinate pinned strictly where it would act made non-actionable, so it's reported
 * as blocked. Where it would act: where it's vulnerable, and every configuration that declares it, since moving a
 * declaration moves it wherever it's inherited, a pinned configuration that already resolves a clean version included.
 */
export function withStrictPinsBlocked(fixes: ReadonlyArray<SecurityFix>, gradle: GradleInventory | undefined): SecurityFix[] {
  const pins = strictPins(gradle);
  return fixes.map((fix) => {
    const pinned = fix.ecosystem === "Maven" ? pinnedAmong(pins, fix.name, [...fix.locations, ...declaringLocations(gradle, fix.name)]) : [];
    return pinned.length === 0 ? fix : { ...fix, to: undefined, problem: strictPinNote(fix.name, pinned) };
  });
}

function declaringLocations(gradle: GradleInventory | undefined, name: string): string[] {
  return (gradle?.builds ?? []).flatMap((build) => build.configurations
    .filter((configuration) => configuration.declared.some((declared) => `${declared.group}:${declared.name}` === name))
    .map((configuration) => gradleLocation(build.build, configuration.id)));
}

// Automatic floor removal, kept on purpose: docs/simplification-candidates.md#reviewed-and-kept-2026-10-16.
async function computeRemoval(execution: Execution, base: PlanBase): Promise<ComputedRemoval> {
  const pins = strictPins(base.gradle);
  // A floor declared with strictly(...) is the owner's pin too: it stays, whatever the proof would say.
  const strict = (floor: Floor) => {
    const pinned = floor.ecosystem === "Maven" ? pinnedAmong(pins, floor.package, floor.locations) : [];
    return pinned.length === 0 ? undefined : strictPinNote(floor.package, pinned);
  };
  return selectRemovals(await floorsOf(base.tree), (floors) => execution.deps.floorProbe(execution.context, base.tree, floors, execution.env),
    (text) => createHash("sha256").update(text).digest("hex"), strict);
}

async function applyRemoval(execution: Execution, removal: ComputedRemoval): Promise<Content> {
  const plan = removal.plan!;
  for (const [path, content] of removal.files) await execution.deps.writeFile(execution.context.workingCopy, path, content);
  const content = { title: "removing redundant security floors", body: planSection(plan), commitMessage: "removing redundant security floors" };
  if (!plan.floorRemoval!.floors.some((floor) => floor.ecosystem === "Maven")) return content;
  const answer = await execution.context.agent<ReturnType<typeof skillInput>, SkillAnswer>({
    entrypoint: "secure-it", input: skillInput(execution.context, plan, [], "apply"),
  });
  if (answer.outcome !== "applied") throw new Error(`the agent couldn't remove the planned Gradle declarations: ${answer.summary}`);
  return content;
}

async function runRemoval(execution: Execution, removal: ComputedRemoval, base: PlanBase, own: ReadonlyArray<GitHubPullRequest>): Promise<Readonly<Record<string, unknown>>> {
  const plan = removal.plan!;
  const owned = await recognisedPlans(execution.context, execution.publication, own, plan);
  const already = owned.find((pr) => stateOf(pr.body)?.head === pr.headSha && planDigest(planOf(pr.body)!) === planDigest(plan));
  const report = { topic: plan.topic, packages: plan.packages, notes: removal.notes };
  if (already !== undefined) {
    await refreshText(execution, already, plan);
    return { ...report, outcome: "already-open", pullRequest: already.url };
  }
  const reusable = owned[0];
  const prepared = await preparePlan(execution.context, execution.deps, plan, reusable, own, base.tree.id, execution.branches);
  const content = await applyRemoval(execution, removal);
  const problems = await verifyEdit(execution.context, execution.deps, plan, execution.env, execution.inventories, base.tree, base.gradle);
  if (problems.length > 0) return { ...report, outcome: "verification-failed", problems };
  if (reusable !== undefined) {
    const { pr } = await publishUpdate(execution.publication, prepared, reusable.number, content, 0);
    return { ...report, outcome: "updated", pullRequest: pr.url };
  }
  const pr = await publishNew(execution.publication, prepared, content);
  return { ...report, outcome: pr === undefined ? "nothing-changed" : "published", ...(pr === undefined ? {} : { pullRequest: pr.url }) };
}

/**
 * A routine fix whose required npm dependency is younger than the wait can't
 * wait either: it moves to a held unit with every package the aged plan couples
 * to it, and with every root requiring the same young companion (a key without
 * a fix of its own still joins them). Held work is then grouped again (`heldUnits`).
 * Moving roots only drops requirements, so one pass leaves the rest aged.
 * Kept on purpose: docs/simplification-candidates.md#reviewed-and-kept-2026-10-16.
 */
async function holdRequiredYoung(execution: Execution, units: ReadonlyArray<SecurityUnit>, base: PlanBase): Promise<SecurityUnit[]> {
  const aged = units.find((unit) => unit.kind === "routine" && unit.held !== true);
  if (aged === undefined) return [...units];
  let plan: ChangePlan;
  try {
    plan = await planUnit(execution, aged, base);
  } catch {
    // Its own run reports why it can't be planned.
    return [...units];
  }
  const moved = new Set((plan.requiredNpm ?? []).filter((target) => target.exempt).map((target) => `npm|${target.root.name}`));
  if (moved.size === 0) return [...units];
  // requiredNpmPlan's coupled sets keep only moved packages: each young requirement joins its root and target here
  // instead, so roots requiring one young companion move together. An aged companion joins nothing: it holds no one.
  const bridges = (plan.requiredNpm ?? []).filter((target) => target.exempt).map((target) => [`npm|${target.root.name}`, `npm|${target.name}`]);
  for (;;) {
    const size = moved.size;
    for (const set of [...(plan.coupled ?? []), ...bridges]) if (set.some((key) => moved.has(key))) for (const key of set) moved.add(key);
    if (moved.size === size) break;
  }
  const held = units.filter((unit) => unit.kind === "routine" && unit.held === true);
  const stays = aged.work.filter((fix) => !moved.has(packageKey(fix)));
  const joined = heldUnits(
    [...held.flatMap((unit) => unit.work), ...aged.work.filter((fix) => moved.has(packageKey(fix)))],
    // The aged plan's sets, not only the unit's: they include what planning required npm discovered (a root that
    // needs another root's fix), which the held units keep for their own retries too.
    [...held.flatMap((unit) => unit.coupled ?? []), ...(plan.coupled ?? []).filter((set) => set.some((key) => moved.has(key)))],
    bridges,
  );
  const rest = stays.length === 0 ? [] : [{ ...aged, work: stays, coupled: (aged.coupled ?? []).filter((set) => !set.some((key) => moved.has(key))) }];
  return [...units.filter((unit) => unit !== aged && !held.includes(unit)), ...rest, ...joined];
}

/**
 * Which open held PR each held unit of this run takes (topic → PR number): the one sharing the most of its packages,
 * strongest pairs first across all units, so the order units run in never decides which PR changes purpose. Ties go
 * to the pair whose lowest shared package sorts first, then to the lower PR number. Each PR goes to one unit at most;
 * a unit with none opens its own.
 */
export function heldClaims(units: ReadonlyArray<SecurityUnit>, own: ReadonlyArray<GitHubPullRequest>): Map<string, number> {
  const held = units.filter((unit) => unit.kind === "routine" && isHeldTopic(unit.topic));
  const pairs = own.flatMap((pr) => {
    const previous = planOf(pr.body);
    if (previous === undefined || !isHeldPlan(previous)) return [];
    return held.flatMap((unit) => {
      const match = heldOverlap(previous, unit);
      return match === undefined ? [] : [{ topic: unit.topic, number: pr.number, ...match }];
    });
  }).sort((a, b) => b.shared - a.shared || (a.lowest < b.lowest ? -1 : a.lowest > b.lowest ? 1 : 0) || a.number - b.number);
  const claims = new Map<string, number>();
  const taken = new Set<number>();
  for (const pair of pairs) {
    if (claims.has(pair.topic) || taken.has(pair.number)) continue;
    claims.set(pair.topic, pair.number);
    taken.add(pair.number);
  }
  return claims;
}

/**
 * The open PRs a held unit may claim, read-only: the head is still the tool's (the body's recorded head, or the
 * journal's, whose saved publication then stands for the body), and no person took it over (a held PR marked ready,
 * which review leaves alone). Otherwise a PR someone pushed to, or one a person took, would keep its unit from the PR
 * the tool opens or keeps instead. The chosen PR is recovered later, as any reused one is.
 */
async function claimable(context: ToolRunContext, publication: PublicationContext, own: ReadonlyArray<GitHubPullRequest>): Promise<GitHubPullRequest[]> {
  const claimable: GitHubPullRequest[] = [];
  for (const pr of own) {
    if (topicOf(RULES, pr.headRef) === undefined) continue;
    const effective = stateOf(pr.body)?.head === pr.headSha ? pr : await journaled(context, publication, pr);
    if (effective === undefined) continue;
    if ((planOf(effective.body)?.cooldown?.length ?? 0) > 0 && !effective.isDraft) continue;
    claimable.push(effective);
  }
  return claimable;
}

/** `pr` as the journal last published it at its current head (legacy entries record only the head); else undefined. */
async function journaled(context: ToolRunContext, publication: PublicationContext, pr: GitHubPullRequest): Promise<GitHubPullRequest | undefined> {
  const pushed = await publication.journal.last(context.repo.repo, pr.number);
  if (pushed?.head !== pr.headSha) return undefined;
  return pushed.publication === undefined ? pr : { ...pr, title: pushed.publication.title, body: pushed.publication.body };
}

/** How many of a held unit's packages a held plan shares, and the lowest shared one; undefined when none. */
function heldOverlap(previous: ChangePlan, unit: SecurityUnit): { readonly shared: number; readonly lowest: string } | undefined {
  const members = new Set(heldMembers(previous));
  const shared = [...new Set(unit.work.map(packageKey))].filter((key) => members.has(key)).sort();
  return shared.length === 0 ? undefined : { shared: shared.length, lowest: shared[0]! };
}

async function planUnit(execution: Execution, unit: SecurityUnit, base: PlanBase): Promise<ChangePlan> {
  const actions = new ActionsGitHub(execution.env.fetch, execution.env.githubToken);
  const sources = base.gradle === undefined ? undefined : await gradleSourceIndex(base.tree);
  const lockfiles = await lockfilesOf(base.tree);
  const plan = await planFor(unit.work, { lockfiles, gradle: base.gradle, named: sources?.named, tagCommit: (action, tag) => actions.tagCommit(action, tag) }, unit);
  return execution.deps.requiredNpm(base.tree, plan, execution.env);
}

async function runUnit(execution: Execution, unit: SecurityUnit, base: PlanBase, own: ReadonlyArray<GitHubPullRequest>, claimed: number | undefined): Promise<Readonly<Record<string, unknown>>> {
  const { context, deps, publication } = execution;
  const plan = await planUnit(execution, unit, base);
  const owned = await recognisedPlans(context, publication, own, plan, claimed);
  const already = owned.find((pr) => {
    const previous = planOf(pr.body);
    return stateOf(pr.body)?.head === pr.headSha && previous !== undefined && planDigest(previous) === planDigest(plan);
  });
  const details = { topic: plan.topic, packages: plan.packages, notes: plan.notes ?? [] };
  if (already !== undefined) {
    await refreshText(execution, already, plan);
    return { ...details, outcome: "already-open", pullRequest: already.url };
  }
  const reusable = owned[0];
  const prepared = await preparePlan(context, deps, plan, reusable, own, base.tree.id, execution.branches);
  const input = await agentInput(execution, plan, base.tree, "apply");
  const answer = await context.agent<ReturnType<typeof skillInput>, SkillAnswer>({ entrypoint: "secure-it", input });
  if (answer.outcome !== "applied" || answer.publication == null) return { ...details, outcome: "cannot-apply", summary: answer.summary };
  assertNoPlanMarker(answer.publication.body);
  const verified = await verifyWithRetry(execution, base, plan, answer.publication, { retryRejected: true });
  const checked = {
    ...details, notes: verified.plan.notes ?? [], packages: verified.plan.packages, named: verified.named, leftOut: verified.leftOut,
    ...(verified.rejected === undefined ? {} : { rejected: verified.rejected }),
  };
  if (verified.problems.length > 0) return { ...checked, outcome: "verification-failed", problems: verified.problems };
  const content = { ...verified.content, body: withPlanSection(verified.content.body, verified.plan) };
  if (reusable !== undefined) {
    const { pr } = await publishUpdate(publication, prepared, reusable.number, content, 0);
    return { ...checked, outcome: "updated", pullRequest: pr.url };
  }
  const created = await publishNew(publication, prepared, content);
  return created === undefined
    ? { ...checked, outcome: "nothing-changed", summary: answer.summary }
    : { ...checked, outcome: "published", pullRequest: created.url };
}

async function preparePlan(context: ToolRunContext, deps: SecureItDeps, plan: ChangePlan, reusable: GitHubPullRequest | undefined, own: ReadonlyArray<GitHubPullRequest>, baseSha: string, created: Set<string>): Promise<PreparedBranch> {
  if (reusable !== undefined) return reconcileBranch(context, deps, reusable, baseSha);
  const taken = new Set([...own.map((pr) => pr.headRef), ...created]);
  const branch = freeBranch(RULES, context.now, plan.topic, taken);
  created.add(branch);
  await clearLeftoverBranch(context.github, RULES, context.repo.repo, branch);
  const fresh = await context.workspace.prepareBranch(context.workingCopy, { branch, start: "default" });
  if (fresh.kind !== "prepared") throw new Error(`${branch} couldn't be prepared`);
  if (fresh.prepared.baseSha !== baseSha) throw new Error("the default branch moved while secure-it ran; the next run starts over");
  return fresh.prepared;
}

interface VerifiedBatch {
  readonly plan: ChangePlan;
  readonly content: Content;
  readonly problems: ReadonlyArray<string>;
  readonly named: ReadonlyArray<ProblemMoves>;
  readonly leftOut: NonNullable<ChangePlan["leftOut"]>;
  /** What verification refused in the first attempt, when the agent was asked again with it. */
  readonly rejected?: ReadonlyArray<string>;
}

/**
 * When the first edit fails, and the caller allows it (a fresh application, not a review's adaptation, which a restart
 * from the base would lose), ask the agent once more for the same plan with the refusal. Then restart once from the
 * same base without named package groups; never shrink malware or guess an unnamed cause.
 */
async function verifyWithRetry(execution: Execution, base: PlanBase, plan: ChangePlan, content: Content, options: { readonly retryRejected?: boolean } = {}): Promise<VerifiedBatch> {
  const { context, deps, env, inventories } = execution;
  if (execution.npmFiles.size === 0 && plan.moves.some((move) => move.ecosystem === "npm")) {
    const window = await npmWindowFor(plan, context.releaseAgeDays, context.releaseAgeExclude, context.now, env.fetch, await lockfilesOf(base.tree));
    for (const [path, text] of await deps.materializeNpm(context, base.tree, plan, window.exclude)) execution.npmFiles.set(path, text);
  }
  let cooldown: CooldownEvaluation | undefined;
  const heard = (evaluation: CooldownEvaluation) => {
    cooldown = evaluation;
  };
  const first = await verifyEdit(context, deps, plan, env, inventories, base.tree, base.gradle, execution.npmFiles, heard);
  if (first.length === 0) return withCooldown(env, base.tree, { plan, content, problems: first, named: [], leftOut: plan.leftOut ?? [] }, cooldown);
  let problems = first;
  let rejected: Pick<VerifiedBatch, "rejected"> = {};
  // Why the feedback attempt never reached a verification; the reduction then works from the first refusal.
  let unverified: string | undefined;
  if (options.retryRejected === true) {
    context.logger.warn("secure-it: asking the agent again with the verification's refusal", { problems });
    rejected = { rejected: first };
    try {
      await deps.revert(context.workingCopy, base.tree.id);
      const again = await context.agent<ReturnType<typeof skillInput>, SkillAnswer>({
        entrypoint: "secure-it", input: await agentInput(execution, plan, base.tree, "apply", { rejected: first }),
      });
      if (again.outcome !== "applied" || again.publication == null) {
        unverified = `the agent couldn't apply: ${again.summary}`;
      } else {
        assertNoPlanMarker(again.publication.body);
        cooldown = undefined;
        problems = await verifyEdit(context, deps, plan, env, inventories, base.tree, base.gradle, execution.npmFiles, heard);
        // Only once verified, so the problems and the publication are always the same attempt's.
        content = again.publication;
      }
    } catch (error) {
      unverified = `the attempt failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (unverified !== undefined) {
      context.logger.warn("secure-it: asking again didn't reach a verification", { why: unverified });
      problems = first;
    } else if (problems.length === 0) {
      return withCooldown(env, base.tree, { plan, content, problems, named: [], leftOut: plan.leftOut ?? [], ...rejected }, cooldown);
    }
  }
  // A failed outcome keeps what stopped the attempt with the refusal; a passing one is never touched.
  const noted = (batch: VerifiedBatch): VerifiedBatch =>
    unverified === undefined || batch.problems.length === 0 ? batch : { ...batch, problems: [...batch.problems, `asked again with that refusal, ${unverified}`] };
  const retry = retryWithoutNamed(plan, problems);
  if (retry.plan === undefined) return noted({ plan, content, problems, named: retry.named, leftOut: retry.leftOut, ...rejected });
  context.logger.warn("secure-it: retrying the routine without named package groups", { leftOut: retry.leftOut });
  let answer: SkillAnswer;
  let remaining: string[];
  try {
    await deps.revert(context.workingCopy, base.tree.id);
    answer = await context.agent<ReturnType<typeof skillInput>, SkillAnswer>({
      entrypoint: "secure-it", input: await agentInput(execution, retry.plan, base.tree, "apply"),
    });
    if (answer.outcome !== "applied" || answer.publication == null) {
      return noted({ plan: retry.plan, content, problems: [`retry could not apply: ${answer.summary}`], named: retry.named, leftOut: retry.plan.leftOut ?? [], ...rejected });
    }
    assertNoPlanMarker(answer.publication.body);
    cooldown = undefined;
    remaining = [...await verifyEdit(context, deps, retry.plan, env, inventories, base.tree, base.gradle, execution.npmFiles, heard)];
  } catch (error) {
    // After a feedback attempt, the report keeps its refusal whatever stopped the reduced one; otherwise as before.
    if (rejected.rejected === undefined) throw error;
    return noted({ plan: retry.plan, content, problems: [`retry failed: ${error instanceof Error ? error.message : String(error)}`], named: retry.named, leftOut: retry.plan.leftOut ?? [], ...rejected });
  }
  const batch = { plan: retry.plan, content: answer.publication!, problems: remaining, named: [...retry.named, ...namedProblems(retry.plan, remaining)], leftOut: retry.plan.leftOut ?? [], ...rejected };
  return noted(remaining.length === 0 ? await withCooldown(env, base.tree, batch, cooldown) : batch);
}

/**
 * The verified plan with what the verifying comparison's cooldown holds (and
 * the signals and advisory evidence people weigh), or without any; a cooldown
 * the comparison couldn't evaluate is a problem, never "nothing held".
 */
async function withCooldown(env: GateEnvironment, base: Tree, batch: VerifiedBatch, cooldown: CooldownEvaluation | undefined): Promise<VerifiedBatch> {
  if (cooldown?.evaluated === false) return { ...batch, problems: [`the cooldown can't be evaluated: ${cooldown.reason}`] };
  const { cooldown: _previous, ...plan } = batch.plan;
  const held = cooldown?.held ?? [];
  if (held.length === 0) return { ...batch, plan };
  const registry = new NpmRegistry(env.fetch);
  const { config } = await readSettings(base);
  const options = { fetch: env.fetch, token: env.githubToken, now: env.now, sourceRepos: { fetch: env.fetch, overrides: config.repositories, mavenRepositories: config.maven.repositories } };
  const planned: PlannedHold[] = [];
  for (const entry of held) {
    planned.push({ ...entry, signals: entry.ecosystem === "npm" ? await npmSignals(registry, entry) : [], ...await evidenceFor(entry, options) });
  }
  return { ...batch, plan: { ...plan, cooldown: planned } };
}

/** The evidence for people, or why it couldn't be read: informative, so it never fails the verification. */
async function evidenceFor(entry: HeldVersion, options: EvidenceOptions): Promise<Pick<PlannedHold, "evidence" | "evidenceFailure">> {
  try {
    const evidence = await heldEvidence(entry, options);
    return evidence === undefined ? {} : { evidence };
  } catch (error) {
    return { evidenceFailure: error instanceof Error ? error.message : String(error) };
  }
}

async function npmSignals(registry: NpmRegistry, entry: HeldVersion): Promise<string[]> {
  try {
    return releaseSignals(await registry.packument(entry.name), entry.name, entry.version, entry.replaced);
  } catch {
    return ["registry metadata unreadable"];
  }
}

async function recognisedPlans(
  context: ToolRunContext,
  publication: PublicationContext,
  own: ReadonlyArray<GitHubPullRequest>,
  plan: ChangePlan,
  claimed?: number,
): Promise<GitHubPullRequest[]> {
  const owned: GitHubPullRequest[] = [];
  const held = plan.kind === "routine" && isHeldTopic(plan.topic);
  for (const candidate of own) {
    // The recorded plan names the unit, not the branch: branch topics are cut and made branch-safe, so two packages can
    // share one (`@scope/foo` and `scope-foo`), and a numbered branch (`…-2`, next to one a human took over) is cut shorter.
    const previous = planOf(candidate.body);
    if (previous === undefined || previous.kind !== plan.kind) continue;
    // A held unit's PR is the one `heldClaims` gave it, whatever its topic says now.
    if (held ? candidate.number !== claimed || !isHeldTopic(previous.topic) : previous.topic !== plan.topic) continue;
    if (topicOf(RULES, candidate.headRef) === undefined) continue;
    const journaled = await publication.journal.last(context.repo.repo, candidate.number);
    // Legacy entries prove only the head: reconcile a freshly computed plan rather than trusting the body.
    const pr = journaled?.head === candidate.headSha && journaled.publication === undefined
      ? candidate : await recoverPublication(publication, candidate);
    const recorded = stateOf(pr.body);
    if (recorded?.head === pr.headSha || journaled?.head === pr.headSha) owned.push(pr);
  }
  return owned;
}

/** Capture the PR's publication history, then start its new plan from a clean, detached base. */
async function reconcileBranch(context: ToolRunContext, deps: SecureItDeps, pr: GitHubPullRequest, baseSha: string): Promise<PreparedBranch> {
  const merged = await context.workspace.prepareBranch(context.workingCopy, { branch: pr.headRef, start: "remote-merging" });
  if (merged.kind === "conflict") throw new Error(`${pr.headRef}: remote-merging reported a conflict without leaving it in progress`);
  if (merged.prepared.remoteHeadSha !== pr.headSha) throw new Error(`${pr.url} moved while secure-it prepared it`);
  if (merged.prepared.baseSha !== baseSha) throw new Error(`the default branch moved while secure-it ran (${baseSha.slice(0, 12)} → ${merged.prepared.baseSha.slice(0, 12)}); the next run starts over`);
  await deps.revert(context.workingCopy, baseSha);
  return merged.prepared;
}

/**
 * Item 23 on the working copy as the agent left it, against `base`: on a snapshot of it, never the live working tree,
 * whose tree is then the only one publication commits.
 */
async function verifyEdit(
  context: ToolRunContext,
  deps: SecureItDeps,
  plan: ChangePlan,
  env: GateEnvironment,
  inventories: GradleInventories,
  base: Tree,
  baseGradle: GradleInputs["head"],
  npmFiles?: ReadonlyMap<string, string>,
  cooldown?: (evaluation: CooldownEvaluation) => void,
): Promise<string[]> {
  const candidate = await deps.snapshot(context.workingCopy);
  const head = await deps.trees.commit(context.workingCopy, candidate);
  const headGradle = await inventories.ofCommit(head);
  let reference: GradleInventory | undefined;
  try {
    reference = await referenceOf(plan, base, baseGradle, inventories);
  } catch (err) {
    return [`the plan's Gradle reference can't be built: ${(err as Error).message}`];
  }
  const changedFiles = await deps.changedBetween(context.workingCopy, base.id, candidate);
  const links = await deps.linkProblems(context.workingCopy, base.id, candidate);
  return [...links, ...await deps.verify({
    plan, base, head, env, npmFiles, gradle: { base: baseGradle, head: headGradle }, reference, changedFiles,
    ...(cooldown === undefined ? {} : { cooldown }),
  })];
}

/**
 * The base with the plan applied by Gradle (`gradle-reference.ts`): its floors removed for a floor removal, its
 * declaration moves and floors otherwise. The base's own inventory when the plan changes nothing there, or when its
 * moves can't be applied faithfully (verification reports why).
 */
async function referenceOf(plan: ChangePlan, base: Tree, baseGradle: GradleInputs["head"], inventories: GradleInventories): Promise<GradleInventory | undefined> {
  if (baseGradle === undefined) return undefined;
  if (plan.kind === "floor-removal") {
    const floors = (plan.floorRemoval?.floors ?? []).filter((floor) => floor.ecosystem === "Maven");
    return floors.length === 0 ? baseGradle : inventories.ofCommit(base, { transform: removalTransform(floors) });
  }
  const { moves, floors, problems } = referencePlan(plan, baseGradle);
  if (problems.length > 0 || (moves.length === 0 && floors.length === 0)) return baseGradle;
  return inventories.ofCommit(base, { transform: referenceTransform(moves, floors) });
}

async function review(context: ToolRunContext, deps: SecureItDeps): Promise<Readonly<Record<string, unknown>>> {
  const env = await deps.gate(context);
  const inventories = deps.gradle(context);
  const publication = publicationOf(context, deps);
  const execution = { context, deps, env, inventories, publication, npmFiles: new Map<string, string>(), branches: new Set<string>() };
  const notes: Array<Readonly<Record<string, unknown>>> = [];
  const planFrom = (pr: GitHubPullRequest): ChangePlan => {
    const plan = planOf(pr.body);
    if (plan === undefined) throw new Error(`${pr.url} has no plan secure-it can read`);
    return plan;
  };
  /** Verifies a reviewed PR's new content and publishes it with its plan section; what verification left out is noted. */
  const verifyAndPublish = async (pr: GitHubPullRequest, prepared: PreparedBranch, base: PlanBase, plan: ChangePlan, content: Content, failure: string, attempt?: number) => {
    const verified = await verifyWithRetry(execution, base, plan, content);
    if (verified.leftOut.length > 0) notes.push({ number: pr.number, leftOut: verified.leftOut, named: verified.named });
    if (verified.problems.length > 0) throw new Error(`${failure}: ${verified.problems.join("; ")}`);
    return publishUpdate(publication, prepared, pr.number, { ...verified.content, body: withPlanSection(verified.content.body, verified.plan) }, attempt);
  };
  const steps: ReviewSteps = {
    cooldown: (pr) => cooldownState(planFrom(pr), context.now),
    async rebase(pr, merge: BaseMerge) {
      execution.npmFiles.clear();
      const previous = planFrom(pr);
      const baseSha = merge.prepared.baseSha;
      // Recomputed on the new base first: it may already have the fix, or need a different one.
      const base = await deps.trees.commit(context.workingCopy, baseSha);
      const baseGradle = await inventories.ofCommit(base);
      const found = await deps.candidates(base, env, { head: baseGradle });
      if (found.incomplete.length > 0) throw new Error(`the new base's inventory is incomplete: ${found.incomplete.join("; ")}`);
      if (previous.kind === "floor-removal") {
        if (found.fixes.some((fix) => fix.malicious)) throw new Error("malware on base must be fixed before removing floors");
        const removal = await computeRemoval(execution, { tree: base, gradle: baseGradle });
        notes.push({ number: pr.number, notes: removal.notes });
        if (removal.plan === undefined) {
          if (removal.notes.length > 0) throw new Error(`floor-removal recomputation is blocked; keeping the PR: ${removal.notes.join("; ")}`);
          await closeAndDelete(publication, pr.number, pr.headSha, "The default branch no longer has removable security floors.");
          return "retired";
        }
        // Recompute unlocked on every changed base; dependency conflicts are resolved by reverting the old plan.
        await deps.revert(context.workingCopy, baseSha);
        const content = await applyRemoval(execution, removal);
        const problems = await verifyEdit(context, deps, removal.plan, env, inventories, base, baseGradle);
        if (problems.length > 0) throw new Error(`floor removal after merging base: ${problems.join("; ")}`);
        await publishUpdate(publication, merge.prepared, pr.number, content);
        return "rebased";
      }
      const planned = await withParentsPlanned(found, { tree: base, gradle: baseGradle }, env, inventories);
      const { units, blocked } = await reviewUnits(previous, planned.fixes, planned.peers);
      if (blocked.length > 0) notes.push({ number: pr.number, blocked });
      // Split exactly as a run would, required-dependency moves included, before telling which unit is this PR's.
      const split = await holdRequiredYoung(execution, units, { tree: base, gradle: baseGradle });
      // A held PR is the unit a run would give it, so a run and a review never disagree on which PR is whose.
      const open = isHeldPlan(previous) ? await claimable(context, publication, await ownOpenPullRequests(context.github, RULES, context.repo.repo, context.base)) : [];
      const claims = heldClaims(split, open);
      const unit = unitOf(previous, split, claims, pr.number);
      if (unit === undefined) {
        await closeAndDelete(publication, pr.number, pr.headSha, "No actionable fixes remain for this security unit on the default branch. Blocked fixes are reported by secure-it.");
        return "retired";
      }
      const recomputed = await planUnit(execution, unit, { tree: base, gradle: baseGradle });
      // Plans predating batches retain their package scope and branch topic until retired.
      const plan = previous.kind === undefined ? { ...recomputed, kind: undefined, topic: previous.topic } : recomputed;
      if (plan.notes !== undefined && plan.notes.length > 0) notes.push({ number: pr.number, notes: plan.notes });
      const changed = planDigest(plan) !== planDigest(previous);
      const code: string[] = [];
      const restoredFiles = new Map<string, FileState>();
      if (changed) {
        // A different plan: the old one's edits go (conflicts included), the new one is applied on the base as it is.
        await deps.revert(context.workingCopy, baseSha);
      } else if (merge.kind === "conflicted") {
        for (const path of merge.conflicted) {
          const theirs = isMechanical(path) ? await base.read(path) : undefined;
          if (theirs === undefined) code.push(path);
          else {
            await deps.writeFile(context.workingCopy, path, theirs);
            restoredFiles.set(path, await deps.fileState(context.workingCopy, path));
          }
        }
      }
      // The agent applies a changed plan, or re-applies the same one over the base's side of conflicted dependency
      // files, resolving code conflicts too.
      let content = { title: pr.title, body: withPlanSection(pr.body, plan), commitMessage: `merging ${context.base}` };
      if (changed || merge.kind === "conflicted") {
        const answer = await context.agent<ReturnType<typeof skillInput>, SkillAnswer>({
          entrypoint: "secure-it",
          input: await agentInput(execution, plan, base, changed ? "apply" : "resolve", changed ? {} : { conflicted: code }, restoredFiles),
          restoredFiles: [...restoredFiles.values()],
        });
        if (answer.outcome !== "applied") throw new Error(`the agent couldn't re-apply the plan on the new base: ${answer.summary}`);
        // A different plan is a different change: its own title and description.
        if (changed && answer.publication != null) {
          assertNoPlanMarker(answer.publication.body);
          const body = `${answer.publication.body}\n\n${planSection(plan)}`;
          assertBodyFits(body);
          content = { title: answer.publication.title, body, commitMessage: answer.publication.commitMessage };
        }
      } else {
        await prepareNpmFiles(execution, plan, base, true);
      }
      // Fixes remain (the recomputation said so): an edit that left the base as it was fails verification, it isn't retired.
      await verifyAndPublish(pr, merge.prepared, { tree: base, gradle: baseGradle }, plan, content, "after merging the default branch");
      return "rebased";
    },
    async adapt(pr, prepared, _context, attempt) {
      execution.npmFiles.clear();
      const plan = planFrom(pr);
      if (plan.kind === "floor-removal") {
        context.logger.warn("secure-it: floor-removal CI failure cannot be adapted", { number: pr.number, detail: "the proved removal cannot legitimately be edited" });
        return false;
      }
      const checks = await context.github.headChecks({ repo: context.repo.repo, sha: pr.headSha });
      const failingChecks = failingCheckNames(checks);
      const base = await deps.trees.commit(context.workingCopy, prepared.baseSha);
      const answer = await context.agent<ReturnType<typeof skillInput>, SkillAnswer>({
        entrypoint: "secure-it",
        input: await agentInput(execution, plan, base, "adapt", { failingChecks }),
      });
      if (answer.outcome !== "applied" || answer.publication == null) return false;
      assertNoPlanMarker(answer.publication.body);
      const { pushed } = await verifyAndPublish(pr, prepared, { tree: base, gradle: await inventories.ofCommit(base) }, plan, answer.publication, "the adaptation doesn't verify", attempt);
      return pushed;
    },
  };
  const reviewed = await reviewOpenPullRequests({ ...publication }, steps);
  return { outcome: "reviewed", reviewed, notes };
}

/** Whether a PR's plan is held, and whether its last held version has aged by `now`. */
export function cooldownState(plan: ChangePlan, now: Date): CooldownState | undefined {
  const until = heldUntil(plan.cooldown ?? []);
  if (until === undefined) return undefined;
  return { kind: now.getTime() >= Date.parse(until) ? "aged" : "waiting", until };
}

/** New routine PRs recompute all non-majors; majors and legacy PRs retain their package scope. */
async function reviewUnits(previous: ChangePlan, fixes: ReadonlyArray<SecurityFix>, peers?: NpmPeerPlanner) {
  if (previous.kind !== "malware" && !previous.malware && fixes.some((fix) => fix.malicious)) {
    throw new Error("malware on the new base must be fixed together before this security unit can verify");
  }
  const ours = new Set(previous.packages);
  const scoped = previous.kind === "routine" || previous.malware ? fixes : fixes.filter((fix) => ours.has(packageKey(fix)));
  return coupledWork(scoped, peers);
}

/**
 * The recomputed unit an open PR stands for: several routine units can exist (the aged one and each held one). A held
 * PR (`number`) stands for the held unit `heldClaims` gives it among the open PRs, so a unit whose name changed keeps
 * its PR and no two PRs stand for one unit; the others, by topic.
 */
export function unitOf(previous: ChangePlan, units: ReadonlyArray<SecurityUnit>, claims: ReadonlyMap<string, number>, number: number): SecurityUnit | undefined {
  const kind = previous.malware ? "malware" : previous.kind;
  if (kind === undefined) return units[0];
  if (!isHeldPlan(previous)) return units.find((unit) => unit.kind === kind && (kind !== "routine" || unit.topic === previous.topic));
  return units.find((unit) => unit.kind === "routine" && isHeldTopic(unit.topic) && claims.get(unit.topic) === number);
}

function isHeldPlan(plan: ChangePlan): boolean {
  return !plan.malware && plan.kind === "routine" && isHeldTopic(plan.topic);
}
