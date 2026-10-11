/** Shared npm materialization, with optional routine retention pins. */
import type { Copy, NpmGraph } from "./npm-graph.ts";
import type { RepositoryOverrides } from "./npm-overrides.ts";
import { NpmPinPlacementError, pinnedManifests, type Pin } from "../../remediation/src/npm-pins.ts";

export * from "../../remediation/src/npm-pins.ts";

/** Retention must not reject an unchanged graph just because a redundant pin is unsupported. */
export function retentionManifests(
  graph: NpmGraph,
  pins: ReadonlyArray<Pin>,
  retained: ReadonlyMap<string, Copy>,
  manifests: ReadonlyMap<string, Record<string, unknown>>,
  overrides: RepositoryOverrides,
): { readonly manifests: ReadonlyMap<string, Record<string, unknown>>; readonly unpinned: ReadonlySet<string> } {
  const accepted = pins.filter((pin) => !retained.has(pin.copy.path));
  let result = pinnedManifests(graph, accepted, manifests, overrides);
  const unpinned = new Set<string>();
  for (const pin of pins.filter((pin) => retained.has(pin.copy.path))) {
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
