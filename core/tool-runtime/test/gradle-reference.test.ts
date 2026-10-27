import { describe, expect, it } from "vitest";

import type { GradleInventory } from "@leanish/gate/gradle";
import { referenceDifferences, referenceProblems, referenceTransform } from "../src/gradle-reference.ts";

import { RICH_VERSION, RICH_VERSION_CHANGES, richVersionInventory } from "./rich-version-inventory.ts";

const inventory = (versions: ReadonlyArray<string | undefined>, resolved = "1.0.0", extra: Partial<GradleInventory["builds"][number]["configurations"][number]> = {}): GradleInventory => ({ tree: "tree", schemaVersion: 1, builds: [{ build: ".", configurations: [{
  id: ":runtimeClasspath", kind: "project", declared: versions.map((version) => ({ group: "g", name: "lib", version, reason: undefined })),
  resolved: [{ group: "g", name: "lib", version: resolved }], unresolved: [], error: undefined, ...extra,
}] }] });
const move = (from: string, to: string) => ({ name: "g:lib", from, to, locations: [":runtimeClasspath"] });
/** `inventory` as the reference script leaves it: the declarations at `moved` versions are the ones it moved. */
const moved = (versions: ReadonlyArray<string | undefined>, movedVersions: ReadonlyArray<string>): GradleInventory => {
  const base = inventory(versions);
  const configuration = base.builds[0]!.configurations[0]!;
  return { ...base, builds: [{ build: ".", configurations: [{ ...configuration, declared: configuration.declared.map((entry) => (movedVersions.includes(entry.version!) ? { ...entry, moved: true as const } : entry)) }] }] };
};

describe("the plan's Gradle reference", () => {
  it("hands the reference script the plan, for the build it runs on", () => {
    const transform = referenceTransform([move("1.0.0", "1.1.0")], []);
    expect(transform.initScript).toMatch(/supply-chain-reference\.init\.gradle$/);
    expect(transform.property).toBe("supplyChain.reference.file");
    expect(transform.content("/tmp/repo")).toEqual({ repositoryRoot: "/tmp/repo", moves: [move("1.0.0", "1.1.0")], floors: [] });
  });

  it("requires each move's sources, and only them, to have moved in the reference, versionless declarations kept", () => {
    const moves = [move("1.0.0", "1.1.0"), move("2.0.0", "2.1.0")];
    expect(referenceProblems(inventory(["1.0.0", "2.0.0", "3.0.0", undefined]), moved(["1.1.0", "2.1.0", "3.0.0", undefined], ["1.1.0", "2.1.0"]), moves, [])).toEqual([]);
    expect(referenceProblems(inventory(["1.0.0", "2.0.0", "3.0.0"]), moved(["1.1.0", "2.1.0", "3.1.0"], ["1.1.0", "2.1.0"]), moves, [])).toEqual([
      "the plan's reference declares g:lib 1.1.0, 2.1.0, 3.1.0 at :runtimeClasspath, not 1.1.0, 2.1.0, 3.0.0",
    ]);
    // A build that reset the move, or a versionless declaration the move took over.
    expect(referenceProblems(inventory(["1.0.0"]), inventory(["1.0.0"]), [move("1.0.0", "1.1.0")], [])).toHaveLength(2);
    expect(referenceProblems(inventory(["1.0.0", undefined]), moved(["1.1.0", "1.1.0"], ["1.1.0"]), [move("1.0.0", "1.1.0")], [])).toEqual([
      "the plan's reference declares g:lib 1.1.0, 1.1.0 at :runtimeClasspath, not (no version), 1.1.0",
      "the plan's reference no longer holds the g:lib declarations it moved at :runtimeClasspath",
    ]);
    expect(referenceProblems(inventory(["2.0.0"]), inventory(["2.0.0"]), [move("1.0.0", "1.1.0")], [])).toEqual(["the plan's base has no declaration of g:lib 1.0.0 to move at :runtimeClasspath"]);
  });

  it("finds a move that reached a configuration the plan doesn't list, or a moved declaration a build replaced, and lets fallout through", () => {
    const two = (runtime: string, test: string, marks: { runtime?: boolean; test?: boolean } = {}, stdlib = "2.0.0"): GradleInventory => ({ tree: "tree", schemaVersion: 1, builds: [{ build: ".", configurations: [":runtimeClasspath", ":testRuntimeClasspath"].map((id) => {
      const marked = id === ":runtimeClasspath" ? marks.runtime : marks.test;
      return {
        id, kind: "project" as const, resolved: [], unresolved: [], error: undefined,
        declared: [
          { group: "g", name: "lib", version: id === ":runtimeClasspath" ? runtime : test, reason: "the build's own reason", ...(marked === true ? { moved: true as const } : {}) },
          { group: "org.jetbrains.kotlin", name: "kotlin-stdlib", version: stdlib, reason: undefined },
        ],
      };
    }) }] });
    expect(referenceProblems(two("1.0.0", "1.0.0"), two("1.1.0", "1.0.0", { runtime: true }), [move("1.0.0", "1.1.0")], [])).toEqual([]);
    expect(referenceProblems(two("1.0.0", "1.0.0"), two("1.1.0", "1.1.0", { runtime: true, test: true }), [move("1.0.0", "1.1.0")], [])).toEqual(["the plan's reference moved g:lib at :testRuntimeClasspath, which the plan doesn't list"]);
    // The moved version, but not the declaration the reference moved: a build replaced it, so its reach is unknown.
    expect(referenceProblems(two("1.0.0", "1.0.0"), two("1.1.0", "1.1.0"), [move("1.0.0", "1.1.0")], [])).toEqual(["the plan's reference no longer holds the g:lib declarations it moved at :runtimeClasspath"]);
    // What running the plan changed elsewhere, unmarked, is its fallout.
    expect(referenceProblems(two("1.0.0", "1.0.0"), two("1.1.0", "1.0.0", { runtime: true }, "2.1.0"), [move("1.0.0", "1.1.0")], [])).toEqual([]);
  });

  it("requires each floor added in the reference, next to what was declared", () => {
    const floor = { name: "g:lib", version: "1.2.0", reason: "GHSA-test", locations: [":runtimeClasspath"] };
    expect(referenceProblems(inventory(["1.0.0"]), inventory(["1.0.0", "1.2.0"]), [], [floor])).toEqual([]);
    expect(referenceProblems(inventory(["1.0.0"]), inventory(["1.2.0"]), [], [floor])).toHaveLength(1);
  });

  it("keeps plain-version and simple strict-pin comparisons identical with the new inventory fields", () => {
    const plain = { strictVersion: "", requiredVersion: "1.0.0", preferredVersion: "", rejectedVersions: [], branch: null };
    const legacy = inventory(["1.0.0"]);
    const configuration = legacy.builds[0]!.configurations[0]!;
    expect(referenceDifferences(legacy, inventory(["1.0.0"], "1.0.0", {
      declared: configuration.declared.map((entry) => ({ ...entry, versionConstraint: plain })), constraints: [],
    }))).toEqual([]);
    const pin = { group: "g", name: "lib", version: "1.0.0", reason: undefined, strict: true as const };
    const strictConstraints = [{ group: "g", name: "other", version: "1.0.0" }];
    const rich = { ...plain, strictVersion: "1.0.0" };
    const before = inventory([], "1.0.0", { declared: [pin], strictConstraints });
    const after = inventory([], "1.0.0", { declared: [{ ...pin, versionConstraint: rich }], strictConstraints,
      constraints: strictConstraints.map((entry) => ({ ...entry, versionConstraint: rich })),
    });
    expect(referenceDifferences(before, after)).toEqual([]);
    expect(referenceDifferences(after, inventory(["1.0.0"]))).toEqual(referenceDifferences(before, inventory(["1.0.0"])));
  });

  it("finds every way head differs from the reference: modules, declarations (versionless too), configurations and failures", () => {
    const reference = inventory(["1.0.0", undefined]);
    expect(referenceDifferences(reference, inventory(["1.0.0", undefined]))).toEqual([]);
    expect(referenceDifferences(reference, inventory(["1.0.0", undefined], "9.0.0"))).toEqual([":runtimeClasspath, unlike the plan's reference, also resolves g:lib:9.0.0 and no longer resolves g:lib:1.0.0"]);
    expect(referenceDifferences(reference, inventory(["1.0.0"]))).toEqual([":runtimeClasspath, unlike the plan's reference, no longer declares g:lib (no version)"]);
    expect(referenceDifferences(reference, inventory(["1.0.0", undefined, undefined]))).toEqual([":runtimeClasspath, unlike the plan's reference, also declares g:lib (no version)"]);
    // Strictness counts: a pin turned into a plain declaration at the same version, or a strict constraint dropped.
    const pinned = inventory(["1.0.0"], "1.0.0", { declared: [{ group: "g", name: "lib", version: "1.0.0", reason: undefined, strict: true }], strictConstraints: [{ group: "g", name: "other", version: "2.0" }] });
    expect(referenceDifferences(pinned, pinned)).toEqual([]);
    expect(referenceDifferences(pinned, inventory(["1.0.0"]))).toEqual([":runtimeClasspath, unlike the plan's reference, also declares g:lib 1.0.0 and no longer declares g:lib 1.0.0 (strict), g:other 2.0 (strict constraint)"]);
    expect(referenceDifferences(reference, inventory(["1.0.0", undefined], "1.0.0", { kind: "buildscript" }))).toEqual([":runtimeClasspath is a buildscript configuration in the edit, project in the plan's reference"]);
    expect(referenceDifferences(reference, inventory(["1.0.0", undefined], "1.0.0", { unresolved: [{ requested: "g:lib:2.0.0", failure: "not found" }] }))).toEqual([":runtimeClasspath doesn't resolve in the edit: g:lib:2.0.0: not found"]);
    expect(referenceDifferences(inventory(["1.0.0", undefined], "1.0.0", { error: "boom" }), reference)).toEqual([":runtimeClasspath doesn't resolve in the plan's reference: boom"]);
    const elsewhere: GradleInventory = { ...reference, builds: [{ build: "tools", configurations: reference.builds[0]!.configurations }] };
    expect(referenceDifferences(reference, elsewhere)).toEqual([
      ":runtimeClasspath is missing from the edit, unlike the plan's reference",
      "tools/:runtimeClasspath is only in the edit, unlike the plan's reference",
    ]);
    expect(referenceDifferences(undefined, undefined)).toEqual([]);
    expect(referenceDifferences(reference, undefined)).toHaveLength(1);
  });

  it("lets a configuration the gate ignores fail to resolve, but only the same way as in the plan's reference", () => {
    // A thrown resolution, as the exporter writes it: the error, and nothing resolved.
    const thrown = (error: string, declared = "1.0.0") => inventory([declared], "1.0.0", { error, resolved: [] });
    const unresolved = (failure: string) => inventory(["1.0.0"], "1.0.0", { unresolved: [{ requested: "g:lib:2.0.0", failure }] });
    const ignored = [":runtimeClasspath"];
    expect(referenceDifferences(thrown("boom"), thrown("boom"), ignored)).toEqual([]);
    expect(referenceDifferences(unresolved("not found"), unresolved("not found"), ignored)).toEqual([]);
    // Outside the ignored ones, any failure on either side is reported, the same one included.
    expect(referenceDifferences(thrown("boom"), thrown("boom"), ["tools/:runtimeClasspath"])).toEqual([
      ":runtimeClasspath doesn't resolve in the plan's reference: boom",
      ":runtimeClasspath doesn't resolve in the edit: boom",
    ]);
    // An edit there (a forced version, say) that changes, adds or removes a failure.
    expect(referenceDifferences(thrown("boom"), thrown("Could not resolve g:lib:9.0.0"), ignored)).toEqual([
      ":runtimeClasspath, unlike the plan's reference, also fails to resolve Could not resolve g:lib:9.0.0 and no longer fails to resolve boom",
    ]);
    expect(referenceDifferences(inventory(["1.0.0"], "1.0.0", { resolved: [] }), thrown("boom"), ignored)).toEqual([
      ":runtimeClasspath, unlike the plan's reference, also fails to resolve boom",
    ]);
    expect(referenceDifferences(unresolved("not found"), unresolved("timed out"), ignored)).toEqual([
      ":runtimeClasspath, unlike the plan's reference, also fails to resolve g:lib:2.0.0: timed out and no longer fails to resolve g:lib:2.0.0: not found",
    ]);
    // What it declares still has to match.
    expect(referenceDifferences(thrown("boom"), thrown("boom", "1.1.0"), ignored)).toEqual([
      ":runtimeClasspath, unlike the plan's reference, also declares g:lib 1.1.0 and no longer declares g:lib 1.0.0",
    ]);
  });
});

describe.each(["declaration", "constraint"] as const)("rich version of a %s", (kind) => {
  it.each(RICH_VERSION_CHANGES)("detects $facet even when resolution is unchanged", ({ before, after }) => {
    expect(referenceDifferences(richVersionInventory(kind, before), richVersionInventory(kind, after)))
      .toContainEqual(expect.stringContaining("unlike the plan's reference"));
  });

  it("compares every facet in both directions and treats rejected versions as unordered", () => {
    const reference = richVersionInventory(kind, { ...RICH_VERSION, rejectedVersions: ["2.0", "2.5"] });
    expect(referenceDifferences(reference, richVersionInventory(kind, { ...RICH_VERSION, rejectedVersions: ["2.5", "2.0"] }))).toEqual([]);
    for (const { before, after } of RICH_VERSION_CHANGES) {
      expect(referenceDifferences(richVersionInventory(kind, after), richVersionInventory(kind, before))).not.toEqual([]);
    }
    const empty = inventory([], "1.5");
    expect(referenceDifferences(reference, empty)).toContainEqual(expect.stringContaining("no longer declares g:rich"));
    expect(referenceDifferences(empty, reference)).toContainEqual(expect.stringContaining("also declares g:rich"));
  });
});
