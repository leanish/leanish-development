import { describe, expect, it } from "vitest";

import type { SecurityFix } from "../../ci/src/candidates.ts";
import type { Floor } from "../../ci/src/floors.ts";
import type { GradleInventory } from "../../ci/src/gradle.ts";
import { selectRemovals } from "../src/floor-removal.ts";
import { selectWork } from "../src/plan.ts";
import { withStrictPinsBlocked } from "../src/secure-it.ts";

const maven = (name: string, locations = [":runtimeClasspath"]): SecurityFix => ({
  ecosystem: "Maven", name, from: "1.0", locations, targets: ["GHSA-a"], unfixable: [], malicious: false, severity: "HIGH",
  to: { version: "1.1", line: "1", aged: true, major: false, blockers: [] }, problem: undefined,
});
const gradle: GradleInventory = { schemaVersion: 3, tree: "base", builds: [{ build: ".", configurations: [
  { id: ":runtimeClasspath", kind: "project", resolved: [], unresolved: [], error: undefined,
    declared: [{ group: "g", name: "pinned", version: "1.0", reason: undefined, strict: true }, { group: "g", name: "free", version: "1.0", reason: undefined }] },
  { id: ":testRuntimeClasspath", kind: "project", resolved: [], unresolved: [], error: undefined, declared: [],
    strictConstraints: [{ group: "g", name: "constrained", version: "1.0" }] },
  // As Gradle pins its embedded Kotlin on every buildscript classpath: it says nothing about the project's classpaths.
  { id: ":buildscript.classpath", kind: "buildscript", resolved: [], unresolved: [], error: undefined, declared: [],
    strictConstraints: [{ group: "g", name: "kotlin", version: "2.0" }] },
] }] };

describe("strict pins in secure-it", () => {
  it("blocks the fixes of coordinates pinned strictly where they'd act, declared or constrained, and keeps planning the rest", () => {
    const fixes = withStrictPinsBlocked([maven("g:pinned"), maven("g:free"), maven("g:constrained", [":runtimeClasspath", ":testRuntimeClasspath"]), maven("g:kotlin"),
      { ...maven("pinned"), ecosystem: "npm" }], gradle);
    const selection = selectWork(fixes);
    expect(selection.units.map((unit) => unit.work.map((fix) => `${fix.ecosystem}|${fix.name}`))).toEqual([["Maven|g:free", "Maven|g:kotlin", "npm|pinned"]]);
    expect(selection.blocked).toHaveLength(2);
    expect(selection.blocked).toEqual(expect.arrayContaining([
      { packages: ["Maven|g:constrained"], reasons: ["g:constrained@1.0: g:constrained is pinned with strictly(...) at :testRuntimeClasspath: the owner's pin, which the tools never move"] },
      { packages: ["Maven|g:pinned"], reasons: ["g:pinned@1.0: g:pinned is pinned with strictly(...) at :runtimeClasspath: the owner's pin, which the tools never move"] },
    ]));
  });

  it("keeps a floor the owner declares with strictly(...) and still proves removing the others", async () => {
    const floor = (pkg: string): Floor => ({ ecosystem: "Maven", package: pkg, version: "2.0", declaredIn: "build.gradle.kts", locations: [":runtimeClasspath"],
      overridePaths: [], purpose: "security", advisories: ["GHSA-a"], reason: "fix", added: "2026-10-01" });
    const probed: string[][] = [];
    const removal = await selectRemovals([floor("g:pinned"), floor("g:free")], async (floors) => {
      probed.push(floors.map((entry) => entry.package));
      return { problems: [], findings: [], files: new Map() };
    }, () => "hash", (candidate) => (candidate.package === "g:pinned" ? "pinned with strictly(...)" : undefined));
    expect(probed.flat()).not.toContain("g:pinned");
    expect(removal.plan?.floorRemoval?.floors.map((entry) => entry.package)).toEqual(["g:free"]);
    expect(removal.notes).toEqual(["g:pinned in build.gradle.kts: floor retained (pinned with strictly(...))"]);
  });
});
