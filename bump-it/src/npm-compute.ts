/**
 * Compute exact npm files in a sandboxed scratch copy, pin targets, then restore planned manifests.
 * npm's age exclusions include young or unreadable locked base versions, reported in notes;
 * routines pin those names' non-bundled locked copies where supported; unpinned replacements must be aged and not deprecated.
 * Any exclusions require npm >= 11.17.0.
 * Routine and major-induced Node types must fit the base tree's lowest supported runtime.
 */
import { lstat, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import semver from "semver";

import type { NpmDeclaration } from "@leanish/gate/candidates";
import { type NodeRuntime, nodeRuntime, nodeTypeProblem, nodeTypeVersions } from "@leanish/gate/node-runtime";
import { NPM_REGISTRY } from "@leanish/gate/npm-lock";
import { resolveExact } from "@leanish/tool-runtime/npm-exact";
import { workingTree } from "@leanish/gate/tree";

import { assertLocalFile } from "./files.ts";
import { withSpec } from "@leanish/tool-runtime/manifest-spec";
import { type Copy, NpmGraph, rangeOf, rewriteSpec } from "./npm-graph.ts";
import { repositoryOverrides } from "./npm-overrides.ts";
import { retentionManifests } from "./npm-pins.ts";
import { type Decision, decideTargets, meetsReleaseAge, type TargetSources } from "./npm-targets.ts";
import { npmWindowFor, requireNpmExcludes } from "./npm-window.ts";
import { provenRehoists } from "./rehoists.ts";

/** Runs npm with `args` in `cwd` (an absolute directory in the scratch copy). */
export type NpmCommand = (cwd: string, args: ReadonlyArray<string>) => Promise<{ code: number; stdout: string; stderr: string }>;

/** A planned direct dependency's move in one declaration. */
export interface DeclarationMove extends NpmDeclaration {
  readonly name: string;
  readonly to: string;
}

export interface NpmInputs {
  readonly kind: "routine" | "major";
  /** The scratch copy: the base's files. */
  readonly dir: string;
  /** The base's lockfiles (repo-relative) and their parsed contents. */
  readonly baseLocks: ReadonlyMap<string, unknown>;
  readonly moves: ReadonlyArray<DeclarationMove>;
  readonly npm: NpmCommand;
  readonly window: { readonly days: number; readonly exclude: ReadonlyArray<string> };
  readonly sources: TargetSources;
}

/** A copy that moved, came or went. */
export interface CopyChange {
  readonly lockfile: string;
  readonly path: string;
  readonly name: string;
  readonly from: string | undefined;
  readonly to: string | undefined;
}

export interface NpmResult {
  /** Repo-relative path → content, for each npm file that differs from the base. */
  readonly files: ReadonlyMap<string, string>;
  readonly changes: ReadonlyArray<CopyChange>;
  /** Packages (`rehoistKey`) whose changes are only copies moving between paths: display only, see `provenRehoists`. */
  readonly rehoisted?: ReadonlyArray<string>;
  /** Copies left as they were, and why. */
  readonly notes: ReadonlyArray<string>;
}

/** How many lock passes a lockfile gets before bump-it gives up on npm keeping the targets. */
export const MAX_PASSES = 4;

type Manifest = Record<string, unknown>;

export async function computeNpm(inputs: NpmInputs): Promise<NpmResult> {
  const files = new Map<string, string>();
  const changes: CopyChange[] = [];
  const rehoisted: string[] = [];
  const baseVersions = versionsByName(inputs.baseLocks);
  const lockfiles = [...inputs.baseLocks.keys()]
    .filter((lockfile) => inputs.kind === "routine" || inputs.moves.some((move) => move.lockfile === lockfile))
    .sort();
  const computedLocks = new Map(lockfiles.map((path) => [path, inputs.baseLocks.get(path)]));
  const preparedWindow = await npmWindowFor(versionsByName(computedLocks), inputs.window, inputs.sources);
  const notes = new Set(preparedWindow.notes);
  const runtime = await nodeRuntime(workingTree(inputs.dir), [...inputs.baseLocks].flatMap(([lockfile, lock]) =>
    Object.keys(new NpmGraph(lock).packages)
      .filter((path) => !path.includes("node_modules/"))
      .map((workspace) => ({ lockfile, workspace: workspace === "" ? "." : workspace })),
  ));
  const readyInputs = { ...inputs, window: preparedWindow.window, sources: preparedWindow.sources };
  for (const lockfile of lockfiles) {
    // Use the same executable and project directory as every install/update, before changing any files.
    await requireNpmExcludes(inputs.npm, join(inputs.dir, dirname(lockfile)), preparedWindow.window.exclude, preparedWindow.reason);
  }
  for (const lockfile of lockfiles) {
    const result = await computeLockfile(lockfile, readyInputs, baseVersions, runtime, preparedWindow.lockedNames);
    for (const [path, content] of result.files) {
      files.set(path, content);
    }
    changes.push(...result.changes);
    rehoisted.push(...result.rehoisted ?? []);
    for (const note of result.notes) {
      notes.add(note);
    }
  }
  return { files, changes, rehoisted, notes: [...notes].sort() };
}

async function computeLockfile(lockfile: string, inputs: NpmInputs, baseVersions: ReadonlyMap<string, ReadonlyArray<string>>, runtime: NodeRuntime, lockedNames: ReadonlySet<string>): Promise<NpmResult> {
  const root = dirname(lockfile) === "." ? "" : dirname(lockfile);
  const at = (path: string) => join(inputs.dir, root, path);
  const repoPath = (path: string) => (root === "" ? path : `${root}/${path}`);
  const baseLock = inputs.baseLocks.get(lockfile)!;
  if (basename(lockfile) === "package-lock.json") {
    try {
      await lstat(at("npm-shrinkwrap.json"));
      throw new Error(`${lockfile} is shadowed by npm-shrinkwrap.json; configure the shrinkwrap instead`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
  }
  const lockName = basename(lockfile);
  if (!["package-lock.json", "npm-shrinkwrap.json"].includes(lockName)) {
    throw new Error(`unsupported npm lockfile: ${lockfile}`);
  }
  await assertLocalFile(inputs.dir, lockfile);
  const baseGraph = new NpmGraph(baseLock);
  const lockText = await readFile(at(lockName), "utf8");

  // The root's and each workspace's package.json, as in the base, then with the planned ranges.
  const declaring = ["", ...Object.keys(baseGraph.packages).filter((path) => path !== "" && !path.includes("node_modules/") && baseGraph.packages[path]?.link !== true)];
  const baseTexts = new Map<string, string>();
  for (const path of declaring) {
    await assertLocalFile(inputs.dir, repoPath(manifestOf(path)));
    baseTexts.set(path, await readFile(at(manifestOf(path)), "utf8"));
  }
  const planned = plannedManifests(baseTexts, inputs.moves.filter((move) => move.lockfile === lockfile), lockfile);
  const plannedParsed = new Map([...planned].map(([path, text]) => [path, JSON.parse(text) as Manifest]));

  const flags = [
    "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund",
    `--min-release-age=${inputs.window.days}`,
    ...inputs.window.exclude.map((pattern) => `--min-release-age-exclude=${pattern}`),
  ];
  const npm = async (...args: string[]) => {
    const result = await inputs.npm(join(inputs.dir, root), [...args, ...flags]);
    if (result.code !== 0) {
      throw new Error(`npm ${args.join(" ")} in ${root === "" ? "the root" : root} failed (exit ${result.code}): ${result.stderr.trim().split("\n").slice(-3).join(" / ")}`);
    }
  };
  const overrides = repositoryOverrides(plannedParsed.get(""));
  const plannedDirect = new Map(inputs.moves.filter((move) => move.lockfile === lockfile).map((move) => [`${move.workspace}:${move.declaredAs}`, move.to]));
  const baseCopies = new Map(baseGraph.copies().map((copy) => [copy.path, copy.version]));
  const baseNodeTypes = new Map(baseGraph.copies().filter((copy) => copy.name === "@types/node").map((copy) => [copy.path, copy.version]));
  const baseDirect = new Map(baseGraph.declaredEdges().flatMap((edge) => {
    const version = edge.to === undefined ? undefined : baseCopies.get(edge.to);
    return version === undefined ? [] : [[`${edge.from === "" ? "." : edge.from}:${edge.key}`, version] as const];
  }));
  // Freeze all direct declarations before npm can drift an excluded name, including peer companions.
  const initialDirect = directTargets(baseGraph, plannedDirect, baseDirect);
  // npm exempts names, not versions: update could otherwise fetch a newer young copy (and
  // fail on its young dependencies) before decisions run. Keep every non-bundled locked
  // transitive copy of an automatically exempted name, including aged copies sharing
  // that name. Bundles cannot be pinned independently: they follow their carrier.
  const retained = new Map(baseGraph.copies()
    .filter((copy) => inputs.kind === "routine" && lockedNames.has(copy.name) && !copy.bundled && !initialDirect.has(copy.path))
    .map((copy) => [copy.path, copy]));
  // Aged replacements accepted for unpinnable copies, kept once a later graph makes them pinnable.
  const accepted = new Map<string, string>();
  const initialTargets = new Map([...initialDirect, ...retainedTargets(baseGraph, retained, new Set(), accepted)]);
  const initialPins = baseGraph.copies().flatMap((copy) => {
    const target = initialTargets.get(copy.path);
    return target === undefined ? [] : [{ copy, target }];
  });
  const initialRetention = retentionManifests(baseGraph, initialPins, retained, plannedParsed, overrides);
  let unpinned = initialRetention.unpinned;
  await resolveExact(join(inputs.dir, root), planned, initialRetention.manifests, async () => {
    await npm("install");
    if (inputs.kind === "routine") await npm("update");
  }, () => npm("install"));

  let decisions: Decision[] = [];
  for (let pass = 0; ; pass++) {
    const graph = new NpmGraph(JSON.parse(await readFile(at(lockName), "utf8")));
    unpinned = withStaleTargets(graph, retained, accepted, unpinned, overrides);
    await assertUnpinnedRetention(graph, retained, unpinned, lockfile, inputs.sources);
    rememberAccepted(graph, retained, unpinned, accepted);
    // Pinnable copies stay at base; unpinnable copies may keep an aged, non-deprecated replacement.
    // Carry that accepted version forward, also after a later graph makes the copy pinnable, so
    // later passes do not pin back to base or reject unrelated updates for a harmless aged move.
    const direct = directTargets(graph, plannedDirect, baseDirect);
    const targets = { graph, base: baseGraph, baseVersions, overrides, direct, retained: retainedTargets(graph, retained, unpinned, accepted), nodeRuntime: runtime };
    // Majors retain their induced graph, except Node API types must still fit the runtime.
    decisions = inputs.kind === "routine"
      ? await decideTargets(targets, inputs.sources)
      : await decideTargets(targets, inputs.sources, (copy) =>
        direct.has(copy.path) || copy.name === "@types/node" && !nodeTypesAllowed(copy.version, baseNodeTypes.get(copy.path), runtime),
      );
    if (decisions.some((decision) => decision.kind === "unresolved" && decision.target === undefined)) {
      throw new Error(`a new copy in ${lockfile} has no eligible target: ${decisions.filter((decision) => decision.kind === "unresolved").map((decision) => decision.why).join("; ")}`);
    }
    const off = decisions.flatMap((decision) => (decision.target !== undefined && decision.target !== decision.copy.version ? [{ copy: decision.copy, target: decision.target }] : []));
    if (off.length === 0) {
      assertNodeTypes(graph, baseNodeTypes, runtime, lockfile);
      break;
    }
    if (pass === MAX_PASSES) {
      throw new Error(`npm didn't keep the targets in ${lockfile} after ${MAX_PASSES} passes: ${off.map((pin) => `${pin.copy.name} at ${pin.copy.path} is ${pin.copy.version}, not ${pin.target}`).join("; ")}`);
    }
    // Pin the full decision set together, not just off-target copies: a later install must not drift a companion.
    const pins = decisions.flatMap((decision) => {
      const needed = decision.target !== decision.copy.version || direct.has(decision.copy.path) || retained.has(decision.copy.path);
      return decision.target === undefined || !needed ? [] : [{ copy: decision.copy, target: decision.target }];
    });
    const retention = retentionManifests(graph, pins, retained, plannedParsed, overrides);
    unpinned = retention.unpinned;
    await assertUnpinnedRetention(graph, retained, unpinned, lockfile, inputs.sources);
    await resolveExact(join(inputs.dir, root), planned, retention.manifests,
      () => npm("install"), () => npm("install"));
  }

  if (inputs.kind !== "routine") await assertNoNewDeprecated(new NpmGraph(JSON.parse(await readFile(at(lockName), "utf8"))), baseVersions, lockfile, inputs.sources);

  const files = new Map<string, string>();
  for (const [path, text] of planned) {
    const onDisk = await readFile(at(manifestOf(path)), "utf8");
    if (onDisk !== text) {
      throw new Error(`npm rewrote ${repoPath(manifestOf(path))}; bump-it lands only the ranges it planned`);
    }
    if (text !== baseTexts.get(path)) {
      files.set(repoPath(manifestOf(path)), text);
    }
  }
  const finalText = await readFile(at(lockName), "utf8");
  if (finalText !== lockText) {
    files.set(lockfile, finalText);
  }
  const notes = decisions.flatMap((decision) => decisionNotes(lockfile, decision));
  if (new NpmGraph(JSON.parse(finalText)).copies().some((copy) => copy.name === "@types/node")) {
    notes.push(nodeTypeProblem(runtime));
  }
  const headGraph = new NpmGraph(JSON.parse(finalText));
  return { files, changes: changesBetween(lockfile, baseGraph, headGraph), rehoisted: provenRehoists(lockfile, baseGraph, headGraph), notes };
}

/** Existing incompatible types need manual correction; never accept a new incompatible copy. */
function assertNodeTypes(graph: NpmGraph, previous: ReadonlyMap<string, string>, runtime: NodeRuntime, lockfile: string): void {
  for (const copy of graph.copies().filter((copy) => copy.name === "@types/node")) {
    const from = previous.get(copy.path);
    if (!nodeTypesAllowed(copy.version, from, runtime)) {
      throw new Error(`${lockfile}: @types/node at ${copy.path} cannot land at ${copy.version}: ${nodeTypeProblem(runtime)}`);
    }
  }
}

function nodeTypesAllowed(version: string, from: string | undefined, runtime: NodeRuntime): boolean {
  if (from === version) {
    return true;
  }
  if (from === undefined && runtime.major === undefined) {
    return false;
  }
  return nodeTypeVersions(from ?? version, [version], runtime).length > 0;
}

function decisionNotes(lockfile: string, decision: Decision): string[] {
  const location = `${lockfile}: ${decision.copy.name} at ${decision.copy.path}`;
  if (decision.kind === "pinned") {
    return [`${location} is pinned at ${decision.target} by the repository override`];
  }
  if (decision.kind === "unresolved") {
    return [`${location} stays at ${decision.target ?? decision.copy.version}: ${decision.why}`];
  }
  return [];
}

function manifestOf(declaringPath: string): string {
  return declaringPath === "" ? "package.json" : `${declaringPath}/package.json`;
}

function retainedTargets(graph: NpmGraph, retained: ReadonlyMap<string, Copy>, unpinned: ReadonlySet<string>, accepted: ReadonlyMap<string, string>): Map<string, string> {
  const targets = new Map<string, string>();
  for (const [path, copy] of retained) {
    const current = graph.packages[path];
    // A direct update can drop the dependency that needed this copy. Removing it
    // introduces no young version; only surviving copies need their locked target.
    if (current === undefined) {
      continue;
    }
    if (graph.nameAt(path) !== copy.name || current.version === undefined) {
      throw new Error(`locked ${copy.name} at ${path} disappeared from the npm graph; its age exclusion only permits keeping ${copy.version}`);
    }
    targets.set(path, unpinned.has(path) ? current.version : accepted.get(path) ?? copy.version);
  }
  return targets;
}

/**
 * A later pass can change what a retained copy's dependents or the repository's overrides ask
 * for (a refreshed parent can need a new major of it). A target they no longer admit, the
 * locked version or a remembered replacement, is dropped, and the copy's current version is
 * checked again like any unpinned replacement. A locked version whose constraints can't be
 * judged here stays pinned, as it always was.
 */
function withStaleTargets(graph: NpmGraph, retained: ReadonlyMap<string, Copy>, accepted: Map<string, string>, unpinned: ReadonlySet<string>, overrides: ReturnType<typeof repositoryOverrides>): Set<string> {
  const result = new Set(unpinned);
  for (const [path, locked] of retained) {
    const copy = graph.copies().find((candidate) => candidate.path === path);
    // A copy that's gone, or another package now at its path, is `retainedTargets`' to handle.
    if (copy === undefined || copy.name !== locked.name) continue;
    const remembered = accepted.get(path);
    const overridden = overrides.rangeFor(copy.installedAs) ?? overrides.rangeFor(copy.name);
    const specs = overridden !== undefined ? [overridden] : graph.edgesTo(path).map((edge) => edge.spec);
    // What can't be judged here (a spec that isn't a version range, a scoped or complex
    // override) can't keep a remembered version either: its current version is checked instead.
    const ranges = overrides.isComplex(copy.installedAs) || overrides.isComplex(copy.name) ? [undefined] : specs.map(rangeOf);
    const judged = ranges.every((range) => range !== undefined);
    if (remembered === undefined && !judged) continue;
    if (judged && ranges.every((range) => semver.satisfies(remembered ?? locked.version, range!))) continue;
    accepted.delete(path);
    result.add(path);
  }
  return result;
}

/**
 * Records the checked aged replacement of each unpinned copy. A later pass can make the
 * copy pinnable; pinning it back to its young locked version would undo an accepted move.
 */
function rememberAccepted(graph: NpmGraph, retained: ReadonlyMap<string, Copy>, unpinned: ReadonlySet<string>, accepted: Map<string, string>): void {
  for (const path of unpinned) {
    const version = graph.packages[path]?.version;
    if (version !== undefined && graph.nameAt(path) === retained.get(path)?.name && version !== retained.get(path)?.version) {
      accepted.set(path, version);
    }
  }
}

/**
 * A major keeps the graph npm induces, but none of its new versions may be deprecated: each version a transitive copy
 * takes that base didn't have must be in the registry's non-deprecated catalog, which unreadable data can't show.
 * Direct copies are the unit's own, chosen with their checks; bundled copies follow their carrier; a copy from git, a
 * tarball or another registry has no npm catalog to ask, and the gate's source rules judge it.
 */
async function assertNoNewDeprecated(graph: NpmGraph, baseVersions: ReadonlyMap<string, ReadonlyArray<string>>, lockfile: string, sources: TargetSources): Promise<void> {
  const declared = new Set(graph.declaredEdges().flatMap((edge) => (edge.to === undefined ? [] : [edge.to])));
  for (const copy of graph.copies()) {
    if (copy.bundled || declared.has(copy.path) || baseVersions.get(copy.name)?.includes(copy.version)) continue;
    const resolved = (graph.packages[copy.path] as { resolved?: unknown } | undefined)?.resolved;
    if (typeof resolved !== "string" || !resolved.startsWith(`${NPM_REGISTRY}/`)) continue;
    const listed = await sources.versions(copy.name).catch(() => undefined);
    if (listed === undefined) throw new Error(`${lockfile}: the major brings ${copy.name}@${copy.version}, whose registry catalog can't be read to rule out deprecation`);
    if (!listed.includes(copy.version)) throw new Error(`${lockfile}: the major brings ${copy.name}@${copy.version}, which is deprecated`);
  }
}

async function assertUnpinnedRetention(graph: NpmGraph, retained: ReadonlyMap<string, Copy>, unpinned: ReadonlySet<string>, lockfile: string, sources: TargetSources): Promise<void> {
  for (const path of unpinned) {
    const previous = retained.get(path)!;
    const current = graph.packages[path];
    if (current === undefined || graph.nameAt(path) === previous.name && current.version === previous.version) {
      continue;
    }
    if (graph.nameAt(path) === previous.name && current.version !== undefined) {
      try {
        const published = await sources.published(previous.name, current.version);
        // Retained targets bypass candidate selection. Check its catalog too:
        // npm's name exemption cannot authorize a new deprecated version.
        if (meetsReleaseAge(published, sources) && (await sources.versions(previous.name))?.includes(current.version)) continue;
      } catch {
        // Unreadable age or catalog data cannot justify drift under a name exemption.
      }
    }
    throw new Error(`${lockfile}: ${previous.name} at ${path} is ${current.version}, not its locked ${previous.version}; cannot pin this copy and its replacement is young, deprecated or unreadable`);
  }
}

/**
 * Each declaring manifest's text with the planned ranges. A manifest npm's
 * own formatting reproduces is re-serialized; any other gets each spec
 * replaced in place, so nothing else in it changes.
 */
function plannedManifests(texts: ReadonlyMap<string, string>, moves: ReadonlyArray<DeclarationMove>, lockfile: string): Map<string, string> {
  const result = new Map(texts);
  for (const move of moves) {
    const path = move.workspace === "." ? "" : move.workspace;
    const text = result.get(path);
    if (text === undefined) {
      throw new Error(`${lockfile} has no workspace ${move.workspace} declaring ${move.declaredAs}`);
    }
    const spec = rewriteSpec(move.spec, move.to);
    if (spec === undefined) {
      throw new Error(`${move.declaredAs}'s range '${move.spec}' in ${manifestOf(path)} can't be moved to ${move.to} mechanically`);
    }
    if (spec === move.spec) {
      continue;
    }
    result.set(path, withSpec(text, move.declaredAs, move.spec, spec, manifestOf(path)));
  }
  return result;
}


/**
 * Copy path → the version each declared dependency's copy must be at: the
 * planned target, else (routine) its declaration's version in the base. Two
 * declarations sharing a copy must agree.
 */
function directTargets(graph: NpmGraph, planned: ReadonlyMap<string, string>, base: ReadonlyMap<string, string>): Map<string, string> {
  const targets = new Map<string, string>();
  const seen = new Set<string>();
  for (const edge of graph.declaredEdges()) {
    const key = `${edge.from === "" ? "." : edge.from}:${edge.key}`;
    if (edge.to === undefined) {
      if (planned.has(key) || base.has(key)) {
        throw new Error(`declared dependency ${key} disappeared from the npm graph`);
      }
      continue;
    }
    seen.add(key);
    const target = planned.get(key) ?? base.get(key);
    if (target === undefined) {
      continue;
    }
    const other = targets.get(edge.to);
    if (other !== undefined && other !== target) {
      throw new Error(`declarations sharing ${edge.to} want ${other} and ${target}`);
    }
    targets.set(edge.to, target);
  }
  for (const key of planned.keys()) {
    if (!seen.has(key)) {
      throw new Error(`planned declaration ${key} disappeared from the npm graph`);
    }
  }
  return targets;
}

function versionsByName(locks: ReadonlyMap<string, unknown>): Map<string, string[]> {
  const versions = new Map<string, Set<string>>();
  for (const lock of locks.values()) {
    for (const copy of new NpmGraph(lock).copies()) {
      versions.set(copy.name, new Set([...(versions.get(copy.name) ?? []), copy.version]));
    }
  }
  return new Map([...versions].map(([name, set]) => [name, [...set].sort()]));
}

/** Every path whose copy differs between two lockfile graphs. */
export function changesBetween(lockfile: string, base: NpmGraph, head: NpmGraph): CopyChange[] {
  const before = new Map(base.copies().map((copy) => [copy.path, copy]));
  const after = new Map(head.copies().map((copy) => [copy.path, copy]));
  const changes: CopyChange[] = [];
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const was = before.get(path);
    const now = after.get(path);
    if (was?.name === now?.name && was?.version === now?.version) {
      continue;
    }
    changes.push({ lockfile, path, name: now?.name ?? was!.name, from: was?.version, to: now?.version });
  }
  return changes;
}
