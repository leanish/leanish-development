import { describe, expect, it } from "vitest";

import { isTrustedPackage, parseConfig } from "../src/config.ts";

describe("supply-chain.json", () => {
  it.each([
    ["trustedPackages", "com.acme"],
    ["trustedPackages", "com.acme."],
    ["ownPackages", "com.acme"],
    ["ownPackages", "com.acme."],
  ])("matches %s plugin prefix %s at dot boundaries and only on markers", (field, prefix) => {
    const config = parseConfig({ [field]: { Maven: { pluginIdPrefixes: [prefix] } } });
    const markerTrusted = (group: string) => isTrustedPackage(config.trustedPackages, { ecosystem: "Maven", name: `${group}:${group}.gradle.plugin` });
    expect(markerTrusted("com.acme")).toBe(prefix === "com.acme");
    expect(markerTrusted("com.acme.x")).toBe(true);
    expect(markerTrusted("com.acme.x.y")).toBe(true);
    expect(markerTrusted("com.acmecorp.evil")).toBe(false);
    expect(markerTrusted("com.acmex")).toBe(false);
    expect(markerTrusted("com.other.acme.x")).toBe(false);
    expect(isTrustedPackage(config.trustedPackages, { ecosystem: "Maven", name: "com.acme.x:library" })).toBe(false);
    expect(isTrustedPackage(config.trustedPackages, { ecosystem: "Maven", name: "com.acme.x:com.other.gradle.plugin" })).toBe(false);
  });

  const trustedPackages = {
    npm: { scopes: ["@leanish", "@aws-sdk"] },
    Maven: { groups: ["com.acme"], pluginIdPrefixes: ["com.acme."] },
    "GitHub Actions": { owners: ["leanish", "aws-actions"] },
  };

  it.each(["trustedPackages", "ownPackages"])("normalizes %s to the same trust policy", (field) => {
    const config = parseConfig({ [field]: trustedPackages });
    expect(config.trustedPackages).toEqual({
      npmScopes: ["@leanish", "@aws-sdk"], mavenGroups: ["com.acme"],
      pluginIdPrefixes: ["com.acme."], actionOwners: ["leanish", "aws-actions"],
    });
    expect(config).not.toHaveProperty("ownPackages");
  });

  it.each([
    { trustedPackages, ownPackages: trustedPackages },
    { trustedPackages: {}, ownPackages: {} },
    { trustedPackages: null, ownPackages: {} },
  ])("rejects both field names together, even with matching or empty policies", (raw) => {
    expect(() => parseConfig(raw)).toThrow("trustedPackages and ownPackages cannot both be present");
  });

  it.each(["trustedPackages", "ownPackages"])("validates %s without silently ignoring malformed policy", (field) => {
    expect(() => parseConfig({ [field]: null })).toThrow(`${field} must be an object`);
    expect(() => parseConfig({ [field]: { owners: [] } })).toThrow(`${field} has unknown field(s): owners`);
    expect(() => parseConfig({ [field]: { npm: { scopes: ["acme"] } } })).toThrow(`${field}.npm.scopes has acme, not an @scope`);
    expect(() => parseConfig({ [field]: { Maven: { groups: [""] } } })).toThrow(`${field}.Maven.groups must be a list`);
    expect(() => parseConfig({ [field]: { "GitHub Actions": { owners: ["aws-actions", "aws-actions"] } } })).toThrow(`${field}["GitHub Actions"].owners has duplicates`);
  });

  it("strips trailing slashes from registries, builds and repositories as before, and a long slash run in linear time", () => {
    const config = parseConfig({
      npm: { registries: ["https://r.example/", "https://r.example///", "https://r.example/a//b/", "https://r.example"] },
      gradle: { builds: ["tools/", "tools//", "./", "a//b"] },
      maven: { repositories: ["https://m.example/maven2/", "https://m.example"] },
    });
    expect(config.npm.registries).toEqual(["https://r.example", "https://r.example", "https://r.example/a//b", "https://r.example"]);
    expect(config.gradle.builds).toEqual(["tools", "tools", ".", "a//b"]);
    expect(config.maven.repositories).toEqual(["https://m.example/maven2", "https://m.example"]);
    const run = `a${"/".repeat(100_000)}b`;
    const started = performance.now();
    // The replaced regex rescanned the run from each slash, for each of the three.
    const long = parseConfig({ npm: { registries: [`https://${run}`] }, gradle: { builds: [run] }, maven: { repositories: [`https://${run}`] } });
    const elapsed = performance.now() - started;
    expect([long.npm.registries, long.gradle.builds, long.maven.repositories]).toEqual([[`https://${run}`], [run], [`https://${run}`]]);
    expect(elapsed).toBeLessThan(2_000);
  });
});
