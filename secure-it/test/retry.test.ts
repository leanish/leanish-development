import { describe, expect, it } from "vitest";

import { markedLength, ownPullRequests } from "@leanish/tool-runtime/own-pr";
import { planBlock } from "@leanish/tool-runtime/plan-blocks";
import { cooldownWarning, planOf, planSection, withPlanSection } from "../src/plan-block.ts";
import type { ChangePlan, PlannedMove } from "../src/plan.ts";
import { retryWithoutNamed } from "../src/retry.ts";

function move(name: string, from = "1.0.0"): PlannedMove {
  return { ecosystem: "npm", name, from, to: "1.0.1", mechanism: "npm-lock", locations: [`node_modules/${name}`], advisories: ["GHSA-a"], major: false, commitSha: undefined, declaredAs: undefined };
}

function plan(...moves: PlannedMove[]): ChangePlan {
  return { kind: "routine", topic: "security", malware: false, packages: [...new Set(moves.map((entry) => `${entry.ecosystem}|${entry.name}`))].sort(), moves, severity: "HIGH" };
}

describe("batch retry", () => {
  it("omits a direct-peer set together and persists the reason for its companion too", () => {
    const original = { ...plan(move("vitest"), move("@vitest/ui"), move("other")), coupled: [["npm|vitest", "npm|@vitest/ui", "npm|unchanged"]] };
    const retry = retryWithoutNamed(original, ["vitest at node_modules/vitest is gone, not 1.0.1"]);
    expect(retry.plan?.packages).toEqual(["npm|other"]);
    expect(retry.leftOut).toHaveLength(2);
    expect(retry.leftOut.every((entry) => entry.moves.length === 1 && entry.problems.length === 1)).toBe(true);
    expect(planOf(planSection(retry.plan!))?.coupled).toEqual(original.coupled);
  });

  it("drops the notes of the moves it omits, a package one carries included, and keeps the rest", () => {
    const floor: PlannedMove = { ...move("g:foo"), ecosystem: "Maven" };
    const carrier: PlannedMove = { ...move("carrier"), carries: [{ name: "brace", from: ["5.0.9"], locations: ["node_modules/carrier/node_modules/brace"], advisories: ["GHSA-b"], to: [] }] };
    // A note is about the package it starts with; the others it names only explain it.
    const notes = [
      "g:foo@1.0.0 gets a floor: gradle/libs.versions.toml names it",
      "brace@5.0.9 is affected by GHSA-r: these advisories alone don't trigger an update",
      "carrier@1.0.1 at node_modules/carrier keeps an override: every parent version in range drops @scope/kept@1.0.1",
      "@scope/kept@1.0.0 is affected by GHSA-k: these advisories alone don't trigger an update",
      "@scope/kept@1.0.1 at node_modules/@scope/kept keeps an override: every parent version in range drops carrier@1.0.1",
      "a gate note",
    ];
    const retry = retryWithoutNamed({ ...plan(floor, carrier, move("@scope/kept")), notes }, ["g:foo at gradle/libs.versions.toml is gone, not 1.0.1", "carrier at node_modules/carrier is gone, not 1.0.1"]);
    expect(retry.plan?.moves.map((kept) => kept.name)).toEqual(["@scope/kept"]);
    expect(retry.plan?.notes).toEqual(notes.slice(3));
  });

  it("keeps the remaining moves' vetoes and every other note when it omits a package", () => {
    const vetoed = { ...move("lib"), vetoed: [{ version: "1.0.0.1", advisories: ["GHSA-repo"] }] };
    const original = { ...plan(vetoed, move("other")), notes: ["lib@2.0.0 is affected by GHSA-x, only in the project's repository advisories"] };
    const retry = retryWithoutNamed(original, ["other at node_modules/other is gone, not 1.0.1"]);
    expect(retry.plan?.moves).toEqual([vetoed]);
    expect(retry.plan?.notes).toEqual(original.notes);
    expect(planSection(retry.plan!)).toContain("- lib 1.0.0.1 was ruled out by GHSA-repo, not corroborated by the sources this decision used.");
    // An advisory id from elsewhere can't open a comment hiding the rest of the section.
    const quoting = plan({ ...move("lib"), vetoed: [{ version: "1.0.0.1", advisories: ["<!-- x"] }] });
    expect(planSection(quoting)).toContain("was ruled out by &lt;!-- x, not corroborated");
  });

  it("counts the vetoes left out, keeps eight such moves well within every limit, and refuses a malformed count", () => {
    const vetoed = Array.from({ length: 10 }, (_, i) => ({ version: `1.0.0.${i}`, advisories: ["GHSA-repo", "CVE-2026-1"] }));
    const counted = { ...move("lib"), vetoed, vetoesLeftOut: 1_990 };
    expect(planSection(plan(counted))).toContain(
      "- lib: 1990 more candidates were ruled out the same way, by advisories not corroborated by the sources this decision used.",
    );
    // Eight projects locking eight versions of one package, one open-ended repository advisory over 2,000 candidates.
    const eight = plan(...Array.from({ length: 8 }, (_, i) => ({ ...counted, from: `1.0.${i}`, locations: [`p${i}/node_modules/lib`] })));
    const body = withPlanSection("Description.", eight);
    expect(planOf(body)).toEqual(eight);
    expect(markedLength(ownPullRequests("secure-it"), body)).toBeLessThan(30_000);
    for (const vetoesLeftOut of [0, -1, 1.5, "3"]) expect(planOf(withPlanSection("Description.", plan({ ...counted, vetoesLeftOut } as unknown as PlannedMove)))).toBeUndefined();
    expect(planOf(withPlanSection("Description.", plan({ ...move("lib"), vetoesLeftOut: 3 })))).toBeUndefined();
  });

  it("attributes a failed required child to its security root and leaves unrelated npm work", () => {
    const root = { name: "lib", version: "1.0.1", path: "node_modules/lib" };
    const target = { name: "child", version: "2.0.0", path: "node_modules/child", lockfile: "package-lock.json", root, parent: root, key: "child", range: "^2", exempt: true, reason: "forced young child" };
    const original = { ...plan(move("lib"), move("other")), requiredNpm: [target], notes: [target.reason], coupled: [["npm|lib"]] };
    const retry = retryWithoutNamed(original, ["compare: child@2.0.0 adds an advisory"]);
    expect(retry.plan?.packages).toEqual(["npm|other"]);
    expect(retry.plan?.requiredNpm).toEqual([]);
    expect(retry.plan?.notes).toEqual([]);
    expect(retry.leftOut[0]?.problems).toEqual(["compare: child@2.0.0 adds an advisory"]);
  });

  it("keeps a reason an omitted target shares with a kept one, and drops only the omitted target's own", () => {
    const lib = { name: "lib", version: "1.0.1", path: "node_modules/lib" };
    const app = { name: "app", version: "1.0.1", path: "node_modules/app" };
    const shared = "parent@1.0.0 requires child ^2; aged child@2.0.0 anchors its required-dependency proof";
    const target = (root: typeof lib, name: string, reason: string) => ({ name, version: "2.0.0", path: `node_modules/${name}`, lockfile: "package-lock.json", root, parent: root, key: name, range: "^2", exempt: false, reason });
    const original = { ...plan(move("lib"), move("app"), move("other")), requiredNpm: [target(lib, "child", shared), target(lib, "own", "lib's own reason"), target(app, "child", shared)], notes: ["a gate note", shared, "lib's own reason"] };
    const retry = retryWithoutNamed(original, ["lib at node_modules/lib is gone, not 1.0.1"]);
    expect(retry.plan?.packages).toEqual(["npm|app", "npm|other"]);
    expect(retry.plan?.notes).toEqual(["a gate note", shared]);
  });

  it("attributes a carried package's problem to its carrier, and keeps the carrier in the plan's text and block", () => {
    const carried = { name: "brace", from: ["5.0.9"], locations: ["node_modules/carrier/node_modules/brace"], advisories: ["GHSA-brace"], to: ["5.0.12"] };
    const carrier: PlannedMove = { ...move("carrier"), mechanism: "npm-direct", advisories: [], carries: [carried] };
    const original = plan(carrier, move("other"));
    const section = planSection(original);
    expect(section).toContain("| npm | `carrier` | 1.0.0 → 1.0.1 | npm-direct | GHSA-brace in bundled `brace` 5.0.9 → 5.0.12 |");
    expect(planOf(section)).toEqual(original);
    expect(planOf(planBlock({ ...original, moves: [{ ...carrier, carries: [{ ...carried, to: "5.0.12" }] }] }))).toBeUndefined();
    const retry = retryWithoutNamed(original, ["brace@5.0.9 still has GHSA-brace, which moving carrier was to fix"]);
    expect(retry.plan?.packages).toEqual(["npm|other"]);
    expect(retry.leftOut[0]?.moves).toEqual([carrier]);
  });

  it("drops all copies of a named package rather than silently publishing only some", () => {
    const original = plan(move("lib"), move("lib", "0.9.0"), move("other"));
    const retry = retryWithoutNamed(original, ["compare: new: lib@1.0.1: GHSA-new has no exception"]);
    expect(retry.plan?.packages).toEqual(["npm|other"]);
    expect(retry.leftOut[0]?.moves.map((entry) => entry.from)).toEqual(["1.0.0", "0.9.0"]);
    expect(original.moves).toHaveLength(3);
  });

  it("matches scoped names and regex characters exactly, not package prefixes or filenames", () => {
    const original = plan(move("@own/lib.plus"), move("@own/lib"), move("lib"));
    const retry = retryWithoutNamed(original, ["compare: @own/lib.plus@1.0.1 has an identity break"]);
    expect(retry.plan?.packages).toEqual(["npm|@own/lib", "npm|lib"]);
    expect(retryWithoutNamed(original, ["the edit changed src/lib.ts"]).plan).toBeUndefined();
  });

  it("does not reduce a batch if any problem is global or names an unplanned induced version", () => {
    const original = plan(move("lib"), move("other"));
    const retry = retryWithoutNamed(original, ["lib at node_modules/lib is gone, not 1.0.1", "compare: induced@2.0.0 has a new advisory"]);
    expect(retry.plan).toBeUndefined();
    expect(retry.named.map((entry) => entry.moves.length)).toEqual([1, 0]);
    expect(retry.leftOut).toEqual([]);
  });

  it("does not retry an empty remainder, malware or a major", () => {
    const original = plan(move("lib"));
    const problems = ["lib at node_modules/lib is gone, not 1.0.1"];
    expect(retryWithoutNamed(original, problems).plan).toBeUndefined();
    expect(retryWithoutNamed({ ...original, kind: "malware", malware: true }, problems).leftOut).toEqual([]);
    expect(retryWithoutNamed({ ...original, kind: "major" }, problems).leftOut).toEqual([]);
  });

  it("names Gradle declaration failures and does not confuse npm with Maven's name suffix", () => {
    const maven = { ...move("g:lib"), ecosystem: "Maven" as const, mechanism: "gradle-declared" as const, locations: [":runtimeClasspath"] };
    const original = plan(maven, move("lib"));
    expect(retryWithoutNamed(original, [":runtimeClasspath declares g:lib nowhere, not 1.0.1"]).plan?.packages).toEqual(["npm|lib"]);
    expect(retryWithoutNamed(original, ["compare: g:lib@1.0.1 has a new advisory"]).plan?.packages).toEqual(["npm|lib"]);
  });

  it("persists and replaces the omissions in the PR-facing section", () => {
    const reduced = retryWithoutNamed(plan(move("lib"), move("other")), ["lib at node_modules/lib is gone, not 1.0.1"]).plan!;
    const body = withPlanSection("Description.", reduced);
    expect(planOf(body)).toEqual(reduced);
    expect(body).toContain("Left out after verification failed");
    expect(body).toContain("lib at node_modules/lib");
    const refreshed = withPlanSection(body, plan(move("other")));
    expect(refreshed).not.toContain("Left out after verification failed");
    expect(refreshed.match(/What secure-it moved/g)).toHaveLength(1);
    expect(planOf(planSection({ ...reduced, kind: "invalid" as never }))).toBeUndefined();
  });

  it("compresses a plan too large for a plain block, and keeps its cooldown warning within GitHub's body limit", () => {
    const large = plan(...Array.from({ length: 400 }, (_, n) => move(`lib-${n}`)));
    expect(planBlock(large).length).toBeGreaterThan(43_000);
    const section = planSection(large);
    expect(section.length).toBeLessThanOrEqual(43_000);
    expect(section).toContain("<!-- leanish:plan:br ");
    expect(section).toContain("Security targets are the versions");
    expect(planOf(section)).toEqual(large);
    const held = { ecosystem: "npm" as const, name: "lib-0", version: "1.0.1", replaced: ["1.0.0"], published: "2026-10-06T00:00:00.000Z", eligibleAt: "2026-10-13T00:00:00.000Z", justification: "security-fix" as const, signals: [] };
    const warned = withPlanSection("Description.", { ...large, cooldown: [held] });
    expect(warned).toContain("Release-age cooldown bypassed");
    expect(planOf(warned)).toEqual({ ...large, cooldown: [held] });
    // The body fits without the warning and goes over with it.
    const warning = cooldownWarning([held])!;
    const filler = "x".repeat(65_536 - "\n\n".length - planSection({ ...large, cooldown: [held] }).length - Math.floor(warning.length / 2));
    expect(() => withPlanSection(filler, large)).not.toThrow();
    expect(() => withPlanSection(filler, { ...large, cooldown: [held] })).toThrow(/over GitHub's 65536/);
  });
});
