/**
 * Parent first, where npm would otherwise need an override: when a dependent's
 * range excludes a transitive copy's security target, secure-it first looks
 * for a version of that dependent which admits it, so the parent moves and the
 * copy is locked inside the parent's own range, instead of an override pinning
 * it against that range.
 *
 * For each excluding dependent P (not bundled: a bundled parent can't move on
 * its own), the candidates are P's versions in its own compatible line, above
 * its current one, at least `releaseAgeDays` old (own packages: any age), that
 * require with ranges admitting them as many as possible of the copies P must
 * admit (at least one), and still admit every copy whose target P's range
 * admits today. Of those, the one admitting the most (the lowest of those that
 * tie) that adds no advisory group of its own and no malware, passes the
 * publisher identity check, and can itself move without an override (a
 * workspace declares it, or every dependent's range admits it) is P's move.
 * A copy every excluding dependent's move admits is locked and those parents
 * move with it; any other keeps today's override. A copy some excluding
 * dependent can't admit in any version gains nothing from the others moving,
 * so they search again without it. Parents are aged, so the gate needs no new
 * justification for them.
 */
import { ActionsGitHub } from "../../ci/src/actions-github.ts";
import { IdentityCheck } from "../../ci/src/candidates.ts";
import { NpmCatalog } from "../../ci/src/catalogs.ts";
import { type Config, isOwnPackage } from "../../ci/src/config.ts";
import type { Exceptions } from "../../ci/src/exceptions.ts";
import { type GateEnvironment, snapshotOptions } from "../../ci/src/gate.ts";
import { npmLocation } from "../../ci/src/inventory.ts";
import { isObject } from "../../ci/src/json.ts";
import { lockedPackages } from "../../ci/src/npm-lock.ts";
import { NpmRegistry } from "../../ci/src/npm-registry.ts";
import { requiredPath, requirementSpec, requirements } from "../../ci/src/npm-required.ts";
import { takeSnapshot } from "../../ci/src/take-snapshot.ts";
import { compatibleLine, fixes, movesFrom } from "../../ci/src/young-fixes.ts";

import { type Dependent, dependentsOf, type FixWork, lockfileOf, type ParentMove, satisfies } from "./plan.ts";

const DAY_MS = 86_400_000;

export interface ParentInputs {
  readonly lockfiles: ReadonlyMap<string, unknown>;
  readonly env: GateEnvironment;
  readonly config: Config;
  readonly exceptions: Exceptions;
}

/** What one parent occurrence must admit: each copy it brings whose target its current range excludes. */
interface Obligation {
  readonly fix: FixWork;
  /** The copy's gate location. */
  readonly location: string;
  readonly name: string;
  readonly to: string;
  /** Its range admits the target today: a new version must keep admitting it, but moving gains nothing for it. */
  readonly required: boolean;
}

/**
 * A parent occurrence's chosen move, with the copies (`copyKey`) its version admits, and those some version past the
 * wait admits (keeping what its range admits today), whatever the ranking or the checks made of it.
 */
interface Chosen {
  readonly move: Omit<ParentMove, "unblocks">;
  readonly admitted: ReadonlySet<string>;
  readonly admissible: ReadonlySet<string>;
}

const copyKey = (name: string, location: string) => `${name}|${location}`;

/**
 * `fixes` with `parents` on each npm fix whose override could be avoided, and a note on each fix that keeps one. A
 * parent occurrence gets one version: the one admitting the most copies it must (from every fix of the batch), the
 * lowest of those that tie, and still admitting what its range admits today; a parent with a fix of its own keeps
 * that fix's version, and only parents what that version admits. A copy is locked when every parent excluding it
 * moves to a version admitting it; the others keep their overrides.
 */
export async function withParents(fixes: ReadonlyArray<FixWork>, inputs: ParentInputs): Promise<FixWork[]> {
  const registry = new NpmRegistry(inputs.env.fetch);
  const search = new ParentSearch(registry, inputs);
  const eligible = (fix: FixWork) => fix.ecosystem === "npm" && fix.to !== undefined && fix.carries === undefined && !fix.malicious;
  // Each excluding parent occurrence (lockfile + path), with what it must admit, one obligation per copy and target.
  const occurrences = new Map<string, { dependent: Dependent; lockfile: string; obligations: Map<string, Obligation> }>();
  // Copies (`copyKey`) whose every excluding parent must move for the copy to be locked.
  const blockedBy = new Map<string, string[]>();
  for (const fix of fixes.filter(eligible)) {
    for (const location of fix.locations) {
      const { declaredByWorkspace, dependents } = dependentsOf(inputs.lockfiles, location);
      const excluding = dependents.filter((dependent) => !satisfies(fix.to!.version, dependent.spec));
      if (declaredByWorkspace || dependents.length === 0 || excluding.length === 0) continue;
      const lockfile = lockfilePathOf(inputs.lockfiles, location);
      const packages = lockedEntries(inputs.lockfiles, lockfile);
      const keys: string[] = [];
      for (const dependent of excluding) {
        const key = `${lockfile}|${dependent.path}`;
        const entry = occurrences.get(key) ?? { dependent, lockfile, obligations: new Map<string, Obligation>() };
        // What the occurrence's edges admit today (optional ones taking precedence, as npm reads them) it must keep.
        const current = packages[dependent.path];
        const obligation = { fix, location, name: fix.name, to: fix.to!.version };
        const required = isObject(current) && admits(current, packages, dependent.path, obligation);
        entry.obligations.set(`${copyKey(fix.name, location)}|${fix.to!.version}`, { ...obligation, required });
        occurrences.set(key, entry);
        // One that admits the copy already doesn't block it: it needn't move for it, only keep admitting it.
        if (!required && !keys.includes(key)) keys.push(key);
      }
      if (keys.length > 0) blockedBy.set(copyKey(fix.name, location), keys);
    }
  }
  // An occurrence must also keep admitting every other planned copy it supplies, even one its range admits today.
  for (const entry of occurrences.values()) {
    for (const fix of fixes.filter(eligible)) {
      for (const location of fix.locations) {
        const key = `${copyKey(fix.name, location)}|${fix.to!.version}`;
        if (entry.obligations.has(key)) continue;
        if (lockfilePathOf(inputs.lockfiles, location) !== entry.lockfile) continue;
        if (dependentsOf(inputs.lockfiles, location).dependents.some((dependent) => dependent.path === entry.dependent.path)) {
          entry.obligations.set(key, { fix, location, name: fix.name, to: fix.to!.version, required: true });
        }
      }
    }
  }

  // Copies a parent can't admit in any version (or whose parent can't move at all) gain nothing from the others
  // moving, so those search again without them, until no such copy is newly found: `hopeless` only grows, so this
  // ends. A copy a parent's chosen version merely ranks out stays wanted: a later search may admit it again.
  // Each with why: a fact about that parent (its search failed, or no version admits the copy), so it stays true.
  const hopeless = new Map<string, string>();
  const searches = new Map<string, Chosen | string>();
  let chosen = new Map<string, Chosen | string>();
  for (;;) {
    chosen = new Map();
    for (const [key, { dependent, lockfile, obligations }] of occurrences) {
      const live = [...obligations.values()].filter((obligation) => obligation.required || !hopeless.has(copyKey(obligation.name, obligation.location)));
      if (!live.some((obligation) => !obligation.required)) continue;
      const signature = `${key}#${live.map((obligation) => `${copyKey(obligation.name, obligation.location)}|${obligation.required}`).sort().join(",")}`;
      if (!searches.has(signature)) {
        const parentLocation = npmLocation(lockfile, dependent.path);
        const own = fixes.find((fix) => fix.ecosystem === "npm" && fix.name === dependent.name && fix.to !== undefined && fix.locations.includes(parentLocation));
        // A search that can't finish leaves the override, as before parents were tried.
        searches.set(signature, await search.parentFor(dependent, lockfile, live, own?.to?.version)
          .catch((error: unknown) => `searching ${dependent.name} failed: ${error instanceof Error ? error.message : String(error)}`));
      }
      chosen.set(key, searches.get(signature)!);
    }
    const before = hopeless.size;
    for (const [copy, keys] of blockedBy) {
      if (hopeless.has(copy)) continue;
      for (const key of keys) {
        const result = chosen.get(key);
        if (result === undefined || (typeof result !== "string" && result.admissible.has(copy))) continue;
        hopeless.set(copy, typeof result === "string" ? result : `no ${result.move.name} version in its line past the wait admits it, keeping what its range admits today`);
        break;
      }
    }
    if (hopeless.size === before) break;
  }
  // From the final choices: a copy is locked when every parent excluding it moves to a version admitting it.
  const unblocked = (copy: string) => !hopeless.has(copy) && blockedBy.get(copy)!.every((key) => { const result = chosen.get(key); return result === undefined || (typeof result !== "string" && result.admitted.has(copy)); });
  const moving = (key: string) => [...blockedBy].some(([copy, keys]) => keys.includes(key) && unblocked(copy));
  const lost = new Map<string, string>();
  for (const [copy, keys] of blockedBy) {
    if (unblocked(copy)) continue;
    if (hopeless.has(copy)) {
      lost.set(copy, hopeless.get(copy)!);
      continue;
    }
    for (const key of keys) {
      const result = chosen.get(key);
      if (result === undefined) continue;
      if (typeof result === "string") {
        lost.set(copy, result);
        break;
      }
      if (result.admitted.has(copy)) continue;
      const { name, to } = result.move;
      lost.set(copy, moving(key)
          ? `${name} moves to ${to}, the version admitting the most of the copies it must, which doesn't admit it`
          : `${name}'s version admitting the most of the copies it must (${to}) doesn't admit it, and none of those can be locked`);
      break;
    }
  }

  const result = fixes.map((fix) => {
    const parents: ParentMove[] = [];
    const notes: string[] = [];
    for (const location of fix.locations) {
      const keys = blockedBy.get(copyKey(fix.name, location));
      if (keys === undefined) continue;
      const why = lost.get(copyKey(fix.name, location));
      if (why !== undefined) {
        notes.push(`${fix.name}@${fix.to!.version} at ${location} keeps an override: ${why}`);
        continue;
      }
      // A blocker never searched admits the copy already (it wanted nothing): it needn't move for it.
      for (const key of keys) {
        const choice = chosen.get(key);
        if (choice !== undefined) parents.push({ ...(choice as Chosen).move, unblocks: location });
      }
    }
    if (parents.length === 0 && notes.length === 0) return fix;
    return { ...fix, ...(parents.length === 0 ? {} : { parents }), ...(notes.length === 0 ? {} : { notes: [...(fix.notes ?? []), ...notes] }) };
  });
  return [...result, ...parentFixes(result)];
}

/**
 * Each chosen parent that has no fix of its own, as a fix with no targets: so it's coupled to the copies it unblocks
 * before the batch splits into units, and it anchors the direct-peer closure like any move.
 */
function parentFixes(fixes: ReadonlyArray<FixWork>): FixWork[] {
  // One fix per transition: occurrences in different lockfiles can start from, and move to, different versions.
  const byTransition = new Map<string, FixWork>();
  for (const fix of fixes) {
    for (const parent of fix.parents ?? []) {
      // Only the occurrence an existing fix moves to the same version is covered by it; another lockfile's isn't.
      if (fixes.some((other) => other.ecosystem === "npm" && other.name === parent.name && other.to?.version === parent.to && other.locations.includes(parent.location))) continue;
      const key = `${parent.name}|${parent.from}|${parent.to}`;
      const existing = byTransition.get(key);
      const locations = [...new Set([...(existing?.locations ?? []), parent.location])].sort();
      byTransition.set(key, existing !== undefined ? { ...existing, locations } : {
        ecosystem: "npm", name: parent.name, from: parent.from, locations, targets: [], unfixable: [], malicious: false, severity: fix.severity,
        to: { version: parent.to, line: parent.line, aged: true, major: false, blockers: [] }, problem: undefined,
      });
    }
  }
  return [...byTransition.values()];
}

class ParentSearch {
  readonly #registry: NpmRegistry;
  readonly #catalog: NpmCatalog;
  readonly #inputs: ParentInputs;
  readonly #identity: IdentityCheck;

  constructor(registry: NpmRegistry, inputs: ParentInputs) {
    this.#registry = registry;
    this.#catalog = new NpmCatalog(registry);
    this.#inputs = inputs;
    const npm = [...inputs.lockfiles].map(([path, lock]) => ({ path, packages: lockedPackages(lock), bundleProblems: [] }));
    this.#identity = new IdentityCheck(registry, npm, inputs.exceptions, inputs.env.now().toISOString().slice(0, 10));
  }

  /**
   * The move of `dependent` (in `lockfile`) whose requirements admit the most of the obligations' targets it's wanted
   * for (the lowest such version), and every one it already admits, through the edge that actually installs each copy;
   * `pinned` when the parent's own security fix fixes its version. Or why there's none.
   */
  async parentFor(dependent: Dependent, lockfile: string, obligations: ReadonlyArray<Obligation>, pinned: string | undefined): Promise<Chosen | string> {
    const { config, env, lockfiles } = this.#inputs;
    if (dependent.bundled) return `${dependent.name} at ${dependent.path} is bundled in its parent's tarball`;
    if (dependent.version === undefined) return `${dependent.name} at ${dependent.path} has no locked version`;
    const parent = { ecosystem: "npm" as const, name: dependent.name };
    const from = dependent.version;
    const listed = await this.#catalog.versions(parent);
    if (listed === undefined) return `the registry doesn't list ${dependent.name}'s versions`;
    const line = (version: string) => compatibleLine(config, parent, version);
    const own = isOwnPackage(config.ownPackages, parent);
    const now = env.now();
    const doc = await this.#registry.packument(dependent.name);
    const packages = lockedEntries(lockfiles, lockfile);
    const required = obligations.filter((obligation) => obligation.required);
    const wanted = obligations.filter((obligation) => !obligation.required);
    const described = wanted.map((obligation) => `${obligation.name}@${obligation.to}`).join(", ");
    const versions = pinned !== undefined ? [pinned] : movesFrom(parent, from, listed, "above").filter((version) => line(version) === line(from));
    // Cheap filters first (line, age, the ranges for the copies); advisories are read for the survivors at once.
    const ranked: Array<{ version: string; admitted: ReadonlyArray<Obligation> }> = [];
    // Copies admitted today that a version admitting a wanted one would drop: why nothing ranks, when that's the reason.
    const dropped = new Set<string>();
    const admissible = new Set<string>();
    for (const version of versions) {
      if (!own && pinned === undefined) {
        const published = await this.#catalog.published({ ...parent, version });
        if (published === undefined || (now.getTime() - published.getTime()) / DAY_MS < config.releaseAgeDays) continue;
      }
      const manifest = doc.versions[version];
      if (!isObject(manifest)) continue;
      const admitted = wanted.filter((obligation) => admits(manifest, packages, dependent.path, obligation));
      if (admitted.length === 0) continue;
      const lost = required.filter((obligation) => !admits(manifest, packages, dependent.path, obligation));
      if (lost.length === 0) {
        ranked.push({ version, admitted });
        for (const obligation of admitted) admissible.add(copyKey(obligation.name, obligation.location));
      }
      for (const obligation of lost) dropped.add(`${obligation.name}@${obligation.to}`);
    }
    if (ranked.length === 0 && dropped.size > 0) {
      const kept = [...dropped].sort().join(", ");
      return pinned !== undefined
        ? `${dependent.name}'s own security fix ${pinned} would drop ${kept}, which its range admits today`
        : `every ${dependent.name} version in its line past the wait admitting ${wanted.length === 1 ? described : `any of ${described}`} drops ${kept}, which its range admits today`;
    }
    if (ranked.length === 0) {
      return pinned !== undefined
        ? `${dependent.name}'s own security fix ${pinned} doesn't admit ${wanted.length === 1 ? described : `any of ${described}`}`
        : `no ${dependent.name} version in its line past the wait requires ${described} in a range admitting ${wanted.length === 1 ? "it" : "any of them"}`;
    }
    // The most copies first; among versions that tie, the lowest (the sort is stable over ascending versions).
    ranked.sort((a, b) => b.admitted.length - a.admitted.length);
    const snapshot = await takeSnapshot([{ ...parent, version: from }], snapshotOptions(config, env, new ActionsGitHub(env.fetch, env.githubToken)),
      ranked.map(({ version }) => ({ ...parent, version })));
    const parentLocation = npmLocation(lockfile, dependent.path);
    const movable = dependentsOf(lockfiles, parentLocation);
    // Why each admitting version can't move, so the note names the check that failed rather than all of them.
    const rejected = { advisories: [] as string[], identity: [] as string[], ranges: [] as string[] };
    let identityDetail: string | undefined;
    for (const { version, admitted } of ranked) {
      if (pinned === undefined && !fixes(snapshot, parent, from, [], version)) {
        rejected.advisories.push(version);
        continue;
      }
      const identity = await this.#identity.problems({ ...parent, version: from }, version);
      if (identity.length > 0) {
        rejected.identity.push(version);
        identityDetail ??= identity[0];
        continue;
      }
      if (!movable.declaredByWorkspace && !(movable.dependents.length > 0 && movable.dependents.every((entry) => satisfies(version, entry.spec)))) {
        rejected.ranges.push(version);
        continue;
      }
      return {
        move: { name: dependent.name, from, to: version, location: parentLocation, line: line(version) },
        admitted: new Set(admitted.map((obligation) => copyKey(obligation.name, obligation.location))),
        admissible,
      };
    }
    const failing = (versions: ReadonlyArray<string>, one: string, many: string) => versions.length === 0 ? [] : [`${versions.join(", ")} ${versions.length === 1 ? one : many}`];
    const reasons = [
      ...failing(rejected.advisories, "brings new advisories", "bring new advisories"),
      ...failing(rejected.identity, `fails the identity check (${identityDetail})`, `fail the identity check (${identityDetail})`),
      ...failing(rejected.ranges, "would need an override itself", "would need an override themselves"),
    ];
    return `no ${dependent.name} version admitting ${wanted.length === 1 ? described : `any of ${described}`} can move: ${reasons.join("; ")}`;
  }
}

/**
 * Whether a parent version's requirements admit an obligation's target: every edge of its manifest that would
 * install the very copy (an ordinary dependency below the parent, a peer beside it, as npm places them) admits it,
 * and there's at least one.
 */
function admits(manifest: Record<string, unknown>, packages: Readonly<Record<string, unknown>>, parentPath: string, obligation: Pick<Obligation, "location" | "name" | "to">): boolean {
  const key = obligation.location.slice(obligation.location.lastIndexOf("node_modules/") + "node_modules/".length);
  const copy = obligation.location.slice(obligation.location.indexOf("node_modules/"));
  const applicable = requirements(manifest).filter((edge) => edge.key === key && requiredPath(packages, parentPath, edge.key, edge.peer) === copy);
  return applicable.length > 0 && applicable.every((edge) => {
    const spec = requirementSpec(edge.key, edge.spec);
    return spec.name === obligation.name && satisfies(obligation.to, spec.range);
  });
}

/** A lockfile's raw `packages` entries, by path. */
function lockedEntries(lockfiles: ReadonlyMap<string, unknown>, lockfile: string): Readonly<Record<string, unknown>> {
  return ((lockfiles.get(lockfile) ?? {}) as { packages?: Record<string, unknown> }).packages ?? {};
}

/** The lockfile path whose directory prefixes a gate location. */
function lockfilePathOf(lockfiles: ReadonlyMap<string, unknown>, location: string): string {
  const { lock } = lockfileOf(lockfiles, location);
  for (const [path, candidate] of lockfiles) if (candidate === lock) return path;
  throw new Error(`no lockfile holds ${location}`);
}
