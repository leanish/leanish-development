import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type { SecurityFix } from "@leanish/gate/candidates";
import { parseConfig } from "@leanish/gate/config";
import { NO_EXCEPTIONS } from "@leanish/gate/exceptions";
import type { GateEnvironment } from "@leanish/gate/gate";
import { runProcess, type RunProcess } from "@leanish/gate/process";
import { fakeFetch } from "@leanish/gate/test/fake-fetch";
import { withParents } from "../src/npm-parents.ts";
import { withParentsPlanned } from "../src/secure-it.ts";
import { coupledWork, planFor } from "../src/plan.ts";

const NOW = new Date("2026-10-10T12:00:00Z");
const OLD = "2026-01-01T00:00:00Z";
const YOUNG = "2026-10-09T00:00:00Z";
/** Aged, but after the versions a lockfile holds: a new publisher here has no history up to them. */
const LATER = "2026-06-01T00:00:00Z";

/** `name` → version → its publish time and its dependencies. */
type Registry = Record<string, Record<string, { readonly time: string; readonly dependencies?: Record<string, string>; readonly publisher?: string }>>;

function environment(registry: Registry, affected: Record<string, string[]> = {}): GateEnvironment {
  const run: RunProcess = async (command, args, options) => {
    if (command !== "osv-scanner") return runProcess(command, args, options);
    if (args[0] === "--version") return { code: 0, stdout: "osv-scanner version: 2.6.0\n", stderr: "" };
    const inventory = JSON.parse(await readFile(args[args.indexOf("--lockfile") + 1]!.replace(/^osv-scanner:/, ""), "utf8")) as {
      results: Array<{ packages: Array<{ package: { name: string; version: string; ecosystem: string } }> }>;
    };
    const packages = inventory.results[0]!.packages.map(({ package: pkg }) => ({
      package: pkg,
      vulnerabilities: (affected[`${pkg.name}@${pkg.version}`] ?? []).map((id) => ({ id, summary: id })),
    }));
    return { code: 1, stdout: JSON.stringify({ results: [{ packages }] }), stderr: "" };
  };
  const routes: Parameters<typeof fakeFetch>[0] = {};
  for (const [name, versions] of Object.entries(registry)) {
    routes[`https://registry.npmjs.org/${name}`] = { body: {
      time: Object.fromEntries(Object.entries(versions).map(([version, entry]) => [version, entry.time])),
      versions: Object.fromEntries(Object.entries(versions).map(([version, entry]) => [version, { _npmUser: { name: entry.publisher ?? "maintainer" }, dependencies: entry.dependencies ?? {}, dist: {} }])),
    } };
    for (const version of Object.keys(versions)) routes[`https://registry.npmjs.org/${name}/${version}`] = { body: {} };
  }
  return { run, fetch: fakeFetch(routes), now: () => NOW, osvScanner: "osv-scanner", githubToken: undefined };
}

/** The app declares `parent` (`^1.0.0`, from the registry, so its publisher is checked), which pins `brace` with `~1.1.0`. */
function lockfiles() {
  return new Map([["package-lock.json", { lockfileVersion: 3, packages: {
    "": { name: "app", dependencies: { parent: "^1.0.0" } },
    "node_modules/parent": { version: "1.0.0", resolved: "https://registry.npmjs.org/parent/-/parent-1.0.0.tgz", dependencies: { brace: "~1.1.0" } },
    "node_modules/brace": { version: "1.1.0" },
  } }]]);
}

const brace = (to = "1.2.4"): SecurityFix => ({
  ecosystem: "npm", name: "brace", from: "1.1.0", locations: ["node_modules/brace"], targets: ["GHSA-brace"], unfixable: [], malicious: false, severity: "HIGH",
  to: { version: to, line: "1", aged: true, major: false, blockers: [] }, problem: undefined,
});

async function parents(registry: Registry, options: { affected?: Record<string, string[]>; locks?: ReadonlyMap<string, unknown> } = {}) {
  const fixes = await withParents([brace()], { lockfiles: options.locks ?? lockfiles(), env: environment(registry, options.affected), config: parseConfig({}), exceptions: NO_EXCEPTIONS });
  return { fixes, notes: fixes.flatMap((fix) => fix.notes ?? []) };
}

const PARENT = {
  "1.0.0": { time: OLD, dependencies: { brace: "~1.1.0" } },
  "1.0.1": { time: OLD, dependencies: { brace: "~1.1.0" } },
  "1.2.0": { time: OLD, dependencies: { brace: "^1.2.4" } },
  "1.3.0": { time: OLD, dependencies: { brace: "^1.2.4" } },
  "2.0.0": { time: OLD, dependencies: { brace: "^2.0.0" } },
};

describe("moving a parent instead of overriding its range", () => {
  it("takes the parent's lowest aged version in its line that admits the target, and plans the copy as a lock", async () => {
    const result = await parents({ parent: PARENT });
    expect(result.notes).toEqual([]);
    expect(result.fixes[0]!.parents).toEqual([{ name: "parent", from: "1.0.0", to: "1.2.0", line: "1", location: "node_modules/parent", unblocks: "node_modules/brace" }]);
    const plan = await planFor(result.fixes, { named: undefined, lockfiles: lockfiles(), gradle: undefined, tagCommit: async () => undefined });
    expect(plan.moves.map((move) => [move.name, move.mechanism, move.to, move.advisories])).toEqual([
      ["brace", "npm-lock", "1.2.4", ["GHSA-brace"]],
      ["parent", "npm-direct", "1.2.0", []],
    ]);
    const { units } = await coupledWork(result.fixes);
    expect(units.map((unit) => [unit.work.map((fix) => fix.name).sort(), unit.coupled])).toEqual([[["brace", "parent"], [["npm|brace", "npm|parent"]]]]);
    expect(plan.packages).toEqual(["npm|brace", "npm|parent"]);
  });

  it.each<[string, Registry["x"], Record<string, string[]>, string]>([
    ["only a young version admits it", { ...PARENT, "1.2.0": { ...PARENT["1.2.0"]!, time: YOUNG }, "1.3.0": { ...PARENT["1.3.0"]!, time: YOUNG } }, {}, "no parent version in its line past the wait"],
    ["only another line admits it", { "1.0.0": PARENT["1.0.0"]!, "2.0.0": PARENT["2.0.0"]! }, {}, "no parent version in its line past the wait"],
    ["every admitting version brings an advisory of its own", PARENT, { "parent@1.2.0": ["GHSA-p"], "parent@1.3.0": ["GHSA-p"] }, "can move: 1.2.0, 1.3.0 bring new advisories"],
    ["every admitting version has another publisher", { ...PARENT, "1.2.0": { ...PARENT["1.2.0"]!, publisher: "stranger", time: LATER }, "1.3.0": { ...PARENT["1.3.0"]!, publisher: "stranger", time: LATER } }, {}, "can move: 1.2.0, 1.3.0 fail the identity check (parent@1.2.0 has no provenance and its publisher stranger"],
    ["admitting versions fail different checks", { ...PARENT, "1.3.0": { ...PARENT["1.3.0"]!, publisher: "stranger", time: LATER } }, { "parent@1.2.0": ["GHSA-p"] }, "can move: 1.2.0 brings new advisories; 1.3.0 fails the identity check"],
  ])("keeps the override when %s", async (_, versions, affected, note) => {
    const result = await parents({ parent: versions }, { affected });
    expect(result.fixes[0]!.parents).toBeUndefined();
    expect(result.notes).toEqual([expect.stringContaining(note)]);
    const plan = await planFor(result.fixes, { named: undefined, lockfiles: lockfiles(), gradle: undefined, tagCommit: async () => undefined });
    expect(plan.moves.map((move) => move.mechanism)).toEqual(["npm-override"]);
  });

  it("skips an admitting version with an advisory for the next one", async () => {
    const result = await parents({ parent: PARENT }, { affected: { "parent@1.2.0": ["GHSA-p"] } });
    expect(result.fixes[0]!.parents?.[0]?.to).toBe("1.3.0");
  });

  it("keeps the override for a bundled parent", async () => {
    const locks = new Map([["package-lock.json", { lockfileVersion: 3, packages: {
      "": { name: "app", dependencies: { carrier: "^1.0.0" } },
      "node_modules/carrier": { version: "1.0.0" },
      "node_modules/carrier/node_modules/parent": { version: "1.0.0", dependencies: { brace: "~1.1.0" }, inBundle: true },
      "node_modules/brace": { version: "1.1.0" },
    } }]]);
    const result = await parents({ parent: PARENT }, { locks });
    expect(result.notes).toEqual([expect.stringContaining("is bundled")]);
  });

  it("keeps the override when the parent's own dependents wouldn't admit it", async () => {
    const locks = new Map([["package-lock.json", { lockfileVersion: 3, packages: {
      "": { name: "app", dependencies: { holder: "^1.0.0" } },
      "node_modules/holder": { version: "1.0.0", dependencies: { parent: "~1.0.0" } },
      "node_modules/parent": { version: "1.0.0", dependencies: { brace: "~1.1.0" } },
      "node_modules/brace": { version: "1.1.0" },
    } }]]);
    const result = await parents({ parent: PARENT }, { locks });
    expect(result.notes).toEqual([expect.stringContaining("can move: 1.2.0, 1.3.0 would need an override themselves")]);
  });

  it("keeps the override, with the reason, when the registry can't be read", async () => {
    const result = await parents({});
    expect(result.notes).toEqual([expect.stringContaining("searching parent failed")]);
  });
});

describe("npm parents, regressions", () => {
  const fixOf = (name: string, from: string, to: string, location = `node_modules/${name}`): SecurityFix => ({
    ecosystem: "npm", name, from, locations: [location], targets: [`GHSA-${name}`], unfixable: [], malicious: false, severity: "HIGH",
    to: { version: to, line: to.split(".")[0]!, aged: true, major: false, blockers: [] }, problem: undefined,
  });
  const twoChildren = () => new Map([["package-lock.json", { lockfileVersion: 3, packages: {
    "": { name: "app", dependencies: { parent: "^1.0.0" } },
    "node_modules/parent": { version: "1.0.0", dependencies: { x: "~1.0.0", y: "~1.0.0" } },
    "node_modules/x": { version: "1.0.0" },
    "node_modules/y": { version: "1.0.0" },
  } }]]);
  const run = (fixes: SecurityFix[], registry: Registry, locks: ReadonlyMap<string, unknown>) =>
    withParents(fixes, { lockfiles: locks, env: environment(registry), config: parseConfig({}), exceptions: NO_EXCEPTIONS });

  it("gives one parent occurrence one version admitting every copy it must", async () => {
    const registry: Registry = { parent: {
      "1.0.0": { time: OLD, dependencies: { x: "~1.0.0", y: "~1.0.0" } },
      "1.1.0": { time: OLD, dependencies: { x: "^1.1.0", y: "~1.0.0" } },
      "1.2.0": { time: OLD, dependencies: { x: "^1.1.0", y: "^1.1.0" } },
    } };
    const fixes = await run([fixOf("x", "1.0.0", "1.1.0"), fixOf("y", "1.0.0", "1.1.0")], registry, twoChildren());
    expect(fixes.filter((fix) => fix.parents !== undefined).map((fix) => fix.parents!.map((parent) => parent.to))).toEqual([["1.2.0"], ["1.2.0"]]);
    const plan = await planFor(fixes, { named: undefined, lockfiles: twoChildren(), gradle: undefined, tagCommit: async () => undefined });
    expect(plan.moves.filter((move) => move.name === "parent")).toEqual([expect.objectContaining({ to: "1.2.0", locations: ["node_modules/parent"] })]);
  });

  it("parents only through the version the parent's own fix takes", async () => {
    const registry: Registry = { parent: {
      "1.0.0": { time: OLD, dependencies: { x: "~1.0.0", y: "~1.0.0" } },
      "1.1.0": { time: OLD, dependencies: { x: "^1.1.0", y: "~1.0.0" } },
      "1.2.0": { time: OLD, dependencies: { x: "^1.1.0", y: "~1.0.0" } },
    } };
    const fixes = await run([fixOf("x", "1.0.0", "1.1.0"), fixOf("parent", "1.0.0", "1.2.0")], registry, twoChildren());
    expect(fixes[0]!.parents?.map((parent) => parent.to)).toEqual(["1.2.0"]);
  });

  it("reads the range of the edge that installs the copy, not a peer's", async () => {
    const locks = new Map([["package-lock.json", { lockfileVersion: 3, packages: {
      "": { name: "app", dependencies: { parent: "^1.0.0" } },
      "node_modules/parent": { version: "1.0.0", dependencies: { x: "~1.0.0" } },
      "node_modules/parent/node_modules/x": { version: "1.0.0" },
    } }]]);
    const registry: Registry = { parent: {
      "1.0.0": { time: OLD, dependencies: { x: "~1.0.0" } },
      "1.1.0": { time: OLD, dependencies: { x: "~1.0.0" } },
      "1.2.0": { time: OLD, dependencies: { x: "^1.1.0" } },
    } };
    // 1.1.0 also asks for x as a peer admitting the fix, but its own nested copy stays ~1.0.0.
    const environmentWithPeer = environment(registry);
    const fetch = environmentWithPeer.fetch;
    const withPeer: typeof environmentWithPeer = { ...environmentWithPeer, fetch: async (url, init) => {
      const response = await fetch(url, init);
      if (url !== "https://registry.npmjs.org/parent") return response;
      const body = await response.json() as { versions: Record<string, Record<string, unknown>> };
      body.versions["1.1.0"]!["peerDependencies"] = { x: "^1.1.0" };
      return { ...response, json: async () => body, text: async () => JSON.stringify(body) };
    } };
    const fixes = await withParents([fixOf("x", "1.0.0", "1.1.0", "node_modules/parent/node_modules/x")], { lockfiles: locks, env: withPeer, config: parseConfig({}), exceptions: NO_EXCEPTIONS });
    expect(fixes[0]!.parents?.map((parent) => parent.to)).toEqual(["1.2.0"]);
  });

  it("moves a transitive parent too, locked inside its own parent's range", async () => {
    const locks = new Map([["package-lock.json", { lockfileVersion: 3, packages: {
      "": { name: "app", dependencies: { holder: "^1.0.0" } },
      "node_modules/holder": { version: "1.0.0", dependencies: { parent: "^1.0.0" } },
      "node_modules/parent": { version: "1.0.0", dependencies: { x: "~1.0.0" } },
      "node_modules/x": { version: "1.0.0" },
    } }]]);
    const registry: Registry = { parent: { "1.0.0": { time: OLD, dependencies: { x: "~1.0.0" } }, "1.1.0": { time: OLD, dependencies: { x: "^1.1.0" } } } };
    const fixes = await run([fixOf("x", "1.0.0", "1.1.0")], registry, locks);
    const plan = await planFor(fixes, { named: undefined, lockfiles: locks, gradle: undefined, tagCommit: async () => undefined });
    expect(plan.moves.map((move) => [move.name, move.mechanism, move.to])).toEqual([["x", "npm-lock", "1.1.0"], ["parent", "npm-lock", "1.1.0"]]);
  });
});

describe("npm parents, second round", () => {
  const fixOf = (name: string, from: string, to: string, aged = true): SecurityFix => ({
    ecosystem: "npm", name, from, locations: [`node_modules/${name}`], targets: [`GHSA-${name}`], unfixable: [], malicious: false, severity: "HIGH",
    to: { version: to, line: to.split(".")[0]!, aged, major: false, blockers: [] }, problem: undefined,
  });
  const locks = (ranges: Record<string, string>) => new Map([["package-lock.json", { lockfileVersion: 3, packages: {
    "": { name: "app", dependencies: { parent: "^1.0.0", q: "^1.0.0" } },
    "node_modules/parent": { version: "1.0.0", dependencies: ranges },
    "node_modules/x": { version: "1.0.0" },
    "node_modules/y": { version: "1.0.0" },
    "node_modules/q": { version: "1.0.0" },
  } }]]);
  const run = (fixes: SecurityFix[], registry: Registry, lockfiles: ReadonlyMap<string, unknown>) =>
    withParents(fixes, { lockfiles, env: environment(registry), config: parseConfig({}), exceptions: NO_EXCEPTIONS });

  it("keeps admitting the copies the parent's range already admits", async () => {
    const registry: Registry = { parent: {
      "1.0.0": { time: OLD, dependencies: { x: "^1.0.0", y: "~1.0.0" } },
      "1.1.0": { time: OLD, dependencies: { x: "~1.0.0", y: "^1.1.0" } },
      "1.2.0": { time: OLD, dependencies: { x: "^1.1.0", y: "^1.1.0" } },
    } };
    const fixes = await run([fixOf("x", "1.0.0", "1.1.0"), fixOf("y", "1.0.0", "1.1.0")], registry, locks({ x: "^1.0.0", y: "~1.0.0" }));
    expect(fixes.find((fix) => fix.name === "y")?.parents?.map((parent) => parent.to)).toEqual(["1.2.0"]);
  });

  it("ties a copy to its parent's own young fix, in one held unit", async () => {
    const registry: Registry = { parent: {
      "1.0.0": { time: OLD, dependencies: { x: "~1.0.0" } },
      "1.1.0": { time: YOUNG, dependencies: { x: "^1.1.0" } },
    } };
    const fixes = await run([fixOf("x", "1.0.0", "1.1.0"), fixOf("parent", "1.0.0", "1.1.0", false)], registry, locks({ x: "~1.0.0" }));
    const { units } = await coupledWork(fixes);
    expect(units.map((unit) => [unit.topic, unit.work.map((fix) => fix.name).sort()])).toEqual([["security-cooldown-parent", ["parent", "x"]]]);
  });

  it("anchors the direct-peer closure on a chosen parent", async () => {
    const registry: Registry = { parent: { "1.0.0": { time: OLD, dependencies: { x: "~1.0.0" } }, "1.1.0": { time: OLD, dependencies: { x: "^1.1.0" } } } };
    const fixes = await run([fixOf("x", "1.0.0", "1.1.0")], registry, locks({ x: "~1.0.0" }));
    const anchors: string[] = [];
    await coupledWork(fixes, { resolve: async (moves) => {
      anchors.push(...moves.map((move) => `${move.name}@${move.to}`));
      return { additions: [], blocked: [], sets: [] };
    } });
    expect(anchors.sort()).toEqual(["parent@1.1.0", "x@1.1.0"]);
  });
});

describe("npm parents, third round", () => {
  const fixAt = (location: string, from: string, to: string): SecurityFix => ({
    ecosystem: "npm", name: "x", from, locations: [location], targets: ["GHSA-x"], unfixable: [], malicious: false, severity: "HIGH",
    to: { version: to, line: to.split(".")[0]!, aged: true, major: false, blockers: [] }, problem: undefined,
  });
  const lock = (parent: string, x: string, range: string) => ({ lockfileVersion: 3, packages: {
    "": { name: "app", dependencies: { parent: `^${parent}` } },
    "node_modules/parent": { version: parent, dependencies: { x: range } },
    "node_modules/x": { version: x },
  } });
  const registry: Registry = { parent: {
    "1.0.0": { time: OLD, dependencies: { x: "~1.0.0" } }, "1.1.0": { time: OLD, dependencies: { x: "^1.1.0" } },
    "2.0.0": { time: OLD, dependencies: { x: "~1.0.0" } }, "2.1.0": { time: OLD, dependencies: { x: "^1.1.0" } },
  } };

  it("keeps each occurrence's own transition when lockfiles hold different versions of the parent", async () => {
    const lockfiles = new Map<string, unknown>([["package-lock.json", lock("1.0.0", "1.0.0", "~1.0.0")], ["sub/package-lock.json", lock("2.0.0", "1.0.0", "~1.0.0")]]);
    const fixes = await withParents([fixAt("node_modules/x", "1.0.0", "1.1.0"), fixAt("sub/node_modules/x", "1.0.0", "1.1.0")],
      { lockfiles, env: environment(registry), config: parseConfig({}), exceptions: NO_EXCEPTIONS });
    expect(fixes.filter((fix) => fix.name === "parent").map((fix) => [fix.from, fix.to?.version, fix.locations])).toEqual([
      ["1.0.0", "1.1.0", ["node_modules/parent"]],
      ["2.0.0", "2.1.0", ["sub/node_modules/parent"]],
    ]);
  });

  it("rebuilds the direct-peer closure with the parents it adds", async () => {
    const files: Record<string, string> = { "package-lock.json": JSON.stringify(lock("1.0.0", "1.0.0", "~1.0.0")) };
    const tree = { id: "base", read: async (path: string) => files[path], list: async () => [] };
    const asked: string[][] = [];
    const found = {
      fixes: [fixAt("node_modules/x", "1.0.0", "1.1.0")], incomplete: [], gaps: [], osvScannerVersion: "2.6.0",
      npmPeers: { resolve: async () => ({ additions: [], blocked: [], sets: [] }) },
      peersWith: async (extra: ReadonlyArray<{ name: string; version: string }>) => {
        asked.push(extra.map((pkg) => `${pkg.name}@${pkg.version}`));
        return { resolve: async () => ({ additions: [], blocked: [], sets: [] }) };
      },
    };
    const planned = await withParentsPlanned(found, { tree, gradle: undefined }, environment(registry), { ofCommit: async () => undefined, ofWorkingTree: async () => undefined });
    expect(asked).toEqual([["parent@1.1.0"]]);
    expect(planned.fixes.map((fix) => fix.name).sort()).toEqual(["parent", "x"]);
  });
});

describe("npm parents admitting some of the copies they must", () => {
  const fixOf = (name: string, from: string, to: string): SecurityFix => ({
    ecosystem: "npm", name, from, locations: [`node_modules/${name}`], targets: [`GHSA-${name}`], unfixable: [], malicious: false, severity: "HIGH",
    to: { version: to, line: to.split(".")[0]!, aged: true, major: false, blockers: [] }, problem: undefined,
  });
  /** The app declares `parent` (and `other`, when given its range for x), which bring x, y and z, each at 1.0.0. */
  const locks = (other?: string) => new Map([["package-lock.json", { lockfileVersion: 3, packages: {
    "": { name: "app", dependencies: { parent: "^1.0.0", ...(other === undefined ? {} : { other: "^1.0.0" }) } },
    "node_modules/parent": { version: "1.0.0", dependencies: { x: "~1.0.0", y: "~1.0.0", z: "~1.0.0" } },
    ...(other === undefined ? {} : { "node_modules/other": { version: "1.0.0", dependencies: { x: other } } }),
    "node_modules/x": { version: "1.0.0" },
    "node_modules/y": { version: "1.0.0" },
    "node_modules/z": { version: "1.0.0" },
  } }]]);
  const parentVersions = (versions: Record<string, Record<string, string>>): Registry["x"] => Object.fromEntries(Object.entries(versions).map(([version, dependencies]) => [version, { time: OLD, dependencies }]));
  const BASE = { "1.0.0": { x: "~1.0.0", y: "~1.0.0", z: "~1.0.0" } };
  const run = async (fixes: SecurityFix[], registry: Registry, options: { affected?: Record<string, string[]>; other?: string } = {}) => {
    const lockfiles = locks(options.other);
    const result = await withParents(fixes, { lockfiles, env: environment(registry, options.affected), config: parseConfig({}), exceptions: NO_EXCEPTIONS });
    const plan = await planFor(result, { named: undefined, lockfiles, gradle: undefined, tagCommit: async () => undefined });
    return {
      result,
      notes: result.flatMap((fix) => fix.notes ?? []),
      moves: plan.moves.map((move) => `${move.name} ${move.to} ${move.mechanism}`).sort(),
    };
  };

  it("moves the parent for the copies it can admit and keeps the others' overrides", async () => {
    const { notes, moves } = await run([fixOf("x", "1.0.0", "1.1.0"), fixOf("y", "1.0.0", "1.1.0")], { parent: parentVersions({ ...BASE, "1.1.0": { x: "^1.1.0", y: "~1.0.0", z: "~1.0.0" } }) });
    expect(moves).toEqual(["parent 1.1.0 npm-direct", "x 1.1.0 npm-lock", "y 1.1.0 npm-override"]);
    expect(notes).toEqual(["y@1.1.0 at node_modules/y keeps an override: no parent version in its line past the wait admits it, keeping what its range admits today"]);
  });

  it("takes the lowest of the versions admitting as many", async () => {
    const { moves } = await run([fixOf("x", "1.0.0", "1.1.0"), fixOf("y", "1.0.0", "1.1.0")], { parent: parentVersions({
      ...BASE, "1.1.0": { x: "^1.1.0", y: "~1.0.0", z: "~1.0.0" }, "1.2.0": { x: "~1.0.0", y: "^1.1.0", z: "~1.0.0" },
    }) });
    expect(moves).toEqual(["parent 1.1.0 npm-direct", "x 1.1.0 npm-lock", "y 1.1.0 npm-override"]);
  });

  it("falls back to a version admitting fewer when the one admitting the most fails a check", async () => {
    const { moves } = await run([fixOf("x", "1.0.0", "1.1.0"), fixOf("y", "1.0.0", "1.1.0")], { parent: parentVersions({
      ...BASE, "1.1.0": { x: "^1.1.0", y: "~1.0.0", z: "~1.0.0" }, "1.2.0": { x: "^1.1.0", y: "^1.1.0", z: "~1.0.0" },
    }) }, { affected: { "parent@1.2.0": ["GHSA-p"] } });
    expect(moves).toEqual(["parent 1.1.0 npm-direct", "x 1.1.0 npm-lock", "y 1.1.0 npm-override"]);
  });

  it("never takes a version that drops a copy its range admits today", async () => {
    // z's fix 1.0.5 is inside parent 1.0.0's ~1.0.0; 1.2.0 would admit x and y but not z any more.
    const { moves } = await run([fixOf("x", "1.0.0", "1.1.0"), fixOf("y", "1.0.0", "1.1.0"), fixOf("z", "1.0.0", "1.0.5")], { parent: parentVersions({
      ...BASE, "1.1.0": { x: "^1.1.0", y: "~1.0.0", z: "~1.0.0" }, "1.2.0": { x: "^1.1.0", y: "^1.1.0", z: "~0.9.0" },
    }) });
    expect(moves).toEqual(["parent 1.1.0 npm-direct", "x 1.1.0 npm-lock", "y 1.1.0 npm-override", "z 1.0.5 npm-lock"]);
  });

  it("searches again without a copy another parent can't admit", async () => {
    // 1.2.0 admits the most (x and y), but `other` can't admit x, so x keeps its override; for y alone 1.1.0 is lowest.
    const { notes, moves } = await run([fixOf("x", "1.0.0", "1.1.0"), fixOf("y", "1.0.0", "1.1.0")], {
      parent: parentVersions({ ...BASE, "1.1.0": { x: "~1.0.0", y: "^1.1.0", z: "~1.0.0" }, "1.2.0": { x: "^1.1.0", y: "^1.1.0", z: "~1.0.0" } }),
      other: parentVersions({ "1.0.0": { x: "~1.0.0" } }),
    }, { other: "~1.0.0" });
    expect(moves).toEqual(["parent 1.1.0 npm-direct", "x 1.1.0 npm-override", "y 1.1.0 npm-lock"]);
    expect(notes).toEqual([expect.stringMatching(/^x@1\.1\.0 at node_modules\/x keeps an override: no other version in its line past the wait/)]);
  });

  it("takes back a copy a provisional choice ranked out, once the copies it was ranked out for are lost", async () => {
    // 1.2.0 admits the most (x and z) but `other` can't admit x; for y and z, 1.1.0 and 1.2.0 tie, so 1.1.0 admits y.
    const { notes, moves } = await run([fixOf("x", "1.0.0", "1.1.0"), fixOf("y", "1.0.0", "1.1.0"), fixOf("z", "1.0.0", "1.1.0")], {
      parent: parentVersions({ ...BASE, "1.1.0": { x: "~1.0.0", y: "^1.1.0", z: "~1.0.0" }, "1.2.0": { x: "^1.1.0", y: "~1.0.0", z: "^1.1.0" } }),
      other: parentVersions({ "1.0.0": { x: "~1.0.0" } }),
    }, { other: "~1.0.0" });
    expect(moves).toEqual(["parent 1.1.0 npm-direct", "x 1.1.0 npm-override", "y 1.1.0 npm-lock", "z 1.1.0 npm-override"]);
    expect(notes).toEqual([
      expect.stringMatching(/^x@1\.1\.0 at node_modules\/x keeps an override: no other version in its line past the wait/),
      "z@1.1.0 at node_modules/z keeps an override: parent moves to 1.1.0, the version admitting the most of the copies it must, which doesn't admit it",
    ]);
  });

  it("moves no parent when every copy it could admit keeps an override anyway", async () => {
    const { result, moves } = await run([fixOf("x", "1.0.0", "1.1.0")], {
      parent: parentVersions({ ...BASE, "1.1.0": { x: "^1.1.0", y: "~1.0.0", z: "~1.0.0" } }),
      other: parentVersions({ "1.0.0": { x: "~1.0.0" } }),
    }, { other: "~1.0.0" });
    expect(moves).toEqual(["x 1.1.0 npm-override"]);
    expect(result.some((fix) => fix.name === "parent" || fix.parents !== undefined)).toBe(false);
  });

  it("locks a copy only when every parent it needs moves in the same work", async () => {
    const lockfiles = locks("~1.0.0");
    const result = await withParents([fixOf("x", "1.0.0", "1.1.0")], { lockfiles, env: environment({
      parent: parentVersions({ ...BASE, "1.1.0": { x: "^1.1.0", y: "~1.0.0", z: "~1.0.0" } }),
      other: parentVersions({ "1.0.0": { x: "~1.0.0" }, "1.1.0": { x: "^1.1.0" } }),
    }), config: parseConfig({}), exceptions: NO_EXCEPTIONS });
    expect(result.find((fix) => fix.name === "x")!.parents?.map((parent) => parent.name).sort()).toEqual(["other", "parent"]);
    const withoutOther = result.filter((fix) => fix.name !== "other");
    const plan = await planFor(withoutOther, { named: undefined, lockfiles, gradle: undefined, tagCommit: async () => undefined });
    expect(plan.moves.find((move) => move.name === "x")!.mechanism).toBe("npm-override");
  });
});

describe("npm parents, what they must keep admitting", () => {
  const fixAt = (name: string, from: string, to: string, location: string): SecurityFix => ({
    ecosystem: "npm", name, from, locations: [location], targets: [`GHSA-${name}`], unfixable: [], malicious: false, severity: "HIGH",
    to: { version: to, line: to.split(".")[0]!, aged: true, major: false, blockers: [] }, problem: undefined,
  });
  const run = (fixes: SecurityFix[], registry: Registry, lockfiles: ReadonlyMap<string, unknown>) =>
    withParents(fixes, { lockfiles, env: environment(registry), config: parseConfig({}), exceptions: NO_EXCEPTIONS });

  it("reads what the parent admits today through its effective edges, an optional one included", async () => {
    // The optional ^1.0.0 is the edge npm uses for x: x's fix is admitted today, and 1.1.0 would drop it.
    const lockfiles = new Map([["package-lock.json", { lockfileVersion: 3, packages: {
      "": { name: "app", dependencies: { parent: "^1.0.0" } },
      "node_modules/parent": { version: "1.0.0", dependencies: { x: "~1.0.0", y: "~1.0.0" }, optionalDependencies: { x: "^1.0.0" } },
      "node_modules/x": { version: "1.0.0" },
      "node_modules/y": { version: "1.0.0" },
    } }]]);
    const fixes = await run([fixAt("x", "1.0.0", "1.1.0", "node_modules/x"), fixAt("y", "1.0.0", "1.1.0", "node_modules/y")], { parent: {
      "1.0.0": { time: OLD, dependencies: { x: "~1.0.0", y: "~1.0.0" } },
      "1.1.0": { time: OLD, dependencies: { x: "~1.0.0", y: "^1.1.0" } },
    } }, lockfiles);
    expect(fixes.some((fix) => fix.parents !== undefined || fix.name === "parent")).toBe(false);
    expect(fixes.find((fix) => fix.name === "y")!.notes).toEqual([
      "y@1.1.0 at node_modules/y keeps an override: every parent version in its line past the wait admitting y@1.1.0 drops x@1.1.0, which its range admits today",
    ]);
  });

  it("explains nothing about a copy its parent admits already, while moving it for another", async () => {
    const lockfiles = new Map([["package-lock.json", { lockfileVersion: 3, packages: {
      "": { name: "app", dependencies: { parent: "^1.0.0" } },
      "node_modules/parent": { version: "1.0.0", dependencies: { x: "~1.0.0", y: "~1.0.0" }, optionalDependencies: { x: "^1.0.0" } },
      "node_modules/x": { version: "1.0.0" },
      "node_modules/y": { version: "1.0.0" },
    } }]]);
    const fixes = await run([fixAt("x", "1.0.0", "1.1.0", "node_modules/x"), fixAt("y", "1.0.0", "1.1.0", "node_modules/y")], { parent: {
      "1.0.0": { time: OLD, dependencies: { x: "~1.0.0", y: "~1.0.0" } },
      "1.1.0": { time: OLD, dependencies: { x: "^1.1.0", y: "^1.1.0" } },
    } }, lockfiles);
    const x = fixes.find((fix) => fix.name === "x")!;
    expect([x.notes, x.parents]).toEqual([undefined, undefined]);
    expect(fixes.find((fix) => fix.name === "y")!.parents?.map((parent) => parent.to)).toEqual(["1.1.0"]);
  });

  it("keeps a parent transition in another lockfile beside the parent's own fix", async () => {
    // A one-letter directory on purpose: "b" must still rank deeper than the root's ".".
    const lockfiles = new Map<string, unknown>([
      ["package-lock.json", { lockfileVersion: 3, packages: {
        "": { name: "app", dependencies: { parent: "^1.0.0" } },
        "node_modules/parent": { version: "1.0.0", dependencies: {} },
      } }],
      ["b/package-lock.json", { lockfileVersion: 3, packages: {
        "": { name: "b", dependencies: { parent: "^2.0.0" } },
        "node_modules/parent": { version: "2.0.0", dependencies: { x: "~1.0.0" } },
        "node_modules/x": { version: "1.0.0" },
      } }],
    ]);
    const fixes = await run([fixAt("parent", "1.0.0", "1.1.0", "node_modules/parent"), fixAt("x", "1.0.0", "1.1.0", "b/node_modules/x")], { parent: {
      "1.0.0": { time: OLD, dependencies: {} },
      "1.1.0": { time: OLD, dependencies: {} },
      "2.0.0": { time: OLD, dependencies: { x: "~1.0.0" } },
      "2.1.0": { time: OLD, dependencies: { x: "^1.1.0" } },
    } }, lockfiles);
    expect(fixes.filter((fix) => fix.name === "parent").map((fix) => [fix.to!.version, fix.locations])).toEqual([
      ["1.1.0", ["node_modules/parent"]],
      ["2.1.0", ["b/node_modules/parent"]],
    ]);
    expect(fixes.find((fix) => fix.name === "x")!.parents?.map((parent) => parent.to)).toEqual(["2.1.0"]);
  });
});

it("skips ignored npm parents when lifting a dependency's range", async () => {
  const fixes = await withParents([brace()], { lockfiles: lockfiles(), env: environment({ parent: PARENT }), exceptions: NO_EXCEPTIONS,
    config: parseConfig({ ignoredVersions: [{ package: "npm:parent", versions: ["1.2.0"], reason: "broken" }] }) });
  expect(fixes.find((fix) => fix.name === "parent")?.to?.version).toBe("1.3.0");
});
