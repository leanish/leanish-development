import { describe, expect, it } from "vitest";

import type { Located } from "@leanish/gate/findings";
import type { GateEnvironment } from "@leanish/gate/gate";
import type { GradleInventory } from "@leanish/gate/gradle";
import type { Tree } from "@leanish/gate/tree";

import { policyFence } from "../src/edit-checks.ts";
import { admittedCleanup, exceptionsCleanup, keepingExceptions, unusedRemoval, writeExceptionsCleanup } from "../src/exception-cleanup.ts";

const EXCEPTIONS = ".github/supply-chain-exceptions.json";

const npm = (name: string, version: string, ...locations: string[]): Located => ({ ecosystem: "npm", name, version, locations });
const maven = (name: string, version: string, ...locations: string[]): Located => ({ ecosystem: "Maven", name, version, locations });

const vulnerability = (pkg: string, version: string, paths: string[], extra: Record<string, unknown> = {}) =>
  ({ id: `GHSA-${pkg}`, package: pkg, version, paths, reason: "reviewed", expires: "2026-12-31", ...extra });

/** The file as a person writes it: two-space indent, one entry per line block. */
function file(lists: Record<string, unknown>): string {
  return `${JSON.stringify(lists, null, 2)}\n`;
}

describe("unusedRemoval", () => {
  it("removes an entry that covered a copy in the base and covers none in the head, keeping every other byte", () => {
    const text = file({ vulnerabilities: [vulnerability("a", "1.0.0", ["node_modules/a"]), vulnerability("b", "2.0.0", ["node_modules/b"])] });
    const cleanup = unusedRemoval(text, [npm("a", "1.0.0", "node_modules/a"), npm("b", "2.0.0", "node_modules/b")], [npm("a", "1.0.1", "node_modules/a"), npm("b", "2.0.0", "node_modules/b")]);
    expect(cleanup).toEqual({ kind: "removal", text: file({ vulnerabilities: [vulnerability("b", "2.0.0", ["node_modules/b"])] }) });
  });

  it("keeps an entry already unused in the base, one still covering a copy, and one partly used", () => {
    const text = file({
      vulnerabilities: [
        vulnerability("stale", "1.0.0", ["node_modules/stale"]),
        vulnerability("kept", "1.0.0", ["node_modules/kept", "tools/cli/node_modules/kept"]),
      ],
    });
    // `kept` leaves the root lockfile but stays in the other one: still in use.
    const before = [npm("kept", "1.0.0", "node_modules/kept", "tools/cli/node_modules/kept")];
    const after = [npm("kept", "1.0.0", "tools/cli/node_modules/kept"), npm("kept", "1.1.0", "node_modules/kept")];
    expect(unusedRemoval(text, before, after)).toEqual({ kind: "none" });
  });

  it("matches a vulnerability entry only at its paths, as the gate does", () => {
    const text = file({ vulnerabilities: [vulnerability("a", "1.0.0", ["node_modules/a"])] });
    // The head keeps a@1.0.0, but only where the entry doesn't reach: it covers nothing there.
    const cleanup = unusedRemoval(text, [npm("a", "1.0.0", "node_modules/a")], [npm("a", "1.0.0", "node_modules/x/node_modules/a")]);
    expect(cleanup.kind).toBe("removal");
    // And never removes one that only matched elsewhere in the base too.
    expect(unusedRemoval(text, [npm("a", "1.0.0", "node_modules/x/node_modules/a")], [])).toEqual({ kind: "none" });
  });

  it("reads an omitted ecosystem as any, a named one as that one, and identity as npm", () => {
    const npmOnly = vulnerability("g:b", "1.0", ["runtimeClasspath"], { ecosystem: "npm" });
    const identity = { package: "g:a", version: "1.0", reason: "r", expires: "2026-12-31" };
    const text = file({
      vulnerabilities: [vulnerability("g:a", "1.0", ["runtimeClasspath"]), npmOnly],
      releaseAge: [{ package: "g:a", version: "1.0", advisory: "GHSA-x", reason: "r", expires: "2026-12-31" }],
      identity: [identity],
    });
    const before = [maven("g:a", "1.0", "runtimeClasspath"), maven("g:b", "1.0", "runtimeClasspath")];
    // g:b's entry names npm and g:a's identity entry is npm: neither covered the Maven copies, so both stay.
    expect(unusedRemoval(text, before, [])).toEqual({ kind: "removal", text: file({ vulnerabilities: [npmOnly], releaseAge: [], identity: [identity] }) });
  });

  it("removes release-age and identity entries whose version left", () => {
    const text = file({
      releaseAge: [{ package: "a", version: "1.0.1", advisory: "GHSA-a", reason: "r", expires: "2026-12-31" }],
      identity: [{ package: "a", version: "1.0.1", reason: "r", expires: "2026-12-31" }],
    });
    const cleanup = unusedRemoval(text, [npm("a", "1.0.1", "node_modules/x/node_modules/a")], [npm("a", "1.0.2", "node_modules/x/node_modules/a")]);
    expect(cleanup).toEqual({ kind: "removal", text: file({ releaseAge: [], identity: [] }) });
  });

  it("ignores expiry: an expired entry that still covers a version stays", () => {
    const text = file({ vulnerabilities: [vulnerability("a", "1.0.0", ["node_modules/a"], { expires: "2020-01-01" })] });
    expect(unusedRemoval(text, [npm("a", "1.0.0", "node_modules/a")], [npm("a", "1.0.0", "node_modules/a")])).toEqual({ kind: "none" });
  });

  it("keeps formatting and fields it doesn't read, removing first, middle, last and consecutive entries", () => {
    const entry = (name: string) => `{ "id": "GHSA-${name}", "package": "${name}", "version": "1", "paths": ["node_modules/${name}"], "reason": "r", "expires": "2026-12-31", "note": "kept" }`;
    const listed = (names: string[]) => `{\n  "comment": "top-level fields stay",\n  "vulnerabilities": [\n${names.map((name) => `      ${entry(name)}`).join(",\n")}\n  ]\n}\n`;
    const all = ["a", "b", "c", "d", "e"];
    const before = all.map((name) => npm(name, "1", `node_modules/${name}`));
    for (const gone of [["a"], ["c"], ["e"], ["a", "b"], ["b", "c"], ["d", "e"], ["a", "c", "e"], ["a", "b", "d"]]) {
      const cleanup = unusedRemoval(listed(all), before, before.filter((pkg) => !gone.includes(pkg.name)));
      expect(cleanup.kind === "removal" && cleanup.text, gone.join()).toBe(listed(all.filter((name) => !gone.includes(name))));
    }
    const emptied = unusedRemoval(listed(["a"]), before, []);
    expect(emptied.kind === "removal" && emptied.text).toBe(`{\n  "comment": "top-level fields stay",\n  "vulnerabilities": []\n}\n`);
  });

  it("skips a file it can't edit in place", () => {
    const duplicated = `{ "vulnerabilities": [], "vulnerabilities": [${JSON.stringify(vulnerability("a", "1", ["node_modules/a"]))}] }`;
    expect(unusedRemoval(duplicated, [npm("a", "1", "node_modules/a")], []).kind).toBe("skipped");
  });
});

function tree(id: string, files: Record<string, string>): Tree {
  return { id, read: async (path) => files[path], list: async (dir) => Object.keys(files).filter((path) => path.startsWith(`${dir}/`)) };
}

function lock(installed: Record<string, string>, extra: Record<string, object> = {}): string {
  const packages: Record<string, object> = { "": { name: "app" }, ...extra };
  for (const [name, version] of Object.entries(installed)) {
    packages[`node_modules/${name}`] = { version, resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`, integrity: "sha512-AAAA" };
  }
  return JSON.stringify({ lockfileVersion: 3, packages });
}

const ENV: GateEnvironment = {
  run: async () => { throw new Error("no process expected"); },
  fetch: async (url) => { throw new Error(`no request expected: ${String(url)}`); },
  now: () => new Date("2026-11-10T12:00:00Z"),
  osvScanner: "osv-scanner",
  githubToken: undefined,
};

const TEXT = file({ vulnerabilities: [vulnerability("a", "1.0.0", ["node_modules/a"]), vulnerability("b", "1.0.0", ["node_modules/b"])] });
const BASE = tree("base", { [EXCEPTIONS]: TEXT, "package-lock.json": lock({ a: "1.0.0", b: "1.0.0" }) });
const HEAD_LOCK = lock({ a: "1.0.1", b: "1.0.0" });
const CLEANED = file({ vulnerabilities: [vulnerability("b", "1.0.0", ["node_modules/b"])] });

describe("exceptionsCleanup", () => {
  it("compares the base's and the head's inventories", async () => {
    const cleanup = await exceptionsCleanup(BASE, tree("head", { [EXCEPTIONS]: TEXT, "package-lock.json": HEAD_LOCK }), {}, ENV);
    expect(cleanup).toEqual({ kind: "removal", text: CLEANED });
  });

  it("has nothing to do without an exceptions file", async () => {
    expect(await exceptionsCleanup(tree("base", { "package-lock.json": HEAD_LOCK }), tree("head", { "package-lock.json": HEAD_LOCK }), {}, ENV)).toEqual({ kind: "none" });
  });

  it("skips the whole cleanup on a bundle the head's lockfile doesn't record", async () => {
    const bundled = lock({ a: "1.0.1", b: "1.0.0" }, { "node_modules/carrier": { version: "1.0.0", bundleDependencies: ["inner"], resolved: "https://registry.npmjs.org/carrier/-/carrier-1.0.0.tgz", integrity: "sha512-AAAA" } });
    const cleanup = await exceptionsCleanup(BASE, tree("head", { [EXCEPTIONS]: TEXT, "package-lock.json": bundled }), {}, ENV);
    expect(cleanup).toEqual({ kind: "skipped", why: expect.stringContaining("the head's inventory is incomplete") });
  });

  it("skips the whole cleanup on a Gradle configuration that didn't resolve, an ignored one included", async () => {
    const gradle = (error: string | undefined): GradleInventory => ({
      builds: [{ build: ".", configurations: [{ id: "lintClasspath", declared: [], resolved: [], unresolved: [], ...(error === undefined ? {} : { error }) }] }],
    } as unknown as GradleInventory);
    const config = JSON.stringify({ gradle: { ignoreConfigurations: ["lintClasspath"] } });
    const withBuild = (id: string, lockText: string) => tree(id, { [EXCEPTIONS]: TEXT, "package-lock.json": lockText, "build.gradle": "", ".github/supply-chain.json": config });
    const cleanup = await exceptionsCleanup(withBuild("base", lock({ a: "1.0.0", b: "1.0.0" })), withBuild("head", HEAD_LOCK), { base: gradle(undefined), head: gradle("boom") }, ENV);
    expect(cleanup).toEqual({ kind: "skipped", why: expect.stringContaining("lintClasspath didn't resolve") });
  });

  it("skips the whole cleanup, never failing, when looking an action up fails", async () => {
    const workflow = `on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: acme/setup@${"a".repeat(40)} # v1.0.0\n`;
    const head = tree("head", { [EXCEPTIONS]: TEXT, "package-lock.json": HEAD_LOCK, ".github/workflows/ci.yml": workflow });
    // ENV's fetch throws, as GitHub rate-limited or down.
    expect((await exceptionsCleanup(BASE, head, {}, ENV)).kind).toBe("skipped");
  });

  it("skips a base file that isn't JSON", () => {
    expect(unusedRemoval("vulnerabilities: []\n", [], []).kind).toBe("skipped");
  });

  it("skips the whole cleanup on an action whose version can't be told", async () => {
    const workflow = "on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: acme/setup@main\n";
    const cleanup = await exceptionsCleanup(BASE, tree("head", { [EXCEPTIONS]: TEXT, "package-lock.json": HEAD_LOCK, ".github/workflows/ci.yml": workflow }), {}, ENV);
    expect(cleanup).toEqual({ kind: "skipped", why: expect.stringContaining("acme/setup@main") });
  });
});

describe("writing and admitting the cleanup", () => {
  it("writes the file the head should have, whatever it holds, and nothing when it already has it", async () => {
    const writes: string[] = [];
    const write = async (text: string) => { writes.push(text); };
    expect(await writeExceptionsCleanup(BASE, tree("head", { [EXCEPTIONS]: TEXT, "package-lock.json": HEAD_LOCK }), {}, ENV, write)).toEqual({ wrote: true, cleaned: true });
    // A merge that left other text (an earlier cleanup, a base change) is recomputed over the base.
    expect(await writeExceptionsCleanup(BASE, tree("head", { [EXCEPTIONS]: `${TEXT} `, "package-lock.json": HEAD_LOCK }), {}, ENV, write)).toEqual({ wrote: true, cleaned: true });
    expect(await writeExceptionsCleanup(BASE, tree("head", { [EXCEPTIONS]: CLEANED, "package-lock.json": HEAD_LOCK }), {}, ENV, write)).toEqual({ wrote: false, cleaned: true });
    // An earlier cleanup the head no longer justifies goes back to the base's file.
    expect(await writeExceptionsCleanup(BASE, tree("head", { [EXCEPTIONS]: CLEANED, "package-lock.json": lock({ a: "1.0.0", b: "1.0.0" }) }), {}, ENV, write)).toEqual({ wrote: true, cleaned: false });
    expect(writes).toEqual([CLEANED, CLEANED, TEXT]);
  });

  it("refuses an agent pass that changed the exceptions file, and lets one that didn't through", async () => {
    const files: Record<string, string> = { [EXCEPTIONS]: TEXT };
    const working = tree("worktree", files);
    expect(await keepingExceptions(working, async () => "applied")).toBe("applied");
    await expect(keepingExceptions(working, async () => { files[EXCEPTIONS] = CLEANED; return "applied"; }))
      .rejects.toThrow("the agent changed .github/supply-chain-exceptions.json");
  });

  it("admits exactly the cleanup through the policy fence, and nothing else", async () => {
    const fence = async (exceptions: string) => {
      const head = tree("head", { [EXCEPTIONS]: exceptions, "package-lock.json": HEAD_LOCK });
      const changed = [EXCEPTIONS, "package-lock.json"];
      return policyFence(changed, [], BASE, head, await admittedCleanup(changed, BASE, head, {}, ENV));
    };
    expect(await fence(CLEANED)).toEqual([]);
    const refused = [expect.stringContaining("the exceptions file only to remove the entries this change leaves unused")];
    // A reformat, a used entry removed, an entry added or edited.
    expect(await fence(CLEANED.replace(/\n {2}/g, "\n    "))).toEqual(refused);
    expect(await fence(file({ vulnerabilities: [] }))).toEqual(refused);
    expect(await fence(file({ vulnerabilities: [vulnerability("b", "1.0.0", ["node_modules/b"]), vulnerability("c", "1.0.0", ["node_modules/c"])] }))).toEqual(refused);
    expect(await fence(file({ vulnerabilities: [vulnerability("b", "1.0.0", ["node_modules/b"], { expires: "2027-12-31" })] }))).toEqual(refused);
  });

  it("admits nothing when the file changed but the change leaves no entry unused", async () => {
    const head = tree("head", { [EXCEPTIONS]: CLEANED, "package-lock.json": lock({ a: "1.0.0", b: "1.0.0" }) });
    const changed = [EXCEPTIONS];
    expect(await policyFence(changed, [], BASE, head, await admittedCleanup(changed, BASE, head, {}, ENV))).toEqual([expect.stringContaining("the gate's own policy")]);
  });
});
