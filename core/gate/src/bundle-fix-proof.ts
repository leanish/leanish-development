/**
 * The gate's proof that a young npm carrier version is a bundled security
 * fix (`bundle-fix`), reconstructed from the comparison's own trees, never
 * from a PR's plan: at a lockfile path where base had the carrier at R and
 * head has it at V,
 *   1. both archives are read from the registry, authenticated against the
 *      integrity each lockfile records (head's must also be the registry's),
 *      and each lockfile's bundled entries under that path must be exactly
 *      what its archive ships;
 *   2. the targets are the bundled package + advisory groups R's bundle has
 *      and V's doesn't;
 *   3. V must be what the carrier rule (`carrier-fixes.ts`) picks for those
 *      targets among the carrier's versions above R.
 * Any part that can't be established (an unreadable archive, a budget, an
 * unknown publish time) leaves V unjustified, with the reason.
 *
 * The targets include the carrier's own advisory groups R has and V doesn't,
 * so a version fixing both is proved as the combined choice secure-it makes.
 * Every head copy of V must be such an occurrence and pass: a copy elsewhere
 * has no evidence of its own.
 *
 * A carrier proved this way doesn't seed required-dependency proofs: a young
 * non-bundled dependency it needs stays unjustified, and the comparison fails.
 */
import { candidateVersions, groupsOf, reviewedGroups, targetsOf, type VersionCatalog } from "./young-fixes.ts";
import { chooseCarrier, describe, removedTargets, registryIntegrity } from "./carrier-fixes.ts";
import type { Config } from "./config.ts";
import { isOwnPackage } from "./config.ts";
import type { Inventory } from "./inventory.ts";
import { type BundleReader, bundleMismatches } from "./npm-bundles.ts";
import type { NpmRegistry } from "./npm-registry.ts";
import type { PackageVersion } from "./package-version.ts";
import { versionKey } from "./package-version.ts";
import { type ChangedVersion, groupIds, type HeldTarget } from "./release-age.ts";
import type { Snapshot } from "./snapshot.ts";

export interface BundleFixInputs {
  readonly base: Inventory;
  readonly head: Inventory;
  readonly reader: BundleReader;
  readonly registry: NpmRegistry;
  readonly catalog: VersionCatalog;
  readonly config: Config;
  readonly now: Date;
  readonly scan: (packages: ReadonlyArray<PackageVersion>) => Promise<Snapshot>;
}

/** A proved bundle fix and the advisories behind it, or why it isn't one. */
export type BundleFixProof =
  | { readonly problem: undefined; readonly targets: ReadonlyArray<HeldTarget> }
  | { readonly problem: string };

/** Per young npm version (`versionKey`) that replaces a carrier in place. */
export async function bundleFixProofs(young: ReadonlyArray<ChangedVersion>, inputs: BundleFixInputs): Promise<ReadonlyMap<string, BundleFixProof>> {
  const proofs = new Map<string, BundleFixProof>();
  for (const change of young) {
    if (change.pkg.ecosystem !== "npm" || change.replaced.length === 0) continue;
    const found = occurrences(change, inputs);
    if (found.length === 0) continue;
    // Every head copy of the version needs its own evidence: one proved copy can't vouch for another.
    if (found.some((occurrence) => occurrence === undefined)) {
      proofs.set(versionKey(change.pkg), { problem: `${change.pkg.name}@${change.pkg.version} is also where it replaces no carrier copy in place` });
      continue;
    }
    const reasons: string[] = [];
    const targets: HeldTarget[] = [];
    for (const occurrence of found as Occurrence[]) {
      const proof = await occurrenceProof(change.pkg, occurrence, inputs).catch((error: unknown) =>
        `${occurrence.lockfile}: ${occurrence.path}: the bundle-fix justification could not be established: ${error instanceof Error ? error.message : String(error)}`);
      if (typeof proof === "string") reasons.push(proof);
      else targets.push(...proof);
    }
    proofs.set(versionKey(change.pkg), reasons.length === 0 ? { problem: undefined, targets: mergedTargets(targets) } : { problem: reasons.join("; ") });
  }
  return proofs;
}

interface Occurrence {
  readonly lockfile: string;
  readonly path: string;
  readonly from: string;
  readonly fromIntegrity: string | undefined;
  readonly toIntegrity: string | undefined;
}

/**
 * Each head copy of the young version: where base had a replaced version of it at the same path, either side bundling
 * something, the occurrence to prove; `undefined` for any other copy. Empty when no copy is a carrier replaced in
 * place (no bundle-fix to prove).
 */
function occurrences(change: ChangedVersion, inputs: Pick<BundleFixInputs, "base" | "head">): Array<Occurrence | undefined> {
  const found: Array<Occurrence | undefined> = [];
  for (const lockfile of inputs.head.npm) {
    const before = inputs.base.npm.find((candidate) => candidate.path === lockfile.path)?.packages ?? [];
    for (const copy of lockfile.packages) {
      if (copy.bundled || copy.name !== change.pkg.name || copy.version !== change.pkg.version) continue;
      const old = before.find((candidate) => candidate.path === copy.path && !candidate.bundled && candidate.name === copy.name && change.replaced.includes(candidate.version));
      const bundles = (packages: typeof before) => packages.some((pkg) => pkg.bundled && pkg.path.startsWith(`${copy.path}/node_modules/`));
      found.push(old === undefined || (!bundles(before) && !bundles(lockfile.packages))
        ? undefined
        : { lockfile: lockfile.path, path: copy.path, from: old.version, fromIntegrity: old.integrity, toIntegrity: copy.integrity });
    }
  }
  return found.some((occurrence) => occurrence !== undefined) ? found : [];
}

/** The occurrence's targets when it's proved, else why it isn't. */
async function occurrenceProof(pkg: PackageVersion, occurrence: Occurrence, inputs: BundleFixInputs): Promise<HeldTarget[] | string> {
  const { reader, registry, config, now } = inputs;
  const at = `${occurrence.lockfile}: ${occurrence.path}`;
  const published = await registryIntegrity(registry, pkg.name, pkg.version);
  if (published === undefined || published !== occurrence.toIntegrity) return `${at}: the locked ${pkg.name}@${pkg.version} isn't the registry's archive`;
  const fromBundle = await reader.read(pkg.name, occurrence.from, occurrence.fromIntegrity);
  const toBundle = await reader.read(pkg.name, pkg.version, occurrence.toIntegrity);
  if (!fromBundle.complete) return `${at}: ${fromBundle.reason}`;
  if (!toBundle.complete) return `${at}: ${toBundle.reason}`;
  const recorded = [
    ...bundleMismatches(lockfileOf(inputs.base, occurrence.lockfile), occurrence.path, fromBundle),
    ...bundleMismatches(lockfileOf(inputs.head, occurrence.lockfile), occurrence.path, toBundle),
  ];
  if (recorded.length > 0) return `${at}: ${recorded.join("; ")}`;
  const versionsOf = (bundle: typeof fromBundle) => bundle.packages.map((entry): PackageVersion => ({ ecosystem: "npm", name: entry.name, version: entry.version }));
  const snapshot = await inputs.scan([
    { ...pkg, version: occurrence.from }, pkg, ...versionsOf(fromBundle), ...versionsOf(toBundle),
  ]);
  // Only reviewed advisories justify a young carrier: a bundled one or the carrier's own (vetoes still use them all).
  const reviewedIn = (name: string, group: string) => fromBundle.packages.some((entry) => entry.name === name
    && reviewedGroups(snapshot, { ecosystem: "npm", name, version: entry.version }).has(group));
  const removed = removedTargets(fromBundle, toBundle, snapshot);
  const carried = removed.filter((target) => reviewedIn(target.name, target.advisory));
  // The carrier's own advisories it fixes too: the combined choice secure-it makes, reconstructed from the trees.
  const after = groupsOf(snapshot, pkg);
  const ownReviewed = reviewedGroups(snapshot, { ...pkg, version: occurrence.from });
  const own = targetsOf(snapshot, { ...pkg, version: occurrence.from }).filter((group) => !after.has(group) && ownReviewed.has(group));
  if (carried.length === 0 && own.length === 0) {
    return removed.length === 0
      ? `${at}: ${pkg.name}@${pkg.version}'s bundle fixes nothing ${occurrence.from}'s had`
      : `${at}: ${pkg.name}@${pkg.version}'s bundle fixes no reviewed advisory ${occurrence.from}'s had (${describe(removed)} only in the project's repository advisories, not corroborated by the sources this decision used)`;
  }
  const listed = await inputs.catalog.versions(pkg);
  if (listed === undefined) return `${at}: the registry doesn't list ${pkg.name}'s versions, so the rule can't be checked`;
  const choice = await chooseCarrier({
    carrier: pkg.name,
    from: occurrence.from,
    fromBundle,
    carried,
    own,
    malicious: false,
    versions: candidateVersions(config, pkg, occurrence.from, pkg.version, [...listed, pkg.version]),
    ownPackage: isOwnPackage(config.ownPackages, pkg),
  }, {
    bundles: async (version) => reader.read(pkg.name, version, await registryIntegrity(registry, pkg.name, version)),
    scan: inputs.scan,
    catalog: inputs.catalog,
    config,
    now,
  });
  if (choice.kind !== "chosen") return `${at}: the bundle-fix justification could not be established: ${choice.reason}`;
  if (choice.version !== pkg.version) {
    return `${at}: ${choice.version} ${choice.aged ? `ships a bundle without ${describe(carried)} too and is at least ${config.releaseAgeDays} days old` : `is the lowest version whose bundle drops ${describe(carried)}`} (line ${choice.line})`;
  }
  const carriedGroups = new Set(carried.map((target) => target.advisory));
  const bundledTargets = [...new Set(carried.map((target) => target.name))].sort().map((name): HeldTarget => {
    const versions = (bundle: typeof fromBundle) => [...new Set(bundle.packages.filter((entry) => entry.name === name).map((entry) => entry.version))].sort();
    const ofName = new Set(carried.filter((target) => target.name === name).map((target) => target.advisory));
    const replaced = affectedVersions(snapshot, name, versions(fromBundle), ofName);
    return {
      name,
      bundled: true,
      replaced,
      proposed: versions(toBundle),
      groups: groupIds(snapshot, replaced.map((version): PackageVersion => ({ ecosystem: "npm", name, version })), (group) => carriedGroups.has(group) && ofName.has(group)),
    };
  });
  const ownGroups = new Set(own);
  const carrier: HeldTarget[] = own.length === 0 ? [] : [{
    name: pkg.name, bundled: false, replaced: [occurrence.from], proposed: [pkg.version],
    groups: groupIds(snapshot, [{ ...pkg, version: occurrence.from }], (group) => ownGroups.has(group)),
  }];
  return [...carrier, ...bundledTargets];
}

/** The old copies a carried advisory affects: another copy of the package in the bundle isn't what the fix replaced. */
export function affectedVersions(snapshot: Snapshot, name: string, versions: ReadonlyArray<string>, groups: ReadonlySet<string>): string[] {
  return versions.filter((version) => [...groupsOf(snapshot, { ecosystem: "npm", name, version })].some((group) => groups.has(group)));
}

/** One target per package and side, every occurrence's versions and groups together. */
function mergedTargets(targets: ReadonlyArray<HeldTarget>): HeldTarget[] {
  const merged = new Map<string, { name: string; bundled: boolean; replaced: Set<string>; proposed: Set<string>; groups: Map<string, { ids: string[]; replaced: Set<string> }> }>();
  for (const target of targets) {
    const key = `${target.bundled ? "bundled" : "own"}|${target.name}`;
    const entry = merged.get(key) ?? { name: target.name, bundled: target.bundled, replaced: new Set(), proposed: new Set(), groups: new Map() };
    for (const version of target.replaced) entry.replaced.add(version);
    for (const version of target.proposed) entry.proposed.add(version);
    for (const group of target.groups) {
      // Each group keeps the replaced versions it affects, across occurrences.
      const known = entry.groups.get(group.ids.join(" ")) ?? { ids: [...group.ids], replaced: new Set<string>() };
      for (const version of group.replaced) known.replaced.add(version);
      entry.groups.set(group.ids.join(" "), known);
    }
    merged.set(key, entry);
  }
  return [...merged.values()].map((entry) => ({
    name: entry.name, bundled: entry.bundled, replaced: [...entry.replaced].sort(), proposed: [...entry.proposed].sort(),
    groups: [...entry.groups.values()].map((group) => ({ ids: group.ids, replaced: [...group.replaced].sort() })),
  }));
}

function lockfileOf(inventory: Inventory, path: string) {
  const lockfile = inventory.npm.find((candidate) => candidate.path === path);
  if (lockfile === undefined) throw new Error(`no lockfile ${path} in ${inventory.tree}`);
  return lockfile.packages;
}
