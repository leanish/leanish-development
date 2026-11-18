import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import semver from "semver";
import { afterEach, describe, expect, it } from "vitest";

import { parseFloors } from "@leanish/gate/floors";
import { versionKey } from "@leanish/gate/package-version";
import { type Advisory, Snapshot } from "@leanish/gate/snapshot";

import { computeNpm, type NpmCommand, type NpmInputs } from "../src/npm-compute.ts";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const OLD = new Date("2026-09-01");
const YOUNG = new Date("2026-10-06");
const ADVISORY: Advisory = { id: "GHSA-new", ids: ["GHSA-new"], malicious: false, source: "osv", summary: undefined, severity: undefined };

/** A security floor at `version` on the top-level `child` override of the root manifest. */
function floor(version = "1.0.0", purpose: "security" | "compatibility" = "security", selector: unknown = [["child"]]) {
  return parseFloors({ floors: [{
    ecosystem: "npm", package: "child", version, declaredIn: "package.json", selector, purpose,
    ...(purpose === "security" ? { advisories: ["GHSA-g3hv-75wg-m249"] } : {}), reason: "test", added: "2026-11-04",
  }] });
}

interface Options {
  readonly overrides?: Record<string, unknown>;
  readonly dependencies?: Record<string, string>;
  /** Locked versions of the two governed copies (top-level and under parent). */
  readonly locked?: readonly [string, string];
  /** npm leaves the copies at their locked versions on the first `n` commands. */
  readonly stale?: number;
  /** npm's resolution brings a bundled copy of `child` at this version, which no override reaches. */
  readonly bundled?: string;
}

/**
 * A root with `parent` (which brings `child`) and an override on `child`. The fake npm puts every `child` copy at the
 * override's value, as npm does for a plain top-level override.
 */
async function fixture(options: Options = {}) {
  const dir = await mkdtemp(join(process.cwd(), ".bump-raise-")); dirs.push(dir);
  const root = { name: "root", dependencies: { parent: "^1.0.0", ...options.dependencies }, overrides: options.overrides ?? { child: "1.0.0" } };
  const [top, nested] = options.locked ?? ["1.0.0", "1.0.0"];
  const graph = (manifest: unknown, top: string, nested: string, bundled?: string) => ({
    lockfileVersion: 3,
    packages: {
      "": manifest,
      "node_modules/parent": { version: "1.0.0", dependencies: { child: "^1.0.0" } },
      "node_modules/parent/node_modules/child": { version: nested },
      "node_modules/child": { version: top },
      ...(bundled === undefined ? {} : { "node_modules/carrier": { version: "1.0.0", bundleDependencies: ["child"] }, "node_modules/carrier/node_modules/child": { version: bundled, inBundle: true } }),
    },
  });
  const base = graph(root, top, nested);
  await writeFile(join(dir, "package.json"), json(root));
  await writeFile(join(dir, "package-lock.json"), json(base));
  const calls: string[][] = [];
  const npm: NpmCommand = async (cwd, args) => {
    if (args[0] === "--version") return { code: 0, stdout: "11.20.0", stderr: "" };
    calls.push([...args]);
    const manifest = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
    // An exact pin moves every copy; a range or `$` reference keeps the locked versions it admits.
    const pin = manifest.overrides?.child;
    const value = typeof pin === "string" && semver.valid(pin) !== null && calls.length > (options.stale ?? 0) ? pin : undefined;
    const current = JSON.parse(await readFile(join(cwd, "package-lock.json"), "utf8")).packages;
    await writeFile(join(cwd, "package-lock.json"), json(graph(manifest, value ?? current["node_modules/child"].version, value ?? current["node_modules/parent/node_modules/child"].version, options.bundled)));
    return { code: 0, stdout: "", stderr: "" };
  };
  const catalog: Record<string, string[]> = { parent: ["1.0.0"], carrier: ["1.0.0"], child: ["1.0.0", "1.0.1", "1.1.0", "1.2.0-beta.1", "2.0.0"] };
  const inputs: NpmInputs = {
    kind: "routine",
    dir,
    baseLocks: new Map([["package-lock.json", base]]),
    moves: [],
    npm,
    window: { days: 7, exclude: [] },
    sources: {
      versions: async (name) => catalog[name],
      published: async () => OLD,
      snapshot: async (packages, candidates) => new Snapshot(new Map([...packages, ...candidates].map((pkg) => [versionKey(pkg), []])), [], new Date()),
      identity: async () => [],
      isTrusted: () => false,
      releaseAgeDays: 7,
      now: new Date("2026-10-07"),
    },
    overrideFloors: { floors: floor(), line: (_name, version) => String(semver.major(version)) },
  };
  return { dir, inputs, calls };
}

const childVersions = (lock: string) => {
  const packages = JSON.parse(lock).packages;
  return [packages["node_modules/child"].version, packages["node_modules/parent/node_modules/child"].version];
};

describe("routine raise of an exact, security-floored override", () => {
  it("moves the override and every copy it governs to the newest eligible version in its line, keeping the floor", async () => {
    const h = await fixture();
    const result = await computeNpm(h.inputs);
    expect(JSON.parse(result.files.get("package.json")!).overrides).toEqual({ child: "1.1.0" });
    expect(childVersions(result.files.get("package-lock.json")!)).toEqual(["1.1.0", "1.1.0"]);
    expect(result.notes).toContain("package.json: override child 1.0.0 → 1.1.0 (security floor 1.0.0 stays)");
  });

  it.each([
    ["a young version", { published: async (_name: string, version: string) => (version === "1.1.0" ? YOUNG : OLD) }],
    ["an added advisory", { snapshot: async (packages: ReadonlyArray<{ name: string; version: string; ecosystem: "npm" }>, candidates: ReadonlyArray<{ name: string; version: string; ecosystem: "npm" }>) =>
      new Snapshot(new Map([...packages, ...candidates].map((pkg) => [versionKey(pkg), pkg.version === "1.1.0" ? [ADVISORY] : []])), [], new Date()) }],
    ["a publisher change", { identity: async (_name: string, _from: string, to: string) => (to === "1.1.0" ? ["publisher changed"] : []) }],
  ])("skips %s for the next eligible one", async (_label, sources) => {
    const h = await fixture();
    const result = await computeNpm({ ...h.inputs, sources: { ...h.inputs.sources, ...sources } as NpmInputs["sources"] });
    expect(JSON.parse(result.files.get("package.json")!).overrides).toEqual({ child: "1.0.1" });
  });

  it("takes no prerelease from a stable pin and no version past its line", async () => {
    const h = await fixture();
    const result = await computeNpm({ ...h.inputs, sources: { ...h.inputs.sources, versions: async (name) => (name === "child" ? ["1.0.0", "1.2.0-beta.1", "2.0.0"] : ["1.0.0"]) } });
    expect(result.files.has("package.json")).toBe(false);
    expect(result.notes).toContain("package-lock.json: child at node_modules/child is pinned at 1.0.0 by the repository override");
  });

  it("recovers when npm's first resolution leaves the old pin", async () => {
    const h = await fixture({ stale: 1 });
    const result = await computeNpm(h.inputs);
    expect(childVersions(result.files.get("package-lock.json")!)).toEqual(["1.1.0", "1.1.0"]);
  });

  it("refuses the computation when npm never lands the raised override", async () => {
    const h = await fixture({ stale: 100 });
    await expect(computeNpm(h.inputs)).rejects.toThrow("child");
  });

  it.each([
    ["without a security floor", {}, { floors: [] }],
    ["under a compatibility floor", {}, { floors: floor("1.0.0", "compatibility") }],
    ["when a floor selects a nested path", { overrides: { child: "1.0.0", parent: { child: "1.0.0" } } }, { floors: floor("1.0.0", "security", [["parent", "child"]]) }],
    ["when another rule names the package", { overrides: { child: "1.0.0", parent: { child: "1.0.0" } } }, {}],
    ["when a version-qualified rule names the package", { overrides: { child: "1.0.0", "child@1.0.0": { grand: "2.0.0" } } }, {}],
    ["for a $ reference", { overrides: { child: "$child" }, dependencies: { child: "1.0.0" } }, {}],
    ["for a range", { overrides: { child: "^1.0.0" } }, {}],
    ["when the root declares it directly", { dependencies: { child: "1.0.0" } }, {}],
    ["when a locked copy is above the pin", { locked: ["1.0.1", "1.0.0"] as const }, {}],
  ])("leaves the override alone %s", async (_label, options, policy) => {
    const h = await fixture(options);
    const result = await computeNpm({ ...h.inputs, overrideFloors: { ...h.inputs.overrideFloors!, ...policy } });
    expect(result.files.has("package.json")).toBe(false);
  });

  it("refuses the computation when a copy the raise can't reach keeps the old version", async () => {
    const h = await fixture({ bundled: "1.0.0" });
    await expect(computeNpm(h.inputs)).rejects.toThrow("package-lock.json: the override child was raised to 1.1.0, but child at node_modules/carrier/node_modules/child is 1.0.0");
  });

  it.each([
    ["the catalog", { versions: async () => { throw new Error("registry down"); } }, "the registry couldn't list child's versions: registry down"],
    ["a publish time", { published: async (_name: string, version: string) => { if (version === "1.1.0") throw new Error("timeout"); return OLD; } }, "child@1.1.0's publish time couldn't be read: timeout"],
    ["a candidate's missing publish time", { published: async (_name: string, version: string) => (version === "1.1.0" ? undefined : OLD) }, "the registry has no publish time for child@1.1.0, so its age can't be judged"],
    ["the pin's missing publish time", { published: async (_name: string, version: string) => (version === "1.0.0" ? undefined : OLD) }, "a locked copy of it has no readable publish time, so npm's window excludes it"],
    ["the advisory snapshot", { snapshot: async () => { throw new Error("osv down"); } }, "the advisory lookup failed: osv down"],
    ["an identity check", { identity: async (_name: string, _from: string, to: string) => { if (to === "1.1.0") throw new Error("bad attestation"); return []; } }, "child@1.1.0 couldn't be judged: bad attestation"],
  ])("holds the override and reports it when %s can't be read, instead of taking an older version", async (_label, sources, why) => {
    const h = await fixture();
    const result = await computeNpm({ ...h.inputs, sources: { ...h.inputs.sources, ...sources } as NpmInputs["sources"] });
    expect(result.files.has("package.json")).toBe(false);
    expect(result.notes).toContain(`package.json: override child stays at 1.0.0: ${why}`);
    expect(result.undecided).toEqual([`package.json: override child stays at 1.0.0: ${why}`]);
  });

  it("holds the override as undecided when another lockfile's copy of the package has no publish time", async () => {
    const h = await fixture();
    const other = { lockfileVersion: 3, packages: { "": { name: "tool" }, "node_modules/child": { version: "2.0.0" } } };
    await mkdir(join(h.dir, "tool"));
    await writeFile(join(h.dir, "tool/package.json"), json({ name: "tool" }));
    await writeFile(join(h.dir, "tool/package-lock.json"), json(other));
    const result = await computeNpm({
      ...h.inputs,
      baseLocks: new Map([...h.inputs.baseLocks, ["tool/package-lock.json", other]]),
      npm: async (cwd, args) => (cwd.endsWith("/tool") ? { code: 0, stdout: args[0] === "--version" ? "11.20.0" : "", stderr: "" } : h.inputs.npm(cwd, args)),
      sources: { ...h.inputs.sources, published: async (_name, version) => (version === "2.0.0" ? undefined : OLD) },
    });
    const why = "package.json: override child stays at 1.0.0: a locked copy of it has no readable publish time, so npm's window excludes it";
    expect(result.files.has("package.json")).toBe(false);
    expect(result.undecided).toEqual([why]);
  });

  it("explains why an eligible-looking override stays", async () => {
    const h = await fixture({ locked: ["1.0.1", "1.0.0"] });
    const result = await computeNpm(h.inputs);
    expect(result.notes).toContain("package.json: override child stays at 1.0.0: its copies aren't all locked at that version");
  });

  it("defers an override whose locked version npm's window excludes", async () => {
    const h = await fixture();
    const result = await computeNpm({ ...h.inputs, sources: { ...h.inputs.sources, published: async (name, version) => (name === "child" && version === "1.0.0" ? YOUNG : OLD) } });
    expect(result.files.has("package.json")).toBe(false);
    expect(result.notes).toContain("package.json: override child stays at 1.0.0: a locked copy of it is younger than the window");
    expect(result.undecided ?? []).toEqual([]);
  });

  it("does nothing in a major", async () => {
    const h = await fixture();
    const result = await computeNpm({ ...h.inputs, kind: "major", moves: [{ name: "parent", to: "1.0.0", lockfile: "package-lock.json", workspace: ".", declaredAs: "parent", spec: "^1.0.0" }] });
    expect(result.files.has("package.json")).toBe(false);
  });
});
