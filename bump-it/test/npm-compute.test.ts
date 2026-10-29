import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NpmCatalog } from "@leanish/gate/catalogs";
import { NpmRegistry } from "@leanish/gate/npm-registry";
import { versionKey } from "@leanish/gate/package-version";
import { type Advisory, Snapshot } from "@leanish/gate/snapshot";
import { computeNpm, MAX_PASSES, type NpmCommand, type NpmInputs } from "../src/npm-compute.ts";
import { requireNpmExcludes } from "../src/npm-runtime.ts";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const manifest = { name: "root", dependencies: { parent: "^1.0.0", frozen: "^1.0.0" } };
const lock = (parent = "1.0.0", child = "1.0.0", frozen = "1.0.0") => ({ lockfileVersion: 3, packages: { "": { ...manifest }, "node_modules/parent": { version: parent, dependencies: { child: "^1" } }, "node_modules/child": { version: child }, "node_modules/frozen": { version: frozen } } });
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
async function fixture(script?: (dir: string, args: ReadonlyArray<string>, n: number) => Promise<void>) {
  const dir = await mkdtemp(join(process.cwd(), ".bump-test-")); dirs.push(dir);
  await writeFile(join(dir, "package.json"), json(manifest));
  await writeFile(join(dir, "package-lock.json"), json(lock()));
  const calls: string[][] = [];
  const npm: NpmCommand = async (cwd, args) => {
    expect(cwd).toBe(dir);
    if (args[0] === "--version") {
      return { code: 0, stdout: "11.20.0", stderr: "" };
    }
    calls.push([...args]);
    await script?.(dir, args, calls.length);
    return { code: 0, stdout: "", stderr: "" };
  };
  const inputs: NpmInputs = { dir, baseLocks: new Map([["package-lock.json", lock()]]), moves: [{ name: "parent", to: "1.1.0", lockfile: "package-lock.json", workspace: ".", declaredAs: "parent", spec: "^1.0.0" }], npm, kind: "routine", window: { days: 7, exclude: ["@own/*", "@other/*"] }, sources: { versions: async () => ["1.0.0", "1.1.0"], published: async () => new Date("2026-09-01"), snapshot: async (base, candidates) => new Snapshot(new Map([...base, ...candidates].map((pkg) => [versionKey(pkg), []])), [], new Date()), identity: async () => [], isTrusted: () => false, releaseAgeDays: 7, now: new Date("2026-10-07") } };
  return { dir, inputs, calls };
}
describe("exact npm computation", () => {
  it.each(["routine", "major"] as const)("preserves object-form self-overrides through %s npm computation", async (kind) => {
    const h = await fixture();
    const original = { ...manifest, overrides: { frozen: { ".": "^1.0.0", nested: "2.0.0" } } };
    const base = { ...lock(), packages: { ...lock().packages, "": original } };
    await writeFile(join(h.dir, "package.json"), json(original));
    await writeFile(join(h.dir, "package-lock.json"), json(base));
    let calls = 0;
    const result = await computeNpm({ ...h.inputs, kind, baseLocks: new Map([["package-lock.json", base]]), npm: async (dir, args) => {
      if (args[0] === "--version") return { code: 0, stdout: "11.20.0", stderr: "" };
      const root = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
      // npm rejects a direct edge whose applicable self-override differs from its raw spec.
      if (root.overrides.frozen["."] !== root.dependencies.frozen) return { code: 1, stdout: "", stderr: "EOVERRIDE frozen" };
      expect(root.overrides.frozen.nested).toBe("2.0.0");
      if (++calls === 1) expect(root.dependencies.frozen).toBe("1.0.0");
      await writeFile(join(dir, "package-lock.json"), json({ packages: { ...base.packages, "": root, "node_modules/parent": { version: "1.1.0", dependencies: { child: "^1" } }, "node_modules/child": { version: "1.1.0" } } }));
      return { code: 0, stdout: "", stderr: "" };
    } });
    expect(JSON.parse(await readFile(join(h.dir, "package.json"), "utf8"))).toEqual({ ...original, dependencies: { ...original.dependencies, parent: "^1.1.0" } });
    expect(JSON.parse(result.files.get("package-lock.json")!).packages["node_modules/parent"].version).toBe("1.1.0");
  });

  async function nodeTypesFixture(options: { kind: "routine" | "major"; runtime?: number; base?: string; range?: string; induced?: string; alias?: boolean; workspaceRuntime?: number }) {
    const h = await fixture();
    const key = options.alias ? "node-types" : "@types/node";
    const path = `node_modules/${key}`;
    const root = {
      ...manifest,
      ...(options.runtime === undefined ? {} : { engines: { node: `>=${options.runtime} <${options.runtime + 1}` } }),
      ...(options.workspaceRuntime === undefined ? {} : { workspaces: ["ws"] }),
    };
    const graph = (version: string | undefined, parent: string, manifest: unknown) => ({
      packages: {
        "": manifest,
        "node_modules/parent": { version: parent, dependencies: { [key]: options.alias ? "npm:@types/node@*" : options.range ?? "*" } },
        "node_modules/frozen": { version: "1.0.0" },
        ...(version === undefined ? {} : { [path]: { name: "@types/node", version } }),
        ...(options.workspaceRuntime === undefined ? {} : { ws: { engines: { node: `>=${options.workspaceRuntime}` } } }),
      },
    });
    const base = graph(options.base, "1.0.0", root);
    await writeFile(join(h.dir, "package.json"), json(root));
    await writeFile(join(h.dir, "package-lock.json"), json(base));
    if (options.workspaceRuntime !== undefined) {
      await mkdir(join(h.dir, "ws"));
      await writeFile(join(h.dir, "ws/package.json"), json({ engines: { node: `>=${options.workspaceRuntime}` } }));
    }
    let selected = options.induced ?? "26.6.3";
    const npm: NpmCommand = async (dir, args) => {
      if (args[0] === "--version") {
        return { code: 0, stdout: "11.20.0", stderr: "" };
      }
      h.calls.push([...args]);
      const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
      const pin = manifest.overrides?.[`${key}@${selected}`];
      if (typeof pin === "string") {
        selected = pin.startsWith("npm:") ? pin.slice(pin.lastIndexOf("@") + 1) : pin;
      }
      await writeFile(join(dir, "package-lock.json"), json(graph(selected, options.kind === "major" ? "2.0.0" : "1.0.0", manifest)));
      return { code: 0, stdout: "", stderr: "" };
    };
    const inputs: NpmInputs = {
      ...h.inputs,
      kind: options.kind,
      baseLocks: new Map([["package-lock.json", base]]),
      moves: options.kind === "major" ? h.inputs.moves.map((move) => ({ ...move, to: "2.0.0" })) : [],
      npm,
      sources: { ...h.inputs.sources, versions: async () => ["22.6.0", "24.19.0", "24.20.0", "26.6.3"] },
    };
    return { ...h, inputs, path };
  }

  it.each(["routine", "major"] as const)("caps %s transitive Node types through npm computation and exact pinning", async (kind) => {
    const h = await nodeTypesFixture({ kind, runtime: 24, base: "24.19.0" });
    const result = await computeNpm(h.inputs);
    const computed = JSON.parse(result.files.get("package-lock.json")!);
    expect(computed.packages[h.path].version).toBe("24.20.0");
    expect(result.changes).toContainEqual(expect.objectContaining({ name: "@types/node", from: "24.19.0", to: "24.20.0" }));
    expect(result.notes).toContainEqual(expect.stringContaining("lowest supported Node major (24"));
    expect(h.calls.map((call) => call[0])).toEqual(kind === "routine" ? ["install", "update", "install", "install", "install"] : ["install", "install", "install", "install"]);
    expect(JSON.parse(await readFile(join(h.dir, "package.json"), "utf8")).overrides).toBeUndefined();
  });

  it.each(["age", "advisory", "identity"])("keeps major-induced type selection subject to %s checks", async (check) => {
    const h = await nodeTypesFixture({ kind: "major", runtime: 24, base: "24.19.0" });
    const advisory: Advisory = { id: "GHSA-new", ids: ["GHSA-new"], malicious: false, source: "osv", summary: undefined, severity: undefined };
    const result = await computeNpm({
      ...h.inputs,
      sources: {
        ...h.inputs.sources,
        published: async (_name, version) => new Date(check === "age" && version === "24.20.0" ? "2026-10-06" : "2026-09-01"),
        identity: async (_name, _from, to) => check === "identity" && to === "24.20.0" ? ["publisher changed"] : [],
        snapshot: async (base, candidates) => new Snapshot(new Map([...base, ...candidates].map((pkg) =>
          [versionKey(pkg), check === "advisory" && pkg.version === "24.20.0" ? [advisory] : []],
        )), [], h.inputs.sources.now),
      },
    });
    expect(JSON.parse(result.files.get("package-lock.json")!).packages[h.path].version).toBe("24.19.0");
  });

  it("does not refresh a type major already above the supported runtime", async () => {
    const h = await nodeTypesFixture({ kind: "routine", runtime: 24, base: "26.6.2" });
    const result = await computeNpm(h.inputs);
    expect(JSON.parse(await readFile(join(h.dir, "package-lock.json"), "utf8")).packages[h.path].version).toBe("26.6.2");
    expect(result.files.size).toBe(0);
    expect(result.changes.filter((change) => change.name === "@types/node")).toEqual([]);
  });

  it("does not refresh already compatible types in a major unit", async () => {
    const h = await nodeTypesFixture({ kind: "major", runtime: 24, base: "24.19.0", induced: "24.19.0" });
    const versions = vi.fn(h.inputs.sources.versions);
    const result = await computeNpm({ ...h.inputs, sources: { ...h.inputs.sources, versions } });
    expect(JSON.parse(result.files.get("package-lock.json")!).packages[h.path].version).toBe("24.19.0");
    expect(versions).not.toHaveBeenCalled();
    expect(h.calls.map((call) => call[0])).toEqual(["install", "install"]);
  });

  it("caps aliased transitive types in a major-induced graph", async () => {
    const h = await nodeTypesFixture({ kind: "major", runtime: 24, base: "24.19.0", alias: true });
    const result = await computeNpm(h.inputs);
    expect(JSON.parse(result.files.get("package-lock.json")!).packages[h.path].version).toBe("24.20.0");
  });

  it("includes a lower workspace runtime even when Node types are only transitive", async () => {
    const h = await nodeTypesFixture({ kind: "routine", runtime: 24, workspaceRuntime: 22, base: "22.5.0" });
    const result = await computeNpm(h.inputs);
    expect(JSON.parse(result.files.get("package-lock.json")!).packages[h.path].version).toBe("22.6.0");
  });

  it("retains the base type major without runtime evidence, instead of accepting npm's higher major", async () => {
    const h = await nodeTypesFixture({ kind: "major", base: "24.19.0" });
    const result = await computeNpm(h.inputs);
    expect(JSON.parse(result.files.get("package-lock.json")!).packages[h.path].version).toBe("24.20.0");
    expect(result.notes).toContainEqual(expect.stringContaining("cannot read a supported Node major"));
  });

  it("refuses a new induced type copy without runtime evidence", async () => {
    const h = await nodeTypesFixture({ kind: "major" });
    await expect(computeNpm(h.inputs)).rejects.toThrow("no eligible target");
  });

  it("refuses a major whose parent requires a Node-type major above the runtime", async () => {
    const h = await nodeTypesFixture({ kind: "major", runtime: 24, base: "24.19.0", range: "^26" });
    await expect(computeNpm(h.inputs)).rejects.toThrow("no eligible target");
  });

  it("runs install/update/pin/install/restore/install with every release-age flag, returning only changed files", async () => {
    const h = await fixture(async (dir, args, n) => {
      const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
      if (n <= 3) {
        expect(manifest.dependencies.parent).toBe(n <= 2 ? "1.1.0" : "^1.1.0");
        expect(manifest.dependencies.frozen).toBe(n <= 2 ? "1.0.0" : "^1.0.0");
        await writeFile(join(dir, "package-lock.json"), json(lock("1.2.0", "1.0.0", "1.2.0")));
      } else if (n === 4) {
        expect(manifest.dependencies).toEqual({ parent: "1.1.0", frozen: "1.0.0" });
        expect(manifest.overrides).toEqual({ "child@1.0.0": "1.1.0" });
        await writeFile(join(dir, "package-lock.json"), json(lock("1.1.0", "1.1.0", "1.0.0")));
      } else {
        expect(manifest.dependencies).toEqual({ parent: "^1.1.0", frozen: "^1.0.0" });
        expect(manifest.overrides).toBeUndefined();
      }
      expect(args).toContain("--min-release-age=7");
      expect(args).toContain("--min-release-age-exclude=@own/*");
      expect(args).toContain("--min-release-age-exclude=@other/*");
      expect(args).toContain("--ignore-scripts");
    });
    const result = await computeNpm(h.inputs);
    expect(h.calls.map((call) => call[0])).toEqual(["install", "update", "install", "install", "install"]);
    expect([...result.files.keys()]).toEqual(["package.json", "package-lock.json"]);
    expect(result.changes.map((change) => [change.name, change.to])).toEqual([["child", "1.1.0"], ["parent", "1.1.0"]]);
  });
  it("does no routine refresh for a major, and freezes other direct declarations", async () => {
    const h = await fixture(async (dir, _args, n) => {
      await writeFile(join(dir, "package-lock.json"), json(n === 1 ? lock("2.1.0", "1.0.0", "1.1.0") : lock("2.0.0", "1.0.0")));
    });
    await computeNpm({ ...h.inputs, kind: "major", moves: h.inputs.moves.map((move) => ({ ...move, to: "2.0.0" })) });
    expect(h.calls.map((call) => call[0])).toEqual(["install", "install"]);
  });
  it("fails a major that brings a deprecated or unverifiable new transitive version, and passes an eligible one", async () => {
    // The new transitive comes from the npm registry; one from git or another registry has no catalog to ask.
    const registryLock = (resolved: string) => {
      const base = lock("2.0.0", "1.5.0");
      return { ...base, packages: { ...base.packages, "node_modules/child": { version: "1.5.0", resolved } } };
    };
    const major = async (versions: (name: string) => Promise<ReadonlyArray<string> | undefined>, resolved = "https://registry.npmjs.org/child/-/child-1.5.0.tgz") => {
      const h = await fixture(async (dir) => { await writeFile(join(dir, "package-lock.json"), json(registryLock(resolved))); });
      return computeNpm({ ...h.inputs, kind: "major", moves: h.inputs.moves.map((move) => ({ ...move, to: "2.0.0" })), sources: { ...h.inputs.sources, versions } });
    };
    await expect(major(async (name) => name === "child" ? ["1.0.0"] : ["1.0.0", "2.0.0"])).rejects.toThrow("the major brings child@1.5.0, which is deprecated");
    await expect(major(async (name) => name === "child" ? undefined : ["1.0.0", "2.0.0"])).rejects.toThrow("can't be read to rule out deprecation");
    await expect(major(async (name) => name === "child" ? ["1.0.0", "1.5.0"] : ["1.0.0", "2.0.0"])).resolves.toBeDefined();
    await expect(major(async (name) => name === "child" ? undefined : ["1.0.0", "2.0.0"], "git+ssh://git@github.com/acme/child.git#abc")).resolves.toBeDefined();
  });
  it("fails after MAX_PASSES when npm keeps undoing the exact targets", async () => {
    const h = await fixture(async (dir) => { await writeFile(join(dir, "package-lock.json"), json(lock())); });
    await expect(computeNpm(h.inputs)).rejects.toThrow(`after ${MAX_PASSES} passes`);
    expect(h.calls).toHaveLength(3 + MAX_PASSES * 2);
  });
  it("refuses npm's unplanned manifest rewrite", async () => {
    const h = await fixture(async (dir) => {
      await writeFile(join(dir, "package-lock.json"), json(lock("1.1.0", "1.1.0")));
      await writeFile(join(dir, "package.json"), json({ ...manifest, dependencies: { ...manifest.dependencies, parent: "^1.1.0" }, scripts: { surprise: "true" } }));
    });
    await expect(computeNpm(h.inputs)).rejects.toThrow("npm rewrote package.json");
  });
  it("preserves manifest formatting and only returns a changed lockfile for a transitive refresh", async () => {
    const h = await fixture(async (dir) => { await writeFile(join(dir, "package-lock.json"), json(lock("1.0.0", "1.1.0"))); });
    const compact = JSON.stringify(manifest);
    await writeFile(join(h.dir, "package.json"), compact);
    const result = await computeNpm({ ...h.inputs, moves: [] });
    expect([...result.files.keys()]).toEqual(["package-lock.json"]);
    expect(await readFile(join(h.dir, "package.json"), "utf8")).toBe(compact);
  });
  it("fails clearly on an npm command failure", async () => {
    const h = await fixture();
    await expect(computeNpm({ ...h.inputs, npm: async () => ({ code: 1, stdout: "", stderr: "offline" }) })).rejects.toThrow("offline");
  });
  it("computes configured nested lockfiles and workspace aliases, returning their repo paths", async () => {
    const h = await fixture();
    const root = join(h.dir, "tools");
    await mkdir(join(root, "ws"), { recursive: true });
    const rootManifest = { name: "tools", workspaces: ["ws"] };
    const wsManifest = { dependencies: { compat: "npm:lib@^1.0.0" } };
    const base = { packages: { "": rootManifest, ws: wsManifest, "node_modules/compat": { name: "lib", version: "1.0.0" } } };
    await writeFile(join(root, "package.json"), json(rootManifest));
    await writeFile(join(root, "ws/package.json"), json(wsManifest));
    await writeFile(join(root, "package-lock.json"), json(base));
    const npm: NpmCommand = async (cwd, args) => {
      if (args[0] === "--version") {
        return { code: 0, stdout: "11.20.0", stderr: "" };
      }
      expect(cwd).toBe(root); expect(args[0]).toBe("install");
      expect(JSON.parse(await readFile(join(root, "ws/package.json"), "utf8")).dependencies.compat).toBe(h.calls.length === 0 ? "npm:lib@2.0.0" : "npm:lib@^2.0.0");
      h.calls.push([...args]);
      await writeFile(join(root, "package-lock.json"), json({ packages: { ...base.packages, ws: { dependencies: { compat: "npm:lib@^2.0.0" } }, "node_modules/compat": { name: "lib", version: "2.0.0" } } }));
      return { code: 0, stdout: "", stderr: "" };
    };
    const result = await computeNpm({ ...h.inputs, npm, kind: "major", baseLocks: new Map([["tools/package-lock.json", base]]), moves: [{ lockfile: "tools/package-lock.json", workspace: "ws", declaredAs: "compat", spec: "npm:lib@^1.0.0", name: "lib", to: "2.0.0" }] });
    expect([...result.files.keys()]).toEqual(["tools/ws/package.json", "tools/package-lock.json"]);
    expect(result.changes).toMatchObject([{ name: "lib", path: "node_modules/compat", to: "2.0.0" }]);
  });
  it("rejects a planned declaration disappearing instead of treating it as converged", async () => {
    const h = await fixture(async (dir) => { await writeFile(join(dir, "package-lock.json"), json({ packages: { "": {}, "node_modules/child": { version: "1.1.0" } } })); });
    await expect(computeNpm(h.inputs)).rejects.toThrow("planned declaration .:parent disappeared");
  });
  it("returns unresolved notes when failed lookups are held at base, without failing other moves", async () => {
    const h = await fixture(async (dir) => { await writeFile(join(dir, "package-lock.json"), json(lock("1.1.0"))); });
    const result = await computeNpm({ ...h.inputs, sources: { ...h.inputs.sources, versions: async () => undefined } });
    expect(result.notes).toMatchObject([expect.stringContaining("child at node_modules/child stays at 1.0.0")]);
    expect(result.changes).toMatchObject([{ name: "parent", to: "1.1.0" }]);
  });
  it("reports exact repository pins separately from unresolved lookups", async () => {
    const h = await fixture(async (dir) => {
      await writeFile(join(dir, "package-lock.json"), json(lock("1.1.0")));
    });
    await writeFile(join(h.dir, "package.json"), json({ ...manifest, overrides: { child: "1.0.0" } }));
    const result = await computeNpm(h.inputs);
    expect(result.notes).toEqual(["package-lock.json: child at node_modules/child is pinned at 1.0.0 by the repository override"]);
  });
  it("uses a configured shrinkwrap and refuses a shadowed package-lock", async () => {
    const h = await fixture();
    await writeFile(join(h.dir, "npm-shrinkwrap.json"), json(lock()));
    await expect(computeNpm(h.inputs)).rejects.toThrow("shadowed");
    const result = await computeNpm({ ...h.inputs, moves: [], kind: "major", baseLocks: new Map([["npm-shrinkwrap.json", lock()]]), npm: async () => ({ code: 0, stdout: "", stderr: "" }) });
    expect(result.files.size).toBe(0);
  });
  it("requires npm 11.17 only when trusted scopes need exclusion, with no registry call", async () => {
    const fake: NpmCommand = async (_dir, args) => { expect(args).toEqual(["--version"]); return { code: 0, stdout: "11.14.1\n", stderr: "" }; };
    await expect(requireNpmExcludes(fake, ".", ["@own/*"])).rejects.toThrow("11.17.0");
    await requireNpmExcludes(async () => { throw new Error("must not run"); }, ".", []);
    await requireNpmExcludes(async () => ({ code: 0, stdout: "11.20.0", stderr: "" }), ".", ["@own/*"]);
  });
  it("keeps a young locked transitive excluded from npm's window, even when a newer aged target exists", async () => {
    const h = await fixture();
    const published = vi.fn(async (name: string, version: string) => {
      return new Date(name === "child" && version !== "1.2.0" ? "2026-10-06" : "2026-09-01");
    });
    const npm: NpmCommand = async (dir, args) => {
      if (args[0] === "--version") {
        return { code: 0, stdout: "11.20.0", stderr: "" };
      }
      h.calls.push([...args]);
      if (!args.includes("--min-release-age-exclude=child")) {
        return { code: 1, stdout: "", stderr: "notarget No matching version found for child@1.0.0 with a date before the window" };
      }
      const root = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
      if (args[0] === "update") {
        expect(root.overrides).toEqual({ "child@1.0.0": "1.0.0" });
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const result = await computeNpm({
      ...h.inputs,
      moves: [],
      npm,
      sources: { ...h.inputs.sources, published, versions: async () => ["1.0.0", "1.2.0", "1.3.0"] },
    });
    expect(h.calls.map((args) => args[0])).toEqual(["install", "update", "install"]);
    for (const args of h.calls) {
      expect(args.filter((arg) => arg.startsWith("--min-release-age-exclude=")))
        .toEqual(["--min-release-age-exclude=@other/*", "--min-release-age-exclude=@own/*", "--min-release-age-exclude=child"]);
      expect(args).toContain("--min-release-age=7");
    }
    expect(result.notes).toEqual(["child: its locked 1.0.0 is younger than the window, so npm's own window skips it; bump-it's targets still require the age"]);
    expect(result.changes).toEqual([]);
    const lookups = published.mock.calls.map(([name, version]) => `${name}@${version}`);
    expect(lookups.filter((key) => key === "child@1.0.0")).toHaveLength(1);
    expect(new Set(lookups).size).toBe(lookups.length);
  });
  it("holds young locked vite through install, update and later pins without resolving its newer young dependencies", async () => {
    const h = await fixture();
    const base = { ...lock(), packages: {
      ...lock().packages,
      "node_modules/parent": { version: "1.0.0", dependencies: { child: "^1", vite: "^8" } },
      "node_modules/vite": { version: "8.3.3" },
    } };
    await writeFile(join(h.dir, "package-lock.json"), json(base));
    let child = "1.0.0";
    const npm: NpmCommand = async (dir, args) => {
      if (args[0] === "--version") return { code: 0, stdout: "11.20.0", stderr: "" };
      h.calls.push([...args]);
      expect(args).toContain("--min-release-age-exclude=vite");
      const root = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
      const resolving = h.calls.length <= 2 || h.calls.length === 4;
      if (resolving && root.overrides?.["vite@8.3.3"] !== "8.3.3") {
        // npm's name exclusion would choose vite 8.3.4, whose postcss range has no aged version.
        return { code: 1, stdout: "", stderr: "notarget postcss@^8.5.29 with a date before the release window" };
      }
      if (args[0] === "update") child = "1.2.0";
      if (root.overrides?.["child@1.2.0"] === "1.1.0") child = "1.1.0";
      if (!resolving) expect(root).toEqual(manifest);
      await writeFile(join(dir, "package-lock.json"), json({ ...base, packages: { ...base.packages, "node_modules/child": { version: child } } }));
      return { code: 0, stdout: "", stderr: "" };
    };
    const result = await computeNpm({
      ...h.inputs, npm, moves: [], baseLocks: new Map([["package-lock.json", base]]),
      sources: { ...h.inputs.sources, now: new Date("2026-10-11"),
        versions: async (name) => name === "vite" ? ["8.3.2", "8.3.3", "8.3.4"] : ["1.0.0", "1.1.0", "1.2.0"],
        published: async (name, version) => new Date(name === "vite" && version !== "8.3.2" || version === "1.2.0" ? "2026-10-06" : "2026-09-01"),
      },
    });
    expect(h.calls.map((args) => args[0])).toEqual(["install", "update", "install", "install", "install"]);
    expect(JSON.parse(await readFile(join(h.dir, "package-lock.json"), "utf8")).packages["node_modules/vite"].version).toBe("8.3.3");
    expect(result.changes).toEqual([{ lockfile: "package-lock.json", path: "node_modules/child", name: "child", from: "1.0.0", to: "1.1.0" }]);
    expect(await readFile(join(h.dir, "package.json"), "utf8")).toBe(json(manifest));
  });
  it("reports a package whose copies only moved between paths as re-hoisted, next to the unchanged per-path changes", async () => {
    const h = await fixture();
    const { "node_modules/child": _hoisted, ...others } = lock().packages;
    const base = { ...lock(), packages: { ...others, "node_modules/parent/node_modules/child": { version: "1.0.0" } } };
    await writeFile(join(h.dir, "package-lock.json"), json(base));
    const npm: NpmCommand = async (dir, args) => {
      if (args[0] === "--version") return { code: 0, stdout: "11.20.0", stderr: "" };
      await writeFile(join(dir, "package-lock.json"), json(lock()));
      return { code: 0, stdout: "", stderr: "" };
    };
    const result = await computeNpm({ ...h.inputs, npm, moves: [], baseLocks: new Map([["package-lock.json", base]]), sources: { ...h.inputs.sources, versions: async () => ["1.0.0"] } });
    expect(result.changes).toEqual([
      { lockfile: "package-lock.json", path: "node_modules/child", name: "child", from: undefined, to: "1.0.0" },
      { lockfile: "package-lock.json", path: "node_modules/parent/node_modules/child", name: "child", from: "1.0.0", to: undefined },
    ]);
    expect(result.rehoisted).toEqual(["package-lock.json\0child"]);
  });
  it.each(["missing", "throwing", "invalid"])("excludes an unreadable locked publish time (%s), notes it and keeps the base target", async (failure) => {
    const h = await fixture();
    const published = vi.fn(async (name: string) => {
      if (name !== "child") {
        return new Date("2026-09-01");
      }
      if (failure === "throwing") {
        throw new Error("offline");
      }
      return failure === "invalid" ? new Date("invalid") : undefined;
    });
    const result = await computeNpm({ ...h.inputs, moves: [], sources: { ...h.inputs.sources, published } });
    expect(h.calls.every((args) => args.includes("--min-release-age-exclude=child"))).toBe(true);
    expect(result.notes).toContain("child: publish time for its locked 1.0.0 could not be read, so npm's own window skips it; bump-it's targets still require the age");
    expect(result.changes).toEqual([]);
    expect(published.mock.calls.filter(([name]) => name === "child")).toHaveLength(1);
  });
  it("keeps a young locked base when no newer aged target exists", async () => {
    const h = await fixture();
    const result = await computeNpm({
      ...h.inputs,
      moves: [],
      sources: { ...h.inputs.sources, published: async () => new Date("2026-10-06") },
    });
    expect(result.changes).toEqual([]);
    expect(result.notes).toHaveLength(3);
    expect(h.calls.every((args) => args.includes("--min-release-age-exclude=child"))).toBe(true);
  });
  it.each(["unchanged", "carrier update"])("lets a young bundled copy follow its carrier (%s)", async (change) => {
    const h = await fixture();
    const path = "node_modules/parent/node_modules/bundled";
    const base = { ...lock(), packages: { ...lock().packages,
      [path]: { version: "1.0.0", inBundle: true },
    } };
    await writeFile(join(h.dir, "package-lock.json"), json(base));
    const npm: NpmCommand = async (dir, args) => {
      if (args[0] === "--version") return { code: 0, stdout: "11.20.0", stderr: "" };
      h.calls.push([...args]);
      const root = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
      expect(root.overrides).toBeUndefined();
      await writeFile(join(dir, "package-lock.json"), json({ ...base, packages: { ...base.packages,
        "node_modules/parent": { ...base.packages["node_modules/parent"], version: change === "carrier update" ? "1.1.0" : "1.0.0" },
        [path]: { version: change === "carrier update" ? "1.1.0" : "1.0.0", inBundle: true },
      } }));
      return { code: 0, stdout: "", stderr: "" };
    };
    const result = await computeNpm({ ...h.inputs, npm, moves: change === "carrier update" ? h.inputs.moves : [],
      baseLocks: new Map([["package-lock.json", base]]),
      sources: { ...h.inputs.sources, versions: async () => ["1.0.0"],
        published: async (name) => new Date(name === "bundled" ? "2026-10-06" : "2026-09-01"),
      },
    });
    expect(h.calls.map((args) => args[0])).toEqual(["install", "update", "install"]);
    expect(result.changes).toEqual(change === "unchanged" ? [] : [
      { lockfile: "package-lock.json", path: "node_modules/parent", name: "parent", from: "1.0.0", to: "1.1.0" },
      { lockfile: "package-lock.json", path, name: "bundled", from: "1.0.0", to: "1.1.0" },
    ]);
  });
  it("keeps different locked versions under a shared override without EOVERRIDE, including later passes", async () => {
    const h = await fixture();
    const path = "node_modules/parent/node_modules/held";
    const root = { ...manifest, dependencies: { ...manifest.dependencies, held: "^1 || ^2" }, overrides: { held: "^1 || ^2" } };
    const base = { ...lock(), packages: { ...lock().packages, "": root,
      "node_modules/parent": { version: "1.0.0", dependencies: { child: "^1", held: "^1" } },
      "node_modules/held": { version: "2.0.0" }, [path]: { version: "1.9.0" },
    } };
    await writeFile(join(h.dir, "package.json"), json(root));
    await writeFile(join(h.dir, "package-lock.json"), json(base));
    let child = "1.0.0";
    const npm: NpmCommand = async (dir, args) => {
      if (args[0] === "--version") return { code: 0, stdout: "11.20.0", stderr: "" };
      h.calls.push([...args]);
      const current = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
      // npm rejects a name-level self-override that differs from the direct spec.
      if (current.overrides.held !== current.dependencies.held) return { code: 1, stdout: "", stderr: "EOVERRIDE held" };
      expect(current.overrides.held).toBe(h.calls.length <= 2 || h.calls.length === 4 ? "2.0.0" : "^1 || ^2");
      if (args[0] === "update") child = "1.2.0";
      if (current.overrides["child@1.2.0"] === "1.1.0") child = "1.1.0";
      await writeFile(join(dir, "package-lock.json"), json({ ...base, packages: { ...base.packages, "node_modules/child": { version: child } } }));
      return { code: 0, stdout: "", stderr: "" };
    };
    const result = await computeNpm({ ...h.inputs, npm, moves: [], baseLocks: new Map([["package-lock.json", base]]),
      sources: { ...h.inputs.sources,
        versions: async (name) => name === "held" ? ["1.9.0", "2.0.0"] : name === "child" ? ["1.0.0", "1.1.0", "1.2.0"] : ["1.0.0"],
        published: async (name, version) => new Date(name === "held" && version === "1.9.0" || version === "1.2.0" ? "2026-10-06" : "2026-09-01"),
      },
    });
    expect(result.changes).toEqual([{ lockfile: "package-lock.json", path: "node_modules/child", name: "child", from: "1.0.0", to: "1.1.0" }]);
    expect(h.calls.map((args) => args[0])).toEqual(["install", "update", "install", "install", "install"]);
    expect(await readFile(join(h.dir, "package.json"), "utf8")).toBe(json(root));
  });
  it.each(["override", "plain override", "nested peer"])("keeps a young %s copy with supported pins only, including later passes", async (placement) => {
    const h = await fixture();
    const path = placement === "nested peer" ? "node_modules/parent/node_modules/held" : "node_modules/held";
    const root = placement === "override" ? { ...manifest, overrides: { "held@1.0.0": "1.0.0" } }
      : placement === "plain override" ? { ...manifest, overrides: { held: "^1" } } : manifest;
    const base = { ...lock(), packages: { ...lock().packages, "": root,
      "node_modules/parent": { version: "1.0.0", dependencies: { child: "^1", ...(placement === "nested peer" ? { plugin: "^1" } : { held: "^1" }) } },
      ...(placement === "nested peer" ? { "node_modules/parent/node_modules/plugin": { version: "1.0.0", peerDependencies: { held: "^1" } } } : {}),
      [path]: { version: "1.0.0" },
    } };
    await writeFile(join(h.dir, "package.json"), json(root));
    await writeFile(join(h.dir, "package-lock.json"), json(base));
    let child = "1.0.0";
    const npm: NpmCommand = async (dir, args) => {
      if (args[0] === "--version") return { code: 0, stdout: "11.20.0", stderr: "" };
      h.calls.push([...args]);
      const current = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
      expect(current.overrides?.["held@1.0.0"]).toBe(placement === "override" ? "1.0.0" : undefined);
      if (placement === "plain override") expect(current.overrides.held).toBe(h.calls.length <= 2 || h.calls.length === 4 ? "1.0.0" : "^1");
      expect(current.devDependencies).toBeUndefined();
      if (args[0] === "update") child = "1.2.0";
      if (current.overrides?.["child@1.2.0"] === "1.1.0") child = "1.1.0";
      await writeFile(join(dir, "package-lock.json"), json({ ...base, packages: { ...base.packages, "node_modules/child": { version: child } } }));
      return { code: 0, stdout: "", stderr: "" };
    };
    const result = await computeNpm({ ...h.inputs, npm, moves: [], baseLocks: new Map([["package-lock.json", base]]),
      sources: { ...h.inputs.sources, versions: async (name) => name === "child" ? ["1.0.0", "1.1.0", "1.2.0"] : ["1.0.0"],
        published: async (name, version) => new Date(name === "held" || version === "1.2.0" ? "2026-10-06" : "2026-09-01"),
      },
    });
    expect(h.calls.map((args) => args[0])).toEqual(["install", "update", "install", "install", "install"]);
    expect(result.changes).toMatchObject([{ name: "child", to: "1.1.0" }]);
    expect(result.changes).toHaveLength(1);
    expect(await readFile(join(h.dir, "package.json"), "utf8")).toBe(json(root));
  });
  it.each([
    { placement: "override", outcome: "1.1.0", later: false },
    { placement: "override", outcome: "removed", later: false },
    { placement: "nested peer", outcome: "1.1.0", later: false },
    { placement: "nested peer", outcome: "removed", later: false },
    { placement: "nested peer", outcome: "1.1.0", later: true },
  ])("checks an unpinnable young $placement after resolution ($outcome, later=$later)", async ({ placement, outcome, later }) => {
    const h = await fixture();
    const path = placement === "override" ? "node_modules/held" : "node_modules/parent/node_modules/held";
    const root = placement === "override" ? { ...manifest, overrides: { "held@1.0.0": "1.0.0" } } : manifest;
    const base = { ...lock(), packages: { ...lock().packages, "": root,
      "node_modules/parent": { version: "1.0.0", dependencies: { child: "^1", ...(placement === "override" ? { held: "^1" } : { plugin: "^1" }) } },
      ...(placement === "nested peer" ? { "node_modules/parent/node_modules/plugin": { version: "1.0.0", peerDependencies: { held: "^1" } } } : {}),
      [path]: { version: "1.0.0" },
    } };
    await writeFile(join(h.dir, "package.json"), json(root));
    await writeFile(join(h.dir, "package-lock.json"), json(base));
    const npm: NpmCommand = async (dir, args) => {
      if (args[0] === "--version") return { code: 0, stdout: "11.20.0", stderr: "" };
      h.calls.push([...args]);
      const packages: Record<string, unknown> = { ...base.packages };
      if (outcome === "removed") {
        delete packages[path];
        delete packages["node_modules/parent/node_modules/plugin"];
        packages["node_modules/parent"] = { version: "1.0.0", dependencies: { child: "^1" } };
      } else if (!later || h.calls.length >= 4) packages[path] = { version: outcome };
      if (later) packages["node_modules/child"] = { version: h.calls.length >= 4 ? "1.1.0" : "1.2.0" };
      await writeFile(join(dir, "package-lock.json"), json({ ...base, packages }));
      return { code: 0, stdout: "", stderr: "" };
    };
    const result = computeNpm({ ...h.inputs, npm, moves: [], baseLocks: new Map([["package-lock.json", base]]),
      sources: { ...h.inputs.sources, versions: async () => later ? ["1.0.0", "1.1.0", "1.2.0"] : ["1.0.0"],
        published: async (name, version) => new Date(name === "held" || version === "1.2.0" ? "2026-10-06" : "2026-09-01"),
      },
    });
    if (outcome === "removed") {
      expect((await result).changes).toContainEqual({ lockfile: "package-lock.json", path, name: "held", from: "1.0.0", to: undefined });
    } else {
      await expect(result).rejects.toThrow(`held at ${path} is 1.1.0, not its locked 1.0.0; cannot pin this copy`);
    }
    expect(h.calls.map((args) => args[0])).toEqual(later ? ["install", "update", "install", "install", "install"] : ["install", "update", "install"]);
  });
  it.each([
    { stage: "initial resolution", deprecated: false },
    { stage: "later pin pass", deprecated: false },
    { stage: "initial resolution", deprecated: true },
    { stage: "later pin pass", deprecated: true },
  ])("checks aged drift of an unpinnable young peer alongside an unrelated update ($stage, deprecated=$deprecated)", async ({ stage, deprecated }) => {
    const h = await fixture();
    const path = "node_modules/parent/node_modules/held";
    const base = { ...lock(), packages: { ...lock().packages,
      "node_modules/parent": { version: "1.0.0", dependencies: { child: "^1", plugin: "^1" } },
      "node_modules/parent/node_modules/plugin": { version: "1.0.0", peerDependencies: { held: "^1" } },
      [path]: { version: "1.0.1" },
    } };
    await writeFile(join(h.dir, "package-lock.json"), json(base));
    const published = vi.fn(async (name: string, version: string) => new Date(
      name === "held" && version === "1.0.1" || version === "1.2.0" ? "2026-10-06" : "2026-09-30T12:00:00Z",
    ));
    const catalog = new NpmCatalog(new NpmRegistry(async () => new Response(JSON.stringify({
      time: { "1.0.1": "2026-10-06", "1.1.0": "2026-09-30T12:00:00Z" },
      versions: { "1.0.1": {}, "1.1.0": { deprecated: deprecated ? "use a supported release" : "" } },
    }))));
    expect(await catalog.versions({ ecosystem: "npm", name: "held" })).toEqual(deprecated ? ["1.0.1"] : ["1.0.1", "1.1.0"]);
    const npm: NpmCommand = async (dir, args) => {
      if (args[0] === "--version") return { code: 0, stdout: "11.20.0", stderr: "" };
      h.calls.push([...args]);
      const root = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
      expect(root.devDependencies).toBeUndefined();
      const child = root.overrides?.["child@1.2.0"] === "1.1.0" || h.calls.length >= 5 ? "1.1.0" : "1.2.0";
      const held = stage === "initial resolution" || h.calls.length >= 4 ? "1.1.0" : "1.0.1";
      await writeFile(join(dir, "package-lock.json"), json({ ...base, packages: { ...base.packages,
        "node_modules/child": { version: child }, [path]: { version: held },
      } }));
      return { code: 0, stdout: "", stderr: "" };
    };
    const computed = computeNpm({ ...h.inputs, npm, moves: [], baseLocks: new Map([["package-lock.json", base]]),
      sources: { ...h.inputs.sources, now: new Date("2026-10-07T12:00:00Z"), published,
        versions: async (name) => name === "held" ? catalog.versions({ ecosystem: "npm", name })
          : name === "child" ? ["1.0.0", "1.0.1", "1.1.0", "1.2.0"] : ["1.0.0"],
      },
    });
    if (deprecated) {
      await expect(computed).rejects.toThrow(`held at ${path} is 1.1.0, not its locked 1.0.1; cannot pin this copy and its replacement is young, deprecated or unreadable`);
      expect(h.calls.map((args) => args[0])).toEqual(stage === "initial resolution"
        ? ["install", "update", "install"] : ["install", "update", "install", "install", "install"]);
      return;
    }
    const result = await computed;
    expect(result.changes).toEqual([
      { lockfile: "package-lock.json", path: "node_modules/child", name: "child", from: "1.0.0", to: "1.1.0" },
      { lockfile: "package-lock.json", path, name: "held", from: "1.0.1", to: "1.1.0" },
    ]);
    expect(h.calls.map((args) => args[0])).toEqual(["install", "update", "install", "install", "install"]);
    expect(published.mock.calls.filter(([name, version]) => name === "held" && version === "1.1.0")).toHaveLength(1);
  });
  it("keeps an accepted aged move once its copy becomes pinnable in a later pass", async () => {
    const h = await fixture();
    const path = "node_modules/parent/node_modules/held";
    const anchored = {
      "node_modules/parent": { version: "1.0.0", dependencies: { child: "^1", plugin: "^1" } },
      "node_modules/parent/node_modules/plugin": { version: "1.0.0", peerDependencies: { held: "^1" } },
    };
    const base = { ...lock(), packages: { ...lock().packages, ...anchored, [path]: { version: "1.0.1" } } };
    await writeFile(join(h.dir, "package-lock.json"), json(base));
    const heldPins: unknown[] = [];
    const npm: NpmCommand = async (dir, args) => {
      if (args[0] === "--version") return { code: 0, stdout: "11.20.0", stderr: "" };
      h.calls.push([...args]);
      const root = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
      if (root.overrides?.["held@1.1.0"] !== undefined) heldPins.push(root.overrides["held@1.1.0"]);
      // child drifts back to its young version on every restore until the third pin pass settles it.
      const child = root.overrides?.["child@1.2.0"] === "1.1.0" || h.calls.length >= 7 ? "1.1.0" : "1.2.0";
      // From the first pin pass on, the peer anchor is gone and held becomes a plain, pinnable dependency.
      const parent = h.calls.length >= 4
        ? { "node_modules/parent": { version: "1.0.0", dependencies: { child: "^1", held: "^1" } } }
        : anchored;
      await writeFile(join(dir, "package-lock.json"), json({ ...base, packages: { ...lock().packages, ...parent,
        "node_modules/child": { version: child }, [path]: { version: root.overrides?.["held@1.1.0"] ?? "1.1.0" },
      } }));
      return { code: 0, stdout: "", stderr: "" };
    };
    const result = await computeNpm({ ...h.inputs, npm, moves: [], baseLocks: new Map([["package-lock.json", base]]),
      sources: { ...h.inputs.sources, now: new Date("2026-10-07T12:00:00Z"),
        published: async (name, version) => new Date(name === "held" && version === "1.0.1" || version === "1.2.0" ? "2026-10-06" : "2026-09-30T12:00:00Z"),
        versions: async (name) => name === "held" ? ["1.0.1", "1.1.0"] : name === "child" ? ["1.0.0", "1.0.1", "1.1.0", "1.2.0"] : ["1.0.0"],
      },
    });
    expect(result.changes).toContainEqual({ lockfile: "package-lock.json", path, name: "held", from: "1.0.1", to: "1.1.0" });
    expect(heldPins).toContain("1.1.0");
    expect(heldPins).not.toContain("1.0.1");
    expect(h.calls.map((args) => args[0])).toEqual(["install", "update", "install", "install", "install", "install", "install"]);
  });
  it.each([
    { constraint: "a range", spec: "^2", overrides: undefined },
    { constraint: "a non-range spec", spec: "https://registry.npmjs.org/held/-/held-2.0.0.tgz", overrides: undefined },
    { constraint: "a scoped override", spec: "^1 || ^2", overrides: { "parent@1.0.0": { held: "^2" } } },
  ])("checks the current replacement again when $constraint drops a remembered aged move", async ({ spec, overrides }) => {
    const h = await fixture();
    const path = "node_modules/parent/node_modules/held";
    const anchored = {
      "node_modules/parent": { version: "1.0.0", dependencies: { child: "^1", plugin: "^1" } },
      "node_modules/parent/node_modules/plugin": { version: "1.0.0", peerDependencies: { held: "^1" } },
    };
    const root = overrides === undefined ? manifest : { ...manifest, overrides };
    const base = { ...lock(), packages: { ...lock().packages, "": root, ...anchored, [path]: { version: "1.0.1" } } };
    await writeFile(join(h.dir, "package.json"), json(root));
    await writeFile(join(h.dir, "package-lock.json"), json(base));
    const npm: NpmCommand = async (dir, args) => {
      if (args[0] === "--version") return { code: 0, stdout: "11.20.0", stderr: "" };
      h.calls.push([...args]);
      const root = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
      const child = root.overrides?.["child@1.2.0"] === "1.1.0" || h.calls.length >= 7 ? "1.1.0" : "1.2.0";
      // held becomes pinnable at 1.1.0 after the first pin pass; from the second, its parent asks for ^2.
      const held = h.calls.length >= 6 ? "2.0.0" : "1.1.0";
      const parent = h.calls.length >= 4
        ? { "node_modules/parent": { version: "1.0.0", dependencies: { child: "^1", held: h.calls.length >= 6 ? spec : "^1" } } }
        : anchored;
      await writeFile(join(dir, "package-lock.json"), json({ ...base, packages: { ...lock().packages, "": root, ...parent,
        "node_modules/child": { version: child }, [path]: { version: held },
      } }));
      return { code: 0, stdout: "", stderr: "" };
    };
    const result = await computeNpm({ ...h.inputs, npm, moves: [], baseLocks: new Map([["package-lock.json", base]]),
      sources: { ...h.inputs.sources, now: new Date("2026-10-07T12:00:00Z"),
        published: async (name, version) => new Date(name === "held" && version === "1.0.1" || version === "1.2.0" ? "2026-10-06" : "2026-09-30T12:00:00Z"),
        versions: async (name) => name === "held" ? ["1.0.1", "1.1.0", "2.0.0"] : name === "child" ? ["1.0.0", "1.0.1", "1.1.0", "1.2.0"] : ["1.0.0"],
      },
    });
    expect(result.changes).toContainEqual({ lockfile: "package-lock.json", path, name: "held", from: "1.0.1", to: "2.0.0" });
    expect(h.calls.map((args) => args[0])).toEqual(["install", "update", "install", "install", "install", "install", "install"]);
  });
  /** held 1.0.1 is young and locked; after the routine, the planned parent asks for `spec` and npm resolves held 2.0.0. */
  async function refreshedParent(spec: string, extra: Record<string, unknown> = {}, published = (name: string, version: string) => new Date(name === "held" && version === "1.0.1" ? "2026-10-06" : "2026-09-01"), heldVersions = ["1.0.1", "2.0.0"]) {
    const h = await fixture();
    const base = { ...lock(), packages: { ...lock().packages, ...extra,
      "node_modules/parent": { version: "1.0.0", dependencies: { child: "^1", held: "^1" } }, "node_modules/held": { version: "1.0.1" } } };
    await writeFile(join(h.dir, "package-lock.json"), json(base));
    const npm: NpmCommand = async (dir, args) => {
      if (args[0] === "--version") return { code: 0, stdout: "11.20.0", stderr: "" };
      h.calls.push([...args]);
      const root = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
      await writeFile(join(dir, "package-lock.json"), json({ ...base, packages: { ...base.packages, "": root,
        "node_modules/parent": { version: "1.1.0", dependencies: { child: "^1", held: spec } }, "node_modules/held": { version: "2.0.0" } } }));
      return { code: 0, stdout: "", stderr: "" };
    };
    return computeNpm({ ...h.inputs, npm, baseLocks: new Map([["package-lock.json", base]]),
      sources: { ...h.inputs.sources, published: async (name, version) => published(name, version),
        versions: async (name) => name === "held" ? heldVersions : name === "child" ? ["1.0.0"] : ["1.0.0", "1.1.0"] },
    });
  }
  it("checks the current version again when an updated parent no longer admits a retained locked copy", async () => {
    const result = await refreshedParent("^2");
    expect(result.changes).toContainEqual({ lockfile: "package-lock.json", path: "node_modules/held", name: "held", from: "1.0.1", to: "2.0.0" });
  });
  it.each([
    { replacement: "young", published: (name: string) => new Date(name === "held" ? "2026-10-06" : "2026-09-01"), versions: ["1.0.1", "2.0.0"] },
    { replacement: "deprecated", published: (name: string, version: string) => new Date(name === "held" && version === "1.0.1" ? "2026-10-06" : "2026-09-01"), versions: ["1.0.1"] },
  ])("still refuses a $replacement version an updated parent's range brings in place of a retained copy", async ({ published, versions }) => {
    await expect(refreshedParent("^2", {}, published, versions))
      .rejects.toThrow("held at node_modules/held is 2.0.0, not its locked 1.0.1; cannot pin this copy and its replacement is young, deprecated or unreadable");
  });
  it("keeps pinning a retained copy when one of its dependents' constraints can't be judged, even if another range rejects it", async () => {
    // tool's spec isn't a version range: the locked version stays the target, as before, and npm can't land it here.
    await expect(refreshedParent("^2", { "node_modules/tool": { version: "1.0.0", dependencies: { held: "github:acme/held#v1" } } }))
      .rejects.toThrow("npm didn't keep the targets in package-lock.json after 4 passes: held at node_modules/held is 2.0.0, not 1.0.1");
  });
  it.each(["young", "missing", "invalid", "throwing"])("rejects unpinned drift when the replacement's publish time is %s", async (time) => {
    const h = await fixture();
    const path = "node_modules/parent/node_modules/held";
    const base = { ...lock(), packages: { ...lock().packages,
      "node_modules/parent": { version: "1.0.0", dependencies: { child: "^1", plugin: "^1" } },
      "node_modules/parent/node_modules/plugin": { version: "1.0.0", peerDependencies: { held: "^1" } },
      [path]: { version: "1.0.1" },
    } };
    await writeFile(join(h.dir, "package-lock.json"), json(base));
    const npm: NpmCommand = async (dir, args) => {
      if (args[0] === "--version") return { code: 0, stdout: "11.20.0", stderr: "" };
      h.calls.push([...args]);
      await writeFile(join(dir, "package-lock.json"), json({ ...base, packages: { ...base.packages, [path]: { version: "1.1.0" } } }));
      return { code: 0, stdout: "", stderr: "" };
    };
    await expect(computeNpm({ ...h.inputs, npm, moves: [], baseLocks: new Map([["package-lock.json", base]]),
      sources: { ...h.inputs.sources, published: async (name, version) => {
        if (name !== "held") return new Date("2026-09-01");
        if (version === "1.0.1" || time === "young") return new Date("2026-10-06");
        if (time === "throwing") throw new Error("offline");
        return time === "invalid" ? new Date("invalid") : undefined;
      } },
    })).rejects.toThrow("not its locked 1.0.1; cannot pin this copy");
    expect(h.calls.map((args) => args[0])).toEqual(["install", "update", "install"]);
  });
  it("retains distinct locked copies of an excluded name, including its aged copy", async () => {
    const h = await fixture();
    const base = { ...lock(), packages: { ...lock().packages,
      "node_modules/frozen": { version: "1.0.0", dependencies: { child: "^2" } },
      "node_modules/frozen/node_modules/child": { version: "2.0.0" },
    } };
    await writeFile(join(h.dir, "package-lock.json"), json(base));
    const versions = vi.fn(async () => ["1.0.0", "1.1.0", "2.0.0", "2.1.0"]);
    const npm: NpmCommand = async (dir, args) => {
      if (args[0] === "--version") return { code: 0, stdout: "11.20.0", stderr: "" };
      const root = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
      h.calls.push([...args]);
      if (h.calls.length <= 2) expect(root.overrides).toEqual({ "child@1.0.0": "1.0.0", "child@2.0.0": "2.0.0" });
      return { code: 0, stdout: "", stderr: "" };
    };
    const result = await computeNpm({ ...h.inputs, npm, moves: [], baseLocks: new Map([["package-lock.json", base]]),
      sources: { ...h.inputs.sources, versions,
        published: async (name, version) => new Date(name === "child" && version === "1.0.0" ? "2026-10-06" : "2026-09-01"),
      },
    });
    expect(result.changes).toEqual([]);
    expect(versions).not.toHaveBeenCalled();
  });
  it.each(["configured", "trusted"])("still refreshes a transitive with only a %s age exemption", async (exemption) => {
    const h = await fixture(async (dir) => { await writeFile(join(dir, "package-lock.json"), json(lock("1.0.0", "1.1.0"))); });
    const result = await computeNpm({ ...h.inputs, moves: [], window: { days: 7, exclude: ["child"] },
      sources: { ...h.inputs.sources, isTrusted: (name) => exemption === "trusted" && name === "child",
        published: async () => new Date(exemption === "trusted" ? "2026-10-06" : "2026-09-01"),
      },
    });
    expect(result.changes).toMatchObject([{ name: "child", from: "1.0.0", to: "1.1.0" }]);
  });
  it("allows a direct update to remove a retained transitive it no longer needs", async () => {
    const h = await fixture(async (dir, _args, n) => {
      const base = lock();
      const { "node_modules/child": _child, ...packages } = base.packages;
      const root = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
      if (n <= 2) expect(root.overrides).toEqual({ "child@1.0.0": "1.0.0" });
      else expect(root.overrides).toBeUndefined();
      await writeFile(join(dir, "package-lock.json"), json({ ...base, packages: {
        ...packages, "node_modules/parent": { version: "1.1.0" },
      } }));
    });
    const result = await computeNpm({ ...h.inputs,
      sources: { ...h.inputs.sources, published: async (name) => new Date(name === "child" ? "2026-10-06" : "2026-09-01") },
    });
    expect(result.changes).toEqual([
      { lockfile: "package-lock.json", path: "node_modules/child", name: "child", from: "1.0.0", to: undefined },
      { lockfile: "package-lock.json", path: "node_modules/parent", name: "parent", from: "1.0.0", to: "1.1.0" },
    ]);
    expect(JSON.parse(result.files.get("package-lock.json")!).packages["node_modules/child"]).toBeUndefined();
    expect(h.calls.map((args) => args[0])).toEqual(["install", "update", "install"]);
  });
  it("fails clearly if npm keeps a retained copy at a different version after every pin pass", async () => {
    const h = await fixture(async (dir) => {
      await writeFile(join(dir, "package-lock.json"), json(lock("1.0.0", "1.1.0")));
    });
    await expect(computeNpm({ ...h.inputs, moves: [],
      sources: { ...h.inputs.sources, published: async (name) => new Date(name === "child" ? "2026-10-06" : "2026-09-01") },
    })).rejects.toThrow(`after ${MAX_PASSES} passes: child at node_modules/child is 1.1.0, not 1.0.0`);
  });
  it("keeps a young locked direct at its base version through a routine and later pins", async () => {
    let frozen = "1.0.0";
    let child = "1.0.0";
    const h = await fixture(async (dir, args, n) => {
      const root = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
      expect(args).toContain("--min-release-age-exclude=frozen");
      const pinned = n <= 2 || n === 4;
      expect(root.dependencies.frozen).toBe(pinned ? "1.0.0" : "^1.0.0");
      if (args[0] === "update") {
        // Without an exact direct declaration the name exemption would select young 1.1.0.
        frozen = root.dependencies.frozen === "1.0.0" ? "1.0.0" : "1.1.0";
        child = "1.2.0";
      }
      if (root.overrides?.["child@1.2.0"] === "1.1.0") child = "1.1.0";
      await writeFile(join(dir, "package-lock.json"), json(lock("1.1.0", child, frozen)));
    });
    const result = await computeNpm({ ...h.inputs,
      sources: { ...h.inputs.sources, versions: async () => ["1.0.0", "1.1.0", "1.2.0"],
        published: async (name, version) => new Date(name === "frozen" || version === "1.2.0" ? "2026-10-06" : "2026-09-01"),
      },
    });
    expect(JSON.parse(result.files.get("package-lock.json")!).packages["node_modules/frozen"].version).toBe("1.0.0");
    expect(result.changes.map((change) => change.name)).toEqual(["child", "parent"]);
    expect(h.calls.map((args) => args[0])).toEqual(["install", "update", "install", "install", "install"]);
  });
  it("leaves a major's induced transitive changes to verification even with a young locked base", async () => {
    const h = await fixture(async (dir) => { await writeFile(join(dir, "package-lock.json"), json(lock("2.0.0", "1.1.0"))); });
    const result = await computeNpm({ ...h.inputs, kind: "major", moves: h.inputs.moves.map((move) => ({ ...move, to: "2.0.0" })),
      sources: { ...h.inputs.sources, published: async (name) => new Date(name === "child" ? "2026-10-06" : "2026-09-01") },
    });
    expect(result.changes).toMatchObject([{ name: "child", to: "1.1.0" }, { name: "parent", to: "2.0.0" }]);
    expect(h.calls.map((args) => args[0])).toEqual(["install", "install"]);
  });
  it("requires a new enough npm for a young base alone, before editing any files", async () => {
    const h = await fixture();
    const npm = vi.fn<NpmCommand>(async (_dir, args) => {
      expect(args).toEqual(["--version"]);
      return { code: 0, stdout: "11.14.1", stderr: "" };
    });
    await expect(computeNpm({
      ...h.inputs,
      npm,
      window: { days: 7, exclude: [] },
      sources: { ...h.inputs.sources, published: async () => new Date("2026-10-06") },
    })).rejects.toThrow("young or unreadable locked versions require npm >= 11.17.0");
    expect(npm).toHaveBeenCalledOnce();
    expect(await readFile(join(h.dir, "package.json"), "utf8")).toBe(json(manifest));
  });
  it.each(["routine", "major"] as const)("uses only the %s computation's lockfiles for base-age exclusions", async (kind) => {
    const h = await fixture();
    await mkdir(join(h.dir, "nested"));
    const nestedManifest = { dependencies: { child: "^1" } };
    const nestedLock = { packages: { "": nestedManifest, "node_modules/child": { version: "1.1.0" } } };
    await writeFile(join(h.dir, "nested/package.json"), json(nestedManifest));
    await writeFile(join(h.dir, "nested/package-lock.json"), json(nestedLock));
    const published = vi.fn(async (_name: string, version: string) => new Date(version === "1.1.0" ? "2026-10-06" : "2026-09-01"));
    const invocations: Array<{ cwd: string; args: ReadonlyArray<string> }> = [];
    const npm: NpmCommand = async (cwd, args) => {
      invocations.push({ cwd, args });
      if (args[0] === "--version") {
        return { code: 0, stdout: "11.20.0", stderr: "" };
      }
      if (kind === "major") {
        await writeFile(join(cwd, "package-lock.json"), json(lock("2.0.0")));
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const result = await computeNpm({
      ...h.inputs,
      kind,
      moves: kind === "major" ? h.inputs.moves.map((move) => ({ ...move, to: "2.0.0" })) : [],
      window: { days: 7, exclude: [] },
      baseLocks: new Map([...h.inputs.baseLocks, ["nested/package-lock.json", nestedLock]]),
      npm,
      sources: { ...h.inputs.sources, published, versions: async () => ["1.0.0", "1.1.0"] },
    });
    const installs = invocations.filter(({ args }) => args[0] !== "--version");
    if (kind === "routine") {
      expect(new Set(installs.map(({ cwd }) => cwd))).toEqual(new Set([h.dir, join(h.dir, "nested")]));
      expect(installs.every(({ args }) => args.includes("--min-release-age-exclude=child"))).toBe(true);
      expect(result.notes).toEqual(["child: its locked 1.1.0 is younger than the window, so npm's own window skips it; bump-it's targets still require the age"]);
      expect(published.mock.calls.filter(([name, version]) => name === "child" && version === "1.1.0")).toHaveLength(1);
    } else {
      expect(invocations).toHaveLength(2);
      expect(installs[0]?.cwd).toBe(h.dir);
      expect(installs[0]?.args.some((arg) => arg.startsWith("--min-release-age-exclude="))).toBe(false);
      expect(result.notes).toEqual([]);
      expect(published.mock.calls.some(([, version]) => version === "1.1.0")).toBe(false);
    }
  });
});

describe("exact targets before npm's first resolution", () => {
  it.each(["routine", "major"] as const)("prevents excluded-name drift for %s, with simultaneous frozen directs", async (kind) => {
    let selected = "1.0.0";
    const h = await fixture(async (dir, args, n) => {
      const root = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
      if (n === 1 || args[0] === "update") {
        // A name exemption with a range would select 1.9.0 before the target loop can run.
        expect(root.dependencies).toEqual({ parent: "1.1.0", frozen: "1.0.0" });
        selected = root.dependencies.parent;
      }
      await writeFile(join(dir, "package-lock.json"), json(lock(selected, kind === "routine" ? "1.1.0" : "1.0.0")));
    });
    const result = await computeNpm({ ...h.inputs, kind, window: { days: 7, exclude: ["parent"] } });
    expect(JSON.parse(result.files.get("package-lock.json")!).packages["node_modules/parent"].version).toBe("1.1.0");
    expect(JSON.parse(await readFile(join(h.dir, "package.json"), "utf8")).dependencies).toEqual({ parent: "^1.1.0", frozen: "^1.0.0" });
  });

  it("materializes multiple planned direct companions together before any install", async () => {
    const h = await fixture(async (dir, _args, n) => {
      const root = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
      if (n === 1) expect(root.dependencies).toEqual({ parent: "1.1.0", frozen: "1.1.0" });
      await writeFile(join(dir, "package-lock.json"), json(lock("1.1.0", "1.1.0", "1.1.0")));
    });
    const moves = [...h.inputs.moves, { ...h.inputs.moves[0]!, name: "frozen", declaredAs: "frozen", to: "1.1.0" }];
    const result = await computeNpm({ ...h.inputs, kind: "major", moves });
    const final = JSON.parse(result.files.get("package-lock.json")!);
    expect(final.packages["node_modules/parent"].version).toBe("1.1.0");
    expect(final.packages["node_modules/frozen"].version).toBe("1.1.0");
    expect(JSON.parse(result.files.get("package.json")!).dependencies).toEqual({ parent: "^1.1.0", frozen: "^1.1.0" });
  });

  it("refreshes a peer-only copy through a declaration, even when npm ignores its overrides", async () => {
    const h = await fixture();
    const root = { devDependencies: { parent: "^1" } };
    const base = { packages: { "": root, "node_modules/parent": { version: "1.0.0", peerDependencies: { vite: "^8" } }, "node_modules/vite": { version: "8.3.2", peer: true } } };
    await writeFile(join(h.dir, "package.json"), json(root));
    await writeFile(join(h.dir, "package-lock.json"), json(base));
    let selected = "8.3.2";
    const npm: NpmCommand = async (dir, args) => {
      if (args[0] === "--version") return { code: 0, stdout: "11.19.1", stderr: "" };
      const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
      selected = manifest.devDependencies.vite ?? selected;
      await writeFile(join(dir, "package-lock.json"), json({ packages: { ...base.packages, "": manifest, "node_modules/vite": { version: selected, peer: true } } }));
      return { code: 0, stdout: "", stderr: "" };
    };
    const result = await computeNpm({ ...h.inputs, moves: [], npm, baseLocks: new Map([["package-lock.json", base]]), sources: { ...h.inputs.sources, versions: async () => ["8.3.2", "8.3.3"] } });
    expect(JSON.parse(result.files.get("package-lock.json")!).packages["node_modules/vite"].version).toBe("8.3.3");
    expect(await readFile(join(h.dir, "package.json"), "utf8")).toBe(json(root));
  });

  it("reports an unsupported nested peer before accepting computed npm bytes", async () => {
    const h = await fixture();
    const base = { packages: { "": manifest, "node_modules/parent": { version: "1.0.0", peerDependencies: { vite: "^8" } }, "node_modules/parent/node_modules/vite": { version: "8.3.2" }, "node_modules/frozen": { version: "1.0.0" } } };
    await writeFile(join(h.dir, "package-lock.json"), json(base));
    await expect(computeNpm({ ...h.inputs, baseLocks: new Map([["package-lock.json", base]]), sources: { ...h.inputs.sources, versions: async () => ["8.3.2", "8.3.3"] } })).rejects.toThrow("unsupported npm peer placement");
    expect(h.calls.map((args) => args[0])).toEqual(["install", "update", "install"]);
  });
});
