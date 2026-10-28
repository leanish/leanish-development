import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { SECTION_LIMIT } from "@leanish/tool-runtime/plan-blocks";

import { cell, changeRows } from "../src/change-rows.ts";
import { changesBetween, type CopyChange } from "../src/npm-compute.ts";
import { NpmGraph } from "../src/npm-graph.ts";
import { planDigest, planFor, planOf, planSection } from "../src/plan.ts";
import { provenRehoists, rehoistKey } from "../src/rehoists.ts";
import { routineUnit } from "../src/units.ts";

const lockfile = "package-lock.json";
const HEADER = "| Package | From | To | Locations |\n|---|---|---|---|";
const npm = { files: new Map([[lockfile, "lock bytes"]]), changes: [], notes: [] };

type Packages = Record<string, object>;
const graph = (packages: Packages) => new NpmGraph({ packages: { "": { name: "root" }, ...packages } });
const change = (path: string, name: string, from: string | undefined, to: string | undefined): CopyChange => ({ lockfile, path, name, from, to });

/** What bump-it computes from two lockfiles, and the table rows a PR body would show for them. */
function shown(base: Packages, head: Packages): { rehoisted: ReadonlyArray<string>; rows: string[] } {
  const [before, after] = [graph(base), graph(head)];
  const changes = changesBetween(lockfile, before, after);
  const rehoisted = provenRehoists(lockfile, before, after);
  return { rehoisted, rows: changeRows(changes, true, new Set(rehoisted)) };
}
const moved = (rows: ReadonlyArray<string>) => rows.filter((line) => line.includes("| moved |"));

async function tableOf(changes: ReadonlyArray<CopyChange>, rehoisted: ReadonlyArray<string>, changeCount = changes.length) {
  const plan = await planFor(routineUnit([]), { ...npm, changes, rehoisted }, async () => undefined);
  return planSection({ ...plan, changeCount }).split("\n\n")[1]!;
}

describe("npm re-hoists in the moves table", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/rehoisted-lockfiles.json", import.meta.url), "utf8"));

  it("shows the lockfile change of leanish-development#305 as moves, with the extra copy apart", async () => {
    const base = new NpmGraph(fixture.before);
    const head = new NpmGraph(fixture.after);
    const changes = changesBetween(lockfile, base, head);
    const rehoisted = provenRehoists(lockfile, base, head);
    expect(changes).toHaveLength(6);
    expect(rehoisted).toEqual([rehoistKey(lockfile, "ajv"), rehoistKey(lockfile, "json-schema-traverse")]);
    expect(await tableOf(changes, rehoisted)).toBe([
      HEADER,
      "| `ajv` | `6.15.0` | moved | `package-lock.json`: `node_modules/eslint/node_modules/ajv` → `node_modules/ajv` |",
      "| `ajv` | `8.20.0` | moved | `package-lock.json`: `node_modules/ajv` → `core/agent-runtime/node_modules/ajv`, `core/gate/node_modules/ajv` |",
      "| `ajv` | new | `8.20.0` | 1 copy more than before |",
      "| `json-schema-traverse` | `0.4.1` | moved | `package-lock.json`: `node_modules/eslint/node_modules/json-schema-traverse` → `node_modules/ajv/node_modules/json-schema-traverse` |",
    ].join("\n"));
  });

  it("keeps a plain upgrade as a from-to row", async () => {
    const upgrade = change("node_modules/postcss", "postcss", "8.5.30", "8.5.31");
    expect(await tableOf([upgrade], [])).toBe(`${HEADER}\n| \`postcss\` | \`8.5.30\` | \`8.5.31\` | \`package-lock.json:node_modules/postcss\` |`);
    const result = shown({ "node_modules/postcss": { version: "8.5.30" } }, { "node_modules/postcss": { version: "8.5.31" } });
    expect(result.rehoisted).toEqual([]);
  });

  it("moves one package and upgrades another in the same table, in path order", () => {
    const root = { "": { name: "root", dependencies: { a: "1", lib: "^1" } }, "node_modules/a": { version: "1.0.0", dependencies: { dep: "^1" } } };
    const result = shown(
      { ...root, "node_modules/a/node_modules/dep": { version: "1.0.0" }, "node_modules/lib": { version: "1.0.0" } },
      { ...root, "node_modules/dep": { version: "1.0.0" }, "node_modules/lib": { version: "1.1.0" } },
    );
    expect(result.rehoisted).toEqual([rehoistKey(lockfile, "dep")]);
    expect(result.rows).toEqual([
      "| `dep` | `1.0.0` | moved | `package-lock.json`: `node_modules/a/node_modules/dep` → `node_modules/dep` |",
      "| `lib` | `1.0.0` | `1.1.0` | `package-lock.json:node_modules/lib` |",
    ]);
  });

  it("notes the copies a version has fewer after a move", () => {
    const rows = changeRows([
      change("node_modules/a/node_modules/dep", "dep", "1.0.0", undefined),
      change("node_modules/b/node_modules/dep", "dep", "1.0.0", undefined),
      change("node_modules/dep", "dep", undefined, "1.0.0"),
    ], true, new Set([rehoistKey(lockfile, "dep")]));
    expect(rows).toEqual([
      "| `dep` | `1.0.0` | moved | `package-lock.json`: `node_modules/a/node_modules/dep`, `node_modules/b/node_modules/dep` → `node_modules/dep` |",
      "| `dep` | `1.0.0` | removed | 1 copy fewer than before |",
    ]);
  });

  describe("a real version change for a consumer keeps per-path rows", () => {
    const depends = (name: string, dep: string) => ({ [name]: { version: "1.0.0", dependencies: { dep } } });
    it.each([
      ["a copy replaced by another version while a third copy appears (scenario A)",
        { "": { name: "root", dependencies: { dep: "*", p: "1", q: "1" } }, ...depends("node_modules/p", "2.0.0"), ...depends("node_modules/q", "1.0.0"),
          "node_modules/dep": { version: "1.0.0" }, "node_modules/p/node_modules/dep": { version: "2.0.0" } },
        { "": { name: "root", dependencies: { dep: "*", p: "1", q: "1" } }, ...depends("node_modules/p", "2.0.0"), ...depends("node_modules/q", "1.0.0"),
          "node_modules/dep": { version: "2.0.0" }, "node_modules/q/node_modules/dep": { version: "1.0.0" } }],
      ["two copies swapping versions (scenario B)",
        { "": { name: "root", dependencies: { dep: "*", b: "1" } }, ...depends("node_modules/b", "*"), "node_modules/dep": { version: "1.0.0" }, "node_modules/b/node_modules/dep": { version: "1.1.0" } },
        { "": { name: "root", dependencies: { dep: "*", b: "1" } }, ...depends("node_modules/b", "*"), "node_modules/dep": { version: "1.1.0" }, "node_modules/b/node_modules/dep": { version: "1.0.0" } }],
      ["an installed dependent resolving another version after",
        { "": { name: "root", dependencies: { b: "1", c: "1" } }, ...depends("node_modules/b", "*"), ...depends("node_modules/c", "*"),
          "node_modules/b/node_modules/dep": { version: "1.0.0" }, "node_modules/c/node_modules/dep": { version: "2.0.0" } },
        { "": { name: "root", dependencies: { b: "1", c: "1" } }, ...depends("node_modules/b", "*"), ...depends("node_modules/c", "*"),
          "node_modules/b/node_modules/dep": { version: "2.0.0" }, "node_modules/c/node_modules/dep": { version: "1.0.0" } }],
      ["a dependent that exists on one side only",
        { "": { name: "root", dependencies: { b: "1" } }, ...depends("node_modules/b", "*"), "node_modules/b/node_modules/dep": { version: "1.0.0" } },
        { "": { name: "root", dependencies: { b: "1", c: "1" } }, ...depends("node_modules/b", "*"), ...depends("node_modules/c", "*"), "node_modules/dep": { version: "1.0.0" } }],
    ])("%s", (_, base, head) => {
      const result = shown(base, head);
      expect(result.rehoisted).toEqual([]);
      expect(moved(result.rows)).toEqual([]);
      expect(result.rows).toHaveLength(changesBetween(lockfile, graph(base), graph(head)).length);
    });
  });

  it("treats a workspace's own dependency as a dependent", () => {
    const workspaces = { "": { name: "root", workspaces: ["ws"] }, ws: { name: "ws", dependencies: { dep: "*" } }, "node_modules/ws": { resolved: "ws", link: true } };
    const result = shown(
      { ...workspaces, "node_modules/dep": { version: "1.0.0" } },
      { ...workspaces, "ws/node_modules/dep": { version: "1.0.0" } },
    );
    expect(result.rehoisted).toEqual([rehoistKey(lockfile, "dep")]);
    const changed = shown(
      { ...workspaces, "node_modules/dep": { version: "1.0.0" }, "node_modules/x/node_modules/dep": { version: "2.0.0" }, "node_modules/x": { version: "1.0.0", dependencies: { dep: "2" } } },
      { ...workspaces, "node_modules/dep": { version: "2.0.0" }, "node_modules/x/node_modules/dep": { version: "1.0.0" }, "node_modules/x": { version: "1.0.0", dependencies: { dep: "2" } } },
    );
    expect(changed.rehoisted).toEqual([]);
  });

  it("does not call it a move when a path changed its package", () => {
    const users = { "": { name: "root", dependencies: { a: "1", y: "1" } }, "node_modules/a": { version: "1.0.0", dependencies: { foo: "*" } }, "node_modules/y": { version: "1.0.0", dependencies: { baz: "*" } } };
    const control = shown({ ...users, "node_modules/a/node_modules/foo": { version: "1.0.0" } }, { ...users, "node_modules/foo": { version: "1.0.0" } });
    expect(control.rehoisted).toEqual([rehoistKey(lockfile, "foo")]);
    const renamed = shown(
      { ...users, "node_modules/x": { name: "foo", version: "2.0.0" }, "node_modules/y/node_modules/baz": { version: "1.0.0" } },
      { ...users, "node_modules/x": { name: "baz", version: "1.0.0" }, "node_modules/foo": { version: "2.0.0" } },
    );
    expect(renamed.rehoisted).toEqual([]);
    expect(moved(renamed.rows)).toEqual([]);
  });

  describe("copies that can't be told apart, or that nothing asks for, are not proven", () => {
    const [one, other] = ["1.0.0-" + "a".repeat(200), "1.0.0-" + "b".repeat(200)];
    // Two installed copies of the same dependent (dep 1.0.0 under x and under y), each with its own lib.
    const sameDependent = (xLib: string, yLib: string): Packages => ({
      "": { name: "root", dependencies: { x: "1", y: "1" } },
      "node_modules/x": { version: "1.0.0", dependencies: { dep: "*" } },
      "node_modules/y": { version: "1.0.0", dependencies: { dep: "*" } },
      "node_modules/x/node_modules/dep": { version: "1.0.0", dependencies: { lib: "*" } },
      "node_modules/y/node_modules/dep": { version: "1.0.0", dependencies: { lib: "*" } },
      "node_modules/x/node_modules/dep/node_modules/lib": { version: xLib },
      "node_modules/y/node_modules/dep/node_modules/lib": { version: yLib },
    });
    const hoisting = (): [Packages, Packages] => {
      const users = { "": { name: "root", dependencies: { a: "1" } }, "node_modules/a": { version: "1.0.0", dependencies: { mv: "*" } } };
      return [{ ...users, "node_modules/a/node_modules/mv": { version: "1.0.0" } }, { ...users, "node_modules/mv": { version: "1.0.0" } }];
    };

    it("a swap between two copies of the same dependent", () => {
      const result = shown(sameDependent(one, other), sameDependent(other, one));
      expect(result.rehoisted).toEqual([]);
      expect(moved(result.rows)).toEqual([]);
      expect(result.rows).toHaveLength(2);
    });

    it.each(["both", "base", "head"])("rejects duplicate consumer identities across optional aliases (%s)", (duplicates) => {
      const consumer = { name: "consumer", version: "1.0.0", optionalDependencies: { x: "npm:lib@1", y: "npm:lib@2" } };
      const aliases = (split: boolean, swap: boolean): Packages => ({
        "": { name: "root", dependencies: { a: "npm:consumer@1", b: "npm:consumer@1" } },
        "node_modules/a": consumer,
        "node_modules/b": consumer,
        [`node_modules/${split && swap ? "b" : "a"}/node_modules/x`]: { name: "lib", version: "1.0.0" },
        [`node_modules/${split && !swap ? "b" : "a"}/node_modules/y`]: { name: "lib", version: "2.0.0" },
      });
      const result = shown(aliases(duplicates !== "head", false), aliases(duplicates !== "base", true));
      expect(result.rehoisted).toEqual([]);
      expect(moved(result.rows)).toEqual([]);
      expect(result.rows).toHaveLength(duplicates === "both" ? 4 : 2);
    });

    it("rejects duplicate optional consumers even when only one copy resolves lib in each graph", () => {
      const consumer = { name: "consumer", version: "1.0.0", optionalDependencies: { lib: "1" } };
      const consumers = {
        "": { name: "root", dependencies: { a: "npm:consumer@1", b: "npm:consumer@1" } },
        "node_modules/a": consumer,
        "node_modules/b": consumer,
      };
      const result = shown(
        { ...consumers, "node_modules/a/node_modules/lib": { version: "1.0.0" } },
        { ...consumers, "node_modules/b/node_modules/lib": { version: "1.0.0" } },
      );
      expect(result.rehoisted).toEqual([]);
      expect(moved(result.rows)).toEqual([]);
      expect(result.rows).toHaveLength(2);
    });

    it("the same swap next to an unrelated real move, which is still shown as moved", () => {
      const [moveFrom, moveTo] = hoisting();
      const result = shown({ ...sameDependent(one, other), ...moveFrom }, { ...sameDependent(other, one), ...moveTo });
      expect(result.rehoisted).toEqual([rehoistKey(lockfile, "mv")]);
      expect(result.rows.filter((line) => line.includes("`lib`"))).toHaveLength(2);
      expect(moved(result.rows)).toHaveLength(1);
    });

    it("a changed copy nothing depends on, beside one that moves", () => {
      const [moveFrom, moveTo] = hoisting();
      expect(shown(moveFrom, moveTo).rehoisted).toEqual([rehoistKey(lockfile, "mv")]);
      const result = shown({ ...moveFrom, "node_modules/b/node_modules/mv": { version: "1.0.0" } }, moveTo);
      expect(result.rehoisted).toEqual([]);
      expect(moved(result.rows)).toEqual([]);
      const added = shown(moveFrom, { ...moveTo, "node_modules/c/node_modules/mv": { version: "1.0.0" } });
      expect(added.rehoisted).toEqual([]);
    });
  });

  it("keeps per-path rows when the moved rows would be more numerous, even if shorter", () => {
    const [one, other] = ["1.0.0-" + "a".repeat(300), "1.0.0-" + "b".repeat(300)];
    const changes = [change("node_modules/a/node_modules/dep", "dep", one, other), change("node_modules/b/node_modules/dep", "dep", one, other), change("node_modules/c/node_modules/dep", "dep", other, one)];
    const rows = changeRows(changes, true, new Set([rehoistKey(lockfile, "dep")]));
    expect(rows).toHaveLength(3);
    expect(moved(rows)).toEqual([]);
  });

  it("keeps a package's rows when it has nothing moving from anywhere", () => {
    const added = [change("node_modules/dep", "dep", undefined, "1.0.0")];
    expect(changeRows(added, true, new Set([rehoistKey(lockfile, "dep")]))).toEqual(["| `dep` | new | `1.0.0` | `package-lock.json:node_modules/dep` |"]);
  });

  it("keeps per-path rows when the moved rows would be longer, so the table's line cut still fits more", () => {
    const pad = "p".repeat(300);
    const swaps = Array.from({ length: 30 }, (_, n) => change(`node_modules/${pad}${n}/node_modules/dep`, "dep", n < 15 ? "1.0.0" : "2.0.0", n < 15 ? "2.0.0" : "1.0.0"));
    const rows = changeRows(swaps, true, new Set([rehoistKey(lockfile, "dep")]));
    expect(rows).toHaveLength(30);
    expect(moved(rows)).toEqual([]);
    expect(changeRows(swaps.slice(0, 2), true, new Set()).join("\n")).toBe(rows.slice(0, 2).join("\n"));
  });

  it("keeps per-path rows when the section cuts the grouped row of a 29-to-1 re-hoist", async () => {
    const consumers: Packages = {};
    const nestedCopies: Packages = {};
    for (let n = 0; n < 29; n++) {
      const path = Array.from({ length: 14 }, (_, depth) => `node_modules/${"p".repeat(100)}${depth === 13 ? n : ""}`).join("/");
      consumers[path] = { version: "1.0.0", dependencies: { lib: "1" } };
      nestedCopies[`${path}/node_modules/lib`] = { version: "1.0.0" };
    }
    const [base, head] = [graph({ ...consumers, ...nestedCopies }), graph({ ...consumers, "node_modules/lib": { version: "1.0.0" } })];
    const changes = changesBetween(lockfile, base, head);
    const rehoisted = provenRehoists(lockfile, base, head);
    expect(changes).toHaveLength(30);
    expect(rehoisted).toEqual([rehoistKey(lockfile, "lib")]);
    const plan = await planFor(routineUnit([]), { ...npm, changes, rehoisted }, async () => undefined);
    const plain = planSection({ ...plan, rehoisted: undefined });
    expect(plain.split("\n").filter((line) => line.startsWith("| `lib`"))).toHaveLength(26);
    const section = planSection(plan);
    expect(section.length).toBeLessThanOrEqual(SECTION_LIMIT);
    expect(section.split("\n").filter((line) => line.startsWith("| `lib`"))).toHaveLength(26);
    expect(section).toBe(plain);
  });

  it("keeps all 15 visible upgrades when a 14-to-1 re-hoist would displace them", async () => {
    const removals = Array.from({ length: 14 }, (_, n) => change(`node_modules/${n === 0 ? "a" : "z"}${n}${"p".repeat(2300)}/node_modules/lib`, "lib", "1.0.0", undefined));
    const upgrades = Array.from({ length: 15 }, (_, n) => change(`node_modules/u${n}${"q".repeat(2000)}`, `upgrade${n}`, "1.0.0", "1.1.0"));
    const changes = [...removals, ...upgrades, change("node_modules/lib", "lib", undefined, "1.0.0")].sort((a, b) => a.path < b.path ? -1 : 1);
    const plan = await planFor(routineUnit([]), { ...npm, changes, rehoisted: [rehoistKey(lockfile, "lib")] }, async () => undefined);
    const plain = planSection({ ...plan, rehoisted: undefined });
    expect(plain.split("\n").filter((line) => line.startsWith("| `upgrade"))).toHaveLength(15);
    const section = planSection(plan);
    expect(section.split("\n").filter((line) => line.startsWith("| `upgrade"))).toHaveLength(15);
    expect(section).toBe(plain);
    expect(section.length).toBeLessThanOrEqual(SECTION_LIMIT);
  });

  it("falls back for the whole section when distinct lockfiles have identical formatted moved rows", async () => {
    const lockfiles = ["apps/a b/package-lock.json", "apps/a  b/package-lock.json"].sort();
    const pair = (lock: string) => [
      { ...change("node_modules/a/node_modules/lib", "lib", "1.0.0", undefined), lockfile: lock },
      { ...change("node_modules/lib", "lib", undefined, "1.0.0"), lockfile: lock },
    ];
    const upgrades = Array.from({ length: 26 }, (_, n) => ({
      ...change(`node_modules/u${n}${"p".repeat(1550)}`, `upgrade${n}`, "1.0.0", "1.1.0"), lockfile: lockfiles[0]!,
    }));
    const changes = [...pair(lockfiles[0]!), ...upgrades, ...pair(lockfiles[1]!)];
    const rehoisted = lockfiles.map((lock) => rehoistKey(lock, "lib"));
    expect(cell(lockfiles[0]!)).toBe(cell(lockfiles[1]!));
    const grouped = moved(changeRows(changes, true, new Set(rehoisted)));
    expect(grouped).toHaveLength(2);
    expect(grouped[0]).toBe(grouped[1]);
    const plan = await planFor(routineUnit([]), { ...npm, files: new Map(lockfiles.map((lock) => [lock, "lock bytes"])), changes, rehoisted }, async () => undefined);
    const section = planSection(plan);
    expect(moved(section.split("\n"))).toHaveLength(0);
    expect(section).toBe(planSection({ ...plan, rehoisted: undefined }));
    expect(section.length).toBeLessThanOrEqual(SECTION_LIMIT);
  });

  it("escapes a moved row's paths like any cell", () => {
    const odd = "node_modules/a|b/`x`";
    const [row] = changeRows([change(`${odd}/node_modules/dep`, "dep", "1.0.0", undefined), change("node_modules/dep", "dep", undefined, "1.0.0")], true, new Set([rehoistKey(lockfile, "dep")]));
    expect(row).toContain(`${cell(`${odd}/node_modules/dep`)} → `);
    expect(row).toContain("a\\|b");
    expect(row!.split(/(?<!\\)\|/)).toHaveLength(6);
  });

  it("keeps per-path rows when the list is cut short, since the rest may change the versions", async () => {
    const pair = [change("node_modules/a/node_modules/dep", "dep", "1.0.0", undefined), change("node_modules/dep", "dep", undefined, "1.0.0")];
    const rehoisted = [rehoistKey(lockfile, "dep")];
    expect(changeRows(pair, false, new Set(rehoisted))).toHaveLength(2);
    expect(moved(changeRows(pair, true, new Set(rehoisted)))).toHaveLength(1);
    const section = await tableOf(pair, rehoisted, 31);
    expect(section).toContain("| `dep` | `1.0.0` | removed |");
    expect(section).not.toContain("| moved |");
  });

  it("judges each lockfile on its own", () => {
    const other = { ...change("other/node_modules/dep", "dep", undefined, "1.0.0"), lockfile: "other/package-lock.json" };
    const changes = [change("node_modules/a/node_modules/dep", "dep", "1.0.0", undefined), other];
    expect(moved(changeRows(changes, true, new Set([rehoistKey(lockfile, "dep")])))).toEqual([]);
  });

  it("is display only: never recorded in the plan, its identity or what a body read back shows", async () => {
    const pair = [change("node_modules/a/node_modules/dep", "dep", "1.0.0", undefined), change("node_modules/dep", "dep", undefined, "1.0.0")];
    const rehoisted = [rehoistKey(lockfile, "dep")];
    const plan = await planFor(routineUnit([]), { ...npm, changes: pair, rehoisted }, async () => undefined);
    const plain = await planFor(routineUnit([]), { ...npm, changes: pair }, async () => undefined);
    expect(plan.rehoisted).toEqual(rehoisted);
    expect(planDigest(plan)).toBe(planDigest(plain));
    const section = planSection(plan);
    expect(section).toContain("| moved |");
    expect(planOf(section)).toEqual(plain);
    expect(planSection(planOf(section)!)).toContain("| `dep` | `1.0.0` | removed |");
    expect(planSection(planOf(section)!)).not.toContain("| moved |");
  });
});
