/** Shared npm materialization, with optional routine retention pins. */
import type { Copy, NpmGraph } from "./npm-graph.ts";
import type { RepositoryOverrides } from "./npm-overrides.ts";
import { NpmPinPlacementError, pinnedManifests, type Pin } from "@leanish/tool-runtime/npm-pins";

export * from "@leanish/tool-runtime/npm-pins";

/** Retention must not reject an unchanged graph just because a redundant pin is unsupported. */
export function retentionManifests(
  graph: NpmGraph,
  pins: ReadonlyArray<Pin>,
  retained: ReadonlyMap<string, Copy>,
  manifests: ReadonlyMap<string, Record<string, unknown>>,
  overrides: RepositoryOverrides,
): { readonly manifests: ReadonlyMap<string, Record<string, unknown>>; readonly unpinned: ReadonlySet<string> } {
  const accepted = pins.filter((pin) => !retained.has(pin.copy.path));
  const targets = new Map(pins.map((pin) => [pin.copy.path, pin.target]));
  let result = pinnedManifests(graph, accepted, manifests, overrides);
  const unpinned = new Set<string>();
  for (const pin of pins.filter((pin) => retained.has(pin.copy.path))) {
    // A name-level override governs every matching copy. Narrowing it for retention
    // can contradict a direct's exact spec (EOVERRIDE) or another copy's target.
    // Leave that optional pin out; the caller checks the copy after resolution.
    if (sharesOverrideWithDifferentTarget(graph, pin, targets, overrides)) {
      unpinned.add(pin.copy.path);
      continue;
    }
    try {
      // Test against all accepted pins: individually valid pins may conflict in one manifest.
      result = pinnedManifests(graph, [...accepted, pin], manifests, overrides);
      accepted.push(pin);
    } catch (err) {
      if (!(err instanceof NpmPinPlacementError)) throw err;
      // Existing overrides and nested peers can keep the version without a temporary pin.
      // The caller must verify it after npm runs; malformed manifests still fail above.
      unpinned.add(pin.copy.path);
    }
  }
  return { manifests: result, unpinned };
}

function sharesOverrideWithDifferentTarget(graph: NpmGraph, pin: Pin, targets: ReadonlyMap<string, string>, overrides: RepositoryOverrides): boolean {
  // Declarations and peer anchors do not use the transitive override-rewrite path.
  if (graph.edgesTo(pin.copy.path).some((edge) => edge.declared || edge.kind === "peer")) return false;
  const key = overrides.rangeFor(pin.copy.installedAs) !== undefined ? pin.copy.installedAs : pin.copy.name;
  if (overrides.rangeFor(key) === undefined) return false;
  return graph.copies().some((copy) => copy.path !== pin.copy.path && (copy.installedAs === key || copy.name === key)
    && (copy.name !== pin.copy.name || (targets.get(copy.path) ?? copy.version) !== pin.target));
}
