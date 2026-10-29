/**
 * Checks on what a change adds or changes in an npm lockfile: the source of
 * every locked package and the publisher identity of each version that
 * replaces another. It also lists the changed versions, with their publish
 * times, for the release-age rule (`release-age.ts`, shared with Maven).
 *
 * Ported from leanish-development `tools/supply-chain/src/supply-chain.ts`
 * (commit adc2a6f); the advisory evidence now comes from the shared snapshot.
 * Trusted-package changes are also returned separately as potential security roots,
 * without introducing a publish-date requirement for their age exemption.
 */
import { type Config, isTrustedPackage } from "./config.ts";
import type { Exceptions } from "./exceptions.ts";
import { changedPackages, fromRegistry, type LockedPackage, NPM_REGISTRY, replacedArtifacts, sourceProblems } from "./npm-lock.ts";
import { identityBaseline, type NpmRegistry, publishTime } from "./npm-registry.ts";
import { uniqueVersions } from "./package-version.ts";
import type { ChangedVersion } from "./release-age.ts";

export interface NpmChangeContext {
  readonly registry: NpmRegistry;
  readonly exceptions: Exceptions;
  readonly config: Config;
  readonly now: Date;
}

export interface NpmChanges {
  /** Source and identity problems. */
  readonly problems: ReadonlyArray<string>;
  /** Versions from the npm registry the change adds or changes. */
  readonly changes: ReadonlyArray<ChangedVersion>;
  /** Trusted packages can seed required-dependency proofs without needing a publish date of their own. */
  readonly trustedChanges: ReadonlyArray<ChangedVersion>;
}

export async function npmChanges(
  base: ReadonlyArray<LockedPackage>,
  head: ReadonlyArray<LockedPackage>,
  context: NpmChangeContext,
): Promise<NpmChanges> {
  const problems = sourceProblems(head, context.config.npm.registries);
  for (const pkg of replacedArtifacts(base, head)) {
    problems.push(
      `${pkg.name}@${pkg.version} at ${pkg.path} changed its source or bytes without changing version: the gate can't tell the new artifact is the same package`,
    );
  }
  const changes: ChangedVersion[] = [];
  const trustedChanges: ChangedVersion[] = [];
  const today = context.now.toISOString().slice(0, 10);
  const changed = changedPackages(base, head).filter((pkg) => fromRegistry(pkg, context.config.npm.registries));
  for (const pkg of uniqueVersions(changed.map((locked) => ({ ...locked, ecosystem: "npm" as const })))) {
    if (!pkg.resolved!.startsWith(`${NPM_REGISTRY}/`)) {
      problems.push(...otherRegistryProblems(pkg, context, today));
      continue;
    }
    problems.push(...(await context.registry.identityProblems(pkg, identityBaseline(replacedEntries(pkg.name, base, head)), context.exceptions, today)));
    // Trusted packages skip only the wait: their identity is checked, their publish time isn't needed.
    if (isTrustedPackage(context.config.trustedPackages, pkg)) {
      trustedChanges.push({ pkg: { ecosystem: "npm", name: pkg.name, version: pkg.version }, published: new Date(0), replaced: replacedVersions(pkg.name, base, head) });
      continue;
    }
    const published = publishTime(await context.registry.packument(pkg.name), pkg.name, pkg.version);
    changes.push({ pkg: { ecosystem: "npm", name: pkg.name, version: pkg.version }, published, replaced: replacedVersions(pkg.name, base, head) });
  }
  return { problems, changes, trustedChanges };
}

/**
 * Another allowed registry has no publish time or identity source the gate
 * trusts: a trusted package still skips only the wait, so its identity needs an
 * unexpired `identity` exception recording a review; anything else fails.
 */
function otherRegistryProblems(pkg: LockedPackage, context: NpmChangeContext, today: string): string[] {
  const label = `${pkg.name}@${pkg.version}`;
  if (!isTrustedPackage(context.config.trustedPackages, { ecosystem: "npm", name: pkg.name })) {
    return [`${label} comes from ${pkg.resolved}, where the gate can't check its release age or publisher identity`];
  }
  const reviewed = context.exceptions.identity.find(
    (entry) => entry.package === pkg.name && entry.version === pkg.version && entry.expires >= today,
  );
  return reviewed === undefined
    ? [`${label} comes from ${pkg.resolved}, where the gate can't check its publisher identity; an identity exception records the review`]
    : [];
}

/**
 * Versions of `name` that `base` had at a lockfile path where `head` no longer
 * has them: upgraded in place, or removed (npm may hoist the new version
 * elsewhere). A copy `head` keeps doesn't count, so an added copy can't borrow
 * a retained copy's advisory.
 */
function replacedVersions(name: string, base: ReadonlyArray<LockedPackage>, head: ReadonlyArray<LockedPackage>): string[] {
  return [...new Set(replacedEntries(name, base, head).map((old) => old.version))];
}

function replacedEntries(name: string, base: ReadonlyArray<LockedPackage>, head: ReadonlyArray<LockedPackage>): LockedPackage[] {
  const kept = new Set(head.map((pkg) => `${pkg.path}|${pkg.name}@${pkg.version}`));
  return base.filter((old) => old.name === name && !kept.has(`${old.path}|${old.name}@${old.version}`));
}
