/** Planning and editing one independent unit; no publication until verification passes. */
import { isDeepStrictEqual } from "node:util";

import { ActionsGitHub } from "@leanish/gate/actions-github";
import { readActionsInventory } from "@leanish/gate/actions-inventory";
import type { GateEnvironment, GradleInputs } from "@leanish/gate/gate";
import type { NpmPeerPlanner } from "@leanish/gate/npm-peers";
import type { Tree } from "@leanish/gate/tree";
import type { ToolRunContext } from "@leanish/tool-runtime/command";
import { GATE_WORKFLOW, isPolicyFile, writtenPins } from "@leanish/tool-runtime/edit-checks";
import type { FileState } from "@leanish/tool-runtime/git-copies";
import { referenceTransform } from "@leanish/tool-runtime/gradle-reference";
import { type GradleInventories, lockfilesOf } from "@leanish/tool-runtime/inventories";
import { ownPullRequests } from "@leanish/tool-runtime/own-pr";
import { assertPublishable, type PublicationContext, type PullRequestContent } from "@leanish/tool-runtime/publication";

import type { WrapperArtifact } from "./wrapper-generation.ts";
import type { WrapperCandidates, WrapperPlanner } from "./gradle-wrapper.ts";
import { constrainedUnit } from "./constraints.ts";
import type { BumpItDeps } from "./deps.ts";
import { assertLocalFile } from "./files.ts";
import { formatManifest } from "./manifest-format.ts";
import { coupledUnit, constrainedPeers, type UndecidedPeers } from "./peers.ts";
import { assertNoPlanMarker } from "@leanish/tool-runtime/plan-blocks";
import { type BumpPlan, DEPENDENCY_FIELDS, planFor, planSection } from "./plan.ts";
import type { Unit } from "./units.ts";
import { referenceMoves } from "./verify.ts";

export const RULES = ownPullRequests("bump-it");

export interface Execution {
  readonly context: ToolRunContext;
  readonly deps: BumpItDeps;
  readonly env: GateEnvironment;
  readonly inventories: GradleInventories;
  readonly wrapper: WrapperPlanner;
  readonly publication: PublicationContext;
  /** Branches this run created, on top of the open PRs' ones: two units' topics can cut to the same branch name. */
  readonly branches: Set<string>;
}

export interface Computed {
  readonly plan: BumpPlan;
  readonly files: ReadonlyMap<string, string>;
  readonly base: Tree;
  readonly gradle: GradleInputs["head"];
  readonly wrapperFiles?: ReadonlyArray<WrapperArtifact>;
  readonly wrapperOmitted?: boolean;
  readonly blocked?: string;
  /** Direct-peer sets whose checks failed (`coupledUnit`): moves left out that may still be needed, a failure to report. */
  readonly undecided?: ReadonlyArray<UndecidedPeers>;
}

interface SkillAnswer {
  readonly outcome: "applied" | "cannot-apply";
  readonly summary: string;
  readonly publication?: PullRequestContent | null;
}

interface EditContext {
  readonly failingChecks?: ReadonlyArray<string>;
  readonly conflicted?: ReadonlyArray<string>;
  /** Why verification refused the previous attempt at this same plan. */
  readonly rejected?: ReadonlyArray<string>;
  /** Base-side dependency restores, checked by the guard; the agent may reapply the plan over them. */
  readonly restoredFiles?: ReadonlyArray<FileState>;
}

export async function compute(execution: Execution, unit: Unit, base: Tree, gradle: GradleInputs["head"], peers?: NpmPeerPlanner, wrapper: WrapperCandidates = {}): Promise<Computed> {
  const coupled = await coupledUnit(unit, peers === undefined ? new Map() : await lockfilesOf(base), peers);
  const bounded = await constrainedUnit(coupled.unit, base);
  const ready = constrainedPeers(coupled.unit, bounded.unit, coupled.sets);
  const generated = await prepareWrapper(execution, ready.unit, base.id);
  const notes = [...wrapper.notes ?? [], ...coupled.notes, ...bounded.notes, ...ready.notes, ...generated.notes];
  const blocked = unit.kind === "major" && generated.unit.moves.length === 0 && notes.length > 0 ? notes.join("; ") : undefined;
  const npm = blocked === undefined
    ? await execution.deps.npm(execution.context, generated.unit, base, execution.env, gradle)
    : { files: new Map<string, string>(), changes: [], notes: [] };
  const actions = new ActionsGitHub(execution.env.fetch, execution.env.githubToken);
  const planned = await planFor(generated.unit, { ...npm, notes: [...notes, ...npm.notes] }, (name, tag) => actions.tagCommit(name, tag));
  const wrapperFiles = generated.files;
  const plan = wrapperFiles.length === 0 ? planned : { ...planned, wrapperFiles: wrapperFiles.map(({ bytes: _bytes, ...file }) => file) };
  return {
    plan, files: npm.files, wrapperFiles, wrapperOmitted: wrapper.unavailable === true || generated.notes.length > 0, base, gradle,
    ...(blocked === undefined ? {} : { blocked }),
    ...(coupled.undecided.length === 0 ? {} : { undecided: coupled.undecided }),
  };
}

async function prepareWrapper(execution: Execution, unit: Unit, baseSha: string): Promise<{ unit: Unit; files: ReadonlyArray<WrapperArtifact>; notes: string[] }> {
  const move = unit.moves.find((move) => move.mechanism === "gradle-wrapper");
  if (move === undefined) {
    return { unit, files: [], notes: [] };
  }
  try {
    const files = await execution.deps.generateWrapper(execution.context, baseSha, move);
    return { unit, files, notes: [] };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      unit: { ...unit, moves: unit.moves.filter((candidate) => candidate !== move) },
      files: [],
      notes: [`Gradle wrapper left out: ${reason}`],
    };
  }
}

export async function writeNpm(execution: Execution, files: ReadonlyMap<string, string>, preserveManifestFields = false, restoredFiles?: Map<string, FileState>): Promise<void> {
  for (const [path, content] of files) {
    let text = content;
    if (preserveManifestFields && path.endsWith("package.json")) {
      const current = await execution.deps.trees.working(execution.context.workingCopy).read(path);
      if (current !== undefined) {
        const manifest = JSON.parse(current) as Record<string, unknown>;
        const original = structuredClone(manifest);
        const planned = JSON.parse(content) as Record<string, unknown>;
        for (const field of DEPENDENCY_FIELDS) {
          if (planned[field] === undefined) {
            delete manifest[field];
          } else {
            manifest[field] = planned[field];
          }
        }
        text = isDeepStrictEqual(original, manifest) ? current : formatManifest(current, manifest);
      }
    }
    await execution.deps.writeFile(execution.context.workingCopy, path, text);
    const restored = restoredFiles?.get(path);
    if (restoredFiles !== undefined && restored !== undefined) {
      restoredFiles.set(path, { ...await execution.deps.fileState(execution.context.workingCopy, path), index: restored.index });
    }
  }
}

export async function writeWrapper(execution: Execution, computed: Computed, restoredFiles?: Map<string, FileState>): Promise<void> {
  if (computed.wrapperFiles !== undefined && computed.wrapperFiles.length > 0) {
    await execution.deps.writeWrapperFiles(execution.context.workingCopy, computed.wrapperFiles);
    for (const { path } of computed.wrapperFiles) {
      const restored = restoredFiles?.get(path);
      if (restoredFiles !== undefined && restored !== undefined) {
        restoredFiles.set(path, { ...await execution.deps.fileState(execution.context.workingCopy, path), index: restored.index });
      }
    }
  }
}

/**
 * Writes the plan's action pins itself, like npm files and wrappers: a pin move is deterministic, and an agent asked
 * to make it may change more (a stale comment in the gate's own workflow, which verification rightly refuses). A file
 * whose pins can't be rewritten in place is left to the agent; `complete` says whether every pin file was written.
 */
export async function writePins(execution: Execution, computed: Computed, restoredFiles?: Map<string, FileState>): Promise<{ readonly written: string[]; readonly complete: boolean }> {
  const pins = computed.plan.moves.filter((move) => move.mechanism === "action-pin");
  const written: string[] = [];
  let complete = true;
  for (const path of [...new Set(pins.flatMap((move) => move.locations))].sort()) {
    // Locations can come from a PR body's plan: only an in-repository workflow or action file that's a regular file
    // is read here, so a crafted path never reaches a device, a pipe or a file outside the working copy.
    if (!isPolicyFile(path) || !await localFile(execution.context.workingCopy.path, path)) { complete = false; continue; }
    const current = await execution.deps.trees.working(execution.context.workingCopy).read(path);
    const planned = pins.filter((move) => move.locations.includes(path));
    if (current === undefined || planned.some((move) => move.commitSha === undefined)) { complete = false; continue; }
    let text: string;
    try {
      text = writtenPins(current, path, planned.map((move) => ({ name: move.name, from: move.from, to: move.to, commitSha: move.commitSha! })));
    } catch {
      complete = false;
      continue;
    }
    if (text !== current) await execution.deps.writeFile(execution.context.workingCopy, path, text);
    written.push(path);
    const restored = restoredFiles?.get(path);
    if (restoredFiles !== undefined && restored !== undefined) {
      restoredFiles.set(path, { ...await execution.deps.fileState(execution.context.workingCopy, path), index: restored.index });
    }
  }
  return { written, complete };
}

async function localFile(root: string, path: string): Promise<boolean> {
  try { await assertLocalFile(root, path); return true; } catch { return false; }
}

/** Whether every planned pin is the gate's own reusable workflow, the only major that needs no agent: nothing but its pin may change there. */
async function onlyGateWorkflow(computed: Computed): Promise<boolean> {
  const moves = computed.plan.moves;
  if (moves.length === 0 || moves.some((move) => move.mechanism !== "action-pin" || move.name.toLowerCase() !== GATE_WORKFLOW.name)) return false;
  const uses = (await readActionsInventory(computed.base)).uses.filter((use) => use.name === GATE_WORKFLOW.name);
  return uses.length > 0 && uses.every((use) => use.path === GATE_WORKFLOW.path);
}

/** `toolWritten`: what `edit` wrote when it wrote this pass without the agent, else `undefined` (see `Edited`). */
export async function verify(execution: Execution, computed: Computed, toolWritten: ReadonlyArray<string> | undefined): Promise<void> {
  const { context, deps, env, inventories } = execution;
  // Everything below reads this snapshot, never the live working tree, and publication commits exactly its tree.
  const candidate = await deps.snapshot(context.workingCopy);
  const head = await deps.trees.commit(context.workingCopy, candidate);
  const gradle = { base: computed.gradle, head: await inventories.ofCommit(head) };
  const changedFiles = await deps.changedBetween(context.workingCopy, computed.base.id, candidate);
  const wrapperAt = computed.plan.moves.some((move) => move.mechanism === "gradle-wrapper") ? await deps.wrapperAt(context.workingCopy, candidate) : undefined;
  // The base with the plan applied by Gradle (and its generated wrapper): the base itself when the plan moves nothing there.
  const moves = referenceMoves(computed.plan);
  const wrapper = computed.wrapperFiles ?? [];
  const reference = moves.length === 0 && wrapper.length === 0 ? computed.gradle
    : await inventories.ofCommit(computed.base, { transform: referenceTransform(moves, []), overlay: wrapper.map(({ path, bytes, executable }) => ({ path, bytes, executable })) });
  const problems = await deps.verify({
    plan: computed.plan,
    npmFiles: computed.files,
    base: computed.base,
    head,
    env,
    wrapper: execution.wrapper,
    wrapperFiles: wrapperAt?.files,
    wrapperJarSha256: wrapperAt?.jarSha256,
    gradle,
    reference,
    changedFiles,
    toolWritten,
  });
  const links = await deps.linkProblems(context.workingCopy, computed.base.id, candidate);
  if (problems.length > 0 || links.length > 0) throw new VerificationRejected([...links, ...problems]);
}

/** Verification refused the edit (as opposed to an operational failure): its problems, for the agent to see. */
export class VerificationRejected extends Error {
  readonly problems: ReadonlyArray<string>;

  constructor(problems: ReadonlyArray<string>) {
    super(`verification failed: ${problems.join("; ")}`);
    this.name = "VerificationRejected";
    this.problems = problems;
  }
}

/** What `edit` publishes, and the files the tool wrote when it wrote the pass alone (`undefined` when the agent ran). */
export interface Edited {
  readonly content: PullRequestContent;
  readonly toolWritten: ReadonlyArray<string> | undefined;
}

export async function edit(execution: Execution, computed: Computed, mode: "apply" | "adapt" | "resolve", extra: EditContext = {}): Promise<Edited> {
  const restoredFiles = new Map((extra.restoredFiles ?? []).map((file) => [file.path, file]));
  await writeNpm(execution, computed.files, false, restoredFiles);
  await writeWrapper(execution, computed, restoredFiles);
  const pins = await writePins(execution, computed, restoredFiles);
  const { plan } = computed;
  const toolWritten = [...computed.files.keys(), ...(computed.wrapperFiles ?? []).map((file) => file.path), ...pins.written];
  const toolWrites = plan.moves.every((move) => move.mechanism === "npm-range" || move.mechanism === "gradle-wrapper" || move.mechanism === "action-pin");
  // A major other than the gate's workflow keeps its agent pass, and so does adapting or resolving one.
  if (pins.complete && toolWrites && (plan.kind === "routine" || (mode === "apply" && await onlyGateWorkflow(computed)))) {
    return { content: mechanicalContent(plan), toolWritten };
  }
  const { context } = execution;
  const answer = await context.agent<ReturnType<typeof skillInput>, SkillAnswer>({
    entrypoint: "bump-it",
    input: skillInput(context, plan, mode, toolWritten, extra),
    ...(extra.restoredFiles === undefined ? {} : { restoredFiles: [...restoredFiles.values()] }),
  });
  if (answer.outcome !== "applied" || answer.publication == null) {
    throw new Error(`the agent couldn't apply the plan: ${answer.summary}`);
  }
  assertNoPlanMarker(answer.publication.body);
  const content = { ...answer.publication, body: `${answer.publication.body}\n\n${planSection(plan)}` };
  assertPublishable(execution.publication, content);
  return { content, toolWritten: undefined };
}

function skillInput(context: ToolRunContext, plan: BumpPlan, mode: "apply" | "adapt" | "resolve", toolWritten: string[], extra: EditContext) {
  const { restoredFiles: _restoredFiles, ...agentExtra } = extra;
  return {
    repo: context.repo.repo,
    today: context.now.toISOString().slice(0, 10),
    kind: plan.kind,
    mode,
    moves: plan.moves.map(({ declarations: _declarations, ...move }) => move),
    toolWritten,
    ...agentExtra,
  };
}

export function mechanicalContent(plan: BumpPlan): PullRequestContent {
  const move = plan.moves[0];
  const title = plan.kind === "routine" ? "refreshing dependencies" : move === undefined ? "upgrading a dependency" : `moving ${move.name} to ${move.to}`;
  return { title, body: `Updates selected by the supply-chain version rule and verified before publication.\n\n${planSection(plan)}`, commitMessage: title };
}
