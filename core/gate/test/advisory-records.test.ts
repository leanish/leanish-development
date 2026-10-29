import { describe, expect, it } from "vitest";

import { AdvisoryRecords } from "../src/advisory-records.ts";
import type { PackageVersion } from "../src/package-version.ts";
import { fakeFetch } from "./fake-fetch.ts";

const GHSA = "GHSA-test-record";
const PKG: PackageVersion = { ecosystem: "Maven", name: "org.example:library", version: "2.0.0" };

function records(github: unknown, osv: unknown): AdvisoryRecords {
  return new AdvisoryRecords({ token: undefined, fetch: fakeFetch({
    [`https://api.github.com/advisories/${GHSA}`]: { body: github },
    [`https://api.osv.dev/v1/vulns/${GHSA}`]: { body: osv },
  }) });
}

const githubRecord = (name: string, ecosystem = "maven") => ({
  ghsa_id: GHSA, type: "reviewed", vulnerabilities: [{ package: { ecosystem, name }, vulnerable_version_range: "<2.0.0" }],
});
const osvRecord = (name: string, ecosystem = "Maven") => ({
  id: GHSA, affected: [{ package: { ecosystem, name }, versions: ["1.0.0"] }],
});

describe("global advisory records", () => {
  it.each([
    [PKG.name, PKG.name, true],
    ["library", PKG.name, false],
    ["other.group:library", PKG.name, false],
    ["library", "malformed-maven-name", false],
  ])("matches full Maven coordinates in both evidence readers (%s, %s)", async (name, target, matches) => {
    const lookups = records(githubRecord(name), osvRecord(name));
    const pkg = { ...PKG, name: target };
    expect((await lookups.github(GHSA, pkg, [pkg.version]))?.namesPackage).toBe(matches);
    expect((await lookups.osv(GHSA, pkg, [pkg.version]))?.namesPackage).toBe(matches);
  });

  it.each([
    ["GitHub Actions", "actions", "OWNER/ACTION", "owner/action", true],
    ["npm", "npm", "LIBRARY", "library", false],
  ] as const)("ignores name case only for Actions (%s)", async (ecosystem, githubEcosystem, name, target, matches) => {
    const pkg = { ecosystem, name: target, version: "2.0.0" };
    const lookups = records(githubRecord(name, githubEcosystem), osvRecord(name, ecosystem));
    expect((await lookups.github(GHSA, pkg, [pkg.version]))?.namesPackage).toBe(matches);
    expect((await lookups.osv(GHSA, pkg, [pkg.version]))?.namesPackage).toBe(matches);
  });

  it("preserves the evidence readers' acceptance of empty ids", async () => {
    const lookups = records({ ...githubRecord("other:package"), ghsa_id: "" }, { ...osvRecord("other:package"), id: "" });
    expect(await lookups.github(GHSA, PKG, [PKG.version])).toMatchObject({ id: "", namesPackage: false });
    expect(await lookups.osv(GHSA, PKG, [PKG.version])).toMatchObject({ id: "", namesPackage: false });
  });

  it("rejects empty ids on the snapshot path for both databases", async () => {
    const lookups = records({ ...githubRecord("owner/action", "actions"), ghsa_id: "" }, { ...osvRecord(PKG.name), id: "" });
    await expect(lookups.reviewed(GHSA, PKG)).rejects.toThrow("has no id");
    await expect(lookups.reviewed(GHSA, { ecosystem: "GitHub Actions", name: "owner/action", version: "2.0.0" })).rejects.toThrow("has no ghsa_id");
  });
});

describe("strict snapshot record validation", () => {
  const action: PackageVersion = { ecosystem: "GitHub Actions", name: "owner/action", version: "2.0.0" };

  it.each([
    { withdrawn_at: true },
    { cve_id: "" },
    { identifiers: [{ value: null }] },
    { vulnerabilities: [{ package: { ecosystem: "actions", name: action.name }, vulnerable_version_range: 42 }] },
    { vulnerabilities: [{ package: { ecosystem: "actions", name: action.name }, vulnerable_version_range: "<1.0.0", first_patched_version: { identifier: null } }] },
  ])("rejects malformed GitHub fields rather than clearing the version (%j)", async (fields) => {
    const lookups = records({ ...githubRecord(action.name, "actions"), ...fields }, undefined);
    await expect(lookups.reviewed(GHSA, action)).rejects.toThrow("unreadable");
  });

  it("requires GitHub's returned id to match even if an identifier claims the requested alias", async () => {
    const lookups = records({ ...githubRecord(action.name, "actions"), ghsa_id: "GHSA-other", identifiers: [{ value: GHSA }] }, undefined);
    await expect(lookups.reviewed(GHSA, action)).rejects.toThrow("doesn't identify requested");
  });

  it("accepts a different OSV id only when its aliases identify the request", async () => {
    const raw = { ...osvRecord(PKG.name), id: "CVE-2026-12345" };
    await expect(records(undefined, raw).reviewed(GHSA, PKG)).rejects.toThrow("doesn't identify requested");
    expect(await records(undefined, { ...raw, aliases: [GHSA] }).reviewed(GHSA, PKG)).toMatchObject({
      id: raw.id, namesPackage: true, verdicts: { [PKG.version]: "not-affected" },
    });
  });

  it.each([
    ["SEMVER", "1.0.0-sp1", "affected"],
    ["ECOSYSTEM", "1.0.0-sp1", "not-affected"],
    ["SEMVER", "1.0.Final", "unknown"],
    ["SEMVER", "1.0.0", "not-affected"],
  ])("uses %s ordering for Maven %s", async (type, version, verdict) => {
    const lookups = records(undefined, { id: GHSA, affected: [{ package: { ecosystem: "Maven", name: PKG.name }, ranges: [
      { type, events: [{ introduced: "0" }, { fixed: "1.0.0" }] },
    ] }] });
    const pkg = { ...PKG, version };
    expect((await lookups.reviewed(GHSA, pkg))?.verdicts[version]).toBe(verdict);
    expect((await lookups.osv(GHSA, pkg, [version]))?.verdicts[version]).toBe(verdict);
  });

  it("keeps mixed range types separate and rejects malformed SEMVER bounds", async () => {
    const range = (type: string, fixed: string) => ({ type, events: [{ introduced: "0" }, { fixed }] });
    const raw = (ranges: unknown[]) => ({ id: GHSA, affected: [{ package: { ecosystem: "Maven", name: PKG.name }, ranges }] });
    const pkg = { ...PKG, version: "1.0.0-sp1" };
    const both = records(undefined, raw([range("ECOSYSTEM", "1.0.0"), range("SEMVER", "1.0.0")]));
    expect((await both.reviewed(GHSA, pkg))?.verdicts[pkg.version]).toBe("affected");
    await expect(records(undefined, raw([range("SEMVER", "1.0.Final")])).reviewed(GHSA, pkg)).rejects.toThrow("unreadable SEMVER bounds");
  });
});

describe("package-less source entries in reviewed databases", () => {
  it.each(["osv", "github"] as const)("ignores absent/null packages in %s while still reading package entries", async (source) => {
    const pkg: PackageVersion = source === "github" ? { ecosystem: "GitHub Actions", name: "owner/action", version: "2.0.0" } : PKG;
    const gitRange = { ranges: [{ type: "GIT", repo: "https://github.com/owner/project", events: [{ introduced: "0" }, { fixed: "1".repeat(40) }] }], versions: ["release-1.0.0"] };
    const unscoped = [{ ...gitRange, package: null }, gitRange];
    const github = githubRecord(pkg.name, "actions");
    const osv = osvRecord(pkg.name);
    const onlySource = records({ ...github, vulnerabilities: unscoped }, { ...osv, affected: unscoped });
    expect(await onlySource.reviewed(GHSA, pkg)).toMatchObject({ namesPackage: false, verdicts: { [pkg.version]: "unknown" } });
    const mixed = records({ ...github, vulnerabilities: [...unscoped, ...github.vulnerabilities] }, { ...osv, affected: [...unscoped, ...osv.affected] });
    expect(await mixed.reviewed(GHSA, pkg)).toMatchObject({ namesPackage: true, verdicts: { [pkg.version]: "not-affected" } });
  });

  it.each(["osv", "github"] as const)("still rejects malformed present packages in %s", async (source) => {
    const pkg: PackageVersion = source === "github" ? { ecosystem: "GitHub Actions", name: "owner/action", version: "2.0.0" } : PKG;
    for (const malformed of ["package", 42, [], {}, { ecosystem: "Maven" }, { ecosystem: "Maven", name: 42 }, { name: PKG.name }]) {
      const entry = { package: malformed };
      const lookups = records({ ...githubRecord(pkg.name, "actions"), vulnerabilities: [entry] }, { ...osvRecord(pkg.name), affected: [entry] });
      await expect(lookups.reviewed(GHSA, pkg)).rejects.toThrow("no readable package list");
    }
    // A malformed entry itself isn't an entry with an absent package.
    const lookups = records({ ...githubRecord(pkg.name, "actions"), vulnerabilities: [null] }, { ...osvRecord(pkg.name), affected: [null] });
    await expect(lookups.reviewed(GHSA, pkg)).rejects.toThrow("no readable package list");
  });
});
