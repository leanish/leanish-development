import { describe, expect, it } from "vitest";

import type { GradleInventory } from "@leanish/gate/gradle";
import type { Tree } from "@leanish/gate/tree";
import { preservedFloors } from "../src/floor-checks.ts";
import type { ChangePlan } from "../src/plan.ts";
import { verifyPlan } from "../src/verify.ts";

const ID = "CVE-2026-12345";
const floor = (overrides: Record<string, unknown> = {}) => ({ ecosystem: "Maven", package: "g:lib", version: "1.0", declaredIn: "build.gradle.kts",
  selector: [":runtimeClasspath"], purpose: "security", advisories: [ID], reason: "security fix", added: "2026-10-01", ...overrides });
const plan: ChangePlan = { kind: "major", topic: "security", malware: false, packages: ["Maven|g:lib"], severity: "HIGH",
  moves: [{ ecosystem: "Maven", name: "g:lib", from: "1.0", to: "1.1", mechanism: "gradle-declared", locations: [":runtimeClasspath"],
    advisories: [ID], major: true, commitSha: undefined, declaredAs: undefined }] };

function tree(floors: unknown[], manifest = {}): Tree {
  const files: Record<string, string> = { ".github/dependency-floors.json": JSON.stringify({ floors }), "build.gradle.kts": "dependencies {}", "package.json": JSON.stringify(manifest) };
  return { id: "fixture", read: async (path) => files[path], list: async () => [] };
}

function gradle(version: string, reason = ID): GradleInventory {
  return { schemaVersion: 1, tree: "fixture", builds: [{ build: ".", configurations: [{ id: ":runtimeClasspath", kind: "project", error: undefined,
    resolved: [{ group: "g", name: "lib", version }], unresolved: [], declared: [{ group: "g", name: "lib", version, reason }] }] }] };
}

describe("secure-it floor preservation", () => {
  it.each(["1.0", "1.1"])("accepts a plugin-added duplicate security floor declaration resolving to %s", async (version) => {
    const base = tree([floor()]);
    const before = gradle("1.0");
    const head: GradleInventory = { ...before, builds: before.builds.map((build) => ({ ...build,
      configurations: build.configurations.map((config) => ({ ...config, declared: [...config.declared, ...config.declared],
        resolved: [{ group: "g", name: "lib", version }] })) })) };
    const pluginPlan = { ...plan, moves: plan.moves.map((move) => ({ ...move, name: "g:plugin" })) };
    expect(await preservedFloors(pluginPlan, base, base, { base: before, head })).toEqual([]);
  });
  it("preserves declaration reasons and their multiplicity for unchanged Maven floor records", async () => {
    const base = tree([floor()]);
    expect(await preservedFloors(plan, base, base, { base: gradle("1.0"), head: gradle("1.0", "plugin") }))
      .toEqual([`security floor g:lib in build.gradle.kts: a declaration or its reason was removed or changed at :runtimeClasspath`]);
    const before = gradle("1.0");
    const duplicated: GradleInventory = { ...before, builds: before.builds.map((build) => ({ ...build,
      configurations: build.configurations.map((config) => ({ ...config, declared: [...config.declared, ...config.declared] })) })) };
    expect(await preservedFloors(plan, base, base, { base: duplicated, head: before }))
      .toEqual([`security floor g:lib in build.gradle.kts: floor declaration for g:lib 1.0 was removed or changed at :runtimeClasspath`]);
  });
  it("rejects resolution below an unchanged Maven floor and the loss of a base resolution", async () => {
    const base = tree([floor()]);
    const before = gradle("1.0");
    const withResolution = (version: string | undefined): GradleInventory => ({ ...before, builds: before.builds.map((build) => ({ ...build,
      configurations: build.configurations.map((config) => ({ ...config, resolved: version === undefined ? [] : [{ group: "g", name: "lib", version }] })) })) });
    expect(await preservedFloors(plan, base, base, { base: before, head: withResolution("0.9") }))
      .toEqual(["security floor g:lib in build.gradle.kts: floor resolution for g:lib at :runtimeClasspath is 0.9, below 1.0"]);
    expect(await preservedFloors(plan, base, base, { base: before, head: withResolution(undefined) }))
      .toEqual(["security floor g:lib in build.gradle.kts: floor resolution for g:lib disappeared at :runtimeClasspath (base resolved 1.0)"]);
    expect(await preservedFloors(plan, base, base, { base: withResolution(undefined), head: withResolution(undefined) })).toEqual([]);
  });
  it("rejects removed records and changed selectors before compare, even for a major", async () => {
    const base = tree([floor()]);
    expect(await preservedFloors(plan, base, tree([]), {})).toEqual([expect.stringContaining("was removed")]);
    expect(await preservedFloors(plan, base, tree([floor({ selector: [":testRuntimeClasspath"] })]), {})).toContainEqual(expect.stringContaining("selector changed"));
    const unreachable = async () => { throw new Error("compare must not run"); };
    expect(await verifyPlan({ reference: undefined, plan, base, head: tree([]), gradle: {}, changedFiles: [".github/dependency-floors.json"],
      env: { run: unreachable, fetch: unreachable, now: () => new Date(), osvScanner: "osv-scanner", githubToken: undefined } })).toEqual([expect.stringContaining("was removed")]);
  });

  it("never changes compatibility records or their declarations, even for a planned package", async () => {
    const compatibility = floor({ purpose: "compatibility", advisories: [], reason: "plugin requires it" });
    const base = tree([compatibility]);
    expect(await preservedFloors(plan, base, tree([{ ...compatibility, version: "1.1" }]), {})).toEqual([expect.stringContaining("compatibility floor")]);
    expect(await preservedFloors(plan, base, base, { base: gradle("1.0", "plugin"), head: gradle("1.1", "plugin") })).toEqual([expect.stringContaining("compatibility floor")]);
    expect(await preservedFloors(plan, tree([]), tree([compatibility]), {})).toEqual([expect.stringContaining("added outside the plan")]);
  });

  it("rejects an identical declaration added to a compatibility Maven floor", async () => {
    const base = tree([floor({ purpose: "compatibility", advisories: [], reason: "plugin requires it" })]);
    const before = gradle("1.0", "plugin");
    const head: GradleInventory = { ...before, builds: before.builds.map((build) => ({ ...build,
      configurations: build.configurations.map((config) => ({ ...config, declared: [...config.declared, ...config.declared] })) })) };
    expect(await preservedFloors(plan, base, base, { base: before, head }))
      .toEqual(["compatibility floor g:lib in build.gradle.kts or its declaration changed outside an explicit security-floor move"]);
  });

  it.each(["added", "removed"])("distinguishes an empty configuration from a missing one when %s for a compatibility floor", async (change) => {
    const base = tree([floor({ purpose: "compatibility", advisories: [], reason: "plugin requires it" })]);
    const inventory = gradle("1.0");
    const empty: GradleInventory = { ...inventory, builds: inventory.builds.map((build) => ({ ...build,
      configurations: build.configurations.map((config) => ({ ...config, declared: [], resolved: [] })) })) };
    const missing: GradleInventory = { ...inventory, builds: inventory.builds.map((build) => ({ ...build, configurations: [] })) };
    const gradleInputs = change === "added" ? { base: missing, head: empty } : { base: empty, head: missing };
    expect(await preservedFloors(plan, base, base, gradleInputs))
      .toEqual(["compatibility floor g:lib in build.gradle.kts or its declaration changed outside an explicit security-floor move"]);
  });

  it("preserves npm override declarations independently of the record", async () => {
    const npm = floor({ ecosystem: "npm", package: "lib", version: "1.0.0", declaredIn: "package.json", selector: ["lib"] });
    const base = tree([npm], { overrides: { lib: "^1.0.0" } });
    expect(await preservedFloors(plan, base, tree([npm], { overrides: { lib: "1.1.0" } }), {})).toEqual([expect.stringContaining("declaration changed")]);
    expect(await preservedFloors(plan, base, tree([npm]), {})).toEqual([expect.stringContaining("declaration changed")]);
  });

  it("allows exact planned security updates while preserving record history and scope", async () => {
    expect(await preservedFloors(plan, tree([floor()]), tree([floor({ version: "1.1" })]), { base: gradle("1.0"), head: gradle("1.1") })).toEqual([]);
    expect(await preservedFloors(plan, tree([floor()]), tree([floor({ version: "1.1", reason: "different history" })]), {})).toEqual([expect.stringContaining("explicit security-floor move")]);
    expect(await preservedFloors({ ...plan, moves: [] }, tree([floor()]), tree([floor({ version: "1.1" })]), {})).toEqual([expect.stringContaining("outside an explicit")]);
    expect(await preservedFloors(plan, tree([floor()]), tree([floor({ version: "1.2" })]), {})).toEqual([expect.stringContaining("outside an explicit")]);
  });

  describe("a security raise of an npm override bump-it already moved above its record", () => {
    const FIRST = "GHSA-g3hv-75wg-m249";
    const NEXT = "GHSA-cf2h-pxjq-68xw";
    const record = (version: string, advisories: string[]) => floor({ ecosystem: "npm", package: "minimatch", version, declaredIn: "package.json", selector: [["minimatch"]], advisories });
    const raise = (overrides: Partial<ChangePlan["moves"][number]> = {}): ChangePlan => ({ ...plan, kind: "routine", packages: ["npm|minimatch"], moves: [{
      ecosystem: "npm", name: "minimatch", from: "11.0.8", to: "11.0.9", mechanism: "npm-override", locations: ["node_modules/minimatch"],
      advisories: [NEXT], major: false, commitSha: undefined, declaredAs: undefined, ...overrides }] });
    const base = tree([record("11.0.1", [FIRST])], { overrides: { minimatch: "11.0.8" } });
    const head = (pin = "11.0.9", version = "11.0.9") => tree([record(version, [FIRST, NEXT])], { overrides: { minimatch: pin } });

    it("lets the planned override move start from the installed pin", async () => {
      expect(await preservedFloors(raise(), base, head(), {})).toEqual([]);
    });

    it("accepts one move that also covers a nested copy or another lockfile root", async () => {
      const locations = ["node_modules/minimatch", "node_modules/parent/node_modules/minimatch", "example/node_modules/minimatch"];
      expect(await preservedFloors(raise({ locations }), base, head(), {})).toEqual([]);
    });

    it.each([
      ["a move that lowers the recorded minimum", raise({ to: "11.0.0" }), head("11.0.0", "11.0.0")],
      ["a move from another version", raise({ from: "11.0.7" }), head()],
      ["a move for a nested copy", raise({ locations: ["node_modules/parent/node_modules/minimatch"] }), head()],
      ["a pin other than the target", raise(), head("11.0.10")],
      ["a record other than the target", raise(), head("11.0.9", "11.0.10")],
    ])("refuses %s", async (_label, changes, after) => {
      expect(await preservedFloors(changes, base, after, {})).toEqual([expect.stringContaining("outside an explicit security-floor move")]);
    });
  });

  it("allows only planned security floor additions, never a direct move's unrequested floor", async () => {
    const added = tree([floor({ version: "1.1" })]);
    expect(await preservedFloors(plan, tree([]), added, {})).toEqual([expect.stringContaining("added outside the plan")]);
    const floorPlan = { ...plan, moves: plan.moves.map((move) => ({ ...move, mechanism: "gradle-floor" as const })) };
    expect(await preservedFloors(floorPlan, tree([]), added, {})).toEqual([]);
    expect(await preservedFloors(floorPlan, tree([]), tree([floor({ version: "1.1", advisories: ["CVE-2026-99999"] })]), {})).toEqual([expect.stringContaining("added outside the plan")]);
  });
});
