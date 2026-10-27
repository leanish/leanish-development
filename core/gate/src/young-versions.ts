/**
 * Whether head's young versions are justified, and the advisory snapshot that judged them. One call owns the order
 * this needs: the candidates a young version could have taken join the snapshot, a young carrier is proved on its
 * bundles, required-dependency proofs come only from independently verified security roots, and only then is each
 * young version judged (`reviewReleaseAge`). Compare reuses the snapshot for its findings.
 */
import { type BundleFixProof, bundleFixProofs } from "./bundle-fix-proof.ts";
import type { Config } from "./config.ts";
import type { Exceptions } from "./exceptions.ts";
import type { Inventory } from "./inventory.ts";
import type { BundleReader } from "./npm-bundles.ts";
import type { NpmRegistry } from "./npm-registry.ts";
import { gatherRequiredProofs, verifiedRequiredProofs, verifiedSecurityRoots } from "./npm-required-gate.ts";
import type { PackageVersion } from "./package-version.ts";
import { type ChangedVersion, type HeldVersion, isYoung, reviewReleaseAge } from "./release-age.ts";
import type { Snapshot } from "./snapshot.ts";
import type { Tree } from "./tree.ts";
import type { Ecosystem } from "./versions.ts";
import { gatherCandidates, type VersionCatalog } from "./young-fixes.ts";

export interface YoungVersionInputs {
  readonly base: Tree;
  readonly head: Tree;
  readonly baseInventory: Inventory;
  readonly headInventory: Inventory;
  /** Every package base and head use: the snapshot covers them all, young or not. */
  readonly packages: ReadonlyArray<PackageVersion>;
  /** What head adds or changes, one entry per version (with every version it replaces). */
  readonly changes: ReadonlyArray<ChangedVersion>;
  /** Changes of own packages, never young themselves, that can still be the root of a required-dependency proof. */
  readonly ownRoots: ReadonlyArray<ChangedVersion>;
  readonly config: Config;
  readonly exceptions: Exceptions;
  readonly now: Date;
  readonly catalogs: Readonly<Record<Ecosystem, VersionCatalog>>;
  readonly registry: NpmRegistry;
  readonly reader: BundleReader;
  /** An advisory snapshot of `packages`, also covering `candidates` (versions only looked up, never findings). */
  readonly scan: (packages: ReadonlyArray<PackageVersion>, candidates?: ReadonlyArray<PackageVersion>) => Promise<Snapshot>;
}

export interface YoungVersionReview {
  /** Refusals: unjustified young versions and broken required-dependency proofs. */
  readonly problems: ReadonlyArray<string>;
  /** Every young version, justified or not, with its justification. */
  readonly held: ReadonlyArray<HeldVersion>;
  /** What required-dependency proofs exempted, and why. */
  readonly notes: ReadonlyArray<string>;
  readonly snapshot: Snapshot;
}

export async function reviewYoungVersions(inputs: YoungVersionInputs): Promise<YoungVersionReview> {
  const { config, now, catalogs } = inputs;
  const young = inputs.changes.filter((change) => isYoung(change, config, now));
  const rootChanges = [...inputs.changes, ...inputs.ownRoots].filter((change) => change.pkg.ecosystem === "npm" && change.replaced.length > 0);
  const youngNpm = young.some((change) => change.pkg.ecosystem === "npm");
  // A young npm version may be a required dependency of a security root, so the roots' candidates are needed too.
  const candidates = await gatherCandidates([...young, ...youngNpm ? rootChanges.filter((change) => !young.includes(change)) : []], catalogs, config);
  const snapshot = await inputs.scan(inputs.packages, candidates.versions);
  // A young carrier is proved on snapshots of its own, over the bundles it reads.
  const bundleFixes = youngNpm
    ? await bundleFixProofs(young, {
      base: inputs.baseInventory, head: inputs.headInventory, reader: inputs.reader, registry: inputs.registry, catalog: catalogs.npm, config, now,
      scan: (packages) => inputs.scan(packages),
    })
    : new Map<string, BundleFixProof>();
  const securityRoots = youngNpm ? await verifiedSecurityRoots(rootChanges, candidates, snapshot, catalogs.npm, config, now) : [];
  const required = await gatherRequiredProofs(securityRoots, inputs.base, inputs.head, inputs.headInventory, inputs.registry, config, now);
  const proved = verifiedRequiredProofs(required, securityRoots);
  const age = await reviewReleaseAge(young, {
    snapshot, exceptions: inputs.exceptions, config, now, catalogs, candidates: candidates.byChange, required: proved.versions, bundleFixes,
  });
  return { problems: [...proved.problems, ...age.problems], held: age.held, notes: proved.notes, snapshot };
}
