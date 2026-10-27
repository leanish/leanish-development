/**
 * The proof that a version younger than the wait may be taken anyway: it's
 * the security fix the version rule would pick.
 *
 * For a young version V replacing R, the targets are the advisory groups
 * that affect R and not V (malware aside; an upgrade that fixes A and leaves
 * B fixes A). Candidates are the registry's versions above R, up to the end
 * of V's line (prereleases only if R is one; Maven keeps R's flavor, `-jre`).
 * A candidate fixes when no target affects it and it adds no advisory R
 * doesn't have (a reviewed one R has only from the project's repository
 * advisories counts as added: `inherits`), malware included. The rule:
 *   1. the first line, from R's own compatible line upward, with a fixing
 *      candidate (so a backport beats a newer major);
 *   2. in it, the lowest fixing candidate at least `releaseAgeDays` old;
 *   3. else the lowest fixing candidate, however young.
 * V passes only if it's that version. If an older fix in the line turns 7
 * days old before CI runs, the proof fails on purpose: that one is safer.
 *
 * All of it is read from the comparison's snapshot, which includes every
 * candidate, so the proof and the comparison see the same advisories.
 */
import { ageDays } from "./age.ts";
import type { Config } from "./config.ts";
import { evidenceOf, inherits } from "./findings.ts";
import { type PackageName, type PackageVersion, versionKey } from "./package-version.ts";
import type { Snapshot } from "./snapshot.ts";
import { type Ecosystem, versionScheme } from "./versions.ts";

/** Where a package's versions and their publish times come from. */
export interface VersionCatalog {
  /** Every version the registry has, in any order; undefined when it can't list them. */
  versions(pkg: PackageName): Promise<ReadonlyArray<string> | undefined>;
  /** When `pkg` was published; undefined when the registry can't say. */
  published(pkg: PackageVersion): Promise<Date | undefined>;
}

export interface YoungVersion {
  readonly pkg: PackageVersion;
  /** Versions of the package the change replaces. */
  readonly replaced: ReadonlyArray<string>;
}

/** The compatible line of `version`: config's override (numeric segments after an optional v/V), else the ecosystem's rule. */
export function compatibleLine(config: Config, pkg: PackageName, version: string): string {
  const segments = lineOverride(config, pkg);
  if (segments === undefined) return versionScheme(pkg.ecosystem).line(version);
  const numbers = version.replace(/^[vV]/, "").split(/[.\-+]/).filter((part) => /^\d+$/.test(part));
  return numbers.slice(0, segments).join(".");
}

function lineOverride(config: Config, pkg: PackageName): number | undefined {
  const key = `${pkg.ecosystem}:${pkg.name}`;
  for (const [pattern, segments] of config.compatibleLines) {
    if (pattern === key || (pattern.endsWith("*") && key.startsWith(pattern.slice(0, -1)))) return segments;
  }
  return undefined;
}

/**
 * The versions a move from `from` may land on, in ascending order: every
 * listed version that parses, other than `from`, with no prerelease unless
 * `from` is one, and `from`'s flavor (Maven's `-jre`). `above` keeps only the
 * newer ones; the older ones are for leaving a malicious version.
 */
export function movesFrom(pkg: PackageName, from: string, all: ReadonlyArray<string>, direction: "above" | "any" = "above"): string[] {
  const scheme = versionScheme(pkg.ecosystem);
  const parses = (version: string) => {
    try {
      scheme.compare(version, from);
      return true;
    } catch {
      return false;
    }
  };
  return [...new Set(all)]
    .filter(parses)
    .filter((version) => (direction === "above" ? scheme.compare(version, from) > 0 : scheme.compare(version, from) !== 0))
    .filter((version) => scheme.isPrerelease(from) || !scheme.isPrerelease(version))
    .filter((version) => scheme.flavor(version) === scheme.flavor(from))
    .sort(scheme.compare);
}

/** The versions the proof weighs for replacing `from` with `to`, in ascending order. */
export function candidateVersions(config: Config, pkg: PackageName, from: string, to: string, all: ReadonlyArray<string>): string[] {
  const scheme = versionScheme(pkg.ecosystem);
  const line = (version: string) => compatibleLine(config, pkg, version);
  return movesFrom(pkg, from, all).filter((version) => scheme.compare(version, to) <= 0 || line(version) === line(to) || line(version) === line(from));
}

/** The advisory groups affecting a version, from the snapshot. */
export function groupsOf(snapshot: Snapshot, pkg: PackageVersion): Set<string> {
  return new Set(snapshot.advisories(pkg).map((advisory) => snapshot.group(advisory.id)));
}

/** The groups a move from `from` has to fix: the ones affecting it, malware aside, and among `only` when given. */
export function targetsOf(snapshot: Snapshot, pkg: PackageVersion, only?: ReadonlySet<string>): string[] {
  const malicious = new Set(snapshot.advisories(pkg).filter((advisory) => advisory.malicious).map((advisory) => snapshot.group(advisory.id)));
  return [...groupsOf(snapshot, pkg)].filter((group) => !malicious.has(group) && (only === undefined || only.has(group)));
}

/**
 * Whether `version` fixes `targets` of `from`: none of them affects it, every group on it is inherited from `from`
 * (`inherits`: a reviewed one only from reviewed evidence there), no malware. Groups in `ignore` don't count against it
 * (malware always does): what a veto by them alone looks like.
 */
export function fixes(snapshot: Snapshot, pkg: PackageName, from: string, targets: ReadonlyArray<string>, version: string, ignore: ReadonlySet<string> = new Set()): boolean {
  const before = baselineEvidence(snapshot, [{ ...pkg, version: from }]);
  const candidate = { ...pkg, version };
  const advisories = snapshot.advisories(candidate);
  const reviewed = reviewedGroups(snapshot, candidate);
  const found = new Set(advisories.map((advisory) => snapshot.group(advisory.id)).filter((group) => !ignore.has(group)));
  return !advisories.some((advisory) => advisory.malicious) && targets.every((group) => !found.has(group)) && [...found].every((group) => inherits(before, group, reviewed.has(group)));
}

/**
 * The advisory groups on `versions` (copies of one package) as inheritance evidence (`inherits`): a group is reviewed
 * when a reviewed source reports it on any of them.
 */
export function baselineEvidence(snapshot: Snapshot, versions: ReadonlyArray<PackageVersion>): Map<string, boolean> {
  return evidenceOf(versions.flatMap((pkg) => {
    const reviewed = reviewedGroups(snapshot, pkg);
    return [...groupsOf(snapshot, pkg)].map((group) => [group, reviewed.has(group)] as const);
  }));
}

/**
 * The groups on `pkg` that a reviewed source corroborates: some advisory of the group on this version comes from
 * OSV or GitHub's database, not only from the project's own repository advisories. Only these trigger a fix or
 * justify a young version; the rest still count against a candidate (`fixes`), as vetoes.
 */
export function reviewedGroups(snapshot: Snapshot, pkg: PackageVersion): Set<string> {
  return new Set(snapshot.advisories(pkg).filter((advisory) => advisory.source !== "repository").map((advisory) => snapshot.group(advisory.id)));
}

/** The groups on `pkg` only the project's own repository advisories publish, as far as the snapshot's sources go. */
export function unreviewedGroups(snapshot: Snapshot, pkg: PackageVersion): Set<string> {
  const reviewed = reviewedGroups(snapshot, pkg);
  return new Set([...groupsOf(snapshot, pkg)].filter((group) => !reviewed.has(group)));
}

/** A candidate a veto by unreviewed groups alone ruled out: it would fix `targets` with those groups ignored. */
export interface Veto {
  readonly version: string;
  /** Every id of the unreviewed groups that ruled it out. */
  readonly advisories: ReadonlyArray<string>;
}

/**
 * The candidates in `versions` that fail `fixes` only because of unreviewed groups on them. A group reviewed on the
 * candidate that `from` has only from the project's repository advisories is never ignored here, so a candidate it
 * rules out stays ruled out without becoming a veto: no unreviewed advisory is what blocks it.
 */
export function vetoesOf(snapshot: Snapshot, pkg: PackageName, from: string, targets: ReadonlyArray<string>, versions: ReadonlyArray<string>): Veto[] {
  return versions.flatMap((version) => {
    const candidate = { ...pkg, version };
    const unreviewed = unreviewedGroups(snapshot, candidate);
    if (unreviewed.size === 0 || fixes(snapshot, pkg, from, targets, version) || !fixes(snapshot, pkg, from, targets, version, unreviewed)) return [];
    // Only the unreviewed groups that block it: a target it still has, or one not inherited from `from` (inherited debt
    // doesn't); an unreviewed group inherits from any evidence there.
    const before = baselineEvidence(snapshot, [{ ...pkg, version: from }]);
    const blocking = (group: string) => unreviewed.has(group) && (targets.includes(group) || !inherits(before, group, false));
    const ids = snapshot.advisories(candidate).filter((advisory) => blocking(snapshot.group(advisory.id))).flatMap((advisory) => advisory.ids);
    return [{ version, advisories: [...new Set(ids)].sort() }];
  });
}

/** How a veto note starts, so attribution can leave it out (`withoutVetoNote`). */
const VETO_NOTE_START = "; advisories no reviewed source corroborates ruled out ";

/** At most this many advisories are shown per vetoed version; the rest are counted. */
const ADVISORIES_SHOWN = 3;

/** The first `limit` items, and a count of the rest. */
const counted = (items: ReadonlyArray<string>, limit: number) =>
  `${items.slice(0, limit).join(", ")}${items.length > limit ? ` and ${items.length - limit} more` : ""}`;

/**
 * For a refusal: the candidates advisories no reviewed source corroborates alone ruled out, lowest first and at most
 * `VETOES_SHOWN`, each with at most `ADVISORIES_SHOWN` of its advisories, so the message names what a person could
 * override; "" when there were none. Only the text is bounded: the recorded vetoes stay whole.
 */
export function vetoNote(vetoes: ReadonlyArray<Veto>): string {
  if (vetoes.length === 0) return "";
  const shown = vetoes.slice(0, VETOES_SHOWN).map((veto) => `${veto.version} (${counted(veto.advisories, ADVISORIES_SHOWN)})`);
  const more = vetoes.length - shown.length;
  return `${VETO_NOTE_START}${shown.join(", ")}${more === 0 ? "" : ` and ${more} more`}`;
}

/**
 * `text` without the note `vetoNote` appended: what a retry reads to tell which move a problem names. The note names
 * versions and advisory ids, which say nothing about which move failed, yet could read like another package's name.
 */
export function withoutVetoNote(text: string): string {
  const at = text.indexOf(VETO_NOTE_START);
  return at === -1 ? text : text.slice(0, at);
}

/** At most this many vetoes are recorded with a choice, the ones nearest it; the rest are counted (`nearestVetoes`). */
export const VETOES_SHOWN = 10;

/** What a choice records of its vetoes: a bounded sample, the ones nearest it, and how many more there were. */
export interface RecordedVetoes {
  readonly vetoed: ReadonlyArray<Veto>;
  readonly vetoesLeftOut: number;
}

/**
 * The VETOES_SHOWN vetoes nearest `chosen` in `order` (the candidates as the choice ranks them), on either side, the
 * earlier first on a tie, kept in `order`'s order, and a count of the rest. Either side: the rule prefers an aged fix,
 * so the one a veto took from it can sit above a young choice. A sample, not every veto that shaped the choice; without
 * it, every move of a package would repeat them all (thousands, for one open-ended advisory). Only vetoes of
 * candidates in `order` count, never the chosen version's own.
 */
export function nearestVetoes(vetoes: ReadonlyArray<Veto>, order: ReadonlyArray<string>, chosen: string): RecordedVetoes {
  const at = order.indexOf(chosen);
  if (at === -1) throw new Error(`the chosen version ${chosen} isn't among the candidates the choice ranked`);
  const position = new Map(order.map((version, i) => [version, i]));
  const ranked = vetoes.flatMap((veto) => {
    const i = position.get(veto.version);
    return i === undefined || i === at ? [] : [{ veto, i }];
  });
  const nearest = [...ranked].sort((a, b) => Math.abs(a.i - at) - Math.abs(b.i - at) || a.i - b.i).slice(0, VETOES_SHOWN);
  return { vetoed: nearest.sort((a, b) => a.i - b.i).map(({ veto }) => veto), vetoesLeftOut: ranked.length - nearest.length };
}

/** The fields a move carries for `recorded`: none of them when nothing was vetoed. */
export function vetoFields(recorded: RecordedVetoes): { readonly vetoed?: ReadonlyArray<Veto>; readonly vetoesLeftOut?: number } {
  return { ...(recorded.vetoed.length === 0 ? {} : { vetoed: recorded.vetoed }), ...(recorded.vetoesLeftOut === 0 ? {} : { vetoesLeftOut: recorded.vetoesLeftOut }) };
}

export type RuleChoice =
  | { readonly kind: "chosen"; readonly version: string; readonly line: string; readonly aged: boolean }
  /** Fixing versions in the line whose publish time is unknown: an older aged fix can't be ruled out. */
  | { readonly kind: "undated"; readonly line: string; readonly versions: ReadonlyArray<string> };

/**
 * What the rule picks among `fixing` (ascending, non-empty): the first
 * compatible line with a fix, the lowest version in it at least
 * `releaseAgeDays` old, else the lowest. `young`, the version under proof, is
 * young by definition, so its own publish time needn't be known.
 */
export async function ruleChoice(
  pkg: PackageName,
  fixing: ReadonlyArray<string>,
  catalog: VersionCatalog,
  config: Config,
  now: Date,
  young?: string,
): Promise<RuleChoice> {
  if (fixing.length === 0) throw new Error(`ruleChoice needs at least one fixing version of ${pkg.name}`);
  const line = compatibleLine(config, pkg, fixing[0]!);
  const inLine = fixing.filter((version) => compatibleLine(config, pkg, version) === line);
  const ages = await agesOf(inLine, pkg, catalog, now);
  const undated = inLine.filter((version, i) => ages[i] === undefined && version !== young);
  if (undated.length > 0) return { kind: "undated", line, versions: undated };
  const aged = inLine.find((_, i) => ages[i] !== undefined && ages[i]! >= config.releaseAgeDays);
  return aged === undefined ? { kind: "chosen", version: inLine[0]!, line, aged: false } : { kind: "chosen", version: aged, line, aged: true };
}

export interface Candidates {
  /** Every candidate version, to scan with the rest. */
  readonly versions: ReadonlyArray<PackageVersion>;
  /** `versionKey` of a young version → replaced version → its candidates, ascending. */
  readonly byChange: ReadonlyMap<string, ReadonlyMap<string, ReadonlyArray<string>>>;
}

/** The candidates of every young version that replaces something. */
export async function gatherCandidates(
  young: ReadonlyArray<YoungVersion>,
  catalogs: Readonly<Record<Ecosystem, VersionCatalog>>,
  config: Config,
): Promise<Candidates> {
  const versions: PackageVersion[] = [];
  const byChange = new Map<string, Map<string, ReadonlyArray<string>>>();
  for (const change of young) {
    if (change.replaced.length === 0) continue;
    const listed = await catalogs[change.pkg.ecosystem].versions(change.pkg);
    // No listing, no proof: the young version alone would look like the only fix.
    if (listed === undefined) continue;
    // The young version itself, even if the registry's listing lags behind.
    const all = [...listed, change.pkg.version];
    const perReplaced = new Map<string, ReadonlyArray<string>>();
    for (const from of change.replaced) {
      const found = candidateVersions(config, change.pkg, from, change.pkg.version, all);
      perReplaced.set(from, found);
      versions.push(...found.map((version) => ({ ...change.pkg, version })));
    }
    byChange.set(versionKey(change.pkg), perReplaced);
  }
  return { versions, byChange };
}

/**
 * Why `young` isn't the fix the rule picks (for each version it replaces), or
 * undefined when it is. `candidates` maps each replaced version to its
 * candidate versions, all in the snapshot.
 */
export async function youngFixProblem(
  young: YoungVersion,
  candidates: ReadonlyMap<string, ReadonlyArray<string>>,
  snapshot: Snapshot,
  catalog: VersionCatalog,
  config: Config,
  now: Date,
): Promise<string | undefined> {
  const { pkg } = young;
  if (young.replaced.length === 0) return "it's new here, not a fix of an earlier version";
  if (candidates.size === 0) return `the registry doesn't list ${pkg.name}'s versions, so the rule can't be checked`;
  const reasons: string[] = [];
  for (const from of young.replaced) {
    const after = groupsOf(snapshot, pkg);
    const reviewed = reviewedGroups(snapshot, { ...pkg, version: from });
    const fixed = targetsOf(snapshot, { ...pkg, version: from }).filter((group) => !after.has(group));
    // Only a reviewed advisory justifies a young version; an unreviewed one can still rule candidates out below.
    const targets = fixed.filter((group) => reviewed.has(group));
    if (targets.length === 0) {
      reasons.push(fixed.length === 0
        ? `it fixes no advisory affecting ${from}`
        : `it fixes no reviewed advisory affecting ${from}: ${fixed.join(", ")} only in the project's repository advisories, not corroborated by the sources this decision used`);
      continue;
    }
    const fixing = (candidates.get(from) ?? []).filter((version) => fixes(snapshot, pkg, from, targets, version));
    if (fixing.length === 0) {
      reasons.push(`no candidate above ${from} fixes ${targets.join(", ")}`);
      continue;
    }
    const choice = await ruleChoice(pkg, fixing, catalog, config, now, pkg.version);
    if (choice.kind === "undated") {
      reasons.push(`the publish time of ${choice.versions.join(", ")} (fixing too, line ${choice.line}) is unknown, so an older fix can't be ruled out`);
      continue;
    }
    if (choice.version === pkg.version) return undefined;
    reasons.push(
      choice.aged
        ? `${choice.version} fixes ${targets.join(", ")} too and is at least ${config.releaseAgeDays} days old (line ${choice.line})`
        : `the lowest version fixing ${targets.join(", ")} above ${from} is ${choice.version} (line ${choice.line})`,
    );
  }
  return reasons.join("; ");
}

/** Each version's age in days, undefined where the registry can't say. */
async function agesOf(versions: ReadonlyArray<string>, pkg: PackageName, catalog: VersionCatalog, now: Date): Promise<Array<number | undefined>> {
  const ages: Array<number | undefined> = [];
  for (const version of versions) {
    const published = await catalog.published({ ...pkg, version });
    ages.push(ageDays(published, now));
  }
  return ages;
}
