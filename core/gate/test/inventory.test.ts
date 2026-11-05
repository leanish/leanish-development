import { describe, expect, it } from "vitest";

import { parseConfig } from "../src/config.ts";
import { baseSources } from "../src/gate.ts";
import { readInventory, sourcesOf } from "../src/inventory.ts";
import type { Tree } from "../src/tree.ts";

const LOCK = JSON.stringify({ lockfileVersion: 3, packages: {} });
const tree = (files: Record<string, string>, id = "head"): Tree => ({ id, read: async (path) => files[path], links: async () => [], list: async () => [] });

describe("npm lockfile selection", () => {
  it.each([
    ["package-lock.json", "npm-shrinkwrap.json", undefined],
    ["package-lock.json", "npm-shrinkwrap.json", ["package-lock.json"]],
    ["tools/package-lock.json", "tools/npm-shrinkwrap.json", ["tools/package-lock.json"]],
  ] as const)("refuses selected %s when %s shadows it", async (path, shrinkwrap, lockfiles) => {
    const head = tree({ [path]: LOCK, [shrinkwrap]: LOCK });
    const config = parseConfig(lockfiles === undefined ? {} : { npm: { lockfiles } });
    await expect(sourcesOf(head, config)).rejects.toThrow(
      lockfiles === undefined
        ? "head has npm-shrinkwrap.json: npm installs from the shrinkwrap; list npm-shrinkwrap.json in supply-chain.json npm.lockfiles instead"
        : `${path} in head is shadowed by ${shrinkwrap}: npm installs from the shrinkwrap; list ${shrinkwrap} in supply-chain.json npm.lockfiles instead`,
    );
  });

  it("refuses implicit discovery of a root shrinkwrap without a package lock", async () => {
    await expect(sourcesOf(tree({ "npm-shrinkwrap.json": LOCK }), parseConfig({}))).rejects.toThrow(
      "list npm-shrinkwrap.json in supply-chain.json npm.lockfiles instead",
    );
  });

  it("reads an explicitly selected shrinkwrap even when a package lock is beside it", async () => {
    const head = tree({ "package-lock.json": LOCK, "npm-shrinkwrap.json": LOCK });
    const sources = await sourcesOf(head, parseConfig({ npm: { lockfiles: ["npm-shrinkwrap.json"] } }));
    expect(sources.lockfiles).toEqual(["npm-shrinkwrap.json"]);
    expect((await readInventory(head, sources)).npm.map((lock) => lock.path)).toEqual(["npm-shrinkwrap.json"]);
  });

  it("does not reject a package lock because another directory has a shrinkwrap", async () => {
    const head = tree({ "package-lock.json": LOCK, "tools/npm-shrinkwrap.json": LOCK });
    expect((await sourcesOf(head, parseConfig({}))).lockfiles).toEqual(["package-lock.json"]);
  });

  it.each([
    [{ gradle: { builds: ["app"] } }, ["app"]],
    [{ gradle: { builds: [] } }, []],
  ])("keeps a base's own Gradle builds while it's still on the removed ownPackages (%j)", async (sources, builds) => {
    const config = JSON.stringify({ ...sources, npm: { lockfiles: ["tools/package-lock.json"] }, ownPackages: { npm: { scopes: ["@a"] } } });
    const base = tree({ ".github/supply-chain.json": config, "settings.gradle.kts": "", "tools/package-lock.json": LOCK }, "base");
    expect(await baseSources(base, { lockfiles: ["package-lock.json"], gradleBuilds: [] }))
      .toEqual({ lockfiles: ["package-lock.json", "tools/package-lock.json"], gradleBuilds: builds });
  });

  it("falls back to the defaults for a base on the removed ownPackages whose other settings don't parse", async () => {
    const base = tree({ ".github/supply-chain.json": JSON.stringify({ gradle: { builds: "app" }, ownPackages: {} }), "settings.gradle.kts": "" }, "base");
    expect((await baseSources(base, { lockfiles: [], gradleBuilds: [] })).gradleBuilds).toEqual(["."]);
  });

  it.each([true, false])("keeps baseline lockfile handling when the shadowed lock exists: %s", async (exists) => {
    const base = tree({ "npm-shrinkwrap.json": LOCK, ...(exists ? { "package-lock.json": LOCK } : {}) }, "base");
    const sources = await baseSources(base, { lockfiles: ["package-lock.json"], gradleBuilds: [] });
    expect(sources.lockfiles).toEqual(["package-lock.json"]);
    expect((await readInventory(base, sources, { missingLockfilesAreEmpty: true })).npm)
      .toEqual([{ path: "package-lock.json", packages: [], bundleProblems: [] }]);
  });
});
