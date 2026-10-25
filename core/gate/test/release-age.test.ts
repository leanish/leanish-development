import { describe, expect, it } from "vitest";

import type { BundleFixProof } from "../src/bundle-fix-proof.ts";
import { parseConfig } from "../src/config.ts";
import { NO_EXCEPTIONS, parseExceptions, type Exceptions } from "../src/exceptions.ts";
import type { PackageVersion } from "../src/package-version.ts";
import { type AgeContext, type ChangedVersion, type HeldTarget, reviewReleaseAge } from "../src/release-age.ts";
import { type Advisory, Snapshot } from "../src/snapshot.ts";
import type { VersionCatalog } from "../src/young-fixes.ts";

const NOW = new Date("2026-10-09T05:05:00Z");
const config = parseConfig({});
const advisory = (id: string, source: Advisory["source"], aliases: string[] = []): Advisory => ({ id, ids: [id, ...aliases], source, malicious: false, summary: undefined, severity: "HIGH" });
const npm = (name: string, version: string): PackageVersion => ({ ecosystem: "npm", name, version });
const young = (pkg: PackageVersion, replaced: string): ChangedVersion => ({ pkg, replaced: [replaced], published: new Date("2026-10-06T00:00:00Z") });
/** A registry listing only the versions the change moves between, so no proof finds another candidate. */
const catalog: VersionCatalog = { versions: async () => ["1.0.0", "1.0.1"], published: async () => new Date("2026-10-06T00:00:00Z") };

function review(change: ChangedVersion, affecting: Record<string, Advisory[]>, extra: Partial<AgeContext> & { readonly exceptions?: Exceptions } = {}) {
  const map = new Map<string, Advisory[]>([[`npm|${change.pkg.name}|${change.replaced[0]}`, []], [`npm|${change.pkg.name}|${change.pkg.version}`, []]]);
  for (const [key, advisories] of Object.entries(affecting)) map.set(key, advisories);
  return reviewReleaseAge([change], {
    snapshot: new Snapshot(map, [], NOW), exceptions: NO_EXCEPTIONS, config, now: NOW,
    catalogs: { npm: catalog, Maven: catalog, "GitHub Actions": catalog }, candidates: new Map(), ...extra,
  });
}

describe("what a young version records as the advisories it fixes", () => {
  const lib = npm("lib", "1.0.1");
  const required = { required: new Set(["npm|lib|1.0.1"]) };
  const bundled: HeldTarget = { name: "inner", bundled: true, replaced: ["2.0.0"], proposed: ["2.0.1"], groups: [{ ids: ["GHSA-inner"], replaced: ["2.0.0"] }] };

  it("keeps a required version's own reviewed advisories, though the requirement justifies it", async () => {
    const outcome = await review(young(lib, "1.0.0"), { "npm|lib|1.0.0": [advisory("GHSA-lib", "osv")] }, required);
    expect(outcome).toEqual({ problems: [], held: [expect.objectContaining({ justification: "required", targets: [
      { name: "lib", bundled: false, replaced: ["1.0.0"], proposed: ["1.0.1"], groups: [{ ids: ["GHSA-lib"], replaced: ["1.0.0"] }] },
    ] })] });
  });

  it("records nothing for a required version that fixes nothing", async () => {
    const [held] = (await review(young(lib, "1.0.0"), {}, required)).held;
    expect(held).toMatchObject({ justification: "required" });
    expect(held!.targets).toBeUndefined();
  });

  it("records nothing for a required version the change adds, which replaces none", async () => {
    const added: ChangedVersion = { pkg: lib, replaced: [], published: new Date("2026-10-06T00:00:00Z") };
    const [held] = (await review(added, { "npm|lib|1.0.0": [advisory("GHSA-lib", "osv")] }, required)).held;
    expect(held).toMatchObject({ justification: "required" });
    expect(held!.targets).toBeUndefined();
  });

  it("adds a required carrier's proved bundle, once, and never a bundle whose proof failed", async () => {
    const own = { "npm|lib|1.0.0": [advisory("GHSA-lib", "osv")] };
    const proved: BundleFixProof = { problem: undefined, targets: [bundled, bundled] };
    const [both] = (await review(young(lib, "1.0.0"), own, { ...required, bundleFixes: new Map([["npm|lib|1.0.1", proved]]) })).held;
    expect(both!.targets?.map((target) => [target.name, target.groups.map((group) => group.ids)])).toEqual([["lib", [["GHSA-lib"]]], ["inner", [["GHSA-inner"]]]]);
    const failed = { problem: "the bundle can't be read", targets: [bundled] } as unknown as BundleFixProof;
    const [alone] = (await review(young(lib, "1.0.0"), own, { ...required, bundleFixes: new Map([["npm|lib|1.0.1", failed]]) })).held;
    expect(alone!.targets?.map((target) => target.name)).toEqual(["lib"]);
  });

  it("records the advisory an exception names, by any alias and from any source, beside its own reviewed ones", async () => {
    // The fix also adds GHSA-new, so the rule doesn't take it: only the owner's exception lets it through.
    const affecting = { "npm|lib|1.0.0": [advisory("GHSA-repo", "repository", ["CVE-2026-1"]), advisory("GHSA-lib", "osv")], "npm|lib|1.0.1": [advisory("GHSA-new", "osv")] };
    const exceptions = parseExceptions({ releaseAge: [{ ecosystem: "npm", package: "lib", version: "1.0.1", advisory: "CVE-2026-1", reason: "the owner's call", expires: "2026-10-20" }] });
    const outcome = await review(young(lib, "1.0.0"), affecting, { exceptions });
    expect(outcome).toEqual({ problems: [], held: [expect.objectContaining({ justification: "exception", targets: [
      { name: "lib", bundled: false, replaced: ["1.0.0"], proposed: ["1.0.1"], groups: [{ ids: ["CVE-2026-1", "GHSA-repo"], replaced: ["1.0.0"] }, { ids: ["GHSA-lib"], replaced: ["1.0.0"] }] },
    ] })] });
  });

  it("records nothing for an exception naming an advisory no replaced version has: it stays unjustified", async () => {
    const affecting = { "npm|lib|1.0.0": [advisory("GHSA-lib", "osv")], "npm|lib|1.0.1": [advisory("GHSA-new", "osv")] };
    const exceptions = parseExceptions({ releaseAge: [{ ecosystem: "npm", package: "lib", version: "1.0.1", advisory: "CVE-9999-0000", reason: "the owner's call", expires: "2026-10-20" }] });
    const { problems, held } = await review(young(lib, "1.0.0"), affecting, { exceptions });
    expect(problems).toHaveLength(1);
    expect(held[0]).toMatchObject({ justification: "unjustified" });
    expect(held[0]!.targets).toBeUndefined();
  });
});
