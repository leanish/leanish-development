/**
 * A routine raises an exact top-level override that a security floor records, within the override's compatible line,
 * to the newest version a routine target could take. The floor record stays: it's a minimum, and secure-it's.
 */
import semver from "semver";

import type { Floor } from "@leanish/gate/floors";
import { isObject } from "@leanish/gate/json";
import { baselineEvidence } from "@leanish/gate/young-fixes";
import { withOverride } from "@leanish/tool-runtime/manifest-spec";

import type { NpmGraph } from "./npm-graph.ts";
import { splitKey } from "./npm-overrides.ts";
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

export interface RaisedOverrides {
  readonly text: string;
  readonly raises: ReadonlyArray<OverrideRaise>;
  /** A note per raise, and per override left where it was for a reason the existing pin note wouldn't show. */
  readonly notes: ReadonlyArray<string>;
  /** The notes of overrides held because a lookup failed: whether they'd move can't be decided. */
  readonly undecided: ReadonlyArray<string>;
}

/** The root manifest's text with each eligible override raised. */
export async function raiseOverrides(
  manifest: { readonly text: string; readonly path: string },
  graph: NpmGraph,
  /** The names npm's window excludes (`npmWindowFor`), and those of them excluded for an unreadable publish time. */
  excluded: { readonly locked: ReadonlySet<string>; readonly unreadable: ReadonlySet<string> },
  policy: OverrideFloors,
  sources: TargetSources,
): Promise<RaisedOverrides> {
  let text = manifest.text;
  const raises: OverrideRaise[] = [];
  const notes: string[] = [];
  const undecided: string[] = [];
  const overrides = (JSON.parse(text) as { overrides?: unknown }).overrides;
  for (const floor of policy.floors) {
    const key = raisableKey(floor, manifest.path);
    const from = key === undefined || !isObject(overrides) ? undefined : overrides[key];
    // Only a raw exact version: not a range, an alias, a `$` reference or an object-form rule.
    if (key === undefined || typeof from !== "string" || semver.valid(from) !== from) continue;
    const stays = (why: string) => `${manifest.path}: override ${key} stays at ${from}: ${why}`;
    const why = deferral(key, from, graph, selectorsNaming(overrides, key) > 1);
    if (why !== undefined) {
      notes.push(stays(why));
      continue;
    }
    // npm's window excludes a name, in every lockfile, for any locked version that's young or whose age can't be read:
    // only a young one is a known answer.
    if (excluded.locked.has(key) && !excluded.unreadable.has(key)) {
      notes.push(stays("a locked copy of it is younger than the window"));
      continue;
    }
    const found = excluded.unreadable.has(key)
      ? { failed: "a locked copy of it has no readable publish time, so npm's window excludes it" }
      : await newestEligible(key, from, policy, sources);
    if ("failed" in found) {
      notes.push(stays(found.failed));
      undecided.push(stays(found.failed));
      continue;
    }
    if (found.to === undefined) continue;
    text = withOverride(text, key, from, found.to, manifest.path);
    raises.push({ key, from, to: found.to });
    notes.push(`${manifest.path}: override ${key} ${from} → ${found.to} (security floor ${floor.version} stays)`);
  }
  return { text, raises, notes, undecided };
}

/** The top-level key a security floor in this manifest pins, when it's a single unqualified one (verification's rule too). */
export function raisableKey(floor: Floor, manifestPath: string): string | undefined {
  if (floor.ecosystem !== "npm" || floor.purpose !== "security" || floor.declaredIn !== manifestPath) return undefined;
  const [path, ...others] = floor.overridePaths;
  if (path === undefined || others.length > 0 || path.length !== 1) return undefined;
  const key = path[0]!;
  return key === floor.package && splitKey(key).spec === undefined && key !== "@types/node" ? key : undefined;
}

/** How many override selectors, at any depth and with or without a version qualifier, name `name`. */
function selectorsNaming(rules: unknown, name: string): number {
  if (!isObject(rules)) return 0;
  return Object.entries(rules).reduce((count, [selector, rule]) =>
    count + (selector !== "." && splitKey(selector).name === name ? 1 : 0) + selectorsNaming(rule, name), 0);
}

/** Why the copies this override governs can't be shown to move together; undefined when they can. */
function deferral(key: string, pin: string, graph: NpmGraph, ambiguous: boolean): string | undefined {
  if (ambiguous) return "another override rule also names it";
  if (graph.declaredEdges().some((edge) => edge.key === key || edge.to !== undefined && graph.nameAt(edge.to) === key)) return "the root or a workspace declares it directly";
  const governed = graph.copies().filter((copy) => copy.name === key || copy.installedAs === key);
  if (governed.length === 0) return "no locked copy is under it";
  if (governed.some((copy) => copy.bundled || copy.installedAs !== copy.name)) return "a copy under it is bundled or aliased";
  if (governed.some((copy) => copy.version !== pin)) return "its copies aren't all locked at that version";
  return undefined;
}

async function readPublished(name: string, version: string, sources: TargetSources): Promise<{ readonly published: Date } | { readonly failed: string }> {
  let published: Date | undefined;
  try {
    published = await sources.published(name, version);
  } catch (err) {
    return { failed: `${name}@${version}'s publish time couldn't be read: ${(err as Error).message}` };
  }
  return published === undefined || Number.isNaN(published.getTime())
    ? { failed: `the registry has no publish time for ${name}@${version}, so its age can't be judged` }
    : { published };
}

/**
 * The newest version above `from` in its line a routine target could take, judged on one snapshot; `to` undefined
 * when none is. A lookup that fails is reported as such, never read as a refusal that could pick an older version.
 */
async function newestEligible(name: string, from: string, policy: OverrideFloors, sources: TargetSources): Promise<{ readonly to: string | undefined } | { readonly failed: string }> {
  const failure = (err: unknown) => (err as Error).message;
  let listed: ReadonlyArray<string> | undefined;
  try {
    listed = await sources.versions(name);
  } catch (err) {
    return { failed: `the registry couldn't list ${name}'s versions: ${failure(err)}` };
  }
  if (listed === undefined) return { failed: `the registry doesn't list ${name}'s versions completely` };
  const line = policy.line(name, from);
  const prerelease = semver.prerelease(from) !== null;
  const newer = listed
    .filter((version) => semver.valid(version) !== null && semver.gt(version, from) && (prerelease || semver.prerelease(version) === null) && policy.line(name, version) === line)
    .sort(semver.rcompare);
  const aged: string[] = [];
  for (const version of newer) {
    if (sources.isTrusted(name)) {
      aged.push(version);
      continue;
    }
    const read = await readPublished(name, version, sources);
    if ("failed" in read) return read;
    if (meetsReleaseAge(read.published, sources)) aged.push(version);
  }
  if (aged.length === 0) return { to: undefined };
  const baseline = [{ ecosystem: "npm" as const, name, version: from }];
  let snapshot;
  try {
    snapshot = await sources.snapshot(baseline, aged.map((version) => ({ ecosystem: "npm" as const, name, version })));
  } catch (err) {
    return { failed: `the advisory lookup failed: ${failure(err)}` };
  }
  if ([from, ...aged].some((version) => !snapshot.covers({ ecosystem: "npm", name, version }))) {
    return { failed: "the advisory snapshot doesn't cover every candidate" };
  }
  const inherited = baselineEvidence(snapshot, baseline);
  for (const version of aged) {
    try {
      if (await eligible(name, version, from, inherited, snapshot, sources)) return { to: version };
    } catch (err) {
      return { failed: `${name}@${version} couldn't be judged: ${failure(err)}` };
    }
  }
  return { to: undefined };
}
