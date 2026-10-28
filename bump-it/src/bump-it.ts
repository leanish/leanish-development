/** One routine PR and each major apart, with independent computation and verified publication. */
import { fileURLToPath } from "node:url";

import type { GitHubPullRequest } from "@leanish/agent-runtime/types/clients";
import type { BumpCandidate } from "@leanish/gate/candidates";
import type { ToolHandlers, ToolRunContext } from "@leanish/tool-runtime/command";
import { DEFAULT_MAX_NEW_MAJORS_PER_RUN } from "@leanish/tool-runtime/config";
import type { FileState } from "@leanish/tool-runtime/git-copies";
import { isMechanical } from "@leanish/tool-runtime/edit-checks";
import { prepareUnitBranch } from "@leanish/tool-runtime/branches";
import { branchFor, topicOf } from "@leanish/tool-runtime/own-pr";
import { inspectOwnership, type Ours, repairOwnership, samePlan } from "@leanish/tool-runtime/ownership";
import { closeAndDelete, ownOpenPullRequests, publishNew, publishUpdate, type PullRequestContent } from "@leanish/tool-runtime/publication";
import { machineRoots } from "@leanish/tool-runtime/publication-text";
import { reviewOpenPullRequests, type ReviewSteps } from "@leanish/tool-runtime/review";

import { WRAPPER_FILES, type WrapperCandidates } from "./gradle-wrapper.ts";
import { type BumpItDeps, defaultDeps } from "./deps.ts";
import { type Computed, compute, edit, type Execution, RULES, VerificationRejected, verify, writeNpm, writeWrapper } from "./operations.ts";
import { type BumpPlan, planDigest, planOf, withPlanSection } from "./plan.ts";
import { withRehoists } from "./plan-rehoists.ts";
import { majorUnits, packageKey, routineUnit, type Unit } from "./units.ts";
import { plannedFiles, wrapperFilesMatch } from "./verify.ts";

export { type BumpItDeps, defaultDeps } from "./deps.ts";
export { RULES } from "./operations.ts";

const SKILLS_DIR = fileURLToPath(new URL("../skills", import.meta.url));

export function bumpIt(deps: BumpItDeps = defaultDeps()): ToolHandlers {
  return {
    tool: "bump-it",
    skills: { dirs: [SKILLS_DIR], entrypoints: ["bump-it"], support: [] },
    run: (context) => run(context, deps),
    review: (context) => review(context, deps),
  };
}

async function createExecution(context: ToolRunContext, deps: BumpItDeps): Promise<Execution> {
  const env = await deps.gate(context);
  return {
    context,
    deps,
    env,
    wrapper: deps.wrapper(env, context.releaseAgeDays),
    inventories: deps.gradle(context),
    publication: {
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
    },
    branches: new Set(),
  };
}

interface UnitReport {
  readonly topic: string;
  readonly outcome: "published" | "updated" | "already-open" | "nothing-to-move" | "blocked" | "deferred" | "failed";
  readonly pullRequest?: string;
  readonly detail?: string;
  readonly notes?: ReadonlyArray<string>;
  /** What verification refused in the first attempt, when the agent was asked again with it. */
  readonly rejected?: ReadonlyArray<string>;
}

async function run(context: ToolRunContext, deps: BumpItDeps): Promise<Readonly<Record<string, unknown>>> {
  const execution = await createExecution(context, deps);
  const base = await deps.trees.commit(context.workingCopy, context.workingCopy.headSha);
  const gradle = await execution.inventories.ofCommit(base);
  const found = await deps.candidates(base, execution.env, { head: gradle });
  if (found.incomplete.length > 0) {
    return { outcome: "incomplete", incomplete: found.incomplete };
  }
  const wrapper = await execution.wrapper.candidates(base);
  const own = await ownOpenPullRequests(context.github, RULES, context.repo.repo, context.base);
  const priority = deps.priority(context);
  const deferredBefore = await priority.read();
  const order = (unit: Unit) => (unit.package === undefined ? -1 : deferredBefore.indexOf(unit.package));
  const majors = majorUnits(found.bumps, wrapper).sort((a, b) => (order(a) === -1 ? Infinity : order(a)) - (order(b) === -1 ? Infinity : order(b)));
  const units = [routineUnit(found.bumps, wrapper), ...majors];
  const maxNewMajors = context.config.maxNewMajorsPerRun ?? DEFAULT_MAX_NEW_MAJORS_PER_RUN;
  const prepared = await prepareUnits(execution, units, own, maxNewMajors, (unit) => compute(execution, unit, base, gradle, found.npmPeers, wrapper));
  // The first pass's failed peer sets protect every unit's PR before any acts. A new major computed later, if an
  // earlier one didn't publish, adds its failed sets only for units that haven't acted yet.
  const identities = found.bumps.filter((bump) => bump.undecided !== undefined).map((bump) => [packageKey(bump), "publisher identity"] as const);
  const computedBefore = [...prepared.values()].flatMap((entry) => (entry.computed === undefined ? [] : [entry.computed]));
  let undecided = byPackage([...identities, ...computedBefore.flatMap(undecidedPeerKeys)]);
  // Direct-peer sets whose checks failed, as each unit's computation found them.
  const undecidedPeers = computedBefore.flatMap((computed) => (computed.undecided ?? []).map((set) => set.reason));
  const results: UnitReport[] = [];
  const deferred: string[] = [];
  let openedMajors = 0;
  for (const unit of units) {
    try {
      const entry = prepared.get(unit)!;
      if (entry.error !== undefined) {
        throw entry.error;
      }
      if (unit.kind === "major" && entry.owned.length === 0 && openedMajors >= maxNewMajors) {
        results.push({ topic: unit.topic, outcome: "deferred" });
        deferred.push(unit.package!);
        continue;
      }
      let computed = entry.computed;
      if (computed === undefined) {
        // A new major past the first `maxNewMajors` that runs anyway (an earlier one didn't publish): computed in its turn.
        computed = await compute(execution, unit, base, gradle, found.npmPeers, wrapper);
        undecidedPeers.push(...(computed.undecided ?? []).map((set) => set.reason));
        undecided = byPackage([...[...undecided].flatMap(([key, causes]) => causes.map((cause) => [key, cause] as const)), ...undecidedPeerKeys(computed)]);
      }
      const result = await runUnit(execution, computed, unit, own, entry.owned, undecided);
      if (unit.kind === "major" && result.outcome === "published") {
        openedMajors++;
      }
      results.push(result);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      context.logger.warn("bump-it: a unit failed", { topic: unit.topic, error: detail });
      results.push({ topic: unit.topic, outcome: "failed", detail });
    }
  }
  await priority.write(deferred);
  // A dependency whose publisher identity couldn't be decided gets no move, as one with only refused versions, but it's a
  // check that failed: reported as an error too, so the run reads as one that broke. So is a direct-peer set whose
  // checks failed.
  // A routine and a major can block the same set the same way: reported once.
  const errors = [...new Set([...undecidedProblems(found.bumps), ...undecidedPeers])];
  return {
    outcome: "completed",
    units: results,
    notes: [...found.notes, ...wrapper.notes ?? []],
    gaps: found.gaps,
    waiting: found.bumps.flatMap((bump) => bump.problems.map((problem) => `${bump.name}@${bump.from}: ${problem}`)),
    ...(errors.length > 0 ? { errors } : {}),
  };
}

/** Why each dependency whose publisher identity couldn't be decided (`BumpCandidate.undecided`) has no move. */
function undecidedProblems(bumps: ReadonlyArray<BumpCandidate>): string[] {
  return bumps.flatMap((bump) => (bump.undecided === undefined ? [] : [`${bump.name}@${bump.from}: ${bump.undecided}`]));
}

/** A unit's open PRs and its computation when prepared in the first pass; or why either failed. */
interface PreparedUnit {
  readonly owned: ReadonlyArray<Ours>;
  readonly computed?: Computed;
  readonly error?: unknown;
}

/**
 * Every unit's open PRs, and the computation of the routine, majors with an open PR and the first `maxNewMajors` new
 * majors, before any unit acts: their failed peer sets then hold back every unit's PR. Later new majors may be
 * deferred, so aren't computed here; if one runs, its failed sets can't hold back PRs already handled. A failure is
 * the unit's, not the run's.
 */
async function prepareUnits(
  execution: Execution,
  units: ReadonlyArray<Unit>,
  own: ReadonlyArray<GitHubPullRequest>,
  maxNewMajors: number,
  computeUnit: (unit: Unit) => Promise<Computed>,
): Promise<ReadonlyMap<Unit, PreparedUnit>> {
  const prepared = new Map<Unit, PreparedUnit>();
  let newMajors = 0;
  for (const unit of units) {
    let owned: ReadonlyArray<Ours> = [];
    try {
      owned = await recognised(execution, unit, own);
      if (unit.kind === "major" && owned.length === 0 && newMajors++ >= maxNewMajors) {
        prepared.set(unit, { owned });
        continue;
      }
      prepared.set(unit, { owned, computed: await computeUnit(unit) });
    } catch (error) {
      prepared.set(unit, { owned, error });
    }
  }
  return prepared;
}

/** The npm packages `computed`'s direct-peer sets that can't be decided leave out, as package key → cause. */
function undecidedPeerKeys(computed: Computed): Array<readonly [string, string]> {
  return (computed.undecided ?? []).flatMap((set) => set.names.map((name) => [`npm|${name}`, "direct-peer set"] as const));
}

/** Causes by package key, each once: a key with more than one keeps them all, none overriding another. */
function byPackage(entries: ReadonlyArray<readonly [string, string]>): ReadonlyMap<string, ReadonlyArray<string>> {
  const causes = new Map<string, string[]>();
  for (const [key, cause] of entries) {
    const known = causes.get(key) ?? [];
    if (!known.includes(cause)) {
      causes.set(key, [...known, cause]);
    }
  }
  return causes;
}

/**
 * Throws, keeping the PR, when the plan an open PR records moves a dependency (by ecosystem and name) that can't be
 * decided now (`undecided`: package key → what can't be: its publisher identity, its direct-peer set, or both): the
 * recomputed plan lacks that move only because a check failed, so reusing the PR would rewrite it as if the move were no
 * longer needed.
 */
function assertNoUndecidedMoves(recorded: BumpPlan | undefined, undecided: ReadonlyMap<string, ReadonlyArray<string>>): void {
  const lost = new Map((recorded?.moves ?? []).filter((move) => undecided.has(packageKey(move))).map((move) => [packageKey(move), move]));
  if (lost.size === 0) {
    return;
  }
  throw new Error([...lost.values()].map((move) => `${move.ecosystem} ${move.name}'s ${undecided.get(packageKey(move))!.join(" and ")} can't be decided; keeping the PR`).join("; "));
}

/**
 * The unit's open PRs that are still the tool's, matched by their effective content (`inspectOwnership`): a PR whose
 * body lags behind its head is matched by the plan the journal saved for that head, not by its stale body. Read-only:
 * the unit repairs only the PR it uses. Every candidate is inspected, so an unreadable journal fails the unit.
 */
async function recognised(execution: Execution, unit: Unit, own: ReadonlyArray<GitHubPullRequest>): Promise<Ours[]> {
  const matches: Ours[] = [];
  for (const candidate of own) {
    const ownership = await inspectOwnership(execution.publication, candidate);
    // Someone else's push or rewrite is skipped. Legacy entries prove only the head: kept for reconciliation, never `samePlan`.
    if (ownership.kind !== "ours") {
      continue;
    }
    const plan = planOf(ownership.pr.body);
    if (plan === undefined || plan.kind !== unit.kind || plan.package !== unit.package || plan.topic !== unit.topic) {
      continue;
    }
    const topic = topicOf(RULES, ownership.pr.headRef);
    // The block and branch must name this unit. A suffix is the tool's PR beside one a human took over.
    const branchTopic = topicOf(RULES, branchFor(RULES, execution.context.now, unit.topic))!;
    const suffix = /^(.*)-(\d+)$/.exec(topic ?? "");
    const suffixed = suffix !== null && Number(suffix[2]) >= 2 && suffix[1] === branchTopic.slice(0, 60 - suffix[2]!.length - 1);
    if (topic !== branchTopic && !suffixed) {
      continue;
    }
    matches.push(ownership);
  }
  return matches;
}

/** The digest of the plan a body records, for `samePlan`; undefined when it has none bump-it can read. */
function digestOf(body: string): string | undefined {
  const plan = planOf(body);
  return plan === undefined ? undefined : planDigest(plan);
}

const empty = (computed: Computed) => computed.plan.moves.length === 0 && computed.files.size === 0;

async function runUnit(
  execution: Execution,
  computed: Computed,
  unit: Unit,
  own: ReadonlyArray<GitHubPullRequest>,
  owned: ReadonlyArray<Ours>,
  undecided: ReadonlyMap<string, ReadonlyArray<string>>,
): Promise<UnitReport> {
  const same = owned.find((candidate) => samePlan(candidate.pr, planDigest(computed.plan), digestOf));
  // The PR this unit reuses, checked before anything repairs or redoes it, and before a unit left blocked or empty by
  // what can't be decided reads as one with nothing to do.
  const reused = same ?? owned[0];
  if (reused !== undefined) {
    assertNoUndecidedMoves(planOf(reused.pr.body), undecided);
  }
  if (computed.blocked !== undefined) {
    return { topic: unit.topic, outcome: "blocked", detail: computed.blocked, notes: computed.plan.notes };
  }
  if (empty(computed)) {
    return { topic: unit.topic, outcome: "nothing-to-move", notes: computed.plan.notes };
  }
  if (same !== undefined) {
    const pr = await repairOwnership(execution.publication, same);
    return { topic: unit.topic, outcome: "already-open", pullRequest: pr.url, notes: computed.plan.notes };
  }
  const reusable = owned[0] === undefined ? undefined : await repairOwnership(execution.publication, owned[0]);
  const prepared = await prepareUnitBranch(execution.publication, {
    topic: unit.topic, reusable, own, taken: execution.branches, baseSha: computed.base.id, now: execution.context.now, revert: execution.deps.revert,
  });
  const { content, rejected } = await applyVerified(execution, computed);
  const retried = rejected === undefined ? {} : { rejected };
  if (reusable !== undefined) {
    const { pr } = await publishUpdate(execution.publication, prepared, reusable.number, content, 0);
    return { topic: unit.topic, outcome: "updated", pullRequest: pr.url, notes: computed.plan.notes, ...retried };
  }
  const pr = await publishNew(execution.publication, prepared, content);
  return {
    topic: unit.topic,
    outcome: pr === undefined ? "nothing-to-move" : "published",
    ...(pr === undefined ? {} : { pullRequest: pr.url }),
    notes: computed.plan.notes,
    ...retried,
  };
}

/**
 * Applies the plan and verifies it. When verification refuses what the agent wrote, the agent is asked once more,
 * from the base, with the refusal; a second refusal fails the unit as before. A pass the tool wrote alone isn't retried.
 */
async function applyVerified(execution: Execution, computed: Computed): Promise<{ readonly content: PullRequestContent; readonly rejected?: ReadonlyArray<string> }> {
  const first = await edit(execution, computed, "apply");
  try {
    await verify(execution, computed, first.toolWritten);
    return { content: first.content };
  } catch (error) {
    if (!(error instanceof VerificationRejected) || first.toolWritten !== undefined) throw error;
    execution.context.logger.warn("bump-it: asking the agent again with the verification's refusal", { problems: error.problems });
    const after = `asked again after ${error.message}`;
    let again;
    try {
      await execution.deps.revert(execution.context.workingCopy, computed.base.id);
      again = await edit(execution, computed, "apply", { rejected: error.problems });
      await verify(execution, computed, again.toolWritten);
    } catch (second) {
      throw new Error(`${second instanceof Error ? second.message : String(second)} (${after})`);
    }
    return { content: again.content, rejected: error.problems };
  }
}

function planFrom(pr: GitHubPullRequest): BumpPlan {
  const plan = planOf(pr.body);
  if (plan === undefined) {
    throw new Error(`${pr.url} has no valid bump-it plan`);
  }
  return plan;
}

function unitFor(previous: BumpPlan, bumps: ReadonlyArray<BumpCandidate>, wrapper: WrapperCandidates): Unit | undefined {
  return previous.kind === "routine" ? routineUnit(bumps, wrapper) : majorUnits(bumps, wrapper).find((unit) => unit.package === previous.package);
}

function sameTargets(previous: BumpPlan, next: BumpPlan): boolean {
  return JSON.stringify(targetKeys(previous)) === JSON.stringify(targetKeys(next));
}

function targetKeys(plan: BumpPlan): string[] {
  const keys = plan.moves.map((move) => {
    const locations = [...move.locations].sort().join(",");
    const declarations = move.declarations
      .map((declaration) => `${declaration.lockfile}:${declaration.workspace}:${declaration.declaredAs}`)
      .sort()
      .join(",");
    const wrapper = move.wrapper === undefined ? "" : `${move.wrapper.distributionUrl}|${move.wrapper.distributionSha256}|${move.wrapper.jarSha256}`;
    return `${move.ecosystem}|${move.name}|${move.to}|${locations}|${declarations}|${wrapper}`;
  });
  return [...new Set(keys)].sort();
}

async function review(context: ToolRunContext, deps: BumpItDeps): Promise<Readonly<Record<string, unknown>>> {
  const execution = await createExecution(context, deps);
  const steps: ReviewSteps = {
    async rebase(pr, merge) {
      const previous = planFrom(pr);
      const base = await deps.trees.commit(context.workingCopy, merge.prepared.baseSha);
      const gradle = await execution.inventories.ofCommit(base);
      const found = await deps.candidates(base, execution.env, { head: gradle });
      if (found.incomplete.length > 0) {
        throw new Error(`the new base's inventory is incomplete: ${found.incomplete.join("; ")}`);
      }
      // A dependency without a move because its identity check failed isn't one with nothing left to move. On any
      // dependency, not only this PR's: nothing is retired, replaced or rewritten until it can be decided.
      const undecided = undecidedProblems(found.bumps);
      if (undecided.length > 0) {
        throw new Error(`publisher identity can't be decided on the new base; keeping the PR: ${undecided.join("; ")}`);
      }
      const wrapper = await execution.wrapper.candidates(base);
      if (previous.package === "Gradle Wrapper|gradle/gradle" && wrapper.unavailable === true) {
        throw new Error(`recomputation is blocked; keeping the PR: ${wrapper.notes!.join("; ")}`);
      }
      const unit = unitFor(previous, found.bumps, wrapper);
      const computed = unit === undefined ? undefined : await compute(execution, unit, base, gradle, found.npmPeers, wrapper);
      // As for an identity: a direct-peer set whose checks failed leaves out moves that may still be needed.
      if (computed?.undecided !== undefined) {
        throw new Error(`a direct-peer set can't be decided on the new base; keeping the PR: ${computed.undecided.map((set) => set.reason).join("; ")}`);
      }
      if (computed?.blocked !== undefined) {
        throw new Error(`recomputation is blocked; keeping the PR: ${computed.blocked}`);
      }
      if (computed !== undefined && empty(computed) && computed.wrapperOmitted && previous.moves.some((move) => move.mechanism === "gradle-wrapper")) {
        throw new Error(`wrapper recomputation is unavailable; keeping the PR: ${computed.plan.notes.join("; ")}`);
      }
      if (computed === undefined || empty(computed)) {
        await closeAndDelete(execution.publication, pr.number, pr.headSha, "Recomputed on the default branch: this unit has nothing left to move.");
        return "retired";
      }
      // A major's adaptation survives a clean merge while its selected targets stay the same.
      const reconcile = previous.kind === "routine" ? planDigest(previous) !== planDigest(computed.plan) : !sameTargets(previous, computed.plan);
      let content = { title: pr.title, body: withPlanSection(pr.body, computed.plan), commitMessage: `merging ${context.base}` };
      // A clean merge keeps the PR's earlier edits, which may be an agent's: only a fresh tool-only edit tightens the boundary.
      let toolWritten: ReadonlyArray<string> | undefined;
      if (reconcile) {
        await deps.revert(context.workingCopy, base.id);
        ({ content, toolWritten } = await edit(execution, computed, "apply"));
      } else if (merge.kind === "conflicted") {
        const code: string[] = [];
        const restoredFiles: FileState[] = [];
        const pins = new Set(computed.plan.moves.filter((move) => move.mechanism === "action-pin").flatMap((move) => move.locations));
        for (const path of merge.conflicted) {
          if (!isMechanical(path) && !pins.has(path) && !WRAPPER_FILES.includes(path)) {
            code.push(path);
            continue;
          }
          if (WRAPPER_FILES.includes(path)) {
            await deps.restoreWrapperFile(context.workingCopy, base.id, path);
            restoredFiles.push(await deps.fileState(context.workingCopy, path));
            continue;
          }
          const theirs = await base.read(path);
          if (theirs === undefined) {
            await deps.removeFile(context.workingCopy, path);
          } else {
            await deps.writeFile(context.workingCopy, path, theirs);
          }
          restoredFiles.push(await deps.fileState(context.workingCopy, path));
        }
        if (code.length > 0 && previous.kind === "routine") {
          throw new Error("a routine PR may not resolve code conflicts");
        }
        // A routine of tool-written moves resolves without the agent: verification then holds it to what the tool wrote.
        ({ content, toolWritten } = await edit(execution, computed, "resolve", { conflicted: code, restoredFiles }));
      } else {
        await writeNpm(execution, computed.files, previous.kind === "major");
        await writeWrapper(execution, computed);
      }
      await verify(execution, computed, toolWritten);
      await publishUpdate(execution.publication, merge.prepared, pr.number, content);
      return "rebased";
    },
    async adapt(pr, prepared, _publication, attempt, failingChecks) {
      const plan = planFrom(pr);
      if (plan.kind === "routine") {
        context.logger.warn("bump-it: routine CI failure cannot be adapted", { number: pr.number, detail: "the exact change cannot legitimately be edited" });
        return false;
      }
      const base = await deps.trees.commit(context.workingCopy, prepared.baseSha);
      const head = deps.trees.working(context.workingCopy);
      const files = await plannedFiles(plan, head);
      const wrapperFiles = plan.moves.some((move) => move.mechanism === "gradle-wrapper") ? await deps.readWrapperFiles(context.workingCopy) : [];
      if (wrapperFiles.length > 0 && !wrapperFilesMatch(plan, wrapperFiles)) {
        throw new Error("wrapper files no longer match the recorded generated bytes");
      }
      // The recorded plan doesn't carry the table's re-hoists: they come from the lockfiles again, as in a fresh computation.
      const computed = { plan: await withRehoists(plan, base, head), files, wrapperFiles, base, gradle: await execution.inventories.ofCommit(base) };
      const { content } = await edit(execution, computed, "adapt", { failingChecks });
      await verify(execution, computed, undefined);
      const { pushed } = await publishUpdate(execution.publication, prepared, pr.number, content, attempt);
      return pushed;
    },
  };
  return { outcome: "reviewed", reviewed: await reviewOpenPullRequests(execution.publication, steps) };
}
