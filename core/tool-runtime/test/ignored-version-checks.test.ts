import { describe, expect, it } from "vitest";

import type { GradleInventory } from "@leanish/gate/gradle";
import type { Tree } from "@leanish/gate/tree";
import { ignoredVersionProblems } from "../src/ignored-version-checks.ts";

const config = JSON.stringify({ ignoredVersions: [
  { package: "npm:lib", versions: ["1.0.1"], reason: "broken" },
  { package: "Maven:g:lib", versions: ["1.0.1"], reason: "broken" },
  { package: "GitHub Actions:acme/tool", versions: ["v1.0.1"], reason: "broken" },
] });
const tree = (files: Record<string, string>): Tree => ({ id: "worktree", read: async (path) => path === ".github/supply-chain.json" ? config : files[path], list: async (dir) => Object.keys(files).filter((path) => dir === "." || path.startsWith(`${dir}/`)) });
const lock = (packages: Record<string, unknown>) => JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/parent": { version: "1.0.0" }, ...packages } });

describe("ignored resolution verification", () => {
  it("allows inherited copies and refuses changed or additional transitive, bundled and aliased copies", async () => {
    const inherited = { "node_modules/parent/node_modules/lib": { version: "1.0.1", inBundle: true } };
    const base = tree({ "package-lock.json": lock(inherited) });
    expect(await ignoredVersionProblems(base, base, {})).toEqual([]);
    const head = tree({ "package-lock.json": lock({ ...inherited, "node_modules/alias": { name: "lib", version: "1.0.1" } }) });
    expect(await ignoredVersionProblems(base, head, {})).toEqual([expect.stringContaining("npm:lib@1.0.1 at node_modules/alias: broken")]);
    const changed = tree({ "package-lock.json": lock({ "node_modules/parent/node_modules/lib": { version: "1.0.0", inBundle: true } }) });
    expect(await ignoredVersionProblems(changed, base, {})).toEqual([expect.stringContaining("ignored version introduced:")]);
  });

  it("allows hoisting an existing ignored copy, but not increasing its count", async () => {
    const base = tree({ "package-lock.json": lock({ "node_modules/parent/node_modules/lib": { version: "1.0.1" } }) });
    const moved = tree({ "package-lock.json": lock({ "node_modules/lib": { version: "1.0.1" } }) });
    expect(await ignoredVersionProblems(base, moved, {})).toEqual([]);
    const added = tree({ "package-lock.json": lock({ "node_modules/lib": { version: "1.0.1" }, "node_modules/alias": { name: "lib", version: "1.0.1" } }) });
    expect(await ignoredVersionProblems(base, added, {})).toEqual([expect.stringContaining("ignored version introduced:")]);
  });

  it("refuses additional copies in another lockfile", async () => {
    const base = tree({ "package-lock.json": lock({ "node_modules/lib": { version: "1.0.1" } }) });
    const head = tree({ "package-lock.json": lock({ "node_modules/lib": { version: "1.0.1" } }), "other/package-lock.json": lock({ "node_modules/lib": { version: "1.0.1" } }) });
    // Explicitly configure the second lockfile, as an adopter must.
    const configured = (source: Tree): Tree => ({ ...source, read: async (path) => path === ".github/supply-chain.json" ? JSON.stringify({ ...JSON.parse(config), npm: { lockfiles: ["package-lock.json", "other/package-lock.json"] } }) : source.read(path) });
    expect(await ignoredVersionProblems(configured(base), configured(head), {})).toEqual([expect.stringContaining("other/node_modules/lib")]);
  });

  it("checks every Gradle configuration's resolved transitives, including conflict-selected versions", async () => {
    const source = tree({ "build.gradle.kts": "" });
    const inventory = (extra: boolean): GradleInventory => ({ schemaVersion: 3, tree: "worktree", builds: [{ build: ".", configurations: [":runtimeClasspath", ...extra ? [":testRuntimeClasspath"] : []].map((id) => ({ id, kind: "project", resolved: [{ group: "g", name: "lib", version: "1.0.1" }], declared: [], unresolved: [], error: undefined })) }] });
    expect(await ignoredVersionProblems(source, source, { base: inventory(false), head: inventory(false) })).toEqual([]);
    expect(await ignoredVersionProblems(source, source, { base: inventory(false), head: inventory(true) })).toEqual([expect.stringContaining(":testRuntimeClasspath")]);
  });

  it("allows a Maven copy to move between configurations without increasing its count", async () => {
    const source = tree({ "build.gradle.kts": "" });
    const inventory = (id: string): GradleInventory => ({ schemaVersion: 3, tree: "worktree", builds: [{ build: ".", configurations: [{ id, kind: "project", resolved: [{ group: "g", name: "lib", version: "1.0.1" }], declared: [], unresolved: [], error: undefined }] }] });
    expect(await ignoredVersionProblems(source, source, { base: inventory(":oldClasspath"), head: inventory(":runtimeClasspath") })).toEqual([]);
  });

  it("checks literal v-prefixed Maven resolutions without normalization", async () => {
    const source: Tree = { ...tree({ "build.gradle.kts": "" }), read: async (path) => path === ".github/supply-chain.json"
      ? JSON.stringify({ ignoredVersions: [{ package: "Maven:g:lib", versions: ["v1.0.1"], reason: "broken" }] })
      : path === "build.gradle.kts" ? "" : undefined };
    const inventory = (version: string): GradleInventory => ({ schemaVersion: 3, tree: "worktree", builds: [{ build: ".", configurations: [{ id: ":runtimeClasspath", kind: "project", resolved: [{ group: "g", name: "lib", version }], declared: [], unresolved: [], error: undefined }] }] });
    expect(await ignoredVersionProblems(source, source, { base: inventory("v1.0.0"), head: inventory("v1.0.1") })).toEqual([expect.stringContaining("Maven:g:lib@v1.0.1")]);
  });

  it("counts action occurrences and detects changed refs, files and subpaths", async () => {
    const use = `      - uses: acme/tool@${"a".repeat(40)} # v1.0.1\n`;
    const workflow = (steps: string) => `jobs:\n  test:\n    steps:\n${steps}`;
    const path = ".github/workflows/ci.yml";
    const base = tree({ [path]: workflow(use) });
    expect(await ignoredVersionProblems(base, base, {})).toEqual([]);
    expect(await ignoredVersionProblems(tree({}), tree({ [path]: workflow(use.replace(" # v1.0.1", "")) }), {})).toEqual([]);
    const variants: Record<string, string>[] = [
      { [path]: workflow(use + use) },
      { [path]: workflow(use.replace("a".repeat(40), "b".repeat(40))) },
      { [path]: workflow(use.replace("acme/tool@", "acme/tool/sub@")) },
      { ".github/workflows/other.yml": workflow(use) },
    ];
    for (const files of variants) expect(await ignoredVersionProblems(base, tree(files), {})).toEqual([expect.stringContaining("GitHub Actions:acme/tool@v1.0.1")]);
  });
});
