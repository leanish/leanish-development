/** Which packages' lockfile copy changes are only npm moving copies between paths, as far as the lockfile graphs show. */
import type { Copy, NpmGraph } from "./npm-graph.ts";

/** The key a package is known by in a plan's presentation: its name within one lockfile. */
export const rehoistKey = (lockfile: string, name: string) => `${lockfile}\0${name}`;

/**
 * The packages of `lockfile` whose changed copies are a re-hoist, so that no consumer changed version:
 * - no path changed its package (a path that held `foo` now holds `baz`), and the changed copies took away exactly the
 *   versions they brought;
 * - every changed copy has a dependent, in the graph it is in (a copy nothing asks for says nothing about consumers);
 * - every dependent, a workspace or an installed package, resolves the same versions before and after, and none of them
 *   is ambiguous: an installed package is known by name and version (its path may be what moved), so two installed
 *   copies of a participating identity anywhere in either graph leave the package unproven, even if only one resolves
 *   an edge to it.
 * A dependent that resolves to the package on one side only fails the comparison. The answer is for display only; plans
 * and checks never read it.
 */
export function provenRehoists(lockfile: string, base: NpmGraph, head: NpmGraph): ReadonlyArray<string> {
  const before = new Map(base.copies().map((copy) => [copy.path, copy]));
  const after = new Map(head.copies().map((copy) => [copy.path, copy]));
  const kept = new Map<string, boolean>();
  const left = new Map<string, Set<string>>();
  const arrived = new Map<string, Set<string>>();
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(path);
    const now = after.get(path);
    if (was?.name === now?.name && was?.version === now?.version) {
      continue;
    }
    const samePackage = was === undefined || now === undefined || was.name === now.name;
    const wanted = (was === undefined || base.edgesTo(was.path).length > 0) && (now === undefined || head.edgesTo(now.path).length > 0);
    for (const name of [was?.name, now?.name]) {
      if (name !== undefined) {
        kept.set(name, (kept.get(name) ?? true) && samePackage && wanted);
      }
    }
    addVersion(left, was);
    addVersion(arrived, now);
  }
  return [...kept]
    .filter(([name, whole]) => whole && sameVersions(left.get(name), arrived.get(name)))
    .filter(([name]) => sameResolutions(resolutions(base, name), resolutions(head, name)))
    .map(([name]) => rehoistKey(lockfile, name));
}

function addVersion(versions: Map<string, Set<string>>, copy: Copy | undefined): void {
  if (copy !== undefined) {
    versions.set(copy.name, (versions.get(copy.name) ?? new Set()).add(copy.version));
  }
}

/** The copies that went away held exactly the versions the new ones hold: no version appeared or disappeared. */
function sameVersions(left: ReadonlySet<string> | undefined, arrived: ReadonlySet<string> | undefined): boolean {
  return left !== undefined && arrived !== undefined && left.size === arrived.size && [...left].every((version) => arrived.has(version));
}

/**
 * For each dependent of `name` that resolves to one of its copies (and the key it asks for), the versions it resolves
 * to; undefined when a participating installed identity has multiple copies anywhere in the graph, resolved or not.
 */
function resolutions(graph: NpmGraph, name: string): Map<string, Set<string>> | undefined {
  const copies = graph.copies();
  const byPath = new Map(copies.map((copy) => [copy.path, copy]));
  const byIdentity = Map.groupBy(copies, (copy) => identity(copy.path, copy));
  const resolved = new Map<string, Set<string>>();
  for (const copy of copies.filter((copy) => copy.name === name)) {
    for (const edge of graph.edgesTo(copy.path)) {
      const consumer = identity(edge.from, byPath.get(edge.from));
      if ((byIdentity.get(consumer)?.length ?? 0) > 1) {
        return undefined;
      }
      const dependent = `${consumer}\0${edge.key}`;
      resolved.set(dependent, (resolved.get(dependent) ?? new Set()).add(copy.version));
    }
  }
  return resolved;
}

/** A workspace is known by its directory; an installed package by name and version, since its path may be what moved. */
function identity(from: string, copy: Copy | undefined): string {
  if (!from.includes("node_modules/")) {
    return `workspace:${from}`;
  }
  return copy === undefined ? `path:${from}` : `${copy.name}@${copy.version}`;
}

function sameResolutions(before: Map<string, Set<string>> | undefined, after: Map<string, Set<string>> | undefined): boolean {
  if (before === undefined || after === undefined || before.size !== after.size) {
    return false;
  }
  return [...before].every(([dependent, versions]) => {
    const later = after.get(dependent);
    return later !== undefined && later.size === versions.size && [...versions].every((version) => later.has(version));
  });
}
