/**
 * The release-age rule, the same for every ecosystem: a version a change adds
 * or changes must be at least `releaseAgeDays` old, unless
 *   - it's an own package (own packages skip only this wait), or
 *   - it's the security fix the version rule picks (`young-fixes.ts`), or
 *   - it's a carrier version that rule picks for the bundled advisories it
 *     drops (`bundle-fix-proof.ts`), or
 *   - npm needs it for that fix and no aged version satisfies the requirement
 *     (only the lowest satisfying version, independently proved), or
 *   - a `releaseAge` exception names an advisory that, in the comparison's
 *     snapshot, affects a version the change replaces and not this one (for
 *     fixes the proof can't make). Malware advisories can't justify it.
 *
 * Passing this rule isn't trusting the version: every young version, however
 * justified, is also held by the cooldown (`cooldown.ts`) until it ages.
 */
import { ageDays, eligibleAt, isUnderWait } from "./age.ts";
import { type Config, isOwnPackage } from "./config.ts";
import type { Exceptions } from "./exceptions.ts";
import type { BundleFixProof } from "./bundle-fix-proof.ts";
import { label, type PackageVersion, versionKey } from "./package-version.ts";
import type { Snapshot } from "./snapshot.ts";
import type { Ecosystem } from "./versions.ts";
import { groupsOf, reviewedGroups, targetsOf, type VersionCatalog, youngFixProblem } from "./young-fixes.ts";

export interface ChangedVersion {
  readonly pkg: PackageVersion;
  readonly published: Date;
  /** Versions of the package the change replaces. */
  readonly replaced: ReadonlyArray<string>;
}

export interface AgeContext {
  readonly snapshot: Snapshot;
  readonly exceptions: Exceptions;
  readonly config: Config;
  readonly now: Date;
  readonly catalogs: Readonly<Record<Ecosystem, VersionCatalog>>;
  /** Independently reconstructed required versions; never read from a PR plan. */
  readonly required?: ReadonlySet<string>;
  /** `versionKey` of a young version → replaced version → its candidates, all in the snapshot. */
  readonly candidates: ReadonlyMap<string, ReadonlyMap<string, ReadonlyArray<string>>>;
  /** `versionKey` of a young carrier version → its bundle-fix proof, or why there's none. */
  readonly bundleFixes?: ReadonlyMap<string, BundleFixProof>;
}

/** Under the wait and not an own package: what the proof or an exception must justify. */
export function isYoung(change: ChangedVersion, config: Config, now: Date): boolean {
  if (isOwnPackage(config.ownPackages, change.pkg)) return false;
  return isUnderWait(change.published, config.releaseAgeDays, now);
}

/** What let a young version through: the fix proof, the required-dependency proof, an exception; or nothing. */
export type YoungJustification = "security-fix" | "bundle-fix" | "required" | "exception" | "unjustified";

/**
 * A package whose advisories a young version fixes (`fixedTargets`): the version's own package, or one its bundle
 * carries. For people (and the evidence secure-it reads for them), never part of the verdict.
 */
export interface HeldTarget {
  readonly name: string;
  /** Whether the advisories are on a package bundled inside the held version rather than on the version itself. */
  readonly bundled: boolean;
  readonly replaced: ReadonlyArray<string>;
  /** Its versions after the change; empty when the change removes it. */
  readonly proposed: ReadonlyArray<string>;
  readonly groups: ReadonlyArray<HeldGroup>;
}

/** One target advisory group: every id the comparison's snapshot knows for it, and the replaced versions it affects. */
export interface HeldGroup {
  readonly ids: ReadonlyArray<string>;
  readonly replaced: ReadonlyArray<string>;
}

/** A version the change adds or changes that is still under the wait. */
export interface HeldVersion {
  readonly ecosystem: Ecosystem;
  readonly name: string;
  readonly version: string;
  /** Versions of the package the change replaces. */
  readonly replaced: ReadonlyArray<string>;
  readonly published: string;
  /** When it turns `releaseAgeDays` old. */
  readonly eligibleAt: string;
  readonly justification: YoungJustification;
  /** The advisories it fixes (`HeldTarget`), whatever justified it; absent when it fixes none. */
  readonly targets?: ReadonlyArray<HeldTarget>;
}

export interface ReleaseAgeReview {
  readonly problems: ReadonlyArray<string>;
  /** Every young version, justified or not. */
  readonly held: ReadonlyArray<HeldVersion>;
}

export async function reviewReleaseAge(changes: ReadonlyArray<ChangedVersion>, context: AgeContext): Promise<ReleaseAgeReview> {
  const problems: string[] = [];
  const held: HeldVersion[] = [];
  for (const change of changes) {
    if (!isYoung(change, context.config, context.now)) continue;
    const judged = await judgeYoung(change, context);
    if (judged.problem !== undefined) problems.push(judged.problem);
    const targets = fixedTargets(change, context, judged.named);
    held.push({
      ecosystem: change.pkg.ecosystem,
      name: change.pkg.name,
      version: change.pkg.version,
      replaced: change.replaced,
      published: change.published.toISOString(),
      eligibleAt: eligibleAt(change.published, context.config.releaseAgeDays).toISOString(),
      justification: judged.justification,
      ...(targets.length === 0 ? {} : { targets }),
    });
  }
  return { problems, held };
}

/** Just the problems: what fails the `supply-chain` verdict. */
export async function releaseAgeProblems(changes: ReadonlyArray<ChangedVersion>, context: AgeContext): Promise<string[]> {
  return [...(await reviewReleaseAge(changes, context)).problems];
}

interface Judged {
  readonly justification: YoungJustification;
  readonly problem?: string;
  /** The advisory an exception names, when that exception is what justifies the version. */
  readonly named?: string;
}

async function judgeYoung(change: ChangedVersion, context: AgeContext): Promise<Judged> {
  const { pkg } = change;
  if (pkg.ecosystem === "npm" && context.required?.has(versionKey(pkg))) return { justification: "required" };
  const proof = await youngFixProblem(
    { pkg, replaced: change.replaced },
    context.candidates.get(versionKey(pkg)) ?? new Map(),
    context.snapshot,
    context.catalogs[pkg.ecosystem],
    context.config,
    context.now,
  );
  if (proof === undefined) return { justification: "security-fix" };
  const bundle = context.bundleFixes?.get(versionKey(pkg));
  if (bundle !== undefined && bundle.problem === undefined) return { justification: "bundle-fix" };
  const bundled = bundle?.problem;
  const exception = context.exceptions.releaseAge.find(
    (entry) => (entry.ecosystem === undefined || entry.ecosystem === pkg.ecosystem) && entry.package === pkg.name && entry.version === pkg.version,
  );
  if (exception === undefined) {
    const age = ageDays(change.published, context.now)!;
    return {
      justification: "unjustified",
      problem: `${label(pkg)} was published ${change.published.toISOString()} (${age.toFixed(1)} days ago, under ${
        context.config.releaseAgeDays
      }), and it isn't the security fix the version rule would take: ${proof}${bundled === undefined ? "" : `; nor a bundled fix: ${bundled}`}`,
    };
  }
  if (exception.expires < context.now.toISOString().slice(0, 10)) {
    return { justification: "unjustified", problem: `${label(pkg)}: its release-age exception expired on ${exception.expires}` };
  }
  const why = advisoryEvidenceProblem(exception.advisory, pkg, change.replaced, context.snapshot);
  return why === undefined ? { justification: "exception", named: exception.advisory } : { justification: "unjustified", problem: `${label(pkg)}: ${why}` };
}

/**
 * What a young version fixes, for people and whatever justified it: its own reviewed advisories, those of a bundle
 * proved both ways, and the advisory its exception names. Only targets with an advisory group; merged.
 */
function fixedTargets(change: ChangedVersion, context: AgeContext, named: string | undefined): HeldTarget[] {
  const bundle = context.bundleFixes?.get(versionKey(change.pkg));
  const targets = [
    ownTarget(change, context.snapshot),
    ...(bundle?.problem === undefined ? bundle?.targets ?? [] : []),
    ...(named === undefined ? [] : [namedTarget(change, named, context.snapshot)]),
  ];
  return mergedTargets(targets.filter((target) => target.groups.length > 0));
}

/** The group an exception names, on the replaced versions it affects, whichever source lists it: the owner's call. */
function namedTarget(change: ChangedVersion, advisory: string, snapshot: Snapshot): HeldTarget {
  const named = snapshot.group(advisory);
  return {
    name: change.pkg.name,
    bundled: false,
    replaced: change.replaced,
    proposed: [change.pkg.version],
    groups: groupIds(snapshot, change.replaced.map((version) => ({ ...change.pkg, version })), (group) => group === named),
  };
}

/** The reviewed groups a security fix leaves behind: affecting a replaced version and not the new one, malware aside. */
function ownTarget(change: ChangedVersion, snapshot: Snapshot): HeldTarget {
  const after = groupsOf(snapshot, change.pkg);
  return {
    name: change.pkg.name,
    bundled: false,
    replaced: change.replaced,
    proposed: [change.pkg.version],
    groups: groupIds(snapshot, change.replaced.map((version) => ({ ...change.pkg, version })), (group, version) => !after.has(group) && reviewedGroups(snapshot, version).has(group)),
  };
}

/** Each target group of `versions` with every id the snapshot knows for it and the versions it affects, in a stable order. */
export function groupIds(snapshot: Snapshot, versions: ReadonlyArray<PackageVersion>, keep: (group: string, version: PackageVersion) => boolean): HeldGroup[] {
  const groups = new Map<string, { ids: Set<string>; replaced: Set<string> }>();
  for (const version of versions) {
    const targets = new Set(targetsOf(snapshot, version).filter((group) => keep(group, version)));
    for (const advisory of snapshot.advisories(version)) {
      const group = snapshot.group(advisory.id);
      if (!targets.has(group)) continue;
      const entry = groups.get(group) ?? { ids: new Set<string>(), replaced: new Set<string>() };
      // Every alias the package's own advisories name, another version's included: the evidence looks a group up by them.
      for (const id of [...advisory.ids, ...snapshot.aliases(group, version)]) entry.ids.add(id);
      entry.replaced.add(version.version);
      groups.set(group, entry);
    }
  }
  return [...groups.keys()].sort().map((group) => ({ ids: [...groups.get(group)!.ids].sort(), replaced: [...groups.get(group)!.replaced].sort() }));
}

/**
 * One target per package and side, every occurrence's versions and groups together. Groups sharing an id are one
 * (proofs read on different snapshots may know different aliases of it): their ids and replaced versions merge.
 */
export function mergedTargets(targets: ReadonlyArray<HeldTarget>): HeldTarget[] {
  const merged = new Map<string, { name: string; bundled: boolean; replaced: Set<string>; proposed: Set<string>; groups: Array<{ ids: Set<string>; replaced: Set<string> }> }>();
  for (const target of targets) {
    const key = `${target.bundled ? "bundled" : "own"}|${target.name}`;
    const entry = merged.get(key) ?? { name: target.name, bundled: target.bundled, replaced: new Set(), proposed: new Set(), groups: [] };
    for (const version of target.replaced) entry.replaced.add(version);
    for (const version of target.proposed) entry.proposed.add(version);
    for (const group of target.groups) {
      // Each group keeps the replaced versions it affects, across occurrences.
      const sharing = entry.groups.filter((known) => group.ids.some((id) => known.ids.has(id)));
      const into = { ids: new Set(group.ids), replaced: new Set(group.replaced) };
      for (const known of sharing) {
        for (const id of known.ids) into.ids.add(id);
        for (const version of known.replaced) into.replaced.add(version);
      }
      entry.groups = [...entry.groups.filter((known) => !sharing.includes(known)), into];
    }
    merged.set(key, entry);
  }
  return [...merged.values()].map((entry) => ({
    name: entry.name, bundled: entry.bundled, replaced: [...entry.replaced].sort(), proposed: [...entry.proposed].sort(),
    groups: entry.groups.map((group) => ({ ids: [...group.ids].sort(), replaced: [...group.replaced].sort() })).sort((a, b) => (a.ids[0]! < b.ids[0]! ? -1 : 1)),
  }));
}

/**
 * Why `advisory` doesn't justify taking `pkg` before the wait, or undefined
 * when it does: not malware, affecting a version this change replaces, and
 * no longer affecting `pkg`, all in the comparison's snapshot.
 */
function advisoryEvidenceProblem(
  advisory: string,
  pkg: PackageVersion,
  replaced: ReadonlyArray<string>,
  snapshot: Snapshot,
): string | undefined {
  const group = snapshot.group(advisory);
  const hits = (version: string) =>
    snapshot.advisories({ ecosystem: pkg.ecosystem, name: pkg.name, version }).filter((entry) => snapshot.group(entry.id) === group);
  if (replaced.length === 0) return `advisory ${advisory} can't justify it: the change removes no ${pkg.name} version`;
  const affected = replaced.flatMap(hits);
  if (affected.length === 0) return `advisory ${advisory} doesn't affect the replaced version(s) ${replaced.join(", ")}`;
  if (affected.some((entry) => entry.malicious)) return `advisory ${advisory} is a malware entry`;
  if (hits(pkg.version).length > 0) return `advisory ${advisory} still affects ${pkg.version}`;
  return undefined;
}
