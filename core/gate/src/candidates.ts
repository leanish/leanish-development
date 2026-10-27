/**
 * Where secure-it and bump-it move versions, chosen with the gate's own code.
 *
 * Security (`securityCandidates`): the rule the gate checks a young fix
 * against (young-fixes.ts), so picking and checking can't disagree. For each
 * version a full scan fails on, its candidates are every newer version the
 * registry lists, in any line (no prereleases unless it is one; Maven keeps
 * its flavor), scanned in a second snapshot together with the version itself;
 * its targets are its unexcepted advisory groups as that snapshot groups them,
 * so targets and fixes come from the same data. A target no listed version
 * fixes is reported as unfixable and left (fixing A and leaving B is allowed).
 * The choice: the first compatible line, from the version's own upward, with a
 * version that fixes every fixable target and adds no advisory group; in it,
 * the lowest such version at least `releaseAgeDays` old, else the lowest (own
 * packages skip the wait). A choice outside the version's own line is a
 * `major` move: the code may need adapting. A malicious version moves to the
 * nearest clean version at least `releaseAgeDays` old (own packages: any
 * age): newer in its line first, then older in its line (a downgrade), then
 * newer lines. An npm choice whose publisher identity `compare` would reject
 * keeps that as a blocker: a reviewed `identity` exception is the way through.
 *
 * Bumps (`bumpCandidates`): see there.
 */
import { actionGaps } from "./actions-changes.ts";
import { hasAged } from "./age.ts";
import { type CarriedPackage, type CarrierContext, type CarrierDecision, type CarrierGroup, decideCarrier, splitBundled } from "./carrier-candidates.ts";
import { type Config, isOwnPackage } from "./config.ts";
import { type Exceptions, unexcusedProblem } from "./exceptions.ts";
import { type Finding, findingKey, findingsOf, type Located } from "./findings.ts";
import type { Floor } from "./floors.ts";
import {
  bundleReader,
  type GateEnvironment,
  type GradleInputs,
  inventoryProblems,
  readScanState,
  type ScanState,
  snapshotOptions,
  versionCatalogs,
} from "./gate.ts";
import { gradleLocation, pinnedAmong, strictPinNote, strictPins } from "./gradle.ts";
import { gradleSourceIndex } from "./gradle-sources.ts";
import { type NpmLockfile, npmLocation } from "./inventory.ts";
import { directDependencies, type LockedPackage } from "./npm-lock.ts";
import { identityBaseline, NpmRegistry } from "./npm-registry.ts";
import { nodeRuntime, nodeTypeProblem, nodeTypeVersions } from "./node-runtime.ts";
import { requiredPeerTargets } from "./npm-required-peers.ts";
import { type PeerMove, type NpmPeerPlanner, prepareNpmPeers } from "./npm-peers.ts";
import { type PackageName, type PackageVersion, versionKey } from "./package-version.ts";
import type { Snapshot } from "./snapshot.ts";
import { takeSnapshot } from "./take-snapshot.ts";
import type { Tree } from "./tree.ts";
import { type Ecosystem, versionScheme } from "./versions.ts";
import { compatibleLine, fixes, movesFrom, nearestVetoes, reviewedGroups, ruleChoice, targetsOf, type VersionCatalog, type Veto, vetoesOf, vetoFields, vetoNote } from "./young-fixes.ts";

export interface SecurityMove {
  readonly version: string;
  /** The compatible line it's in. */
  readonly line: string;
  /**
   * Whether the gate leaves it unheld (not `isYoung`): at least `releaseAgeDays` old, or an own package, which never
   * waits. False for the lowest fix when no fix in its line is that old yet.
   */
  readonly aged: boolean;
  /** Outside the current version's line: the code may need adapting. */
  readonly major: boolean;
  /** What `compare` would still reject about the move (npm publisher identity), each needing a reviewed exception. */
  readonly blockers: ReadonlyArray<string>;
}

export interface SecurityFix {
  readonly ecosystem: Ecosystem;
  readonly name: string;
  readonly from: string;
  /** Lockfile paths, Gradle configuration ids or workflow files where `from` is. */
  readonly locations: ReadonlyArray<string>;
  /** The failing advisory groups to fix (malware aside), as the second snapshot groups them. */
  readonly targets: ReadonlyArray<string>;
  /** Targets no listed version fixes: `to` leaves them. */
  readonly unfixable: ReadonlyArray<string>;
  readonly malicious: boolean;
  /** The highest severity among its failing advisories, as they state it (`CRITICAL`, `HIGH`, …); undefined when none does. */
  readonly severity: string | undefined;
  readonly to: SecurityMove | undefined;
  /** Why there's no `to`. */
  readonly problem: string | undefined;
  /**
   * Set when `to` was dropped because an error kept its unit's publisher identity from being decided (`problem` says
   * which): a check that failed, to report as a failure, not a move the rules refused.
   */
  readonly undecided?: true;
  /** A carrier move: the bundled packages it replaces, and their advisories (`carrier-candidates.ts`). */
  readonly carries?: ReadonlyArray<CarriedPackage>;
  /** Candidates ruled out only by advisories no reviewed source corroborates, for people: the ones nearest the choice (`nearestVetoes`). */
  readonly vetoed?: ReadonlyArray<Veto>;
  /** How many more candidates such a veto ruled out, when there were more than `vetoed` shows. */
  readonly vetoesLeftOut?: number;
  /** For people: what the fix leaves alone, such as another version's unreviewed advisories. */
  readonly notes?: ReadonlyArray<string>;
}

export interface SecurityCandidates {
  readonly fixes: ReadonlyArray<SecurityFix>;
  /** Direct-peer closure on the same snapshot as these security targets. */
  readonly npmPeers?: NpmPeerPlanner;
  /**
   * The closure again with more npm versions to move (parents a fix's range needs), on a snapshot that covers them
   * and their direct peers' candidates too.
   */
  readonly peersWith?: (extra: ReadonlyArray<PackageVersion>) => Promise<NpmPeerPlanner>;
  /** What makes the inventory incomplete (a configuration that didn't resolve, an unrecorded bundle): the list can't be trusted to be whole. */
  readonly incomplete: ReadonlyArray<string>;
  readonly gaps: ReadonlyArray<string>;
  readonly osvScannerVersion: string;
}

/** A version a full scan fails on, with every advisory that fails it. */
interface FailingVersion {
  readonly pkg: Located;
  malicious: boolean;
  readonly advisories: string[];
  readonly severities: Array<string | undefined>;
}

/** The fix the rule picks for every version a full scan of `head` fails on. */
export async function securityCandidates(head: Tree, env: GateEnvironment, gradle: GradleInputs = {}): Promise<SecurityCandidates> {
  const state = await readScanState(head, env, gradle);
  const { config, exceptions } = state.settings;
  const now = env.now();
  const today = now.toISOString().slice(0, 10);
  const failing = new Map<string, FailingVersion>();
  // Only a reviewed advisory (or malware) triggers a fix; one only the project's repository publishes is reported.
  const findings = unexcused(state.packages, state.snapshot, exceptions, today);
  const triggers = findings.filter((finding) => finding.malicious || reviewedGroups(state.snapshot, finding).has(finding.advisory));
  const unreviewed = unreviewedReports(findings.filter((finding) => !triggers.includes(finding)), triggers);
  // Bundled copies can only move with their carrier: their findings become the carrier's targets. Every finding names
  // carriers (one whose bundle has only unreviewed findings is still a carrier, so its own fix checks the bundle);
  // only triggering ones become targets.
  const split = splitBundled(findings, state.inventory.npm);
  const rest = split.rest.filter((finding) => triggers.some((trigger) => findingKey(trigger) === findingKey(finding) && trigger.version === finding.version));
  const carriers = split.carriers.map((group) => triggeredOnly(group, triggers));
  for (const finding of rest) {
    const pkg: Located = { ecosystem: finding.ecosystem, name: finding.name, version: finding.version, locations: finding.locations };
    const entry = failing.get(versionKey(pkg)) ?? { pkg, malicious: false, advisories: [], severities: [] };
    entry.malicious ||= finding.malicious;
    entry.advisories.push(finding.advisory);
    entry.severities.push(finding.severity);
    failing.set(versionKey(pkg), entry);
  }
  // A carrier failing on its own too is one move with both kinds of targets.
  const carrierOwn = new Map<string, FailingVersion>();
  for (const group of carriers) {
    const key = versionKey({ ecosystem: "npm", name: group.name, version: group.version });
    const own = failing.get(key);
    if (own === undefined) continue;
    carrierOwn.set(key, own);
    failing.delete(key);
  }

  const registry = new NpmRegistry(env.fetch);
  const catalogs = versionCatalogs(config, env, state.github, registry);
  const identity = new IdentityCheck(registry, state.inventory.npm, exceptions, today);
  // Carriers are decided first, on snapshots of their own: their choices then join the peer closure and its snapshot.
  const carrierContext: CarrierContext = {
    reader: bundleReader(env), registry, catalog: catalogs.npm, config, now,
    scan: (packages) => takeSnapshot(packages, snapshotOptions(config, env, state.github)),
  };
  const carried: SecurityFix[] = [];
  for (const group of carriers) {
    const own = carrierOwn.get(versionKey({ ecosystem: "npm", name: group.name, version: group.version }));
    // A carrier with nothing reviewed to fix, in its bundle or of its own, isn't moved: its findings were reported.
    if (group.carried.size === 0 && own === undefined) continue;
    carried.push(await carrierFix(group, own, carrierContext));
  }
  const listings = new Map<string, ReadonlyArray<string> | undefined>();
  const candidates: PackageVersion[] = carried.flatMap((fix) => (fix.to === undefined ? [] : [{ ecosystem: "npm" as const, name: fix.name, version: fix.to.version }]));
  for (const { pkg, malicious } of failing.values()) {
    const listed = await catalogs[pkg.ecosystem].versions(pkg);
    const moves = listed === undefined ? undefined : movesFrom(pkg, pkg.version, listed, malicious ? "any" : "above");
    listings.set(versionKey(pkg), moves);
    candidates.push(...(moves ?? []).map((version) => ({ ...pkg, version })));
  }
  const peers = await preparePeers(head, state, registry, catalogs.npm, candidates, identity, now, true);
  // Direct-peer candidates join the security candidates: one snapshot decides the entire batch.
  const bases: Located[] = [...[...failing.values()].map(({ pkg }) => pkg), ...carried.map((fix): Located => ({ ecosystem: "npm", name: fix.name, version: fix.from, locations: fix.locations }))];
  const snapshot = await takeSnapshot([...bases, ...peers.bases], snapshotOptions(config, env, state.github), [...candidates, ...peers.candidates]);

  const chosen: SecurityFix[] = [];
  for (const { pkg } of failing.values()) {
    // Regrouped on the second snapshot: a candidate can link aliases into another canonical id.
    const current = unexcused([pkg], snapshot, exceptions, today);
    const malicious = current.some((finding) => finding.malicious);
    const reviewed = reviewedGroups(snapshot, pkg);
    const targets = targetsOf(snapshot, pkg, new Set(current.filter((finding) => reviewed.has(finding.advisory)).map((finding) => finding.advisory)));
    const severity = highestSeverity(current.map((finding) => finding.severity));
    const base = { ecosystem: pkg.ecosystem, name: pkg.name, from: pkg.version, locations: pkg.locations, targets, malicious, severity };
    const moves = listings.get(versionKey(pkg));
    const problem = (why: string): SecurityFix => ({ ...base, unfixable: [], to: undefined, problem: why });
    if (moves === undefined) {
      chosen.push(problem(`the registry doesn't list ${pkg.name}'s versions completely, so the rule can't be applied`));
    } else if (!malicious && targets.length === 0) {
      chosen.push(problem(`no failing advisory affects ${pkg.name}@${pkg.version} in the second snapshot (withdrawn or reclassified since the scan)`));
    } else {
      chosen.push(await chooseMove(pkg, targets, malicious, moves, { snapshot, catalog: catalogs[pkg.ecosystem], config, now }, base));
    }
  }
  const found: SecurityFix[] = [...await withUnitIdentity([...chosen, ...carried], identity), ...unreviewed.reports];
  // A package a reviewed fix moves (its own, or a carrier's for a bundled copy) gets its unreviewed findings as notes
  // on that fix, not as blocking reports; one whose reviewed fix is blocked anyway reports them like the rest.
  for (const [pkg, notes] of unreviewed.notes) {
    const moves = (fix: SecurityFix) => `${fix.ecosystem}|${fix.name}` === pkg || (fix.carries ?? []).some((carried) => `${fix.ecosystem}|${carried.name}` === pkg);
    const index = found.findIndex((fix) => fix.to !== undefined && moves(fix));
    if (index >= 0) found[index] = { ...found[index]!, notes: [...found[index]!.notes ?? [], ...notes] };
    else found.push(...unreviewed.held.get(pkg) ?? []);
  }
  return {
    fixes: found,
    npmPeers: { resolve: (moves) => peers.resolve(moves, snapshot) },
    peersWith: async (extra) => {
      const more = await preparePeers(head, state, registry, catalogs.npm, [...candidates, ...extra], identity, now, true);
      const wider = await takeSnapshot([...bases, ...more.bases], snapshotOptions(config, env, state.github), [...candidates, ...extra, ...more.candidates]);
      return { resolve: (moves) => more.resolve(moves, wider) };
    },
    incomplete: inventoryProblems(state.inventory, config),
    gaps: [...state.snapshot.gaps, ...snapshot.gaps, ...actionGaps(state.inventory.actions, state.resolutions)],
    osvScannerVersion: state.osvScannerVersion,
  };
}

/** `group` with only the carried advisories that trigger a fix (reviewed, or malware), and no package left without one. */
function triggeredOnly(group: CarrierGroup, triggers: ReadonlyArray<Finding>): CarrierGroup {
  const triggered = new Set(triggers.map((finding) => `${finding.name}|${finding.version}|${finding.advisory}`));
  const carried = new Map([...group.carried.entries()].flatMap(([name, entry]) => {
    const advisories = new Set([...entry.advisories].filter((advisory) => [...entry.versions].some((version) => triggered.has(`${name}|${version}|${advisory}`))));
    return advisories.size === 0 ? [] : [[name, { ...entry, advisories }] as const];
  }));
  return { ...group, carried };
}

/**
 * Advisories no reviewed source corroborates trigger no move: a fixed note. A package with no reviewed finding
 * anywhere reports them like any fix that can't be made; one with a reviewed finding, on this version or another,
 * gets them as a note on that fix instead (a report there would block the package's whole group).
 */
function unreviewedReports(unreviewed: ReadonlyArray<Finding>, triggers: ReadonlyArray<Finding>): {
  readonly reports: SecurityFix[];
  /** `ecosystem|name` → notes for its reviewed fix, and the same as reports if that fix turns out blocked. */
  readonly notes: Map<string, string[]>;
  readonly held: Map<string, SecurityFix[]>;
} {
  const byVersion = new Map<string, Finding[]>();
  for (const finding of unreviewed) {
    const key = versionKey(finding as PackageVersion);
    byVersion.set(key, [...byVersion.get(key) ?? [], finding]);
  }
  const reports: SecurityFix[] = [];
  const notes = new Map<string, string[]>();
  const held = new Map<string, SecurityFix[]>();
  for (const group of byVersion.values()) {
    const [first] = group as [Finding, ...Finding[]];
    const ids = [...new Set(group.flatMap((finding) => finding.ids))].sort();
    const finding = `${first.name}@${first.version} is affected by ${ids.join(", ")}, only in the project's repository advisories (not corroborated by the sources this decision used)`;
    const problem = `${finding}: no fix is proposed until a reviewed source lists it`;
    const report: SecurityFix = {
      ecosystem: first.ecosystem as Ecosystem, name: first.name, from: first.version, locations: [...new Set(group.flatMap((finding) => finding.locations))].sort(),
      targets: [], unfixable: [], malicious: false, severity: highestSeverity(group.map((finding) => finding.severity)), to: undefined, problem,
    };
    const pkg = `${first.ecosystem}|${first.name}`;
    if (!triggers.some((trigger) => `${trigger.ecosystem}|${trigger.name}` === pkg)) {
      reports.push(report);
      continue;
    }
    // On a reviewed fix's PR, which moves the package anyway: what these advisories don't do on their own.
    notes.set(pkg, [...notes.get(pkg) ?? [], `${finding}: these advisories alone don't trigger an update`]);
    held.set(pkg, [...held.get(pkg) ?? [], report]);
  }
  return { reports, notes, held };
}

/** A carrier version's fix; a decision that can't be made (an archive, a scan) is the fix's problem, not the run's. */
async function carrierFix(group: CarrierGroup, own: FailingVersion | undefined, context: CarrierContext): Promise<SecurityFix> {
  const malicious = group.malicious || own?.malicious === true;
  const decision: CarrierDecision = await decideCarrier(group, own?.advisories ?? [], malicious, context).catch((error: unknown) => ({
    from: group.version, locations: [], carries: [], unfixable: [], to: undefined,
    problem: `${group.name}@${group.version}'s carrier move can't be decided: ${error instanceof Error ? error.message : String(error)}`,
  }));
  return {
    ecosystem: "npm",
    name: group.name,
    from: group.version,
    locations: [...new Set([...decision.locations, ...(own?.pkg.locations ?? [])])].sort(),
    targets: [...new Set(own?.advisories ?? [])],
    unfixable: decision.unfixable,
    malicious,
    severity: highestSeverity([...group.severities, ...(own?.severities ?? [])]),
    to: decision.to,
    problem: decision.problem,
    carries: decision.carries,
    ...(decision.vetoed === undefined ? {} : { vetoed: decision.vetoed }),
    ...(decision.vetoesLeftOut === undefined ? {} : { vetoesLeftOut: decision.vetoesLeftOut }),
  };
}

const SEVERITY_RANK: Readonly<Record<string, number>> = { CRITICAL: 4, HIGH: 3, MODERATE: 2, MEDIUM: 2, LOW: 1 };

/** How severe a severity is, for ordering: CRITICAL 4, HIGH 3, MODERATE or MEDIUM 2, LOW 1, anything else 0. */
export function severityRank(severity: string | undefined): number {
  return severity === undefined ? 0 : (SEVERITY_RANK[severity.toUpperCase()] ?? 0);
}

function highestSeverity(severities: ReadonlyArray<string | undefined>): string | undefined {
  return severities.reduce<string | undefined>((best, next) => (severityRank(next) > severityRank(best) ? next : best), undefined);
}

/** Findings on `packages` that fail: no valid exception covers them (malware never has one). */
function unexcused(packages: ReadonlyArray<Located>, snapshot: Snapshot, exceptions: Exceptions, today: string) {
  return findingsOf(packages, snapshot).filter((finding) => unexcusedProblem(finding, exceptions, snapshot, today) !== undefined);
}

interface ChoiceContext {
  readonly snapshot: Snapshot;
  readonly catalog: VersionCatalog;
  readonly config: Config;
  readonly now: Date;
}

/**
 * Each npm move's identity blockers, judged against every copy its unit replaces along with it (`IdentityCheck`):
 * the copies of every move of the same package and kind. secure-it keeps a package's fixes in one unit or blocks
 * them together, so these are the copies verification will see replaced. Malware leaves on its own, so a malicious
 * copy never borrows the history of a sibling that isn't, and a fix without a move lends none: it blocks the package.
 * An identity check that fails (a provenance the registry won't serve, say) is the unit's problem, not the run's:
 * every move of that unit loses its move, the ones judged before the failure too, so no copy moves on a judgment
 * made without the rest of its unit. Other units and packages go on.
 */
async function withUnitIdentity(fixes: ReadonlyArray<SecurityFix>, identity: IdentityCheck): Promise<SecurityFix[]> {
  const unitOf = (fix: SecurityFix) => `${fix.name}|${fix.malicious}`;
  const moves = (fix: SecurityFix) => fix.ecosystem === "npm" && fix.to !== undefined;
  const replaced = new Map<string, string[]>();
  for (const fix of fixes) {
    if (moves(fix)) replaced.set(unitOf(fix), [...replaced.get(unitOf(fix)) ?? [], ...fix.locations]);
  }
  const blockers = new Map<SecurityFix, string[]>();
  // The first error of each unit whose identity can't be decided; its other moves aren't checked any further.
  const failed = new Map<string, string>();
  for (const fix of fixes) {
    if (!moves(fix) || failed.has(unitOf(fix))) continue;
    try {
      blockers.set(fix, await identity.problems({ ecosystem: "npm", name: fix.name, version: fix.from }, fix.to!.version, replaced.get(unitOf(fix))));
    } catch (error) {
      failed.set(unitOf(fix), error instanceof Error ? error.message : String(error));
    }
  }
  return fixes.map((fix) => {
    if (!moves(fix)) return fix;
    const error = failed.get(unitOf(fix));
    if (error === undefined) return { ...fix, to: { ...fix.to!, blockers: blockers.get(fix)! } };
    // As in `carrierFix` for a carrier. Without a move, the package is blocked with it (secure-it's `selectWork`).
    const problem = fix.carries === undefined
      ? `${fix.name}@${fix.from}'s publisher identity can't be decided: ${error}`
      : `${fix.name}@${fix.from}'s carrier move can't be decided: ${error}`;
    return { ...fix, to: undefined, problem, undecided: true };
  });
}

async function chooseMove(
  pkg: PackageVersion,
  targets: ReadonlyArray<string>,
  malicious: boolean,
  moves: ReadonlyArray<string>,
  context: ChoiceContext,
  base: Omit<SecurityFix, "to" | "problem" | "unfixable">,
): Promise<SecurityFix> {
  const { snapshot, catalog, config, now } = context;
  const name: PackageName = { ecosystem: pkg.ecosystem, name: pkg.name };
  const own = isOwnPackage(config.ownPackages, name);
  const line = (version: string) => compatibleLine(config, name, version);
  const fixable = targets.filter((target) => moves.some((version) => fixes(snapshot, name, pkg.version, [target], version)));
  const unfixable = targets.filter((target) => !fixable.includes(target));
  // Every choice below skips what unreviewed advisories alone rule out: recorded on whichever move it makes, the ones
  // nearest it in `order`, the order the choice ranks the candidates in.
  const vetoes = vetoesOf(snapshot, name, pkg.version, fixable, moves);
  // Its identity blockers wait for the package's other moves (`withUnitIdentity`).
  const move = (version: string, aged: boolean, order: ReadonlyArray<string> = moves): SecurityFix => ({
    ...base,
    unfixable,
    to: { version, line: line(version), aged, major: line(version) !== line(pkg.version), blockers: [] },
    problem: undefined,
    ...vetoFields(nearestVetoes(vetoes, order, version)),
  });
  const none = (why: string): SecurityFix => ({ ...base, unfixable, to: undefined, problem: why });
  const fixing = moves.filter((version) => fixes(snapshot, name, pkg.version, fixable, version));
  if (malicious) {
    const scheme = versionScheme(pkg.ecosystem);
    const sameLine = (version: string) => line(version) === line(pkg.version);
    // Newer in its line first, then older in its line, then newer lines.
    const preferred = (versions: ReadonlyArray<string>) => {
      const newer = versions.filter((version) => scheme.compare(version, pkg.version) > 0);
      return [
        ...newer.filter(sameLine),
        ...versions.filter((version) => scheme.compare(version, pkg.version) < 0 && sameLine(version)).reverse(),
        ...newer.filter((version) => !sameLine(version)),
      ];
    };
    const order = preferred(fixing);
    // The same order over every candidate, vetoed ones included: where each veto sits relative to the choice.
    const tried = preferred(moves);
    // Own packages skip the wait here too; the version must still be clean.
    if (own && order.length > 0) return move(order[0]!, true, tried);
    for (const version of order) {
      if (await isAged({ ...name, version }, catalog, config, now)) return move(version, true, tried);
    }
    return none(`no clean version of ${pkg.name} at least ${config.releaseAgeDays} days old to leave the malicious ${pkg.version} for`);
  }
  // A refusal names what unreviewed advisories alone ruled out, judged against the targets it names.
  const refused = (why: string, named: ReadonlyArray<string>) => none(`${why}${vetoNote(vetoesOf(snapshot, name, pkg.version, named, moves))}`);
  if (fixable.length === 0) return refused(`no version above ${pkg.version} fixes ${targets.join(", ")}`, targets);
  if (fixing.length === 0) return refused(`no single version above ${pkg.version} fixes all of ${fixable.join(", ")}, though each has a fix`, fixable);
  if (own) {
    // Own packages skip the wait: the lowest fix in the first line that has one.
    const first = line(fixing[0]!);
    return move(fixing.find((version) => line(version) === first)!, true);
  }
  const choice = await ruleChoice(name, fixing, catalog, config, now);
  if (choice.kind === "undated") {
    return none(`the publish time of ${choice.versions.join(", ")} (fixing, line ${choice.line}) is unknown, so the rule can't tell which fix is old enough`);
  }
  return move(choice.version, choice.aged);
}

async function isAged(pkg: PackageVersion, catalog: VersionCatalog, config: Config, now: Date): Promise<boolean> {
  const published = await catalog.published(pkg);
  return hasAged(published, config.releaseAgeDays, now);
}

/**
 * The npm publisher identity check `compare` runs on a version that replaces
 * others, made before the change exists: in each lockfile that ships `from`
 * from the registry, against the copies there the change replaces with it, as
 * verification reads them (`identityBaseline`), with the same exceptions. No
 * lockfile lends another its copies. By default the change replaces the copies
 * of `from` alone; a planner that knows which copies its unit replaces together
 * names them. Other ecosystems have none.
 */
export class IdentityCheck {
  readonly #registry: NpmRegistry;
  readonly #lockfiles: ReadonlyArray<NpmLockfile>;
  readonly #exceptions: Exceptions;
  readonly #today: string;

  constructor(registry: NpmRegistry, lockfiles: ReadonlyArray<NpmLockfile>, exceptions: Exceptions, today: string) {
    this.#registry = registry;
    this.#lockfiles = lockfiles;
    this.#exceptions = exceptions;
    this.#today = today;
  }

  /** `replaced`: the locations (`npmLocation`) of every copy of the package the unit replaces along with `from`. */
  async problems(from: PackageVersion, to: string, replaced?: ReadonlyArray<string>): Promise<string[]> {
    if (from.ecosystem !== "npm") return [];
    const taken = replaced === undefined ? undefined : new Set(replaced);
    const baselines = this.#lockfiles
      .map((lockfile) => identityBaseline(lockfile.packages.filter((copy) => copy.name === from.name
        && (taken === undefined ? copy.version === from.version : taken.has(npmLocation(lockfile.path, copy.path))))))
      .filter((baseline) => baseline.has(from.version));
    const doc = await this.#registry.packument(from.name);
    const manifest = doc.versions[to] as { dist?: { integrity?: unknown; tarball?: unknown } } | undefined;
    const candidate: LockedPackage = {
      name: from.name,
      version: to,
      path: `node_modules/${from.name}`,
      resolved: typeof manifest?.dist?.tarball === "string" ? manifest.dist.tarball : undefined,
      bundled: false,
      integrity: typeof manifest?.dist?.integrity === "string" ? manifest.dist.integrity : undefined,
    };
    // With no registry copy of `from` there's no baseline to compare, so no break is reported, but the candidate's
    // own provenance is still read and validated: a malformed or mismatched statement fails.
    const problems: string[] = [];
    for (const baseline of baselines.length === 0 ? [new Map<string, string | undefined>()] : baselines) {
      problems.push(...await this.#registry.identityProblems(candidate, baseline, this.#exceptions, this.#today));
    }
    return [...new Set(problems)];
  }
}

/** How many of a line's newest aged versions bump-it weighs: past them, it reports instead of digging further. */
export const BUMP_DEPTH = 10;

export interface BumpMove {
  readonly version: string;
  readonly line: string;
}

/** Where an npm dependency is declared, for editing it. */
export interface NpmDeclaration {
  readonly lockfile: string;
  /** The declaring workspace, `.` for the root. */
  readonly workspace: string;
  /** The key it's declared under: its name, or an `npm:` alias. */
  readonly declaredAs: string;
  /** The range as written. */
  readonly spec: string;
}

/** A dependency the repository declares directly, and where bump-it can move it. */
export interface BumpCandidate {
  readonly ecosystem: Ecosystem;
  readonly name: string;
  readonly from: string;
  /** npm: `lockfile#workspace`; Gradle: configuration ids; Actions: workflow files. */
  readonly locations: ReadonlyArray<string>;
  /** npm only: each declaration of this version, with the key and range to edit. */
  readonly declarations: ReadonlyArray<NpmDeclaration>;
  /** The highest acceptable version in `from`'s own line (minors and patches go together in one PR). */
  readonly minor: BumpMove | undefined;
  /** The highest acceptable version of the highest newer line that has one (each major is a PR of its own). */
  readonly major: BumpMove | undefined;
  /**
   * What kept versions out: a line whose weighed versions all add an advisory, an identity break, a registry that can't
   * list, a publisher identity that can't be decided (then no move at all).
   */
  readonly problems: ReadonlyArray<string>;
  /**
   * Set when an error kept this dependency's publisher identity from being decided: the problem saying so (also among
   * `problems`). No move is proposed, and it's a check that failed, to report as a failure.
   */
  readonly undecided?: string;
}

export interface BumpCandidates {
  readonly bumps: ReadonlyArray<BumpCandidate>;
  readonly npmPeers?: NpmPeerPlanner;
  /** As in `SecurityCandidates`: the inventory isn't whole, so neither is this list. */
  readonly incomplete: ReadonlyArray<string>;
  readonly gaps: ReadonlyArray<string>;
  readonly osvScannerVersion: string;
  /** Declared dependencies left out because no supported declaration of them was found in their build's sources. */
  readonly notes: ReadonlyArray<string>;
}

interface Direct extends Located {
  readonly declarations: ReadonlyArray<NpmDeclaration>;
}

/** One line of one dependency, still to judge: its newest aged versions, newest first. */
interface Pending {
  readonly pkg: Direct;
  readonly line: string;
  readonly versions: ReadonlyArray<string>;
}

/**
 * Where bump-it can move each directly declared dependency: in its own line,
 * and in the highest newer line that has an acceptable version (lines are
 * tried from the highest down), the highest version at least `releaseAgeDays`
 * old (own packages skip the wait) that adds no advisory group, no malware
 * and, on npm, no publisher identity break (one that can't be decided leaves
 * the dependency without moves, as a problem). Each round of lines is judged on
 * one snapshot of the current versions and every version weighed in it.
 * Direct means: npm dependencies the root and the workspaces of every checked
 * lockfile declare (aliases included); Gradle dependencies declared with a
 * version, recorded floors aside (bump-it doesn't raise floors); and every
 * `uses:` pinned to a release. Gradle transitives are never bumped. Node API
 * types are capped at the lowest declared runtime major; unreadable runtime
 * metadata permits only moves within the current type major.
 */
export async function bumpCandidates(head: Tree, env: GateEnvironment, gradle: GradleInputs = {}): Promise<BumpCandidates> {
  const state = await readScanState(head, env, gradle);
  const { config, floors, exceptions } = state.settings;
  const now = env.now();
  const today = now.toISOString().slice(0, 10);
  const { direct, notes } = await directOf(head, state, floors);
  const registry = new NpmRegistry(env.fetch);
  const catalogs = versionCatalogs(config, env, state.github, registry);
  const identity = new IdentityCheck(registry, state.inventory.npm, exceptions, today);

  const problems = new Map<string, string[]>(direct.map((pkg) => [versionKey(pkg), []]));
  const minors = new Map<string, BumpMove>();
  const majors = new Map<string, BumpMove>();
  // Higher lines still to try per dependency, highest first.
  const higherLines = new Map<string, string[]>();
  const newerOf = new Map<string, ReadonlyArray<string>>();
  // Dependencies whose publisher identity couldn't be decided, with the problem saying so: no move for them.
  const undecided = new Map<string, string>();
  let round: Pending[] = [];
  for (const pkg of direct) {
    const listed = await catalogs[pkg.ecosystem].versions(pkg);
    if (listed === undefined) {
      problems.get(versionKey(pkg))!.push(`the registry doesn't list ${pkg.name}'s versions completely`);
      continue;
    }
    const allowed = pkg.ecosystem === "npm" && pkg.name === "@types/node"
      ? await nodeVersionsFor(head, pkg, listed, problems.get(versionKey(pkg))!) : listed;
    const newer = movesFrom(pkg, pkg.version, allowed);
    newerOf.set(versionKey(pkg), newer);
    problems.get(versionKey(pkg))!.push(...(await untrustedActionReleases(pkg, newer, catalogs[pkg.ecosystem], config)));
    const line = (version: string) => compatibleLine(config, pkg, version);
    const own = line(pkg.version);
    higherLines.set(versionKey(pkg), [...new Set(newer.map(line).filter((candidate) => candidate !== own))].reverse());
    round.push(...(await pending(pkg, own, newer, catalogs[pkg.ecosystem], config, now)));
    round.push(...(await nextHigherLine(pkg, higherLines.get(versionKey(pkg))!, newer, catalogs[pkg.ecosystem], config, now)));
  }

  const snapshots: Snapshot[] = [];
  while (round.length > 0) {
    const snapshot = await takeSnapshot(
      [...new Map(round.map(({ pkg }) => [versionKey(pkg), pkg])).values()],
      snapshotOptions(config, env, state.github),
      round.flatMap(({ pkg, versions }) => versions.map((version) => ({ ...pkg, version }))),
    );
    snapshots.push(snapshot);
    const next: Pending[] = [];
    for (const { pkg, line, versions } of round) {
      const key = versionKey(pkg);
      if (undecided.has(key)) continue;
      const ownLine = line === compatibleLine(config, pkg, pkg.version);
      let accepted: string | undefined;
      for (const version of versions) {
        if (!fixes(snapshot, pkg, pkg.version, [], version)) continue;
        let breaks: string[];
        try {
          breaks = await identity.problems(pkg, version);
        } catch (error) {
          // An identity check that fails (a provenance the registry won't serve, say) is the dependency's problem, not
          // the run's: it gets no move at all, in any line, and no failed read counts as an acceptable version.
          const problem = `${pkg.name}@${version}'s publisher identity can't be decided, so no move is proposed: ${error instanceof Error ? error.message : String(error)}`;
          undecided.set(key, problem);
          problems.get(key)!.push(problem);
          break;
        }
        if (breaks.length > 0) {
          problems.get(key)!.push(...breaks);
          continue;
        }
        accepted = version;
        break;
      }
      if (undecided.has(key)) {
        minors.delete(key);
        majors.delete(key);
        continue;
      }
      if (accepted !== undefined) {
        (ownLine ? minors : majors).set(key, { version: accepted, line });
        continue;
      }
      problems.get(key)!.push(`each of the ${versions.length} newest versions of line ${line} old enough adds an advisory, is malicious or breaks identity`);
      if (ownLine) continue;
      // This major line has nothing acceptable: try the next one down.
      next.push(...(await nextHigherLine(pkg, higherLines.get(key)!, newerOf.get(key)!, catalogs[pkg.ecosystem], config, now)));
    }
    round = next;
  }

  const bumps: BumpCandidate[] = direct.map((pkg) => ({
    ecosystem: pkg.ecosystem,
    name: pkg.name,
    from: pkg.version,
    locations: pkg.locations,
    declarations: pkg.declarations,
    minor: minors.get(versionKey(pkg)),
    major: majors.get(versionKey(pkg)),
    problems: problems.get(versionKey(pkg))!,
    ...(undecided.has(versionKey(pkg)) ? { undecided: undecided.get(versionKey(pkg))! } : {}),
  }));
  const selected = bumps.flatMap((bump) => [bump.minor, bump.major].flatMap((move) =>
    move === undefined ? [] : [{ ecosystem: bump.ecosystem, name: bump.name, version: move.version }]));
  const peers = await preparePeers(head, state, registry, catalogs.npm, selected, identity, now);
  const peerSnapshot = peers.bases.length === 0 ? undefined : await takeSnapshot(peers.bases, snapshotOptions(config, env, state.github), peers.candidates);
  return {
    bumps,
    npmPeers: peerSnapshot === undefined ? undefined : { resolve: (moves) => peers.resolve(moves, peerSnapshot) },
    incomplete: inventoryProblems(state.inventory, config),
    gaps: [...state.snapshot.gaps, ...snapshots.flatMap((snapshot) => snapshot.gaps), ...(peerSnapshot?.gaps ?? []), ...actionGaps(state.inventory.actions, state.resolutions)],
    osvScannerVersion: state.osvScannerVersion,
    notes,
  };
}

/**
 * A note naming an action's newer releases that have no trusted age (only immutable releases have one), which the
 * bump skips: without it they'd just never be picked, with nothing saying why.
 */
export async function untrustedActionReleases(pkg: Direct, newer: ReadonlyArray<string>, catalog: VersionCatalog, config: Config): Promise<string[]> {
  if (pkg.ecosystem !== "GitHub Actions" || isOwnPackage(config.ownPackages, pkg)) return [];
  const undated: string[] = [];
  for (const version of newer) {
    if (await catalog.published({ ...pkg, version }) === undefined) undated.push(version);
  }
  if (undated.length === 0) return [];
  return [`${pkg.name} ${undated.join(", ")}: no immutable GitHub release, so the age can't be trusted and the tools don't pick it; update it by hand, or wait for immutable releases`];
}

async function nodeVersionsFor(head: Tree, pkg: Direct, listed: ReadonlyArray<string>, problems: string[]): Promise<ReadonlyArray<string>> {
  const runtime = await nodeRuntime(head, pkg.declarations);
  const allowed = nodeTypeVersions(pkg.version, listed, runtime);
  if (runtime.major === undefined || allowed.length !== listed.length) problems.push(nodeTypeProblem(runtime));
  return allowed;
}

async function preparePeers(head: Tree, state: ScanState, registry: NpmRegistry, catalog: VersionCatalog, seeds: ReadonlyArray<PackageVersion>, identity: IdentityCheck, now: Date, security = false) {
  const locks = new Map<string, unknown>();
  for (const lock of state.inventory.npm) {
    const text = await head.read(lock.path);
    if (text === undefined) throw new Error(`${lock.path} disappeared while reading peers`);
    locks.set(lock.path, JSON.parse(text));
  }
  const config = state.settings.config;
  return prepareNpmPeers(locks, seeds, {
    ...(security ? { requiredYoung: (_name: string, _from: string, lockfile: string, path: string, anchors: ReadonlyArray<PeerMove>) =>
      forcedPeerVersion(locks, lockfile, path, anchors, registry, config, now) } : {}),
    versions: (name) => catalog.versions({ ecosystem: "npm", name }),
    manifest: async (name, version) => (await registry.packument(name)).versions[version],
    published: (name, version) => catalog.published({ ecosystem: "npm", name, version }),
    // A security unit's moves are judged against every copy they replace together, as `withUnitIdentity` judged them;
    // bump planning keeps checking each source version on its own.
    identity: (name, from, to, replaced) => identity.problems({ ecosystem: "npm", name, version: from }, to, security ? replaced : undefined),
    line: (name, version) => compatibleLine(config, { ecosystem: "npm", name }, version),
    isOwn: (name) => isOwnPackage(config.ownPackages, { ecosystem: "npm", name }),
    now,
    releaseAgeDays: config.releaseAgeDays,
  });
}

async function forcedPeerVersion(locks: ReadonlyMap<string, unknown>, lockfile: string, path: string, anchors: ReadonlyArray<PeerMove>, registry: NpmRegistry, config: Config, now: Date): Promise<string | undefined> {
  const lock = locks.get(lockfile) as { packages: Record<string, unknown> };
  const original = lock.packages;
  const chosen = structuredClone(original);
  const dir = lockfile.includes("/") ? lockfile.slice(0, lockfile.lastIndexOf("/")) : "";
  const inLock = (location: string) => dir === "" ? location : location.startsWith(`${dir}/`) ? location.slice(dir.length + 1) : undefined;
  const roots = anchors.flatMap((anchor) => anchor.locations.flatMap((location) => {
    const key = inLock(location);
    const entry = key === undefined ? undefined : chosen[key];
    if (key === undefined || entry === null || typeof entry !== "object") return [];
    chosen[key] = { ...entry, version: anchor.to };
    return [{ name: anchor.name, version: anchor.to, path: key }];
  }));
  for (const root of roots) {
    const required = await requiredPeerTargets(root, original, chosen, registry, config, now, new Set(roots.map((root) => root.path)));
    const target = required.find((target) => target.path === path);
    if (target !== undefined) return target.version;
  }
  return undefined;
}

/** The highest of `lines` (consumed from the front) with a version old enough to weigh, or none left. */
async function nextHigherLine(
  pkg: Direct,
  lines: string[],
  newer: ReadonlyArray<string>,
  catalog: VersionCatalog,
  config: Config,
  now: Date,
): Promise<Pending[]> {
  for (let line = lines.shift(); line !== undefined; line = lines.shift()) {
    const found = await pending(pkg, line, newer, catalog, config, now);
    if (found.length > 0) return found;
  }
  return [];
}

/** `line`'s newest versions old enough to weigh (none when it has no newer version or none is old enough). */
async function pending(
  pkg: Direct,
  line: string,
  newer: ReadonlyArray<string>,
  catalog: VersionCatalog,
  config: Config,
  now: Date,
): Promise<Pending[]> {
  const inLine = newer.filter((version) => compatibleLine(config, pkg, version) === line).reverse();
  if (inLine.length === 0) return [];
  const versions = await newestAged(pkg, inLine, catalog, config, now);
  return versions.length === 0 ? [] : [{ pkg, line, versions }];
}

/** Up to `BUMP_DEPTH` versions of `newestFirst` old enough (own packages: any age), newest first. */
async function newestAged(
  pkg: PackageVersion,
  newestFirst: ReadonlyArray<string>,
  catalog: VersionCatalog,
  config: Config,
  now: Date,
): Promise<string[]> {
  if (isOwnPackage(config.ownPackages, pkg)) return newestFirst.slice(0, BUMP_DEPTH);
  const aged: string[] = [];
  for (const version of newestFirst) {
    if (aged.length === BUMP_DEPTH) break;
    if (await isAged({ ...pkg, version }, catalog, config, now)) aged.push(version);
  }
  return aged;
}

/**
 * The directly declared dependencies of the scanned tree, one per version, with where each is declared, sorted. A
 * Gradle dependency counts only when the repository's Gradle sources name it (see `gradleSourceIndex`): plugins add
 * dependencies too, and a bump needs a declaration to move. A coordinate pinned with `strictly(...)` (declared or as a
 * constraint) in any configuration that declares it isn't moved at all, in any configuration: the pin is the owner's.
 * The rest are listed in `notes`.
 */
async function directOf(head: Tree, state: ScanState, floors: ReadonlyArray<Floor>): Promise<{ direct: Direct[]; notes: string[] }> {
  const byVersion = new Map<string, { pkg: PackageVersion; locations: Set<string>; declarations: NpmDeclaration[] }>();
  const add = (pkg: PackageVersion, location: string, declaration?: NpmDeclaration) => {
    const entry = byVersion.get(versionKey(pkg)) ?? { pkg, locations: new Set<string>(), declarations: [] };
    entry.locations.add(location);
    if (declaration !== undefined) entry.declarations.push(declaration);
    byVersion.set(versionKey(pkg), entry);
  };
  for (const lockfile of state.inventory.npm) {
    const text = await head.read(lockfile.path);
    if (text === undefined) throw new Error(`${lockfile.path} disappeared while reading it`);
    for (const dependency of directDependencies(JSON.parse(text))) {
      const workspace = dependency.workspace || ".";
      add({ ecosystem: "npm", name: dependency.name, version: dependency.version }, `${lockfile.path}#${workspace}`, {
        lockfile: lockfile.path,
        workspace,
        declaredAs: dependency.declaredAs,
        spec: dependency.spec,
      });
    }
  }
  const floored = new Set(floors.filter((floor) => floor.ecosystem === "Maven").map((floor) => `${floor.package}@${floor.version}`));
  const builds = state.inventory.gradle?.builds ?? [];
  const sources = builds.length === 0 ? undefined : await gradleSourceIndex(head);
  const unnamed = new Map<string, Set<string>>();
  const declaredIn = new Map<string, Set<string>>();
  for (const build of builds) {
    for (const configuration of build.configurations) {
      for (const declared of configuration.declared) {
        const name = `${declared.group}:${declared.name}`;
        declaredIn.set(name, (declaredIn.get(name) ?? new Set()).add(gradleLocation(build.build, configuration.id)));
      }
    }
  }
  const allPins = strictPins(state.inventory.gradle);
  const pins = new Map([...declaredIn].map(([name, locations]) => [name, pinnedAmong(allPins, name, locations)] as const).filter(([, pinned]) => pinned.length > 0));
  for (const build of builds) {
    for (const configuration of build.configurations) {
      for (const declared of configuration.declared) {
        if (declared.version === undefined) continue;
        const name = `${declared.group}:${declared.name}`;
        if (floored.has(`${name}@${declared.version}`) || pins.has(name)) continue;
        const location = gradleLocation(build.build, configuration.id);
        if (!sources!.named(declared.group, declared.name)) {
          const key = `${name}@${declared.version}`;
          unnamed.set(key, (unnamed.get(key) ?? new Set()).add(location));
          continue;
        }
        add({ ecosystem: "Maven", name, version: declared.version }, location);
      }
    }
  }
  const notes = [
    ...[...unnamed.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, locations]) =>
      `${key}: not named in the repository's Gradle sources (${[...locations].sort().join(", ")}), so it isn't moved automatically; a plugin may add it, or it uses notation bump-it doesn't read`),
    ...[...pins.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, locations]) => strictPinNote(name, locations)),
  ];
  for (const pkg of state.packages.filter((located) => located.ecosystem === "GitHub Actions")) {
    for (const location of pkg.locations) add(pkg, location);
  }
  const direct = [...byVersion.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, { pkg, locations, declarations }]) => ({ ...pkg, locations: [...locations].sort(), declarations }));
  return { direct, notes };
}
