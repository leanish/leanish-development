import { describe, expect, it } from "vitest";

import { DAY_MS } from "../src/age.ts";
import { parseConfig } from "../src/config.ts";
import { NO_EXCEPTIONS } from "../src/exceptions.ts";
import type { Inventory } from "../src/inventory.ts";
import { BundleReader } from "../src/npm-bundles.ts";
import { NpmRegistry } from "../src/npm-registry.ts";
import type { PackageVersion } from "../src/package-version.ts";
import { Snapshot } from "../src/snapshot.ts";
import type { Tree } from "../src/tree.ts";
import { reviewYoungVersions } from "../src/young-versions.ts";
import type { VersionCatalog } from "../src/young-fixes.ts";

const NOW = new Date("2026-10-27T12:00:00Z");
const OLD = new Date(NOW.getTime() - 30 * DAY_MS);
const YESTERDAY = new Date(NOW.getTime() - DAY_MS);
const tree: Tree = { id: "worktree", read: async () => undefined, list: async () => [] };
const inventory: Inventory = { tree: "worktree", npm: [], gradle: undefined, actions: { uses: [], docker: [], files: [], gaps: [] } };
const catalog: VersionCatalog = {
  versions: async () => ["1.0.0", "1.0.1"],
  published: async (pkg) => (pkg.version === "1.0.1" ? YESTERDAY : OLD),
};
const offline = async () => { throw new Error("no network in this test"); };

/** Runs the review with a scan that records what each snapshot covered. */
async function review(changes: Parameters<typeof reviewYoungVersions>[0]["changes"]) {
  const scans: Array<{ packages: ReadonlyArray<PackageVersion>; candidates: ReadonlyArray<PackageVersion> }> = [];
  const packages: PackageVersion[] = [{ ecosystem: "Maven", name: "g:a", version: "1.0.1" }];
  const result = await reviewYoungVersions({
    base: tree, head: tree, baseInventory: inventory, headInventory: inventory, packages, changes, ownRoots: [],
    config: parseConfig({}), exceptions: NO_EXCEPTIONS, now: NOW, catalogs: { npm: catalog, Maven: catalog, "GitHub Actions": catalog },
    registry: new NpmRegistry(offline), reader: new BundleReader(offline),
    scan: async (scanned, candidates = []) => {
      scans.push({ packages: scanned, candidates });
      return new Snapshot(new Map([["Maven|g:a|1.0.0", []], ["Maven|g:a|1.0.1", []]]), [], NOW);
    },
  });
  return { result, scans };
}

describe("reviewYoungVersions", () => {
  it("takes one snapshot covering every package and the candidates a young version could have taken, and judges it", async () => {
    const { result, scans } = await review([{ pkg: { ecosystem: "Maven", name: "g:a", version: "1.0.1" }, published: YESTERDAY, replaced: ["1.0.0"] }]);
    expect(scans).toHaveLength(1);
    expect(scans[0]!.packages).toEqual([{ ecosystem: "Maven", name: "g:a", version: "1.0.1" }]);
    // The versions above the replaced 1.0.0: the young version itself included, even if the listing lagged.
    expect(scans[0]!.candidates.map((pkg) => pkg.version)).toEqual(["1.0.1"]);
    expect(result.held).toMatchObject([{ name: "g:a", version: "1.0.1", justification: "unjustified" }]);
    expect(result.problems).toEqual([expect.stringContaining("g:a@1.0.1 was published")]);
  });

  it("still returns the snapshot for compare's findings when nothing is young", async () => {
    const { result, scans } = await review([{ pkg: { ecosystem: "Maven", name: "g:a", version: "1.0.1" }, published: OLD, replaced: ["1.0.0"] }]);
    expect(scans).toEqual([{ packages: [{ ecosystem: "Maven", name: "g:a", version: "1.0.1" }], candidates: [] }]);
    expect(result).toMatchObject({ held: [], problems: [], notes: [] });
    expect(result.snapshot.gaps).toEqual([]);
  });
});
