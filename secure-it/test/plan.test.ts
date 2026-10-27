import { describe, expect, it } from "vitest";

import type { SecurityFix } from "@leanish/gate/candidates";
import type { GradleInventory } from "@leanish/gate/gradle";
import { coupledWork, heldUnits, isHeldTopic, planFor, selectWork, splitByAge, withUnsupportedCarriers } from "../src/plan.ts";

function fix(overrides: Partial<SecurityFix> & Pick<SecurityFix, "name" | "from">): SecurityFix {
  return {
    ecosystem: "npm",
    locations: [`node_modules/${overrides.name}`],
    targets: ["GHSA-a"],
    unfixable: [],
    malicious: false,
    severity: "HIGH",
    to: { version: "9.9.9", line: "9", aged: true, major: false, blockers: [] },
    problem: undefined,
    ...overrides,
  };
}

const NO_TAGS = async () => undefined;

const names = (fixes: ReadonlyArray<SecurityFix>) => fixes.map((f) => f.name);

describe("selectWork", () => {
  it("adds safe direct companions and reports an impossible peer set without blocking another package", async () => {
    const vitest = fix({ name: "vitest", from: "4.1.7", to: { version: "4.1.11", line: "4", aged: true, major: false, blockers: [] } });
    const other = fix({ name: "other", from: "1.0.0" });
    const companion = { name: "@vitest/ui", from: "4.1.7", to: "4.1.11", locations: ["node_modules/@vitest/ui"], line: "4", aged: true, declarations: [] };
    const peers = { resolve: async () => ({ additions: [companion], blocked: [], sets: [["vitest", "@vitest/ui"]] }) };
    const selected = await coupledWork([vitest, other], peers);
    expect(selected.units[0]?.work.map((entry) => entry.name)).toEqual(["other", "vitest", "@vitest/ui"]);
    expect(selected.units[0]?.work[2]).toMatchObject({ targets: [], to: { version: "4.1.11", major: false } });
    expect(selected.units[0]?.coupled).toEqual([["npm|vitest", "npm|@vitest/ui"]]);
    const stuck = { resolve: async () => ({ additions: [], blocked: [{ moves: [{ ...vitest, to: "4.1.11" }], reason: "UI has no safe compatible peer" }], sets: [] }) };
    const remaining = await coupledWork([vitest, other], stuck);
    expect(remaining.units[0]?.work.map((entry) => entry.name)).toEqual(["other"]);
    expect(remaining.blocked).toEqual([{ packages: ["npm|vitest"], reasons: ["UI has no safe compatible peer"] }]);
    expect((await coupledWork([{ ...vitest, malicious: true }, other], stuck)).units).toEqual([]);
  });

  it("keeps an own fix and the own companion it requires out of held work, young as they are", async () => {
    // Both are own packages, so the gate never holds them: their moves are planned as aged (npm-peers' `isAged`).
    const core = fix({ name: "@own/core", from: "1.0.0", to: { version: "1.0.1", line: "1", aged: true, major: false, blockers: [] } });
    const ui = { name: "@own/ui", from: "1.0.0", to: "1.0.1", locations: ["node_modules/@own/ui"], line: "1", aged: true, declarations: [] };
    const selected = await coupledWork([core], { resolve: async () => ({ additions: [ui], blocked: [], sets: [["@own/core", "@own/ui"]] }) });
    expect(selected.units.flatMap(splitByAge)).toMatchObject([{ kind: "routine", held: false, work: [{ name: "@own/core" }, { name: "@own/ui" }] }]);
  });

  it("reports the notes of work peers leave out, transitively tied work's too, and all of a dropped malware unit's", async () => {
    const note = (name: string) => `${name}@2.0.0 has GHSA-repo (unreviewed): these advisories alone don't trigger an update`;
    const vitest = fix({ name: "vitest", from: "4.1.7", notes: [note("vitest")] });
    const tied = fix({ name: "tied", from: "1.0.0", notes: [note("tied")] });
    const other = fix({ name: "other", from: "1.0.0", notes: [note("other")] });
    const stuck = { resolve: async () => ({ additions: [], blocked: [{ moves: [{ ...vitest, to: "9.9.9" }], reason: "UI has no safe compatible peer" }], sets: [["vitest", "tied"]] }) };
    expect((await coupledWork([vitest, tied, other], stuck)).blocked).toEqual([{
      packages: ["npm|tied", "npm|vitest"],
      reasons: ["UI has no safe compatible peer", `tied@1.0.0: ${note("tied")}`, `vitest@4.1.7: ${note("vitest")}`],
    }]);
    const clean = fix({ name: "vitest", from: "4.0.0", notes: ["a clean copy's note"] });
    const malware = await coupledWork([{ ...vitest, malicious: true }, { ...other, malicious: true }, clean], stuck);
    expect(malware.units).toEqual([]);
    expect(malware.blocked[0]?.reasons).toEqual(["UI has no safe compatible peer", `vitest@4.1.7: ${note("vitest")}`, `other@1.0.0: ${note("other")}`, "vitest@4.0.0: a clean copy's note"]);
  });

  it("takes malware together, otherwise batches non-majors in severity/name order", () => {
    const evil = fix({ name: "evil", from: "1.0.0", malicious: true, severity: undefined });
    const worse = fix({ name: "worse", from: "1.0.0", malicious: true });
    const critical = fix({ name: "zlib", from: "1.0.0", severity: "CRITICAL" });
    const high = fix({ name: "alpha", from: "1.0.0", severity: "HIGH" });
    expect(names(selectWork([high, critical, evil, worse]).units[0]!.work)).toEqual(["evil", "worse"]);
    expect(names(selectWork([high, critical]).units[0]!.work)).toEqual(["zlib", "alpha"]);
    expect(names(selectWork([fix({ name: "b", from: "1.0.0" }), fix({ name: "a", from: "1.0.0" })]).units[0]!.work)).toEqual(["a", "b"]);
  });

  it("keeps every failing copy together, and reports blocked groups without blocking the batch", () => {
    const old = fix({ name: "guava", from: "33.5.0-jre", ecosystem: "Maven" });
    const newer = fix({ name: "guava", from: "33.7.1-jre", ecosystem: "Maven" });
    const blocked = fix({
      name: "aaa", from: "1.0.0", severity: "CRITICAL", to: { version: "1.0.1", line: "1", aged: true, major: false, blockers: ["identity break"] },
      notes: ["aaa@2.0.0 has GHSA-repo (unreviewed): these advisories alone don't trigger an update"],
    });
    const partly = fix({ name: "aab", from: "1.0.0", severity: "CRITICAL" });
    const stuck = fix({ name: "aab", from: "2.0.0", severity: "CRITICAL", to: undefined, problem: "no fix" });
    const selection = selectWork([old, blocked, partly, stuck, newer]);
    expect(selection.units[0]!.work.map((f) => f.from)).toEqual(["33.5.0-jre", "33.7.1-jre"]);
    expect(selection.blocked).toEqual([
      { packages: ["npm|aaa"], reasons: ["aaa@1.0.0: identity break; aaa@2.0.0 has GHSA-repo (unreviewed): these advisories alone don't trigger an update"] },
      { packages: ["npm|aab"], reasons: ["aab@2.0.0: no fix"] },
    ]);
  });

  it("keeps majors apart and groups all copies of a major package", () => {
    const minor = fix({ name: "a", from: "1.0.0" });
    const major = fix({ name: "a", from: "2.0.0", to: { version: "3.0.0", line: "3", aged: true, major: true, blockers: [] } });
    const routine = fix({ name: "b", from: "1.0.0", ecosystem: "Maven" });
    const selected = selectWork([minor, major, routine]);
    expect(selected.units.map((unit) => [unit.kind, unit.topic, unit.work.map((entry) => entry.from)])).toEqual([
      ["routine", "security", ["1.0.0"]], ["major", "a-major", ["1.0.0", "2.0.0"]],
    ]);
  });

  it("takes no malware at all when one malicious version can't move", () => {
    const selection = selectWork([fix({ name: "evil", from: "1.0.1", malicious: true }), fix({ name: "worse", from: "1.0.0", malicious: true, to: undefined, problem: "no clean version" }), fix({ name: "x", from: "1.0.0" })]);
    expect(selection).toEqual({ units: [], blocked: [{ packages: ["npm|evil", "npm|worse"], reasons: ["worse@1.0.0: no clean version"] }] });
    const noted = selectWork([fix({ name: "evil", from: "1.0.1", malicious: true, notes: ["evil note"] }), fix({ name: "worse", from: "1.0.0", malicious: true, to: undefined, problem: "no clean version" }), fix({ name: "worse", from: "1.5.0", notes: ["clean copy note"] }), fix({ name: "x", from: "1.0.0", notes: ["unrelated"] })]);
    expect(noted.blocked[0]?.reasons).toEqual(["worse@1.0.0: no clean version", "evil@1.0.1: evil note", "worse@1.5.0: clean copy note"]);
  });

  it("reports the notes of a blocked package's other copies once, beside the blocked copy's reason", () => {
    const shared = "aab@3.0.0 has GHSA-repo (unreviewed): these advisories alone don't trigger an update";
    const stuck = fix({ name: "aab", from: "2.0.0", to: undefined, problem: "no fix", notes: [shared] });
    const first = fix({ name: "aab", from: "1.0.0", notes: [shared, "aab@4.0.0 has GHSA-other (unreviewed)"] });
    const second = fix({ name: "aab", from: "1.5.0", notes: ["aab@4.0.0 has GHSA-other (unreviewed)"] });
    expect(selectWork([stuck, first, second]).blocked).toEqual([{
      packages: ["npm|aab"],
      reasons: [`aab@2.0.0: no fix; ${shared}`, "aab@1.0.0: aab@4.0.0 has GHSA-other (unreviewed)"],
    }]);
  });
});

describe("planFor", () => {
  it("keeps on the move each candidate the gate ruled out only by advisories no reviewed source corroborates", async () => {
    const lock = { lockfileVersion: 3, packages: { "": { name: "app", dependencies: { lib: "^1.0.0" } }, "node_modules/lib": { version: "1.0.0" } } };
    const plan = await planFor(
      [fix({ name: "lib", from: "1.0.0", to: { version: "1.0.2", line: "1", aged: false, major: false, blockers: [] }, vetoed: [{ version: "1.0.1", advisories: ["CVE-1", "GHSA-b"] }], vetoesLeftOut: 4 })],
      { named: () => true, lockfiles: new Map([["package-lock.json", lock]]), gradle: undefined, tagCommit: NO_TAGS },
    );
    expect(plan.moves[0]?.vetoed).toEqual([{ version: "1.0.1", advisories: ["CVE-1", "GHSA-b"] }]);
    expect(plan.moves[0]?.vetoesLeftOut).toBe(4);
    expect(plan.notes).toBeUndefined();
  });

  it("chooses npm-direct for a declared dependency, npm-lock when every parent range allows the fix, else npm-override", async () => {
    const lock = {
      lockfileVersion: 3,
      packages: {
        "": { name: "app", dependencies: { vite: "^8.3.0", postcss: "^8.4.0" } },
        "node_modules/vite": { version: "8.3.1" },
        "node_modules/postcss": { version: "8.4.0", dependencies: { "source-map-js": "^1.2.0" } },
        "node_modules/source-map-js": { version: "1.2.1" },
        "node_modules/legacy": { version: "1.0.0", dependencies: { "brace-expansion": "~1.1.0" } },
        "node_modules/brace-expansion": { version: "1.1.0" },
      },
    };
    const lockfiles = new Map([["package-lock.json", lock]]);
    const plan = await planFor(
      [
        fix({ name: "vite", from: "8.3.1", to: { version: "8.3.3", line: "8", aged: false, major: false, blockers: [] } }),
        fix({ name: "source-map-js", from: "1.2.1", to: { version: "1.2.2", line: "1", aged: true, major: false, blockers: [] } }),
        fix({ name: "brace-expansion", from: "1.1.0", to: { version: "2.0.2", line: "2", aged: true, major: true, blockers: [] } }),
      ],
      { named: () => true, lockfiles, gradle: undefined, tagCommit: NO_TAGS },
    );
    expect(plan.moves.map((move) => [move.name, move.mechanism, move.to, move.major])).toEqual([
      ["vite", "npm-direct", "8.3.3", false],
      ["source-map-js", "npm-lock", "1.2.2", false],
      ["brace-expansion", "npm-override", "2.0.2", true],
    ]);
    expect(plan.topic).toBe("vite-major");
  });

  it("reads a nested lockfile's locations against that lockfile, and resolves copies the way Node does", async () => {
    const root = { packages: { "": { name: "app" } } };
    const nested = {
      packages: {
        "": { name: "clis", dependencies: { tool: "^1.0.0" } },
        "node_modules/tool": { version: "1.0.0", dependencies: { lib: "^2.0.0" } },
        "node_modules/tool/node_modules/lib": { version: "2.0.0" },
        "node_modules/lib": { version: "1.0.0" },
      },
    };
    const lockfiles = new Map<string, unknown>([
      ["package-lock.json", root],
      ["tools/clis/package-lock.json", nested],
    ]);
    const plan = await planFor([fix({ name: "lib", from: "2.0.0", locations: ["tools/clis/node_modules/tool/node_modules/lib"], to: { version: "2.1.0", line: "2", aged: true, major: false, blockers: [] } })], { named: undefined,
      lockfiles,
      gradle: undefined,
      tagCommit: NO_TAGS,
    });
    expect(plan.moves[0]?.mechanism).toBe("npm-lock");
  });

  it("chooses gradle-declared where the configuration declares the module, gradle-floor elsewhere, and pins actions to the tag's commit", async () => {
    const gradle = {
      tree: "worktree",
      builds: [
        {
          build: ".",
          configurations: [
            { id: ":runtimeClasspath", kind: "project", resolved: [], unresolved: [], declared: [{ group: "org.xerial.snappy", name: "snappy-java", version: "1.1.10.8", reason: undefined }], error: undefined },
            { id: ":checkstyle", kind: "project", resolved: [], unresolved: [], declared: [], error: undefined },
          ],
        },
      ],
    } as unknown as GradleInventory;
    const plan = await planFor(
      [
        fix({ ecosystem: "Maven", name: "org.xerial.snappy:snappy-java", from: "1.1.10.8", locations: [":runtimeClasspath", ":checkstyle"] }),
        fix({ ecosystem: "GitHub Actions", name: "actions/checkout", from: "v4.2.2", locations: [".github/workflows/ci.yml"], to: { version: "v4.2.3", line: "4", aged: true, major: false, blockers: [] } }),
      ],
      { named: () => true, lockfiles: new Map(), gradle, tagCommit: async (action, tag) => (action === "actions/checkout" && tag === "v4.2.3" ? "a".repeat(40) : undefined) },
    );
    expect(plan.moves.map((move) => [move.mechanism, move.locations, move.commitSha])).toEqual([
      ["gradle-declared", [":runtimeClasspath"], undefined],
      ["gradle-floor", [":checkstyle"], undefined],
      ["action-pin", [".github/workflows/ci.yml"], "a".repeat(40)],
    ]);
    await expect(planFor([fix({ ecosystem: "GitHub Actions", name: "x/y", from: "v1", locations: ["w.yml"] })], { named: () => true, lockfiles: new Map(), gradle, tagCommit: NO_TAGS })).rejects.toThrow("has no tag 9.9.9");
    // Declared, but no source names it (a plugin adds it): a floor, since there's no declaration to edit.
    const pluginAdded = await planFor([fix({ ecosystem: "Maven", name: "org.xerial.snappy:snappy-java", from: "1.1.10.8", locations: [":runtimeClasspath"] })], { named: () => false, lockfiles: new Map(), gradle, tagCommit: NO_TAGS });
    expect(pluginAdded.moves.map((move) => [move.mechanism, move.locations])).toEqual([["gradle-floor", [":runtimeClasspath"]]]);
    await expect(planFor([fix({ ecosystem: "Maven", name: "org.xerial.snappy:snappy-java", from: "1.1.10.8", locations: [":runtimeClasspath"] })], { named: undefined, lockfiles: new Map(), gradle, tagCommit: NO_TAGS })).rejects.toThrow("source index");
  });

  it("targets only the fixable advisories, and keeps an npm alias's key for the edit", async () => {
    const lockfiles = new Map([["package-lock.json", { packages: { "": { name: "app", dependencies: { compat: "npm:lib@^1.0.0" } }, "node_modules/compat": { name: "lib", version: "1.0.0" } } }]]);
    const plan = await planFor([fix({ name: "lib", from: "1.0.0", locations: ["node_modules/compat"], targets: ["GHSA-a", "GHSA-b"], unfixable: ["GHSA-b"], to: { version: "1.0.1", line: "1", aged: true, major: false, blockers: [] } })], { named: undefined,
      lockfiles,
      gradle: undefined,
      tagCommit: NO_TAGS,
    });
    expect(plan.moves).toEqual([expect.objectContaining({ mechanism: "npm-direct", declaredAs: "compat", advisories: ["GHSA-a"] })]);
  });

  describe("a carrier move", () => {
    const carried = { name: "brace", from: ["5.0.9"], locations: ["node_modules/carrier/node_modules/brace"], advisories: ["GHSA-brace"], to: ["5.0.12"] };
    const carrierFix = (to = "1.1.0") => fix({ name: "carrier", from: "1.0.0", targets: ["GHSA-own"], carries: [carried], to: { version: to, line: "1", aged: true, major: false, blockers: [] } });
    const lockfiles = (range: string, declared: boolean) => new Map([["package-lock.json", { packages: {
      "": { name: "app", dependencies: declared ? { carrier: range } : { parent: "^1.0.0" } },
      ...(declared ? {} : { "node_modules/parent": { version: "1.0.0", dependencies: { carrier: range } } }),
      "node_modules/carrier": { version: "1.0.0" },
      "node_modules/carrier/node_modules/brace": { version: "5.0.9", inBundle: true },
    } }]]);

    it("moves the carrier the way its position allows, its own advisories apart from those it carries", async () => {
      const plan = await planFor([carrierFix()], { named: undefined, lockfiles: lockfiles("^1.0.0", true), gradle: undefined, tagCommit: NO_TAGS });
      expect(plan.moves).toEqual([expect.objectContaining({ name: "carrier", mechanism: "npm-direct", to: "1.1.0", advisories: ["GHSA-own"], carries: [carried] })]);
    });

    it("is blocked rather than overridden when a dependent's range excludes it", () => {
      expect(withUnsupportedCarriers([carrierFix("2.0.0")], lockfiles("^1.0.0", false))[0]!.to!.blockers).toEqual([
        "carrier@2.0.0 would need an npm override at node_modules/carrier, which secure-it doesn't do for a carrier",
      ]);
      expect(withUnsupportedCarriers([carrierFix("1.1.0")], lockfiles("^1.0.0", false))[0]!.to!.blockers).toEqual([]);
    });
  });

  it("names a malware plan `malware` and lists every package", async () => {
    const lockfiles = new Map([["package-lock.json", { packages: { "": { name: "app", dependencies: { a: "^1", b: "^1" } }, "node_modules/a": { version: "1.0.1" }, "node_modules/b": { version: "1.0.1" } } }]]);
    const plan = await planFor([fix({ name: "a", from: "1.0.1", malicious: true }), fix({ name: "b", from: "1.0.1", malicious: true })], { named: undefined, lockfiles, gradle: undefined, tagCommit: NO_TAGS });
    expect(plan).toMatchObject({ topic: "malware", malware: true, packages: ["npm|a", "npm|b"] });
  });
});

describe("packages tied by a carried target", () => {
  const carried = { name: "brace", from: ["5.0.9"], locations: ["node_modules/carrier/node_modules/brace"], advisories: ["GHSA-brace"], to: ["5.0.12"] };
  const carrier = (major = false) => fix({ name: "carrier", from: "1.0.0", targets: [], carries: [carried], to: { version: "1.1.0", line: major ? "2" : "1", aged: true, major, blockers: [] } });
  const brace = (aged: boolean) => fix({ name: "brace", from: "5.0.9", targets: ["GHSA-brace"], to: { version: "5.0.12", line: "5", aged, major: false, blockers: [] } });

  it("go to the held unit together when one of them is young", async () => {
    const { units } = await coupledWork([carrier(), brace(false), fix({ name: "other", from: "1.0.0" })]);
    expect(units.map((unit) => [unit.topic, unit.work.map((entry) => entry.name).sort()])).toEqual([["security", ["other"]], ["security-cooldown-brace", ["brace", "carrier"]]]);
  });

  it("go to one major unit together when either needs a major", async () => {
    const { units } = await coupledWork([carrier(true), brace(true)]);
    expect(units.map((unit) => [unit.kind, unit.work.map((entry) => entry.name).sort()])).toEqual([["major", ["brace", "carrier"]]]);
  });

  it("aren't tied when nothing else fixes the carried package", async () => {
    expect((await coupledWork([carrier(), fix({ name: "other", from: "1.0.0" })])).units[0]?.coupled).toBeUndefined();
  });
});

describe("splitByAge", () => {
  const young = (name: string, major = false) => fix({ name, from: "1.0.0", to: { version: major ? "2.0.0" : "1.0.1", line: major ? "2" : "1", aged: false, major, blockers: [] } });

  it("moves young routine fixes and everything coupled to them into a held unit", async () => {
    const companion = { name: "peer", from: "1.0.0", to: "1.0.2", locations: ["node_modules/peer"], line: "1", aged: true, declarations: [] };
    const peers = { resolve: async () => ({ additions: [companion], blocked: [], sets: [["vite", "peer"]] }) };
    const selected = await coupledWork([young("vite"), fix({ name: "left-pad", from: "1.0.0" })], peers);
    expect(selected.units.map((unit) => [unit.topic, unit.held, names(unit.work), unit.coupled])).toEqual([
      ["security", false, ["left-pad"], []],
      ["security-cooldown-peer", true, ["vite", "peer"], [["npm|vite", "npm|peer"]]],
    ]);
  });

  it("keeps an all-aged batch whole, and holds a young major or malware unit whole", () => {
    const aged = { kind: "routine" as const, topic: "security", work: [fix({ name: "a", from: "1.0.0" })] };
    expect(splitByAge(aged)).toEqual([{ ...aged, held: false }]);
    const major = { kind: "major" as const, topic: "lib-major", work: [young("lib", true)] };
    expect(splitByAge(major)).toEqual([{ ...major, held: true }]);
    const malware = { kind: "malware" as const, topic: "malware", work: [young("bad"), fix({ name: "ok", from: "1.0.0", malicious: true })] };
    expect(splitByAge(malware)).toEqual([{ ...malware, held: true }]);
  });

  it("holds each young fix apart when nothing couples them, so none waits for another", () => {
    expect(splitByAge({ kind: "routine", topic: "security", work: [young("b"), young("a")] }).map((unit) => [unit.topic, names(unit.work)]))
      .toEqual([["security-cooldown-a", ["a"]], ["security-cooldown-b", ["b"]]]);
  });

  it("keeps transitively coupled young fixes in one held unit, named after its lowest package", () => {
    const units = splitByAge({ kind: "routine", topic: "security", work: [young("c"), young("a"), young("b"), young("d")], coupled: [["npm|c", "npm|b"], ["npm|b", "npm|a"]] });
    expect(units.map((unit) => [unit.topic, names(unit.work).sort(), unit.coupled])).toEqual([
      ["security-cooldown-a", ["a", "b", "c"], [["npm|c", "npm|b"], ["npm|b", "npm|a"]]],
      ["security-cooldown-d", ["d"], undefined],
    ]);
  });
});

describe("heldUnits", () => {
  const young = (name: string) => fix({ name, from: "1.0.0", to: { version: "1.0.1", line: "1", aged: false, major: false, blockers: [] } });

  it("joins fixes through a bridge key that has no fix of its own, and records only members", async () => {
    const units = heldUnits([young("a"), young("b"), young("x")], [], [["npm|a", "npm|c"], ["npm|b", "npm|c"]]);
    expect(units.map((unit) => [unit.topic, names(unit.work).sort()])).toEqual([["security-cooldown-a", ["a", "b"]], ["security-cooldown-x", ["x"]]]);
    const plan = await planFor(units[0]!.work, { lockfiles: new Map([["package-lock.json", { packages: { "node_modules/a": { version: "1.0.0" }, "node_modules/b": { version: "1.0.0" } } }]]), gradle: undefined, named: undefined, tagCommit: async () => undefined }, units[0]);
    expect(plan.members).toEqual(["npm|a", "npm|b"]);
    expect(isHeldTopic(plan.topic) && !isHeldTopic("security") && isHeldTopic("security-cooldown")).toBe(true);
  });

});
