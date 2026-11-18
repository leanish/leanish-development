/**
 * A routine raises an exact top-level override that a security floor records, within the override's compatible line,
 * to the newest version a routine target could take. The floor record stays: it's a minimum, and secure-it's.
 */
import semver from "semver";

import type { Floor } from "@leanish/gate/floors";
import { baselineEvidence } from "@leanish/gate/young-fixes";
import { withOverride } from "@leanish/tool-runtime/manifest-spec";

import type { NpmGraph } from "./npm-graph.ts";
import { repositoryOverrides, splitKey } from "./npm-overrides.ts";
import { eligible, meetsReleaseAge, type TargetSources } from "./npm-targets.ts";

/** The floors that may move their overrides, and the repository's compatible-line rule. */
export interface OverrideFloors {
  readonly floors: ReadonlyArray<Floor>;
  readonly line: (name: string, version: string) => string;
}

export interface OverrideRaise {
  readonly key: string;
  readonly from: string;
  readonly to: string;
}

/**
 * The root manifest's text with each eligible override raised, and a note per raise or per override left where it
 * was for a reason the existing pin note wouldn't show.
 */
export async function raiseOverrides(
  manifest: { readonly text: string; readonly path: string },
  graph: NpmGraph,
  lockedNames: ReadonlySet<string>,
  policy: OverrideFloors,
  sources: TargetSources,
): Promise<{ readonly text: string; readonly raises: ReadonlyArray<OverrideRaise>; readonly notes: ReadonlyArray<string> }> {
  let text = manifest.text;
  const raises: OverrideRaise[] = [];
  const notes: string[] = [];
  const parsed = JSON.parse(text) as { overrides?: Record<string, unknown> };
  const overrides = repositoryOverrides(parsed);
  for (const floor of policy.floors) {
    const key = raisableKey(floor, manifest.path);
    const from = key === undefined ? undefined : parsed.overrides?.[key];
    // Only a raw exact version: not a range, an alias, a `$` reference or an object-form rule.
    if (key === undefined || typeof from !== "string" || semver.valid(from) !== from) continue;
    const why = deferral(key, from, graph, lockedNames, overrides.isComplex(key));
    if (why !== undefined) {
      notes.push(`${manifest.path}: override ${key} stays at ${from}: ${why}`);
      continue;
    }
    const to = await newestEligible(key, from, policy, sources);
    if (to === undefined) continue;
    text = withOverride(text, key, from, to, manifest.path);
    raises.push({ key, from, to });
    notes.push(`${manifest.path}: override ${key} ${from} → ${to} (security floor ${floor.version} stays)`);
  }
  return { text, raises, notes };
}

/** The top-level key a security floor in this manifest pins, when it's a single unqualified one (verification's rule too). */
export function raisableKey(floor: Floor, manifestPath: string): string | undefined {
  if (floor.ecosystem !== "npm" || floor.purpose !== "security" || floor.declaredIn !== manifestPath) return undefined;
  const [path, ...others] = floor.overridePaths;
  if (path === undefined || others.length > 0 || path.length !== 1) return undefined;
  const key = path[0]!;
  return key === floor.package && splitKey(key).spec === undefined && key !== "@types/node" ? key : undefined;
}

/** Why the copies this override governs can't be shown to move together; undefined when they can. */
function deferral(key: string, pin: string, graph: NpmGraph, lockedNames: ReadonlySet<string>, ambiguous: boolean): string | undefined {
  if (ambiguous) return "another override rule also names it";
  if (graph.declaredEdges().some((edge) => edge.key === key || edge.to !== undefined && graph.nameAt(edge.to) === key)) return "the root or a workspace declares it directly";
  const governed = graph.copies().filter((copy) => copy.name === key || copy.installedAs === key);
  if (governed.length === 0) return "no locked copy is under it";
  if (governed.some((copy) => copy.bundled || copy.installedAs !== copy.name)) return "a copy under it is bundled or aliased";
  if (governed.some((copy) => copy.version !== pin)) return "its copies aren't all locked at that version";
  if (lockedNames.has(key)) return "its locked version is younger than the window";
  return undefined;
}

/** The newest version above `from` in its line a routine target could take, judged on one snapshot; undefined if none. */
async function newestEligible(name: string, from: string, policy: OverrideFloors, sources: TargetSources): Promise<string | undefined> {
  const listed = await sources.versions(name).catch(() => undefined);
  if (listed === undefined) return undefined;
  const line = policy.line(name, from);
  const prerelease = semver.prerelease(from) !== null;
  const newer = listed
    .filter((version) => semver.valid(version) !== null && semver.gt(version, from) && (prerelease || semver.prerelease(version) === null) && policy.line(name, version) === line)
    .sort(semver.rcompare);
  const aged: string[] = [];
  for (const version of newer) {
    const published = await sources.published(name, version).catch(() => undefined);
    if (sources.isTrusted(name) || meetsReleaseAge(published, sources)) aged.push(version);
  }
  if (aged.length === 0) return undefined;
  const baseline = [{ ecosystem: "npm" as const, name, version: from }];
  const snapshot = await sources.snapshot(baseline, aged.map((version) => ({ ecosystem: "npm" as const, name, version }))).catch(() => undefined);
  if (snapshot === undefined || [from, ...aged].some((version) => !snapshot.covers({ ecosystem: "npm", name, version }))) return undefined;
  const inherited = baselineEvidence(snapshot, baseline);
  for (const version of aged) {
    if (await eligible(name, version, from, inherited, snapshot, sources).catch(() => false)) return version;
  }
  return undefined;
}
