/** Security fixes and a separate proved floor-removal unit; malware first, every publication verified. */
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { GitHubApiError } from "@leanish/agent-runtime/github/github-client";
import type { GitHubPullRequest } from "@leanish/agent-runtime/types/clients";
import type { PreparedBranch, WorkingCopy } from "@leanish/agent-runtime/types/working-copy";
import { ActionsGitHub } from "@leanish/gate/actions-github";
import { eligibleAt } from "@leanish/gate/age";
import type { Floor } from "@leanish/gate/floors";
import { type SecurityCandidates, type SecurityFix, securityCandidates, severityRank, withProblem } from "@leanish/gate/candidates";
import type { CooldownEvaluation } from "@leanish/gate/cooldown";
import type { NpmPeerPlanner } from "@leanish/gate/npm-peers";
import { type EvidenceOptions, heldEvidence } from "@leanish/gate/advisory-evidence";
import { type GateEnvironment, type GradleInputs, readScanState, readSettings, type ScanState } from "@leanish/gate/gate";
import { unexcusedProblem } from "@leanish/gate/exceptions";
import { findingsOf } from "@leanish/gate/findings";
import { type GradleInventory, gradleLocation, pinnedAmong, strictPinNote, strictPins } from "@leanish/gate/gradle";
import { namingFailures } from "@leanish/gate/http";
import { FileRepositoryAdvisoryCache } from "@leanish/tool-runtime/repository-advisory-cache";
import { BundleReader } from "@leanish/gate/npm-bundles";
import { NpmRegistry, releaseSignals } from "@leanish/gate/npm-registry";
import { versionKey } from "@leanish/gate/package-version";
import type { HeldVersion } from "@leanish/gate/release-age";
import { runProcess } from "@leanish/gate/process";
import { gitTree, type Tree, workingTree } from "@leanish/gate/tree";
import type { ToolHandlers, ToolRunContext } from "@leanish/tool-runtime/command";
import { FLOORS_FILE, isMechanical } from "@leanish/tool-runtime/edit-checks";
import { writeLocalFile } from "@leanish/tool-runtime/local-files";
import { gradleSourceIndex } from "@leanish/gate/gradle-sources";
import { candidateTree, changedBetween, fileState, type FileState, linkProblems, snapshotCandidate } from "@leanish/tool-runtime/git-copies";
import { referenceTransform } from "@leanish/tool-runtime/gradle-reference";
import { type GradleInventories, lockfilesOf, sandboxedGradleInventories } from "@leanish/tool-runtime/inventories";
import { FileJournal, type PublicationJournal } from "@leanish/tool-runtime/journal";
import { withPlannedDependencyFields } from "@leanish/tool-runtime/npm-file-checks";
import { requireNpmExcludes } from "@leanish/tool-runtime/npm-version";
import { runSandboxed, sandboxWritable } from "@leanish/tool-runtime/sandboxed";
import { ensureOsvScanner, verifyingRun } from "@leanish/tool-runtime/osv-scanner";
import { prepareUnitBranch } from "@leanish/tool-runtime/branches";
import { branchFor, ownPullRequests, topicOf } from "@leanish/tool-runtime/own-pr";
import { inspectOwnership, type Ours, type Ownership, repairOwnership, samePlan } from "@leanish/tool-runtime/ownership";
import { publicationParent, revertToBase } from "@leanish/tool-runtime/reconcile";
import { assertPublishable, closeAndDelete, ownOpenPullRequests, type PublicationContext, publishNew, publishUpdate, rewriteText } from "@leanish/tool-runtime/publication";
import { machineRoots } from "@leanish/tool-runtime/publication-text";
import { type BaseMerge, reviewOpenPullRequests, type ReviewSteps } from "@leanish/tool-runtime/review";

import { versionCatalogs } from "@leanish/gate/gate";
import { isTrustedPackage } from "@leanish/gate/config";
import { cleanBody, withCanonical } from "@leanish/tool-runtime/publication-text";
import { assessmentOf, decisionMoves, type PlannedUnit, youngOf } from "./issue-assessment.ts";
import { type ObservedFinding, type PackageVersion, subjectId } from "./issue-model.ts";
import { postNotice } from "./issue-notices.ts";
import { syncIssues } from "./issue-sync.ts";
import { attemptBranches, type Disposition, inactiveLabelNotices, issueDisposition, type Tracking, type TrackedExecution, UNSETTLED } from "./issue-tracking.ts";
import { type AttemptClient, type AttemptPatch, endAttempt, recoverAttempts, settleAttempt, showPullRequest } from "./issue-attempts.ts";
import { EarlyPrs, takenEarlyOf, trackedIssueOf } from "./decision-issues.ts";
import { earlyDecisions, reviewClosed, reviewDisposition, reviewExecution, type ReviewIssues, type ReviewPermit } from "./issue-review.ts";
import { trackingContent } from "./issue-text.ts";
import { removalTransform } from "./floor-gradle.ts";
import { probeOnBase } from "./floor-probe.ts";
import { type ComputedRemoval, type RemovalProbe, floorsOf, selectRemovals } from "./floor-removal.ts";
import { reconcileNpmFloors } from "./npm-floor-history.ts";
import { materializeOnBase } from "./npm-materialize.ts";
import { withGradleParents } from "./gradle-parents.ts";
import { withParents } from "./npm-parents.ts";
import { requiredNpmPlan } from "./npm-required-plan.ts";
import { npmWindowFor } from "./npm-window.ts";
import { assertNoPlanMarker } from "@leanish/tool-runtime/plan-blocks";
import { assertNoUndecidedMoves, byPackage } from "@leanish/tool-runtime/undecided-moves";
import { planDigest, planOf, planSection, withPlanSection } from "./plan-block.ts";
import { type ChangePlan, coupledWork, type FixWork, youngUnits, packageKey, planFor, type PlannedHold, type SecurityUnit, type Selection, withUnsupportedCarriers } from "./plan.ts";
import { planningCause } from "./planning-cause.ts";
import { namedProblems, retryWithoutNamed, type ProblemMoves } from "./retry.ts";
import { referencePlan, verifyPlan, type VerifyInputs } from "./verify.ts";
import { youngAt } from "./young-at.ts";

export const RULES = ownPullRequests("secure-it");

/** What is about to execute: a unit's plan, a verification's retry, a floor removal, a reviewed PR's. */
export interface ExecutionTarget {
  readonly kind: "unit" | "retry" | "removal" | "review";
  readonly plan: ChangePlan;
  /** For a retry: the unit's own plan, which decides it (a reduced plan is a different decision, never authorized as one). */
  readonly of?: ChangePlan;
  /** The PR a review step works on. */
  readonly pr?: number;
  /** For a unit: the branch of the open PR it would reuse; an early attempt publishes there instead of a reserved one. */
  readonly branch?: string;
}

export type { Disposition } from "./issue-tracking.ts";

const PROCEED: Disposition = { kind: "proceed" };
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
  /** The tree's scan state (`readScanState`), read once and shared with candidate planning and issue tracking. */
  readonly scan: (tree: Tree, env: GateEnvironment, gradle: GradleInputs) => Promise<ScanState>;
  readonly candidates: (tree: Tree, env: GateEnvironment, gradle: GradleInputs, scanned?: ScanState) => Promise<SecurityCandidates>;
  /**
   * Whether a plan may execute now: asked right before every step that would run its versions (a branch prepared for
   * it, npm files materialized, a Gradle reference, the agent, a verification). `defer` stops it there, as an outcome.
   */
  readonly disposition: (target: ExecutionTarget) => Promise<Disposition>;
  /** The wall clock issue writes are stamped by (`syncIssues`); the system's when absent. */
  readonly clock?: () => Date;
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
    scan: readScanState,
    candidates: securityCandidates,
    // Every plan executes as it always did; the issue flow decides otherwise.
    disposition: async () => PROCEED,
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
  readonly failingChecks?: ReadonlyArray<string>;
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
    await requireNpmExcludes((_dir, args) => deps.npm(context, args), context.workingCopy.path, window.exclude, "young security targets or proved requirements, unreadable or young locked base versions, or trusted-package exclusions");
  }
  let files = await deps.materializeNpm(context, base, plan, window.exclude);
  if (reconcileFloors) files = reconcileNpmFloors(files, await deps.trees.working(context.workingCopy).read(FLOORS_FILE));
  execution.npmFiles.clear();
  for (const [path, text] of files) {
    execution.npmFiles.set(path, text);
    let output = text;
    if (path.endsWith("package.json") && plan.moves.some((move) => move.major)) {
      const current = await deps.trees.working(context.workingCopy).read(path);
      if (current !== undefined) output = withPlannedDependencyFields(current, text);
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
  /** Whether the issue records a PR as a running early attempt, read once per PR in this run/tick; execution still asks its issue afresh. */
  readonly early: EarlyPrs;
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
  const scanned = await deps.scan(tree, env, { head: base.gradle });
  const found = await deps.candidates(tree, env, { head: base.gradle }, scanned);
  // A fix that can't be decided (its publisher identity, a carrier's reads) is blocked like a refused one, but it's a
  // check that failed: reported as an error, so the run reads as one that broke, while the other units still go on.
  // Spread last in every result, so no unit's own keys can replace it.
  const undecided = undecidedProblems(found.fixes);
  const report = { gaps: found.gaps.length, ...((found.notes?.length ?? 0) === 0 ? {} : { notes: found.notes }) };
  if (found.incomplete.length > 0) return { ...report, outcome: "incomplete", incomplete: found.incomplete, ...errorsOf(undecided) };
  const planned = await withParentsPlanned(found, base, env, inventories);
  const selection = await coupledWork(planned.fixes, planned.peers);
  const waiting = selection.blocked.flatMap((group) => group.reasons);
  // A direct-peer set whose checks failed is the same: an error, and its packages' PRs are kept.
  const failedChecks = [...undecided, ...(selection.undecided ?? []).map((set) => set.reason)];
  const undecidedPackages = byPackage([
    ...found.fixes.filter((fix) => fix.undecided === true).map((fix) => [packageKey(fix), fix.carries === undefined ? "publisher identity" : "carrier move"] as const),
    ...(selection.undecided ?? []).flatMap((set) => set.packages.map((key) => [key, "direct-peer set"] as const)),
  ]);

  const execution = { context, deps, env, inventories, publication: publicationOf(context, deps), npmFiles: new Map<string, string>(), branches: new Set<string>(), early: new EarlyPrs({ issues: context.issues, repo: context.repo.repo }) };
  const listed = await ownOpenPullRequests(context.github, RULES, context.repo.repo, context.base);
  const results: Readonly<Record<string, unknown>>[] = [];
  // Metadata first (no Gradle): the units and their plans. Then the issues decide what may execute.
  const prepared = await withRequiredYoung(execution, selection.units, base);
  let tracking: Tracking | Error;
  try {
    tracking = await trackIssues(execution, { tree, scanned, complete: found.incomplete.length === 0 && found.gaps.length === 0, prepared, blocked: selection.blocked, own: listed, base });
  } catch (error) {
    // Nothing executes without its issue: a sync that failed defers every unit this run, saying why.
    tracking = asError(error);
    context.logger.warn("secure-it: the issues couldn't be synced; nothing executes this run", { error: tracking.message });
  }
  // A sync that failed is a broken integration (a missing Issues permission, say): an error, so the run reads as one
  // that broke. One that didn't settle is retryable state: a note, so a summary still shows nothing executed.
  const unsynced = tracking instanceof Error ? `the issues couldn't be synced: ${tracking.message}` : undefined;
  const unsettled = !(tracking instanceof Error) && !tracking.sync.settled ? UNSETTLED : undefined;
  const errors = errorsOf([...failedChecks, ...(unsynced === undefined ? [] : [unsynced])]);
  // A PR taken early whose granted versions all aged is retired before any unit runs, as review would: this run plans
  // that work afresh, so no second PR for it opens beside it.
  const retired = tracking instanceof Error
    ? { own: listed, stuck: new Set<string>() }
    : await withoutAgedEarly(execution, listed, tracking, scanned.settings.config);
  const own = retired.own;
  // A unit with a package of an early PR that couldn't be retired waits this run, so no second PR opens beside that one.
  const waits = (unit: SecurityUnit) => unit.work.some((fix) => retired.stuck.has(packageKey(fix)));
  const governed = { ...execution, deps: { ...deps, disposition: tracking instanceof Error ? untracked(execution, tracking) : trackedDisposition(execution, tracking) } };
  const { units } = prepared;
  for (const unit of units) {
    if (waits(unit) && !prepared.failures.has(unit)) {
      results.push({ topic: unit.topic, outcome: "deferred", reason: "a PR taken early for its packages couldn't be retired this run" });
      continue;
    }
    try {
      const failure = failureOf(prepared, unit);
      if (failure !== undefined) throw failure;
      results.push(await runUnit(governed, unit, base, own, undecidedPackages));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      context.logger.warn("secure-it: a unit failed", { topic: unit.topic, error: detail });
      results.push({ topic: unit.topic, outcome: "failed", detail });
    }
  }
  if (!found.fixes.some((fix) => fix.malicious) && (await floorsOf(tree)).some((floor) => floor.purpose === "security")) {
    // A run whose issues couldn't be synced, or didn't settle, executes nothing, a floor removal included.
    const held = unsynced ?? unsettled;
    if (held !== undefined) {
      results.push({ topic: "floor-removal", outcome: "deferred", reason: held });
    } else {
      try {
        const removal = await computeRemoval(execution, base);
        results.push(removal.plan === undefined
          ? { topic: "floor-removal", outcome: "nothing-to-remove", notes: removal.notes }
          : await runRemoval(execution, removal, base, own));
      } catch (err) {
        results.push({ topic: "floor-removal", outcome: "failed", detail: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  if (results.length === 0) {
    const notes = [...new Set([...(found.notes ?? []), ...(unsettled === undefined ? [] : [unsettled])])];
    return { ...report, outcome: "nothing-to-fix", ...(notes.length === 0 ? {} : { notes }), waiting, blocked: selection.blocked, units: [], ...errors };
  }
  const outcome = results.length === 1 ? results[0]! : { outcome: "completed" };
  const unitNotes = Array.isArray(outcome["notes"]) ? outcome["notes"] : [];
  const notes = [...new Set([...(found.notes ?? []), ...unitNotes, ...(unsettled === undefined ? [] : [unsettled])])];
  return { ...report, ...outcome, ...(notes.length === 0 ? {} : { notes }), waiting, blocked: selection.blocked, units: results, ...errors };
}

/** Why each fix that can't be decided (`SecurityFix.undecided`: its publisher identity, a carrier's reads) has no move. */
function undecidedProblems(fixes: ReadonlyArray<SecurityFix>): string[] {
  return fixes.flatMap((fix) => (fix.undecided === true && fix.problem !== undefined ? [fix.problem] : []));
}

/** The run's `errors` field: checks that failed, each once, when there are any. */
function errorsOf(problems: ReadonlyArray<string>): { readonly errors?: ReadonlyArray<string> } {
  return problems.length > 0 ? { errors: [...new Set(problems)] } : {};
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
 * fresh plan has none yet), stays as published. Compared as written (`withPlanSection`), so evidence that no longer fits
 * with the new notes gives way there instead of failing the comparison.
 */
async function refreshText(execution: Execution, pr: GitHubPullRequest, plan: ChangePlan): Promise<void> {
  const previous = planOf(pr.body);
  if (previous === undefined) return;
  const refreshed = withNotesOf(previous, plan);
  if (withPlanSection(pr.body, refreshed) === withPlanSection(pr.body, previous)) return;
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
    return pinned.length === 0 ? fix : withProblem(fix, strictPinNote(fix.name, pinned));
  });
}

function declaringLocations(gradle: GradleInventory | undefined, name: string): string[] {
  return (gradle?.builds ?? []).flatMap((build) => build.configurations
    .filter((configuration) => configuration.declared.some((declared) => `${declared.group}:${declared.name}` === name))
    .map((configuration) => gradleLocation(build.build, configuration.id)));
}

// Automatic floor removal, kept on purpose: docs/simplification-candidates.md#reviewed-and-kept-2026-10-16.
/**
 * Proves which security floors can go, by probing the base without them (npm and Gradle, unlocked). The probe is how
 * secure-it learns what removing them would resolve, so no disposition precedes it: it runs only versions the base's
 * own requirements select. A young one it resolves is a known limit, and the removal it proves still asks before
 * executing (`runRemoval`, review's rebase).
 */
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
  const owned = await recognisedPlans(execution, own, { plan });
  const already = owned.find((candidate) => samePlan(candidate.pr, planDigest(plan), digestOf));
  const report = { topic: plan.topic, packages: plan.packages, notes: removal.notes };
  if (already !== undefined) {
    const pr = await repairOwnership(execution.publication, already);
    await refreshText(execution, pr, plan);
    return { ...report, outcome: "already-open", pullRequest: pr.url };
  }
  const disposition = await execution.deps.disposition({ kind: "removal", plan });
  if (disposition.kind === "defer") return { ...report, outcome: "deferred", reason: disposition.reason };
  const reusable = owned[0] === undefined ? undefined : await repairOwnership(execution.publication, owned[0]);
  const prepared = await preparePlan(execution, plan, reusable, own, base.tree.id);
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

/** The units a run or review works on, and why some of them can't run this time. */
interface YoungSplit {
  readonly units: SecurityUnit[];
  /** Units that fail with their own error instead of running: their planning failed. */
  readonly failures: ReadonlyMap<SecurityUnit, Error>;
  /**
   * Why the grouping of held work with npm is unknown, when it is: the aged plan, which decides which of its npm roots
   * join held work, failed. No held unit with npm work runs, and no held PR with npm moves is matched or retired,
   * against the grouping without it. Held work without npm can't be joined by those roots, so it goes on.
   */
  readonly ungrouped?: Error;
}

/**
 * Whether the aged plan's npm roots could join this held unit: its work or its coupled sets have an npm package. The
 * required-young moves, their bridges and the parent and carried sets they bring are npm-only.
 */
const hasNpmWork = (unit: SecurityUnit) => unit.work.some((fix) => fix.ecosystem === "npm")
  || (unit.coupled ?? []).some((set) => set.some((key) => key.startsWith("npm|")));

const asError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

/** Why a prepared unit can't run: its own failure, or, for held npm work, the failed aged plan that leaves its grouping unknown. */
function failureOf(prepared: YoungSplit, unit: SecurityUnit): Error | undefined {
  return prepared.failures.get(unit) ?? (prepared.ungrouped !== undefined && unit.young === true && hasNpmWork(unit) ? prepared.ungrouped : undefined);
}

/**
 * The aged unit's fixes that need a young required npm companion, grouped with it.
 * When the aged unit can't be planned, it fails with that error rather than being planned again; with npm work, which
 * of its roots the young requirements would hold is unknown, so the grouping of held npm work is too, whether or not
 * held units remain (a held PR whose fix has aged since could be held again by it).
 */
async function withRequiredYoung(execution: Execution, units: ReadonlyArray<SecurityUnit>, base: PlanBase): Promise<YoungSplit> {
  const unchanged = { units: [...units], failures: new Map<SecurityUnit, Error>() };
  const aged = units.find((unit) => unit.kind === "routine" && unit.young !== true);
  if (aged === undefined) return unchanged;
  let plan: ChangePlan;
  try {
    plan = await planUnit(execution, aged, base);
  } catch (error) {
    const failure = asError(error);
    // Only npm roots can require a young companion; without them the held grouping doesn't depend on this plan.
    const ungrouped = aged.work.some((fix) => fix.ecosystem === "npm")
      ? new Error(`the aged unit's plan, which decides which of its fixes join held work, failed: ${failure.message}`)
      : undefined;
    return { ...unchanged, failures: new Map([[aged, failure]]), ...(ungrouped === undefined ? {} : { ungrouped }) };
  }
  const moved = new Set((plan.requiredNpm ?? []).filter((target) => target.exempt).map((target) => `npm|${target.root.name}`));
  if (moved.size === 0) return unchanged;
  // requiredNpmPlan's coupled sets keep only moved packages: each young requirement joins its root and target here
  // instead, so roots requiring one young companion move together. An aged companion joins nothing: it holds no one.
  const bridges = (plan.requiredNpm ?? []).filter((target) => target.exempt).map((target) => [`npm|${target.root.name}`, `npm|${target.name}`]);
  for (;;) {
    const size = moved.size;
    for (const set of [...(plan.coupled ?? []), ...bridges]) if (set.some((key) => moved.has(key))) for (const key of set) moved.add(key);
    if (moved.size === size) break;
  }
  const held = units.filter((unit) => unit.kind === "routine" && unit.young === true);
  const stays = aged.work.filter((fix) => !moved.has(packageKey(fix)));
  const joined = youngUnits(
    [...held.flatMap((unit) => unit.work), ...aged.work.filter((fix) => moved.has(packageKey(fix)))],
    // The aged plan's sets, not only the unit's: they include what planning required npm discovered (a root that
    // needs another root's fix), which the held units keep for their own retries too.
    [...held.flatMap((unit) => unit.coupled ?? []), ...(plan.coupled ?? []).filter((set) => set.some((key) => moved.has(key)))],
    bridges,
  );
  const rest = stays.length === 0 ? [] : [{ ...aged, work: stays, coupled: (aged.coupled ?? []).filter((set) => !set.some((key) => moved.has(key))) }];
  return { units: [...units.filter((unit) => unit !== aged && !held.includes(unit)), ...rest, ...joined], failures: new Map() };
}

/**
 * A PR's content as ownership establishes it: the journal's saved publication when its state was removed, otherwise
 * its current content; undefined when it isn't ours.
 */
function ownershipView(ownership: Ownership): GitHubPullRequest | undefined {
  if (ownership.kind !== "ours") return undefined;
  if (ownership.recovery === "state-removed" && ownership.saved !== undefined) {
    return { ...ownership.pr, title: ownership.saved.title, body: ownership.saved.body };
  }
  return ownership.pr;
}

async function planUnit(execution: Execution, unit: SecurityUnit, base: PlanBase): Promise<ChangePlan> {
  const actions = new ActionsGitHub(execution.env.fetch, execution.env.githubToken);
  const sources = base.gradle === undefined ? undefined : await gradleSourceIndex(base.tree);
  const lockfiles = await lockfilesOf(base.tree);
  const plan = await planFor(unit.work, { lockfiles, gradle: base.gradle, named: sources?.named, tagCommit: (action, tag) => actions.tagCommit(action, tag) }, unit);
  return execution.deps.requiredNpm(base.tree, plan, execution.env);
}

async function runUnit(
  execution: Execution,
  unit: SecurityUnit,
  base: PlanBase,
  own: ReadonlyArray<GitHubPullRequest>,
  undecided: ReadonlyMap<string, ReadonlyArray<string>>,
): Promise<Readonly<Record<string, unknown>>> {
  const { publication } = execution;
  const plan = await planUnit(execution, unit, base);
  const owned = await recognisedPlans(execution, own, { unit, plan });
  const already = owned.find((candidate) => samePlan(candidate.pr, planDigest(plan), digestOf));
  // The reused PR is checked before anything repairs, refreshes or redoes it.
  const reused = already ?? owned[0];
  const details = { topic: plan.topic, packages: plan.packages, notes: plan.notes ?? [] };
  if (reused !== undefined && !reused.pr.isDraft && await execution.early.is(reused.pr, plan)) {
    return { ...details, outcome: "deferred", reason: "a person marked the early PR ready" };
  }
  if (reused !== undefined) assertNoUndecidedMoves(planOf(reused.pr.body)?.moves, undecided);
  if (already !== undefined) {
    const pr = await repairOwnership(publication, already);
    await refreshText(execution, pr, plan);
    return { ...details, outcome: "already-open", pullRequest: pr.url };
  }
  const disposition = await execution.deps.disposition({ kind: "unit", plan, ...(owned[0] === undefined ? {} : { branch: owned[0].pr.headRef }) });
  if (disposition.kind === "defer") return { ...details, outcome: "deferred", reason: disposition.reason };
  const tracked = disposition.tracked;
  if (tracked === undefined) throw new Error("a version unit can't execute without its decision's issue");
  const attempt = tracked.attempt;
  if (attempt === undefined) return executeUnit(execution, plan, base, owned[0], own, details, tracked);
  // One grant runs one attempt; every post-start failure is settled here or recovered next run.
  let result: Readonly<Record<string, unknown>>;
  try {
    result = await executeUnit(execution, plan, base, owned[0], own, details, tracked);
    await settleAttempt(attemptClient(execution), tracked.issue, attempt.id, attemptPatchOf(result), tracked.assessment);
  } catch (error) {
    // A publication can fail after its PR exists (a label, say): that PR is the attempt's, still running.
    await endAttempt(attemptClient(execution), tracked.issue, attempt.id, tracked.assessment).catch((failure: unknown) => {
      execution.context.logger.warn("secure-it: an early attempt couldn't be ended", { issue: tracked.issue, error: asError(failure).message });
    });
    throw error;
  }
  return result;
}

/** A unit its issue lets execute: applied, verified and published. */
async function executeUnit(
  execution: Execution,
  plan: ChangePlan,
  base: PlanBase,
  owned: Ours | undefined,
  own: ReadonlyArray<GitHubPullRequest>,
  details: Readonly<Record<string, unknown>>,
  tracked: TrackedExecution,
): Promise<Readonly<Record<string, unknown>>> {
  const { context, publication } = execution;
  const reusable = owned === undefined ? undefined : await repairOwnership(publication, owned);
  const prepared = await preparePlan(execution, plan, reusable, own, base.tree.id, reusable === undefined ? tracked.attempt?.branch : undefined);
  const input = await agentInput(execution, plan, base.tree, "apply");
  const answer = await context.agent<ReturnType<typeof skillInput>, SkillAnswer>({ entrypoint: "secure-it", input });
  if (answer.outcome !== "applied" || answer.publication == null) return { ...details, outcome: "cannot-apply", summary: answer.summary };
  assertNoPlanMarker(answer.publication.body);
  const admits = await admitted(base.tree, tracked.young);
  const verified = await verifyWithRetry(execution, base, plan, answer.publication, { retryRejected: true, admits });
  const checked = {
    ...details, notes: verified.plan.notes ?? [], packages: verified.plan.packages, named: verified.named, leftOut: verified.leftOut,
    ...(verified.rejected === undefined ? {} : { rejected: verified.rejected }),
  };
  if (verified.unplanned !== undefined) {
    // Verification found a young version planning didn't choose (a transitive move, say): its issue never allowed it.
    const unplanned = verified.unplanned;
    const next = tracked.attempt === undefined
      ? "a run tries again, and goes ahead once they're past the wait"
      : "this `take-early` attempt has ended; a new reason and label authorize another, or a run goes ahead once they're past the wait";
    await postNotice({ issues: context.issues, repo: context.repo.repo, clean: issueCleaner(context) }, tracked.issue, `unplanned-young:${unplanned.join(",")}`,
      `secure-it applied this decision, but verification found young versions it didn't plan: ${unplanned.map((entry) => `\`${entry}\``).join(", ")}. Nothing was published; ${next}.`);
    return { ...checked, outcome: "deferred", reason: `verification found young versions its issue #${tracked.issue} doesn't allow: ${unplanned.join(", ")}`, problems: verified.problems };
  }
  if (verified.deferred !== undefined) return { ...checked, outcome: "deferred", reason: verified.deferred, problems: verified.problems };
  if (verified.problems.length > 0) return { ...checked, outcome: "verification-failed", problems: verified.problems };
  const published = trackingContent(verified.content, tracked.issue, tracked.attempt !== undefined);
  const content = { ...published, body: withPlanSection(published.body, verified.plan) };
  // An ordinary unit's PR shows on its issue at once, only when it carries the whole decision (a retry can reduce it).
  const show = async (pr: { readonly number: number; readonly url: string }) => {
    if (tracked.attempt === undefined && decisionIdOf(verified.plan) === decisionIdOf(plan)) await showPublished(execution, tracked, pr);
  };
  if (reusable !== undefined) {
    const { pr } = await publishUpdate(publication, prepared, reusable.number, content, 0);
    await show({ number: pr.number, url: pr.url });
    return { ...checked, outcome: "updated", pullRequest: pr.url, number: pr.number };
  }
  const created = await publishNew(publication, prepared, content);
  if (created !== undefined) await show({ number: created.number, url: created.url });
  return created === undefined
    ? { ...checked, outcome: "nothing-changed", summary: answer.summary }
    : { ...checked, outcome: "published", pullRequest: created.url, number: created.number };
}

/** Which held versions an execution may take: the ones its issue allows, and any trusted package's. */
async function admitted(base: Tree, allowed: ReadonlyArray<PackageVersion>): Promise<(held: HeldVersion) => boolean> {
  const { config } = await readSettings(base);
  return (held) => isTrustedPackage(config.trustedPackages, held)
    || allowed.some((young) => versionKey(young) === versionKey(held));
}

/**
 * The PR an ordinary unit just published, or redid, with its whole decision, shown on its issue now rather than at the
 * next run's sync. The PR exists either way, so a write that fails (a rate limit too: whatever the run does next meets
 * it) is logged, never the unit's failure.
 */
async function showPublished(execution: Execution, tracked: TrackedExecution, pr: { readonly number: number; readonly url: string }): Promise<void> {
  await showPullRequest(attemptClient(execution), tracked.issue, pr, tracked.assessment).catch((error: unknown) => {
    execution.context.logger.warn("secure-it: a published PR couldn't be shown on its issue; the next run's sync shows it", { issue: tracked.issue, pr: pr.number, error: asError(error).message });
  });
}

/** How a unit's result ends (or continues) the early attempt it ran. */
function attemptPatchOf(result: Readonly<Record<string, unknown>>): AttemptPatch {
  switch (result["outcome"]) {
    case "published":
    case "updated":
      return { pr: result["number"] as number };
    case "cannot-apply":
      return { outcome: "agent-refused" };
    case "deferred":
      return { outcome: "deferred" };
    default:
      return { outcome: "failed" };
  }
}

/** The run's own PRs after retiring aged early ones, and the packages of any whose retirement failed (`withoutAgedEarly`). */
interface AgedEarlyRetired {
  readonly own: GitHubPullRequest[];
  readonly stuck: ReadonlySet<string>;
}

/**
 * `own` without the PRs taken early whose granted versions have all aged, each closed as review graduates one, its
 * attempt ended and its label returned. Early is what the issue records (a running attempt that is the PR's), not the
 * gate's cooldown, which can hold nothing for a version new only where it arrives. Only the tool's own drafts: one a
 * person marked ready, or someone pushed to, stays theirs.
 */
async function withoutAgedEarly(execution: Execution, own: ReadonlyArray<GitHubPullRequest>, tracking: Tracking, config: ScanState["settings"]["config"]): Promise<AgedEarlyRetired> {
  const { context } = execution;
  const eligibleAtFor = eligibleAtOf(execution, config);
  const aged = async (pkg: PackageVersion) => {
    if (isTrustedPackage(config.trustedPackages, pkg)) return true;
    const at = await eligibleAtFor(pkg).catch(() => undefined);
    return !youngAt(at, context.now);
  };
  // A rate limit stops the run as before, wherever it comes from: going on would only spend more of the limit.
  const rateLimited = (error: unknown) => error instanceof GitHubApiError && error.reason === "rate limited";
  const kept: GitHubPullRequest[] = [];
  const stuck = new Set<string>();
  for (const pr of own) {
    const number = trackedIssueOf(pr.body);
    const record = tracking.sync.tracked.find((issue) => issue.number === number)?.record;
    const attempt = record?.attempts.find((entry) => entry.pr === pr.number && entry.outcome === undefined);
    const grant = record?.grant;
    // One PR's retirement failing (someone pushed to it or closed it meanwhile) leaves that PR as it is this run, never
    // the run: other units and floor removal still go on, but its packages' units wait, so no second PR opens beside it.
    let closed: Awaited<ReturnType<typeof closeAndDelete>> | undefined;
    try {
      const retire = number !== undefined && attempt !== undefined && grant?.labelEventId === attempt.grantEventId
        && (await Promise.all(grant.young.map(aged))).every(Boolean) && pr.isDraft && (await inspectOwnership(execution.publication, pr)).kind === "ours";
      if (retire) {
        closed = await closeAndDelete(execution.publication, pr.number, pr.headSha,
          "Every version this PR was taken early for is now past the release-age wait. secure-it retires this draft: this run plans that work again from the default branch, with fresh checks.",
          { onlyDraft: true });
      }
    } catch (error) {
      if (rateLimited(error)) throw error;
      // A failure after the close itself went through (its comment, its branch) still leaves the PR closed: read back.
      const now = number === undefined || attempt === undefined ? undefined
        : await execution.publication.github.getPullRequest({ repo: execution.publication.repo, number: pr.number }).catch((read: unknown) => {
          if (rateLimited(read)) throw read;
          return undefined;
        });
      if (now?.state === "closed") closed = "closed";
      else for (const pkg of planOf(pr.body)?.packages ?? []) stuck.add(pkg);
      context.logger.warn(closed === undefined
        ? "secure-it: a PR taken early couldn't be retired; it stays as it is this run, and its packages wait"
        : "secure-it: a PR taken early is closed, but retiring it didn't finish", { pr: pr.number, error: asError(error).message });
    }
    if (closed === undefined || closed === "not-draft") {
      kept.push(pr);
      continue;
    }
    // Closed: its attempt ends here, or, if that write fails, at the next run's recovery from the PR's history.
    await settleAttempt(attemptClient(execution), number!, attempt!.id, { outcome: "pr-closed" }, tracking.assessment).catch((error: unknown) => {
      if (rateLimited(error)) throw error;
      context.logger.warn("secure-it: a retired PR's attempt couldn't be ended; the next run's recovery ends it", { pr: pr.number, error: asError(error).message });
    });
  }
  return { own: kept, stuck };
}

/** A plan's decision, as its issue's subject names it. */
const decisionIdOf = (plan: ChangePlan) => subjectId({ kind: "decision", moves: decisionMoves(plan) });

/** The issues and PRs an early attempt is settled with. */
function attemptClient(execution: Execution): AttemptClient {
  const { context } = execution;
  return {
    issues: context.issues, github: context.github, repo: context.repo.repo, clean: issueCleaner(context),
    ours: (pr) => topicOf(RULES, pr.headRef) !== undefined && pr.headRepo?.toLowerCase() === context.repo.repo.toLowerCase() && (pr.body.includes(RULES.marker) || pr.labels.includes(RULES.label)),
  };
}

/**
 * The plan's branch: the reused PR's, captured with its history and redone from a clean, detached base; or a fresh one,
 * the `reserved` one when an early attempt recorded it.
 */
function preparePlan(execution: Execution, plan: ChangePlan, reusable: GitHubPullRequest | undefined, own: ReadonlyArray<GitHubPullRequest>, baseSha: string, reserved?: string): Promise<PreparedBranch> {
  return prepareUnitBranch(execution.publication, {
    topic: plan.topic, reusable, own, taken: execution.branches, baseSha, now: execution.context.now, revert: execution.deps.revert,
    ...(reserved === undefined ? {} : { reserved }),
  });
}

/** The digest of the plan a body records, for `samePlan`; undefined when it has none secure-it can read. */
function digestOf(body: string): string | undefined {
  const plan = planOf(body);
  return plan === undefined ? undefined : planDigest(plan);
}

interface VerifiedBatch {
  readonly plan: ChangePlan;
  readonly content: Content;
  readonly problems: ReadonlyArray<string>;
  readonly named: ReadonlyArray<ProblemMoves>;
  readonly leftOut: NonNullable<ChangePlan["leftOut"]>;
  /** What verification refused in the first attempt, when the agent was asked again with it. */
  readonly rejected?: ReadonlyArray<string>;
  /** Why a retry didn't run: its plan may not execute now (`disposition`). The first attempt's problems stand. */
  readonly deferred?: string;
  /** Young versions a comparison held that the execution's issue doesn't allow (`admits`); it stopped there. */
  readonly unplanned?: ReadonlyArray<string>;
}

/**
 * When the first edit fails, and the caller allows it (a fresh application, not a review's adaptation, which a restart
 * from the base would lose), ask the agent once more for the same plan with the refusal. Then restart once from the
 * same base without named package groups; never shrink malware or guess an unnamed cause.
 */
async function verifyWithRetry(
  execution: Execution,
  base: PlanBase,
  plan: ChangePlan,
  content: Content,
  options: {
    readonly retryRejected?: boolean;
    /**
     * Which young versions its issue lets this execution take. A comparison holding any other stops it there, failed
     * or not: no retry runs what it found (`unplanned`).
     */
    readonly admits?: (held: HeldVersion) => boolean;
  } = {},
): Promise<VerifiedBatch> {
  const { context, deps, env, inventories } = execution;
  if (execution.npmFiles.size === 0 && plan.moves.some((move) => move.ecosystem === "npm")) {
    const window = await npmWindowFor(plan, context.releaseAgeDays, context.releaseAgeExclude, context.now, env.fetch, await lockfilesOf(base.tree));
    for (const [path, text] of await deps.materializeNpm(context, base.tree, plan, window.exclude)) execution.npmFiles.set(path, text);
  }
  let cooldown: CooldownEvaluation | undefined;
  const heard = (evaluation: CooldownEvaluation) => {
    cooldown = evaluation;
  };
  const unplannedIn = (): string[] => (options.admits === undefined || cooldown?.evaluated !== true
    ? []
    : cooldown.held.filter((held) => !options.admits!(held)).map((held) => `${held.name}@${held.version}`));
  const stopped = (batch: Omit<VerifiedBatch, "deferred" | "unplanned">, found: string[]): VerifiedBatch =>
    ({ ...batch, unplanned: found, deferred: `verification found young versions its issue doesn't allow: ${found.join(", ")}` });
  const first = await verifyEdit(context, deps, plan, env, inventories, base.tree, base.gradle, execution.npmFiles, heard);
  const firstFound = unplannedIn();
  if (firstFound.length > 0) return stopped({ plan, content, problems: first, named: [], leftOut: plan.leftOut ?? [] }, firstFound);
  if (first.length === 0) return withCooldown(env, base.tree, { plan, content, problems: first, named: [], leftOut: plan.leftOut ?? [] }, cooldown);
  let problems = first;
  let rejected: Pick<VerifiedBatch, "rejected"> = {};
  // Why the feedback attempt never reached a verification; the reduction then works from the first refusal.
  let unverified: string | undefined;
  if (options.retryRejected === true) {
    const asked = await deps.disposition({ kind: "retry", plan, of: plan });
    if (asked.kind === "defer") return { plan, content, problems: first, named: [], leftOut: plan.leftOut ?? [], deferred: asked.reason };
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
        const found = unplannedIn();
        if (found.length > 0) return stopped({ plan, content, problems, named: [], leftOut: plan.leftOut ?? [], rejected: first }, found);
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
  const reduced = await deps.disposition({ kind: "retry", plan: retry.plan, of: plan });
  if (reduced.kind === "defer") return noted({ plan, content, problems, named: retry.named, leftOut: retry.leftOut, ...rejected, deferred: reduced.reason });
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
    const found = unplannedIn();
    if (found.length > 0) return stopped({ plan: retry.plan, content: answer.publication, problems: remaining, named: retry.named, leftOut: retry.plan.leftOut ?? [], ...rejected }, found);
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

/**
 * The plan's open PRs that are still the tool's, matched by their effective content (`inspectOwnership`): a PR whose
 * body lags behind its head is matched by the plan the journal saved for that head, not by its stale body. Read-only:
 * the caller repairs only the PR it uses. Every candidate is inspected, so an unreadable journal fails the unit.
 */
async function recognisedPlans(execution: Execution, own: ReadonlyArray<GitHubPullRequest>, target: { readonly plan: ChangePlan; readonly unit?: SecurityUnit }): Promise<Ours[]> {
  const owned: Ours[] = [];
  for (const pr of own) {
    if (topicOf(RULES, pr.headRef) === undefined) continue;
    const ownership = await inspectOwnership(execution.publication, pr);
    const effective = ownershipView(ownership);
    const plan = effective === undefined ? undefined : planOf(effective.body);
    if (ownership.kind !== "ours" || effective === undefined || plan === undefined) continue;
    if (matchesPlan(target, { pr: effective, plan, early: await execution.early.is(effective, plan) })) owned.push(ownership);
  }
  return owned;
}

/** Early PRs carry exact decisions; eligible ordinary PRs can reconcile their kind and full recorded topic. */
function matchesPlan(target: { readonly plan: ChangePlan; readonly unit?: SecurityUnit }, candidate: { readonly pr: GitHubPullRequest; readonly plan: ChangePlan; readonly early: boolean }): boolean {
  if (target.plan.kind !== candidate.plan.kind) return false;
  if (candidate.early) return decisionIdOf(target.plan) === decisionIdOf(candidate.plan);
  if (target.unit?.young === true || takenEarlyOf(candidate.pr.body)) return false;
  return target.plan.topic === candidate.plan.topic;
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
  // Trusted packages as the default branch configures them: their young versions in a PR need no grant.
  const { config } = await readSettings(await deps.trees.commit(context.workingCopy, context.workingCopy.headSha));
  const trusted = (pkg: { readonly ecosystem: SecurityFix["ecosystem"]; readonly name: string }) => isTrustedPackage(config.trustedPackages, pkg);
  const open = await ownOpenPullRequests(context.github, RULES, context.repo.repo, context.base);
  // Which PRs the issues record as early attempts, for this tick: dispositions, matching and retries share the answers.
  const early = new EarlyPrs({ issues: context.issues, repo: context.repo.repo });
  // Decisions taken early are never reduced by review. Read once per tick, when first asked.
  let taken: ReturnType<typeof earlyDecisions> | undefined;
  const decisions = () => (taken ??= earlyDecisions(open, early));
  const governed: SecureItDeps = {
    ...deps,
    disposition: async (target) => {
      if (target.kind === "retry" && target.of !== undefined && target.plan !== target.of && (await decisions()).has(decisionIdOf(target.of))) return { kind: "defer", reason: "a decision taken early is retried whole or not at all" };
      return deps.disposition(target);
    },
  };
  const execution = { context, deps: governed, env, inventories, publication, npmFiles: new Map<string, string>(), branches: new Set<string>(), early };
  const notes: Array<Readonly<Record<string, unknown>>> = [];
  const planFrom = (pr: GitHubPullRequest): ChangePlan => {
    const plan = planOf(pr.body);
    if (plan === undefined) throw new Error(`${pr.url} has no plan secure-it can read`);
    return plan;
  };
  const issues: ReviewIssues = {
    ...attemptClient(execution), now: context.now, trusted, eligibleAt: eligibleAtOf(execution, config),
    retire: (pr, comment) => closeAndDelete(publication, pr.number, pr.headSha, comment, { onlyDraft: true }),
  };
  // What each version PR's disposition allowed this tick: one snapshot per PR, so verification needs no second issue
  // read (a grant withdrawn meanwhile leaves the PR on the next tick).
  const permits = new Map<number, ReviewPermit>();
  const permitOf = (pr: GitHubPullRequest): ReviewPermit => {
    const permit = permits.get(pr.number);
    if (permit === undefined) throw new Error("a version PR can't be verified without its review disposition");
    return permit;
  };
  /**
   * Verifies a reviewed PR's new content and publishes it with its plan section; what verification left out is noted.
   * A PR tracking an issue keeps its `Tracks #N.` line whatever the agent rewrote, and publishes no young version
   * its grant didn't cover (or a trusted package's): a new one waits, said on the issue.
   */
  const verifyAndPublish = async (pr: GitHubPullRequest, prepared: PreparedBranch, base: PlanBase, plan: ChangePlan, content: Content, failure: string, attempt?: number) => {
    const tracked = trackedIssueOf(pr.body);
    if (tracked === undefined) throw new Error("a version PR can't be published without its decision's issue");
    const admits = await admitted(base.tree, permitOf(pr).young);
    const verified = await verifyWithRetry(execution, base, plan, content, { admits });
    if (verified.unplanned !== undefined) {
      const unplanned = verified.unplanned;
      await postNotice(issues, tracked, `unplanned-young:${pr.number}:${unplanned.join(",")}`,
        `secure-it didn't update #${pr.number}: on the new base, verification found young versions no grant covers: ${unplanned.map((entry) => `\`${entry}\``).join(", ")}. It tries again on a later review, and goes ahead once they're past the wait.`);
      return { deferred: `verification found young versions no grant covers: ${unplanned.join(", ")}` } as const;
    }
    if (verified.deferred !== undefined) return { deferred: verified.deferred } as const;
    if (verified.leftOut.length > 0) notes.push({ number: pr.number, leftOut: verified.leftOut, named: verified.named });
    if (verified.problems.length > 0) throw new Error(`${failure}: ${verified.problems.join("; ")}`);
    const published = trackingContent(verified.content, tracked, takenEarlyOf(pr.body));
    return publishUpdate(publication, prepared, pr.number, { ...published, body: withPlanSection(published.body, verified.plan) }, attempt);
  };
  const steps: ReviewSteps = {
    disposition: async (pr) => {
      const plan = planFrom(pr);
      if (plan.kind === "floor-removal") return { kind: "proceed" };
      const decided = await reviewDisposition(issues, pr, plan, early);
      if (decided.kind === "proceed") permits.set(pr.number, decided.permit);
      return decided;
    },
    closed: async (pr) => {
      const plan = planOf(pr.body);
      if (plan !== undefined) await reviewClosed(issues, pr, plan);
    },
    async rebase(pr, merge: BaseMerge) {
      execution.npmFiles.clear();
      const previous = planFrom(pr);
      const baseSha = merge.prepared.baseSha;
      // Recomputed on the new base first: it may already have the fix, or need a different one.
      const base = await deps.trees.commit(context.workingCopy, baseSha);
      const baseGradle = await inventories.ofCommit(base);
      const scanned = await deps.scan(base, env, { head: baseGradle });
      const found = await deps.candidates(base, env, { head: baseGradle }, scanned);
      if (found.incomplete.length > 0) throw new Error(`the new base's inventory is incomplete: ${found.incomplete.join("; ")}`);
      // A fix without a move because a check failed (its identity, a carrier's reads) isn't one the base no longer
      // needs. On any package, not only this PR's, since how fixes split into units (malware first) depends on all of
      // them: nothing is retired, replaced or rewritten until it can be decided.
      const undecided = undecidedProblems(found.fixes);
      if (undecided.length > 0) throw new Error(`a fix can't be decided on the new base; keeping the PR: ${undecided.join("; ")}`);
      if (previous.kind === "floor-removal") {
        if (found.fixes.some((fix) => fix.malicious)) throw new Error("malware on base must be fixed before removing floors");
        const removal = await computeRemoval(execution, { tree: base, gradle: baseGradle });
        notes.push({ number: pr.number, notes: removal.notes });
        if (removal.plan === undefined) {
          if (removal.notes.length > 0) throw new Error(`floor-removal recomputation is blocked; keeping the PR: ${removal.notes.join("; ")}`);
          await closeAndDelete(publication, pr.number, pr.headSha, "The default branch no longer has removable security floors.");
          return "retired";
        }
        if ((await deps.disposition({ kind: "review", plan: removal.plan, pr: pr.number })).kind === "defer") return "deferred";
        // Recompute unlocked on every changed base; dependency conflicts are resolved by reverting the old plan.
        await deps.revert(context.workingCopy, baseSha);
        const content = await applyRemoval(execution, removal);
        const problems = await verifyEdit(context, deps, removal.plan, env, inventories, base, baseGradle);
        if (problems.length > 0) throw new Error(`floor removal after merging base: ${problems.join("; ")}`);
        await publishUpdate(publication, merge.prepared, pr.number, content);
        return "rebased";
      }
      const planned = await withParentsPlanned(found, { tree: base, gradle: baseGradle }, env, inventories);
      const { units, blocked, undecided: undecidedPeers } = await reviewUnits(previous, planned.fixes, planned.peers);
      // The same for a direct-peer set whose checks failed: the moves it leaves out may still be needed.
      if (undecidedPeers !== undefined) {
        throw new Error(`a direct-peer set can't be decided on the new base; keeping the PR: ${undecidedPeers.map((set) => set.reason).join("; ")}`);
      }
      if (blocked.length > 0) notes.push({ number: pr.number, blocked });
      // Split exactly as a run would, required-dependency moves included, before telling which unit is this PR's.
      const prepared = await withRequiredYoung(execution, units, { tree: base, gradle: baseGradle });
      // Taken early under a grant that stood at this tick's disposition.
      const { early: takenEarly } = permitOf(pr);
      // Failed aged npm planning leaves early npm grouping unknown, even if its roots now appear aged.
      if (prepared.ungrouped !== undefined && takenEarly && previous.moves.some((move) => move.ecosystem === "npm")) throw prepared.ungrouped;
      const selected = await reviewPlan(execution, previous, prepared, { tree: base, gradle: baseGradle }, takenEarly);
      if (selected === undefined) {
        await closeAndDelete(publication, pr.number, pr.headSha, "No actionable fixes remain for this security unit on the default branch. Blocked fixes are reported by secure-it.");
        if (takenEarly) await reviewClosed(issues, pr, previous);
        return "retired";
      }
      const { unit, plan } = selected;
      if (plan.notes !== undefined && plan.notes.length > 0) notes.push({ number: pr.number, notes: plan.notes });
      const changed = planDigest(plan) !== planDigest(previous);
      // Re-applying or verifying the plan on the new base executes it: asked first, and a PR taken early only as the
      // decision its grant covered.
      // The young versions the recomputed unit takes, as a run assesses them: none may run without a grant.
      const young = (await youngOf(unit, plan, { trusted, eligibleAt: eligibleAtOf(execution, config), now: context.now }))
        .filter((entry) => !trusted(entry));
      const scoped = await reviewExecution(issues, pr, previous, plan, young);
      if (scoped.kind !== "proceed") {
        notes.push({ number: pr.number, left: scoped.reason });
        return "deferred";
      }
      if ((await deps.disposition({ kind: "review", plan, pr: pr.number })).kind === "defer") return "deferred";
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
          // Composed as publication will compose it (a held plan's evidence may give way), so the check measures that text.
          content = { title: answer.publication.title, body: withPlanSection(answer.publication.body, plan), commitMessage: answer.publication.commitMessage };
          assertPublishable(execution.publication, content);
        }
      } else {
        await prepareNpmFiles(execution, plan, base, true);
      }
      // Fixes remain (the recomputation said so): an edit that left the base as it was fails verification, it isn't retired.
      const published = await verifyAndPublish(pr, merge.prepared, { tree: base, gradle: baseGradle }, plan, content, "after merging the default branch");
      return "deferred" in published ? "deferred" : "rebased";
    },
    async adapt(pr, prepared, _context, attempt, failingChecks) {
      execution.npmFiles.clear();
      const plan = planFrom(pr);
      if (plan.kind === "floor-removal") {
        context.logger.warn("secure-it: floor-removal CI failure cannot be adapted", { number: pr.number, detail: "the proved removal cannot legitimately be edited" });
        return false;
      }
      if ((await deps.disposition({ kind: "review", plan, pr: pr.number })).kind === "defer") return "deferred";
      const base = await deps.trees.commit(context.workingCopy, prepared.baseSha);
      const answer = await context.agent<ReturnType<typeof skillInput>, SkillAnswer>({
        entrypoint: "secure-it",
        input: await agentInput(execution, plan, base, "adapt", { failingChecks }),
      });
      if (answer.outcome !== "applied" || answer.publication == null) return false;
      assertNoPlanMarker(answer.publication.body);
      const published = await verifyAndPublish(pr, prepared, { tree: base, gradle: await inventories.ofCommit(base) }, plan, answer.publication, "the adaptation doesn't verify", attempt);
      // Deferred after the agent ran (only a retry was): the attempt happened and counts, so it reports nothing pushed.
      return "deferred" in published ? false : published.pushed;
    },
  };
  const reviewed = await reviewOpenPullRequests({ ...publication }, steps);
  return { outcome: "reviewed", reviewed, notes };
}

/** Routine PRs recompute all non-majors; majors retain their package scope. */
async function reviewUnits(previous: ChangePlan, fixes: ReadonlyArray<SecurityFix>, peers?: NpmPeerPlanner) {
  if (previous.kind !== "malware" && !previous.malware && fixes.some((fix) => fix.malicious)) {
    throw new Error("malware on the new base must be fixed together before this security unit can verify");
  }
  const ours = new Set(previous.packages);
  const scoped = previous.kind === "routine" || previous.malware ? fixes : fixes.filter((fix) => ours.has(packageKey(fix)));
  return coupledWork(scoped, peers);
}

/** Match an early decision exactly; a related changed one reaches reviewExecution's notice rather than retirement. */
async function reviewPlan(execution: Execution, previous: ChangePlan, prepared: YoungSplit, base: PlanBase, early: boolean): Promise<PlannedUnit | undefined> {
  const related = prepared.units.filter((unit) => early
    ? unit.work.some((fix) => previous.moves.some((move) => move.ecosystem === fix.ecosystem && move.name === fix.name))
    : unit.kind === previous.kind && unit.topic === previous.topic);
  let changed: PlannedUnit | undefined;
  let failed: Error | undefined;
  for (const unit of related) {
    try {
      const failure = failureOf(prepared, unit);
      if (failure !== undefined) throw failure;
      const plan = await planUnit(execution, unit, base);
      if (!early || decisionIdOf(plan) === decisionIdOf(previous)) return { unit, plan };
      changed ??= { unit, plan };
    } catch (error) {
      failed ??= asError(error);
    }
  }
  if (failed !== undefined) throw failed;
  return changed;
}

/** What the run's issue flow reads: the shared scan, its units planned from metadata, and what blocked others. */
interface TrackingInputs {
  readonly tree: Tree;
  readonly scanned: ScanState;
  readonly complete: boolean;
  readonly prepared: YoungSplit;
  readonly blocked: Selection["blocked"];
  readonly own: ReadonlyArray<GitHubPullRequest>;
  readonly base: PlanBase;
}

/**
 * The open PRs a unit's run could reuse, as their ownership reads them (`ownershipView`): one someone else pushed to, or
 * whose ownership can't be read, is left out (the run itself fails on the latter, alone), so no issue names it.
 */
async function reusable(publication: PublicationContext, own: ReadonlyArray<GitHubPullRequest>): Promise<GitHubPullRequest[]> {
  const reusable: GitHubPullRequest[] = [];
  for (const pr of own) {
    if (topicOf(RULES, pr.headRef) === undefined) continue;
    const effective = await inspectOwnership(publication, pr).then(ownershipView, () => undefined);
    if (effective !== undefined) reusable.push(effective);
  }
  return reusable;
}

/**
 * What a run observed on the default branch, for its issues: every finding no valid exception covers, read from the
 * same scan state candidate planning uses (`readScanState`), before planning can fail. An excepted finding is a
 * decision the owner already wrote down, so it gets no issue. One observed finding per package and advisory group: its
 * installed versions, ids (every alias seen), whether any record is reviewed or malware, and the highest severity.
 * Sorted, so the same scan always reads the same.
 */
function observationsOf(scan: ScanState, today: string): ObservedFinding[] {
  const groups = new Map<string, { ecosystem: ObservedFinding["ecosystem"]; name: string; ids: Set<string>; versions: Set<string>; reviewed: boolean; malicious: boolean; severity: string | undefined }>();
  for (const finding of findingsOf(scan.packages, scan.snapshot)) {
    if (unexcusedProblem(finding, scan.settings.exceptions, scan.snapshot, today) === undefined) continue;
    const key = `${finding.ecosystem}|${finding.name}|${finding.advisory}`;
    const group = groups.get(key) ?? { ecosystem: finding.ecosystem, name: finding.name, ids: new Set<string>(), versions: new Set<string>(), reviewed: false, malicious: false, severity: undefined };
    for (const id of finding.ids) group.ids.add(id);
    group.ids.add(finding.advisory);
    group.versions.add(finding.version);
    group.reviewed ||= finding.reviewed;
    group.malicious ||= finding.malicious;
    if (severityRank(finding.severity) > severityRank(group.severity)) group.severity = finding.severity;
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => ({
      ecosystem: group.ecosystem, name: group.name, ids: [...group.ids].sort(), versions: [...group.versions].sort(),
      reviewed: group.reviewed, malicious: group.malicious, severity: group.severity,
    }))
    .sort((a, b) => `${a.ecosystem}|${a.name}|${a.ids[0]}`.localeCompare(`${b.ecosystem}|${b.name}|${b.ids[0]}`));
}

/** Observes, assesses and syncs the tool's issues for this run (`issue-tracking.ts`). */
async function trackIssues(execution: Execution, inputs: TrackingInputs): Promise<Tracking> {
  const { context } = execution;
  const today = context.now.toISOString().slice(0, 10);
  const { config } = inputs.scanned.settings;
  // A unit whose planning fails is left out, and the assessment is incomplete: its findings stay tracked (as
  // unassessed) and no issue is retired for it. The unit plans again when it runs: it fails there only if the error
  // persists, so a transient one leaves just this warning and the unassessed issue.
  const planned: PlannedUnit[] = [];
  const planningCauses = new Map<string, string>();
  let complete = inputs.complete;
  const failed = (unit: SecurityUnit, error: Error) => {
    complete = false;
    const packages = [...unit.work.map(packageKey), ...(unit.coupled ?? []).flat(),
      ...unit.work.flatMap((fix) => (fix.carries ?? []).map((carried) => packageKey({ ecosystem: fix.ecosystem, name: carried.name })))];
    const cause = planningCause(error.message);
    for (const key of packages) if (!planningCauses.has(key)) planningCauses.set(key, cause);
  };
  for (const unit of inputs.prepared.units) {
    const failure = failureOf(inputs.prepared, unit);
    if (failure !== undefined) {
      failed(unit, failure);
      continue;
    }
    try {
      planned.push({ unit, plan: await planUnit(execution, unit, inputs.base) });
    } catch (error) {
      const failure = asError(error);
      failed(unit, failure);
      context.logger.warn("secure-it: a unit can't be planned for its issue", { topic: unit.topic, error: failure.message });
    }
  }
  // Assessment names the same effective PR execution can reuse, with the same early-decision boundary.
  const recorded: Array<{ pr: GitHubPullRequest; plan: ChangePlan; early: boolean }> = [];
  for (const pr of await reusable(execution.publication, inputs.own)) {
    const plan = planOf(pr.body);
    if (plan !== undefined) recorded.push({ pr, plan, early: await execution.early.is(pr, plan) });
  }
  const assessment = await assessmentOf({
    sha: inputs.tree.id,
    now: context.now,
    complete,
    observations: observationsOf(inputs.scanned, today),
    units: planned,
    blocked: inputs.blocked,
    planningCauses,
    trusted: (pkg) => isTrustedPackage(config.trustedPackages, pkg),
    eligibleAt: eligibleAtOf(execution, config),
    prOf: (target) => {
      const found = recorded.find((entry) => matchesPlan(target, entry) && decisionIdOf(entry.plan) === decisionIdOf(target.plan));
      return found === undefined ? undefined : { number: found.pr.number, url: found.pr.url };
    },
  });
  const sync = await syncIssues({ issues: context.issues, repo: context.repo.repo, clean: issueCleaner(context), ...(execution.deps.clock === undefined ? {} : { clock: execution.deps.clock }) }, assessment);
  // Before any disposition: an attempt a previous run left running is settled from its PR, or ends as interrupted.
  const recovered = await recoverAttempts(attemptClient(execution), sync.tracked, assessment);
  // Recovery can attach a PR to its attempt: execution must not reuse assessment's earlier ownership answer.
  if (recovered.length > 0) execution.early.forget();
  for (const note of [...sync.notes, ...recovered]) context.logger.warn("secure-it: issues", { note });
  // Labels where they authorize nothing are said so too, whether or not anything here would execute.
  await inactiveLabelNotices({ issues: context.issues, repo: context.repo.repo, clean: issueCleaner(context) }, { assessment, sync });
  return { assessment, sync };
}

/** When a version is past the repository's wait, from its registry publication; undefined when that can't be read. */
function eligibleAtOf(execution: Execution, config: ScanState["settings"]["config"]): (pkg: { readonly ecosystem: SecurityFix["ecosystem"]; readonly name: string; readonly version: string }) => Promise<string | undefined> {
  const catalogs = versionCatalogs(config, execution.env, new ActionsGitHub(execution.env.fetch, execution.env.githubToken));
  return async (pkg) => {
    const published = await catalogs[pkg.ecosystem].published(pkg);
    return published === undefined ? undefined : eligibleAt(published, config.releaseAgeDays).toISOString();
  };
}

/** Local paths out of issue text, as publication keeps them out of PRs. */
function issueCleaner(context: ToolRunContext): (body: string) => string {
  const roots = { workingCopy: withCanonical([context.workingCopy.path]), other: machineRoots(context.config.dirs) };
  return (body) => cleanBody(body, roots);
}

/**
 * The run's disposition once its issues are known: units and their retries go by their decision's issue (a retry by
 * its unit's own plan; a reduced plan of a decision taken early is a different decision, never authorized as one);
 * floor removals and review steps keep the tool's default.
 */
function trackedDisposition(execution: Execution, tracking: Tracking): SecureItDeps["disposition"] {
  const client = { issues: execution.context.issues, repo: execution.context.repo.repo, clean: issueCleaner(execution.context), now: execution.context.now };
  // An early attempt publishes to the branch of the PR its unit reuses, or to one reserved for its grant alone.
  const branches = attemptBranches((labelEventId) => branchFor(RULES, client.now, `take-early-${labelEventId}`));
  return async (target) => {
    if (target.kind === "removal" || target.kind === "review") return execution.deps.disposition(target);
    const own = target.of ?? target.plan;
    const decided = await issueDisposition(tracking, own, client, (labelEventId) => branches(labelEventId, target.branch));
    if (decided.kind === "defer" || target.of === undefined || target.plan === target.of) return decided;
    const id = subjectId({ kind: "decision", moves: decisionMoves(own) });
    const subject = tracking.assessment.subjects.find((entry) => subjectId(entry.subject) === id);
    return subject?.status.kind === "eligible" ? decided : { kind: "defer", reason: "a decision taken early is retried whole or not at all" };
  };
}

/**
 * Every unit deferred: the issues that decide them couldn't be read or written this run. Review steps keep the tool's
 * default; a floor removal never gets here, since such a run defers it before computing it (`run`).
 */
function untracked(execution: Execution, failure: Error): SecureItDeps["disposition"] {
  return async (target) => (target.kind === "removal" || target.kind === "review"
    ? execution.deps.disposition(target)
    : { kind: "defer", reason: `the issues couldn't be synced: ${failure.message}` });
}
