import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, parseConfig, type Config } from "../src/config.ts";
import { NO_EXCEPTIONS, parseExceptions, type Exceptions } from "../src/exceptions.ts";
import type { Fetch } from "../src/http.ts";
import { NpmCatalog } from "../src/catalogs.ts";
import { IdentityCheck } from "../src/candidates.ts";
import { npmChanges } from "../src/npm-changes.ts";
import { isYoung, releaseAgeProblems } from "../src/release-age.ts";
import { gatherCandidates } from "../src/young-fixes.ts";
import { bundleProblems, changedPackages, lockedPackages, replacedArtifacts, sourceProblems } from "../src/npm-lock.ts";
import { identityBaseline, NpmRegistry } from "../src/npm-registry.ts";
import { type Advisory, Snapshot } from "../src/snapshot.ts";

const NOW = new Date("2026-10-04T12:00:00Z");

/** Synthetic tarball digest of `name@version`, the same in lockfiles and provenance statements. */
const sha512 = (key: string) => createHash("sha512").update(key).digest();

/** Synthetic lockfile: package name → version, each resolved from the registry. */
function lock(entries: Record<string, string>, extra: Record<string, object> = {}): unknown {
  const packages: Record<string, object> = { "": { name: "app" } };
  for (const [name, version] of Object.entries(entries)) {
    packages[`node_modules/${name}`] = {
      version,
      resolved: `https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${version}.tgz`,
      integrity: `sha512-${sha512(`${name}@${version}`).toString("base64")}`,
    };
  }
  return { lockfileVersion: 3, packages: { ...packages, ...extra } };
}

const pkgs = (entries: Record<string, string>, extra?: Record<string, object>) => lockedPackages(lock(entries, extra));

const ATTESTATIONS = "https://registry.npmjs.org/-/npm/v1/attestations/";
const SLSA = "https://slsa.dev/provenance/v1";
const SLSA_V02 = "https://slsa.dev/provenance/v0.2";

type Body = { ok: boolean; status: number; body: unknown };

function respond({ ok, status, body }: Body): Awaited<ReturnType<Fetch>> {
  return { ok, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
}

/**
 * Fake registry. `times` gives registry publish times (one manifest per listed
 * version, declaring github.com/acme/<name>); `sources` gives the
 * `name@version`s with SLSA v1 provenance, as "repository workflow-path", or
 * v0.2 provenance, as "v0.2 configSource-uri entryPoint";
 * `publishers` overrides the default publisher ("maintainer").
 */
function fake(options: { times?: Record<string, Record<string, string>>; sources?: Record<string, string>; publishers?: Record<string, string> }): Fetch {
  return async (url) => {
    if (url.startsWith(ATTESTATIONS)) {
      const key = decodeURIComponent(url.slice(ATTESTATIONS.length));
      const source = options.sources?.[key];
      if (source === undefined) return respond({ ok: false, status: 404, body: {} });
      const subject = [{ name: `pkg:npm/${key.replace(/^@/, "%40")}`, digest: { sha512: sha512(key).toString("hex") } }];
      const [first, second, third] = source.split(" ");
      // A leading SLSA predicate type other than v1 or v0.2 is kept, with v1's predicate shape.
      const [predicateType, predicate] = first === "v0.2"
        ? [SLSA_V02, { builder: { id: "https://github.com/actions/runner" }, invocation: { configSource: { uri: second, entryPoint: third } } }]
        : first?.startsWith("https://slsa.dev/")
          ? [first, { buildDefinition: { externalParameters: { workflow: { repository: second, path: third } } } }]
          : [SLSA, { buildDefinition: { externalParameters: { workflow: { repository: first, path: second } } } }];
      const payload = Buffer.from(JSON.stringify({ subject, predicateType, predicate })).toString("base64");
      const attestations = [
        { predicateType: "https://github.com/npm/attestation/tree/main/specs/publish/v0.1", bundle: {} },
        { predicateType, bundle: { dsseEnvelope: { payload } } },
      ];
      return respond({ ok: true, status: 200, body: { attestations } });
    }
    const name = decodeURIComponent(url.slice("https://registry.npmjs.org/".length));
    const time = options.times?.[name];
    if (time === undefined) return respond({ ok: false, status: 404, body: {} });
    const manifest = (version: string) => {
      const key = `${name}@${version}`;
      const source = options.sources?.[key];
      const predicateType = source?.startsWith("v0.2 ") ? SLSA_V02 : SLSA;
      const provenance = source === undefined ? {} : { attestations: { url: `${ATTESTATIONS}${key}`, provenance: { predicateType } } };
      return {
        repository: { type: "git", url: `git+https://github.com/acme/${name}.git` },
        _npmUser: { name: options.publishers?.[key] ?? "maintainer" },
        dist: provenance,
      };
    };
    const versions = Object.fromEntries(Object.keys(time).map((version) => [version, manifest(version)]));
    return respond({ ok: true, status: 200, body: { time, versions } });
  };
}

const registry = (body: unknown): Fetch => async () => respond({ ok: true, status: 200, body });

describe("npm candidate catalog", () => {
  it("excludes every nonempty deprecation message while keeping cleared deprecations and base publish times", async () => {
    let reads = 0;
    const fetch = registry({ time: { "1.0.0": "2026-01-01T00:00:00Z" }, versions: {
      "1.0.0": { deprecated: "Accidental release" }, "1.0.1": { deprecated: " " },
      "1.0.2": { deprecated: "" }, "1.0.3": {},
    } });
    const catalog = new NpmCatalog(new NpmRegistry(async (...args) => { reads++; return fetch(...args); }));
    expect(await catalog.versions({ ecosystem: "npm", name: "lib" })).toEqual(["1.0.2", "1.0.3"]);
    expect(await catalog.published({ ecosystem: "npm", name: "lib", version: "1.0.0" })).toEqual(new Date("2026-01-01"));
    expect(reads).toBe(1);
  });
});

/** A snapshot from `name@version` → advisories; every version not listed (and every candidate) has none. */
function snapshot(
  affecting: Record<string, Advisory[]>,
  packages: ReadonlyArray<{ name: string; version: string }>,
): Snapshot {
  const map = new Map<string, Advisory[]>();
  for (const pkg of packages) map.set(`npm|${pkg.name}|${pkg.version}`, []);
  for (const [key, advisories] of Object.entries(affecting)) {
    const at = key.lastIndexOf("@");
    map.set(`npm|${key.slice(0, at)}|${key.slice(at + 1)}`, advisories);
  }
  return new Snapshot(map, [], NOW);
}

const advisory = (id: string, options: Partial<Advisory> = {}): Advisory => ({
  id,
  ids: [id],
  source: "osv",
  malicious: false,
  summary: undefined,
  severity: undefined,
  ...options,
});

/** The npm half of `compare`: source and identity problems, then the release-age rule over one snapshot. */
async function changes(
  base: ReturnType<typeof pkgs>,
  head: ReturnType<typeof pkgs>,
  fetch: Fetch,
  options: { exceptions?: Exceptions; config?: Config; affecting?: Record<string, Advisory[]> } = {},
) {
  const config = options.config ?? DEFAULT_CONFIG;
  const exceptions = options.exceptions ?? NO_EXCEPTIONS;
  const registry = new NpmRegistry(fetch);
  const npm = await npmChanges(base, head, { registry, exceptions, config, now: NOW });
  const young = npm.changes.filter((change) => isYoung(change, config, NOW));
  const catalogs = { npm: new NpmCatalog(registry), Maven: new NpmCatalog(registry), "GitHub Actions": new NpmCatalog(registry) };
  const candidates = await gatherCandidates(young, catalogs, config);
  const snap = snapshot(options.affecting ?? {}, [...base, ...head, ...candidates.versions]);
  const age = await releaseAgeProblems(young, { snapshot: snap, exceptions, config, now: NOW, catalogs, candidates: candidates.byChange });
  return [...npm.problems, ...age];
}

describe("lockfile reading", () => {
  it("reads nested packages by their own name and aliases by the real package, skipping links and the root", () => {
    const parsed = pkgs(
      { left: "1.0.0", "@scope/pkg": "2.0.0" },
      {
        "node_modules/left/node_modules/inner": { version: "0.1.0", resolved: "https://registry.npmjs.org/inner/-/inner-0.1.0.tgz" },
        "node_modules/alias": { name: "real-name", version: "3.0.0", resolved: "https://registry.npmjs.org/real-name/-/real-name-3.0.0.tgz" },
        "node_modules/local": { link: true, resolved: "workspaces/local" },
      },
    );
    expect(parsed.map((pkg) => `${pkg.name}@${pkg.version}`)).toEqual(["left@1.0.0", "@scope/pkg@2.0.0", "inner@0.1.0", "real-name@3.0.0"]);
  });

  it("rejects old lockfile formats, malformed maps and entries, and entries without a version", () => {
    expect(() => lockedPackages({ lockfileVersion: 1, dependencies: {} })).toThrow(/lockfileVersion 2 or 3/);
    for (const packages of [[], false, 42, null, "x"]) {
      expect(() => lockedPackages({ lockfileVersion: 3, packages })).toThrow(/lockfileVersion 2 or 3 with a `packages` map/);
    }
    expect(() => lockedPackages(null)).toThrow(/lockfileVersion 2 or 3/);
    expect(() => lockedPackages({ lockfileVersion: 3, packages: { "node_modules/x": "1.0.0" } })).toThrow(/node_modules\/x isn't an object/);
    expect(() => lockedPackages({ lockfileVersion: 3, packages: { "node_modules/x": {} } })).toThrow(/has no version/);
  });

  it("reports new packages and changed versions, including transitive ones", () => {
    const changed = changedPackages(pkgs({ a: "1.0.0", b: "1.0.0" }), pkgs({ a: "1.0.0", b: "1.1.0", c: "3.0.0" }));
    expect(changed.map((pkg) => `${pkg.name}@${pkg.version}`)).toEqual(["b@1.1.0", "c@3.0.0"]);
  });

  it("tells a same-version artifact that changed source, bytes or bundling from an unchanged one", () => {
    const base = pkgs({ a: "1.0.0", b: "1.0.0", c: "1.0.0", d: "1.0.0" });
    const head = lockedPackages(lock({ a: "1.0.0", d: "1.1.0" }, {
      "node_modules/b": { version: "1.0.0", resolved: "https://npm.internal.example/b/-/b-1.0.0.tgz", integrity: `sha512-${sha512("b@1.0.0").toString("base64")}` },
      "node_modules/c": { version: "1.0.0", resolved: "https://registry.npmjs.org/c/-/c-1.0.0.tgz", integrity: `sha512-${sha512("other bytes").toString("base64")}` },
    }));
    expect(replacedArtifacts(base, head).map((pkg) => `${pkg.name}@${pkg.version}`)).toEqual(["b@1.0.0", "c@1.0.0"]);
    expect(changedPackages(base, head).map((pkg) => `${pkg.name}@${pkg.version}`)).toEqual(["d@1.1.0"]);
  });

  it("lets an integrity be filled in where base had none, but not removed", () => {
    const resolved = "https://registry.npmjs.org/a/-/a-1.0.0.tgz";
    const integrity = `sha512-${sha512("a@1.0.0").toString("base64")}`;
    const without = lockedPackages(lock({}, { "node_modules/a": { version: "1.0.0", resolved } }));
    const withIt = lockedPackages(lock({}, { "node_modules/a": { version: "1.0.0", resolved, integrity } }));
    expect(replacedArtifacts(without, withIt)).toEqual([]);
    expect(replacedArtifacts(withIt, without).map((pkg) => pkg.name)).toEqual(["a"]);
  });

  it("fails a same-version artifact replaced from another allowed registry, which no other check sees", async () => {
    const config = { ...DEFAULT_CONFIG, npm: { ...DEFAULT_CONFIG.npm, registries: [...DEFAULT_CONFIG.npm.registries, "https://npm.internal.example"] } };
    const head = lockedPackages(lock({}, {
      "node_modules/lib": { version: "1.0.0", resolved: "https://npm.internal.example/lib/-/lib-1.0.0.tgz", integrity: `sha512-${sha512("other bytes").toString("base64")}` },
    }));
    expect(await changes(pkgs({ lib: "1.0.0" }), head, registry({}), { config })).toEqual([
      "lib@1.0.0 at node_modules/lib changed its source or bytes without changing version: the gate can't tell the new artifact is the same package",
    ]);
    expect(await changes(pkgs({ lib: "1.0.0" }), pkgs({ lib: "1.0.0" }), registry({}), { config })).toEqual([]);
  });

  it("checks bundled packages' source through the parent that ships them", () => {
    const bundled = { version: "5.0.9", inBundle: true };
    const parsed = pkgs({ cdk: "2.0.0" }, { "node_modules/cdk/node_modules/brace-expansion": bundled });
    expect(sourceProblems(parsed)).toEqual([]);
    expect(parsed.find((pkg) => pkg.name === "brace-expansion")!.bundled).toBe(true);
    // `inBundle` can't excuse a package that no locked package ships.
    expect(() => pkgs({}, { "node_modules/brace-expansion": bundled })).toThrow(/no locked package ships it/);
    expect(() => pkgs({}, { "node_modules/gone/node_modules/brace-expansion": bundled })).toThrow(/no locked package ships it/);
    expect(() => pkgs({}, { "workspaces/ws": { version: "1.0.0" }, "workspaces/ws/node_modules/brace-expansion": bundled })).toThrow(
      /no locked package ships it/,
    );
    expect(() => pkgs({}, { "node_modules/orphan": bundled, "node_modules/orphan/node_modules/brace-expansion": bundled })).toThrow(
      /no locked package ships it/,
    );
    // A workspace link isn't a shipped package either.
    expect(() =>
      pkgs({}, { "node_modules/ws": { resolved: "workspaces/ws", link: true }, "node_modules/ws/node_modules/brace-expansion": bundled }),
    ).toThrow(/no locked package ships it/);
  });

  it("follows bundles nested in bundles up to the shipping package", () => {
    const parsed = pkgs(
      { cdk: "2.0.0" },
      {
        "node_modules/cdk/node_modules/minimatch": { version: "10.2.5", inBundle: true },
        "node_modules/cdk/node_modules/minimatch/node_modules/evil": { version: "1.0.0", inBundle: true },
      },
    );
    expect(sourceProblems(parsed)).toEqual([]);
    const scoped = pkgs(
      { "@aws-cdk/schema": "1.0.0" },
      {
        "node_modules/@aws-cdk/schema/node_modules/@scope/inner": { version: "2.0.0", inBundle: true },
        "node_modules/@aws-cdk/schema/node_modules/@scope/inner/node_modules/@x/leaf": { version: "3.0.0", inBundle: true },
      },
    );
    expect(sourceProblems(scoped).length).toBe(0);
    expect(() => pkgs({}, { "node_modules/@aws-cdk/gone/node_modules/@scope/inner": { version: "2.0.0", inBundle: true } })).toThrow(
      /no locked package ships it/,
    );
  });

  it("fails a bundle whose shipped closure the lockfile doesn't fully record, transitive dependencies included", () => {
    const cdk = { version: "2.0.0", bundleDependencies: ["minimatch", "semver"] };
    const minimatch = { version: "10.2.5", inBundle: true, dependencies: { "brace-expansion": "^5.0.5" } };
    const complete = {
      "node_modules/cdk": cdk,
      "node_modules/cdk/node_modules/minimatch": minimatch,
      "node_modules/cdk/node_modules/brace-expansion": { version: "5.0.9", inBundle: true },
      "node_modules/cdk/node_modules/semver": { version: "7.7.2", inBundle: true },
    };
    expect(bundleProblems(lock({}, complete))).toEqual([]);

    // The vulnerable copy dropped while every declared bundle stays: still incomplete.
    const { "node_modules/cdk/node_modules/brace-expansion": _brace, ...withoutBrace } = complete;
    expect(bundleProblems(lock({}, withoutBrace))).toEqual([
      "node_modules/cdk ships brace-expansion (needed by node_modules/cdk/node_modules/minimatch), but the lockfile has no inBundle entry for it there",
    ]);

    // Every bundled entry gone (what `--package-lock-only` can write): each declared bundle is missing.
    expect(bundleProblems(lock({}, { "node_modules/cdk": cdk }))).toEqual([
      "node_modules/cdk ships minimatch (needed by node_modules/cdk), but the lockfile has no inBundle entry for it there",
      "node_modules/cdk ships semver (needed by node_modules/cdk), but the lockfile has no inBundle entry for it there",
    ]);

    // A copy outside the bundle doesn't count: the tarball ships its own.
    const { "node_modules/cdk/node_modules/semver": _semver, ...withoutBundledSemver } = complete;
    expect(bundleProblems(lock({ semver: "7.7.2" }, withoutBundledSemver))).toEqual([
      "node_modules/cdk ships semver (needed by node_modules/cdk), but the lockfile has no inBundle entry for it there",
    ]);
  });

  it("reads `bundleDependencies: true` as every dependency, and lets optional dependencies be absent", () => {
    const packages = {
      "node_modules/tool": { version: "1.0.0", bundleDependencies: true, dependencies: { a: "^1" }, optionalDependencies: { b: "^1" } },
      "node_modules/tool/node_modules/a": { version: "1.0.0", inBundle: true },
    };
    expect(bundleProblems(lock({}, packages))).toEqual([]);
    expect(bundleProblems(lock({}, { "node_modules/tool": packages["node_modules/tool"] }))).toEqual([
      "node_modules/tool ships a (needed by node_modules/tool), but the lockfile has no inBundle entry for it there",
    ]);
  });

  it("flags packages that don't come from an allowed registry", () => {
    const git = pkgs({}, { "node_modules/fork": { version: "1.0.0", resolved: "git+ssh://git@github.com/x/fork.git#abc" } });
    expect(sourceProblems(git)).toEqual([
      "fork@1.0.0 (node_modules/fork) doesn't come from an allowed registry as its own tarball: git+ssh://git@github.com/x/fork.git#abc",
    ]);
    const internal = pkgs({}, { "node_modules/own": { version: "1.0.0", resolved: "https://npm.acme.dev/own/-/own-1.0.0.tgz" } });
    expect(sourceProblems(internal)).toHaveLength(1);
    expect(sourceProblems(internal, ["https://registry.npmjs.org", "https://npm.acme.dev"])).toEqual([]);
    // Another package's tarball can't pass as this one, on npm's registry or another allowed one.
    const swapped = pkgs({}, {
      "node_modules/safe": { version: "1.0.0", resolved: "https://registry.npmjs.org/attacker/-/attacker-1.0.0.tgz" },
      "node_modules/@acme/own": { version: "1.0.0", resolved: "https://registry.npmjs.org/@acme/own/-/own-1.0.1.tgz" },
      "node_modules/other": { version: "1.0.0", resolved: "https://npm.acme.dev/attacker/-/attacker-1.0.0.tgz" },
    });
    expect(sourceProblems(swapped, ["https://registry.npmjs.org", "https://npm.acme.dev"]).map((problem) => problem.split(" ")[0])).toEqual(["safe@1.0.0", "@acme/own@1.0.0", "other@1.0.0"]);
    const scoped = pkgs({}, { "node_modules/@acme/own": { version: "1.0.0", resolved: "https://registry.npmjs.org/@acme/own/-/own-1.0.0.tgz" } });
    expect(sourceProblems(scoped)).toEqual([]);
    // GitHub Packages' download paths: the full scoped name, then the exact version.
    const github = ["https://npm.pkg.github.com"];
    const at = (resolved: string) => sourceProblems(pkgs({}, { "node_modules/@trusted/name": { version: "1.0.0", resolved } }), github);
    expect(at("https://npm.pkg.github.com/download/@trusted/name/1.0.0/abc123")).toEqual([]);
    for (const resolved of [
      "https://npm.pkg.github.com/download/@attacker/name/1.0.0/abc123",
      "https://npm.pkg.github.com/download/@trusted/name/11.0.0/abc123",
      "https://npm.pkg.github.com/download/@trusted/name/1.0.0/../../../@attacker/name/1.0.0/abc123",
      "https://npm.pkg.github.com/download/@trusted/other/1.0.0/abc123",
      // URL parsing would normalize these into another package's path.
      String.raw`https://npm.pkg.github.com/download/@trusted/name/1.0.0/hash\..\..\..\..\@attacker/name/1.0.0/evilhash`,
      "https://npm.pkg.github.com/download/@trusted/name/1.0.0/.\t./.\t./.\t./.\t./@attacker/name/1.0.0/evilhash",
      "https://npm.pkg.github.com/download/@trusted/name/1.0.0/abc123?x=1",
    ]) expect(at(resolved), resolved).toHaveLength(1);
    expect(sourceProblems(pkgs({}, { "node_modules/safe": { version: "1.0.0", resolved: "https://registry.npmjs.org/safe/-/safe-1.0.0.tgz#x" } }))).toHaveLength(1);
  });
});

describe("release age", () => {
  it("passes versions at least 7 days old (boundary included) and fails younger ones, transitive or not", async () => {
    const fetch = fake({ times: { old: { "1.0.0": "2026-09-27T12:00:00Z" }, young: { "2.0.0": "2026-10-02T00:00:00Z" } } });
    expect(await changes([], pkgs({ old: "1.0.0", young: "2.0.0" }), fetch)).toEqual([
      "young@2.0.0 was published 2026-10-02T00:00:00.000Z (2.5 days ago, under 7), and it isn't the security fix the version rule would take: it's new here, not a fix of an earlier version",
    ]);
  });

  it("uses the configured wait and lets own packages skip it", async () => {
    const fetch = fake({ times: { young: { "2.0.0": "2026-10-02T00:00:00Z" }, "@acme/own": { "1.0.0": "2026-10-04T11:00:00Z" } } });
    const head = pkgs({ young: "2.0.0", "@acme/own": "1.0.0" });
    const config = parseConfig({ releaseAgeDays: 2, ownPackages: { npm: { scopes: ["@acme"] } } });
    expect(await changes([], head, fetch, { config })).toEqual([]);
  });

  it("doesn't need an own package's publish time", async () => {
    const odd = registry({ time: { "1.0.0": "not a date" }, versions: { "1.0.0": { _npmUser: { name: "m" }, dist: {} } } });
    const config = parseConfig({ ownPackages: { npm: { scopes: ["@acme"] } } });
    expect(await changes([], pkgs({ "@acme/own": "1.0.0" }), odd, { config })).toEqual([]);
  });

  it("ignores packages the change doesn't touch", async () => {
    const same = pkgs({ untouched: "1.0.0" });
    expect(await changes(same, same, fake({}))).toEqual([]);
  });

  it("checks the age of a bundle's shipping package, not of what it bundles", async () => {
    const cdk = (version: string) => pkgs({ cdk: version }, { "node_modules/cdk/node_modules/minimatch": { version: "10.2.5", inBundle: true } });
    const fetch = fake({ times: { cdk: { "2.0.0": "2026-01-01T00:00:00Z", "2.1.0": "2026-10-03T00:00:00Z" } } });
    expect(await changes(cdk("2.0.0"), cdk("2.1.0"), fetch)).toEqual([
      "cdk@2.1.0 was published 2026-10-03T00:00:00.000Z (1.5 days ago, under 7), and it isn't the security fix the version rule would take: it fixes no advisory affecting 2.0.0",
    ]);
  });

  it("fails a package from another allowed registry, and needs a reviewed identity exception even for an own one", async () => {
    const head = pkgs({}, { "node_modules/@acme/x": { version: "1.0.0", resolved: "https://npm.acme.dev/@acme/x/-/x-1.0.0.tgz" } });
    const registries = ["https://registry.npmjs.org", "https://npm.acme.dev"];
    expect(await changes([], head, fake({}), { config: parseConfig({ npm: { registries } }) })).toEqual([
      "@acme/x@1.0.0 comes from https://npm.acme.dev/@acme/x/-/x-1.0.0.tgz, where the gate can't check its release age or publisher identity",
    ]);
    const own = parseConfig({ npm: { registries }, ownPackages: { npm: { scopes: ["@acme"] } } });
    expect(await changes([], head, fake({}), { config: own })).toEqual([
      "@acme/x@1.0.0 comes from https://npm.acme.dev/@acme/x/-/x-1.0.0.tgz, where the gate can't check its publisher identity; an identity exception records the review",
    ]);
    const reviewed = (expires: string) =>
      parseExceptions({ identity: [{ package: "@acme/x", version: "1.0.0", reason: "our CI published it", expires }] });
    expect(await changes([], head, fake({}), { config: own, exceptions: reviewed("2026-10-04") })).toEqual([]);
    expect(await changes([], head, fake({}), { config: own, exceptions: reviewed("2026-10-03") })).toHaveLength(1);
  });

  describe("security exception", () => {
    const base = pkgs({ lib: "1.0.0" });
    const head = pkgs({ lib: "1.0.1" });
    const fetch = fake({ times: { lib: { "1.0.1": "2026-10-03T00:00:00Z" } } });
    const exception = (advisoryId: string, expires = "2026-10-31") =>
      parseExceptions({ releaseAge: [{ package: "lib", version: "1.0.1", advisory: advisoryId, reason: "fixes it", expires }] });

    it("accepts a young version the version rule picks, with no exception", async () => {
      const affecting = { "lib@1.0.0": [advisory("GHSA-fix", { ids: ["GHSA-fix", "CVE-2026-1"] })] };
      expect(await changes(base, head, fetch, { affecting })).toEqual([]);
    });

    it("accepts a young version by an exception naming any alias of an advisory it fixes, where the proof can't", async () => {
      // An aged 1.0.2 fixes it too, so the rule picks 1.0.2: only a reviewed exception can justify the young 1.0.1.
      const withAged = fake({ times: { lib: { "1.0.1": "2026-10-03T00:00:00Z", "1.0.2": "2026-09-01T00:00:00Z" } } });
      const affecting = { "lib@1.0.0": [advisory("GHSA-fix", { ids: ["GHSA-fix", "CVE-2026-1"] })] };
      expect(await changes(base, head, withAged, { affecting })).toEqual([
        "lib@1.0.1 was published 2026-10-03T00:00:00.000Z (1.5 days ago, under 7), and it isn't the security fix the version rule would take: 1.0.2 fixes GHSA-fix too and is at least 7 days old (line 1)",
      ]);
      expect(await changes(base, head, withAged, { exceptions: exception("GHSA-fix"), affecting })).toEqual([]);
      expect(await changes(base, head, withAged, { exceptions: exception("CVE-2026-1"), affecting })).toEqual([]);
    });

    it("rejects an advisory that doesn't affect the replaced version, still affects the new one, or is malware", async () => {
      expect(await changes(base, head, fetch, { exceptions: exception("GHSA-old") })).toEqual([
        "lib@1.0.1: advisory GHSA-old doesn't affect the replaced version(s) 1.0.0",
      ]);
      const notFixed = { "lib@1.0.0": [advisory("GHSA-fix")], "lib@1.0.1": [advisory("GHSA-fix")] };
      expect(await changes(base, head, fetch, { exceptions: exception("GHSA-fix"), affecting: notFixed })).toEqual([
        "lib@1.0.1: advisory GHSA-fix still affects 1.0.1",
      ]);
      const malware = { "lib@1.0.0": [advisory("GHSA-m", { malicious: true })] };
      expect(await changes(base, head, fetch, { exceptions: exception("GHSA-m"), affecting: malware })).toEqual([
        "lib@1.0.1: advisory GHSA-m is a malware entry",
      ]);
    });

    it("rejects an expired exception and an exception for a version that removes nothing", async () => {
      const affecting = { "lib@1.0.0": [advisory("GHSA-fix")] };
      expect(await changes(base, head, fetch, { exceptions: exception("GHSA-old", "2026-10-03") })).toEqual([
        "lib@1.0.1: its release-age exception expired on 2026-10-03",
      ]);
      expect(await changes([], head, fetch, { exceptions: exception("GHSA-fix"), affecting })).toEqual([
        "lib@1.0.1: advisory GHSA-fix can't justify it: the change removes no lib version",
      ]);
    });

    it("binds the advisory to a copy the change removes, not to one it keeps", async () => {
      const affecting = { "lib@1.0.0": [advisory("GHSA-fix")] };
      const nested = (dir: string, version: string) => ({
        [`node_modules/${dir}/node_modules/lib`]: { version, resolved: `https://registry.npmjs.org/lib/-/lib-${version}.tgz` },
      });
      const before = pkgs({ a: "1.0.0", b: "1.0.0" }, nested("a", "1.0.0"));

      // The vulnerable copy under `a` stays; a new copy under `b` can't borrow its advisory.
      const keptOld = pkgs({ a: "1.0.0", b: "1.0.0" }, { ...nested("a", "1.0.0"), ...nested("b", "1.0.1") });
      expect(await changes(before, keptOld, fetch, { exceptions: exception("GHSA-fix"), affecting })).toEqual([
        "lib@1.0.1: advisory GHSA-fix can't justify it: the change removes no lib version",
      ]);

      // The vulnerable copy is gone and npm hoisted the fixed version: that's a replacement.
      const hoisted = pkgs({ a: "1.0.0", b: "1.0.0", lib: "1.0.1" });
      expect(await changes(before, hoisted, fetch, { exceptions: exception("GHSA-fix"), affecting })).toEqual([]);
    });
  });

  it("fails sources it can't check and fails closed on a missing or malformed publish time", async () => {
    const git = pkgs({}, { "node_modules/fork": { version: "1.0.0", resolved: "git+ssh://git@github.com/x/fork.git#abc" } });
    expect(await changes([], git, fake({}))).toEqual([
      "fork@1.0.0 (node_modules/fork) doesn't come from an allowed registry as its own tarball: git+ssh://git@github.com/x/fork.git#abc",
    ]);
    await expect(changes([], pkgs({ gone: "1.0.0" }), fake({}))).rejects.toThrow(/HTTP 404/);
    for (const time of ["not a date", "2026", null, 0, false, 1_700_000_000_000]) {
      const odd = registry({ time: { "1.0.0": time }, versions: { "1.0.0": { _npmUser: { name: "m" }, dist: {} } } });
      await expect(changes([], pkgs({ odd: "1.0.0" }), odd)).rejects.toThrow(/no valid publish time/);
    }
    await expect(changes([], pkgs({ odd: "1.0.0" }), registry({ time: "2020-01-01T00:00:00Z", versions: {} }))).rejects.toThrow(/malformed/);
  });
});

describe("publisher identity", () => {
  const base = pkgs({ lib: "1.0.0" });
  const head = pkgs({ lib: "1.1.0" });
  const times = { lib: { "1.0.0": "2026-01-01T00:00:00Z", "1.1.0": "2026-09-01T00:00:00Z" } };
  const RELEASE = "https://github.com/acme/lib .github/workflows/release.yml";
  const accepted = (expires: string) => parseExceptions({ identity: [{ package: "lib", version: "1.1.0", reason: "moved CI", expires }] });

  it("builds the baseline from registry copies only, with the first integrity locked per version", () => {
    const copy = (path: string, version: string, integrity: string | undefined, resolved = `https://registry.npmjs.org/lib/-/lib-${version}.tgz`, bundled = false) =>
      ({ name: "lib", version, path, resolved, bundled, integrity });
    expect([...identityBaseline([
      copy("node_modules/lib", "1.0.0", undefined),
      copy("node_modules/a/node_modules/lib", "1.0.0", "sha512-first"),
      copy("node_modules/b/node_modules/lib", "1.0.0", "sha512-later"),
      copy("node_modules/c/node_modules/lib", "0.9.0", undefined),
      copy("node_modules/d/node_modules/lib", "0.8.0", "sha512-bundled", undefined, true),
      copy("node_modules/e/node_modules/lib", "0.7.0", "sha512-git", "git+https://github.com/acme/lib.git"),
    ])]).toEqual([["1.0.0", "sha512-first"], ["0.9.0", undefined]]);
  });

  it("fails a version without provenance that replaces one with it, unless an unexpired exception accepts it", async () => {
    const dropped = fake({ times, sources: { "lib@1.0.0": RELEASE } });
    expect(await changes(base, head, dropped)).toEqual(["lib@1.1.0 has no provenance, but the version it replaces (1.0.0) had it"]);
    expect(await changes(base, head, dropped, { exceptions: accepted("2026-10-04") })).toEqual([]);
    expect(await changes(base, head, dropped, { exceptions: accepted("2026-10-03") })).toEqual([
      "lib@1.1.0: its identity exception expired on 2026-10-03",
    ]);
  });

  it("fails provenance naming another source repository or workflow, even for an old version", async () => {
    const moved = (source: string) => fake({ times, sources: { "lib@1.0.0": RELEASE, "lib@1.1.0": source } });
    expect(await changes(base, head, moved("https://github.com/evil/lib .github/workflows/release.yml"))).toEqual([
      "lib@1.1.0 was built from https://github.com/evil/lib (.github/workflows/release.yml), but the version it replaces (1.0.0) from https://github.com/acme/lib (.github/workflows/release.yml)",
    ]);
    expect(await changes(base, head, moved("https://github.com/acme/lib .github/workflows/other.yml"))).toEqual([
      "lib@1.1.0 was built from https://github.com/acme/lib (.github/workflows/other.yml), but the version it replaces (1.0.0) from https://github.com/acme/lib (.github/workflows/release.yml)",
    ]);
    expect(await changes(base, head, moved(RELEASE))).toEqual([]);
  });

  it("reads npm's SLSA v0.2 provenance as the same source v1 names, and refuses a malformed one", async () => {
    const V02 = "v0.2 git+https://github.com/acme/lib@refs/heads/main .github/workflows/release.yml";
    const from = (old: string, now: string) => fake({ times, sources: { "lib@1.0.0": old, "lib@1.1.0": now } });
    expect(await changes(base, head, from(V02, RELEASE))).toEqual([]);
    expect(await changes(base, head, from(V02, V02))).toEqual([]);
    expect(await changes(base, head, from(V02, "v0.2 git+https://github.com/acme/lib@refs/tags/v1.1.0 .github/workflows/other.yml"))).toEqual([
      "lib@1.1.0 was built from https://github.com/acme/lib (.github/workflows/other.yml), but the version it replaces (1.0.0) from https://github.com/acme/lib (.github/workflows/release.yml)",
    ]);
    expect(await changes(base, head, from(RELEASE, "v0.2 git+https://github.com/evil/lib@refs/heads/main .github/workflows/release.yml"))).toEqual([
      "lib@1.1.0 was built from https://github.com/evil/lib (.github/workflows/release.yml), but the version it replaces (1.0.0) from https://github.com/acme/lib (.github/workflows/release.yml)",
    ]);
    expect(await changes(base, head, from(V02, "v0.2 git+https://github.com/evil/lib@refs/heads/main .github/workflows/other.yml"))).toEqual([
      "lib@1.1.0 was built from https://github.com/evil/lib (.github/workflows/other.yml), but the version it replaces (1.0.0) from https://github.com/acme/lib (.github/workflows/release.yml)",
    ]);
    // A newly added package's v0.2 provenance is read (and bound to its tarball), with no baseline to compare.
    const fresh = fake({ times: { fresh: { "1.0.0": "2026-01-01T00:00:00Z" } }, sources: { "fresh@1.0.0": "v0.2 git+https://github.com/acme/fresh@refs/heads/main .github/workflows/release.yml" } });
    expect(await changes([], pkgs({ fresh: "1.0.0" }), fresh)).toEqual([]);
    for (const malformed of [
      "v0.2 https://github.com/acme/lib@refs/heads/main .github/workflows/release.yml", // no git+
      "v0.2 git+https://github.com/acme/lib .github/workflows/release.yml", // no @ref
      "v0.2 git+https://github.com/acme/lib@ .github/workflows/release.yml", // an empty ref
      "v0.2 git+https://@refs/heads/main .github/workflows/release.yml", // no host
      "v0.2 git+http://github.com/acme/lib@refs/heads/main .github/workflows/release.yml", // not https
      "v0.2 git+https://github.com/acme/lib@refs/heads/main", // no entryPoint
      "v0.2 git+https://github.com/acme/lib@refs/heads/main ", // an empty entryPoint
      "v0.2 git+https://github.com/acme/lib/../other@refs/heads/main .github/workflows/release.yml", // a longer path
      "v0.2 git+https://github.com/acme/lib?x=1@refs/heads/main .github/workflows/release.yml", // a query
      "v0.2 git+https://github.com/acme/lib#x@refs/heads/main .github/workflows/release.yml", // a fragment
      `https://slsa.dev/provenance/v9 ${RELEASE}`, // a predicate type the gate doesn't know, with v1's fields
    ]) {
      await expect(changes(base, head, from(V02, malformed))).rejects.toThrow(/unrecognized provenance/);
    }
  });

  it("refuses more than one provenance statement, or one whose type differs from its entry's", async () => {
    const attested = fake({ times, sources: { "lib@1.0.0": RELEASE, "lib@1.1.0": RELEASE } });
    const rewritten = (change: (attestations: Array<Record<string, unknown>>) => unknown[]): Fetch => async (url, init) => {
      const response = await attested(url, init);
      if (!url.startsWith(ATTESTATIONS)) return response;
      const { attestations } = (await response.json()) as { attestations: Array<Record<string, unknown>> };
      return respond({ ok: true, status: 200, body: { attestations: change(attestations) } });
    };
    expect(await changes(base, head, attested)).toEqual([]);
    await expect(changes(base, head, rewritten((entries) => [...entries, entries[1]]))).rejects.toThrow(/unrecognized provenance/);
    await expect(changes(base, head, rewritten((entries) => [entries[0], { ...entries[1], predicateType: SLSA_V02 }]))).rejects.toThrow(/unrecognized provenance/);
  });

  it("compares a source's repository and workflow apart, not as the text they join into", async () => {
    // Both join to "https://github.com/acme/lib (x (y)".
    const statements: Record<string, object> = {
      "lib@1.0.0": { predicateType: SLSA, predicate: { buildDefinition: { externalParameters: { workflow: { repository: "https://github.com/acme/lib (x", path: "y)" } } } } },
      "lib@1.1.0": { predicateType: SLSA_V02, predicate: { invocation: { configSource: { uri: "git+https://github.com/acme/lib@refs/heads/main", entryPoint: "x (y)" } } } },
    };
    const registry = fake({ times, sources: { "lib@1.0.0": RELEASE, "lib@1.1.0": RELEASE } });
    const fetch: Fetch = async (url, init) => {
      if (!url.startsWith(ATTESTATIONS)) return registry(url, init);
      const key = decodeURIComponent(url.slice(ATTESTATIONS.length));
      const subject = [{ name: `pkg:npm/${key}`, digest: { sha512: sha512(key).toString("hex") } }];
      const payload = Buffer.from(JSON.stringify({ subject, ...statements[key] })).toString("base64");
      const predicateType = (statements[key] as { predicateType: string }).predicateType;
      return respond({ ok: true, status: 200, body: { attestations: [{ predicateType, bundle: { dsseEnvelope: { payload } } }] } });
    };
    expect(await changes(base, head, fetch)).toEqual([
      "lib@1.1.0 was built from https://github.com/acme/lib (x (y)), but the version it replaces (1.0.0) from https://github.com/acme/lib (x (y))",
    ]);
  });

  it("reads a real SLSA v0.2 statement from npm, bound to its tarball", async () => {
    const real = readFileSync(new URL("fixtures/eslint-visitor-keys-3.4.3-attestations.json", import.meta.url), "utf8");
    const name = "eslint-visitor-keys";
    const registry = fake({ times: { [name]: { "3.4.3": "2023-08-08T00:00:00Z" } }, sources: { [`${name}@3.4.3`]: "v0.2 x y" } });
    const fetch: Fetch = async (url, init) => (url.startsWith(ATTESTATIONS) ? respond({ ok: true, status: 200, body: JSON.parse(real) }) : registry(url, init));
    const digest = "c2973e2d77a2ca28acc4f944914cd4eacbf24b57eb20edcc8318f57ddcbb3e6f1883382e6b1d8ddc56bf0ff6a0d56a9b3a9add23eb98eb031497cfdad86fa26a";
    const locked = (sha: string) => pkgs({}, { [`node_modules/${name}`]: { version: "3.4.3", resolved: `https://registry.npmjs.org/${name}/-/${name}-3.4.3.tgz`, integrity: `sha512-${Buffer.from(sha, "hex").toString("base64")}` } });
    expect(await changes([], locked(digest), fetch)).toEqual([]);
    await expect(changes([], locked(sha512("something else").toString("hex")), fetch)).rejects.toThrow(/doesn't describe eslint-visitor-keys@3.4.3 as locked/);
  });

  it("binds SLSA v0.2 provenance to the locked tarball as it does v1", async () => {
    const attested = fake({ times, sources: { "lib@1.0.0": RELEASE, "lib@1.1.0": "v0.2 git+https://github.com/acme/lib@refs/heads/main .github/workflows/release.yml" } });
    const forged = pkgs({}, { "node_modules/lib": { version: "1.1.0", resolved: "https://registry.npmjs.org/lib/-/lib-1.1.0.tgz", integrity: `sha512-${sha512("something else").toString("base64")}` } });
    await expect(changes(base, forged, attested)).rejects.toThrow(/doesn't describe lib@1.1.0 as locked/);
    const swapped: Fetch = async (url, init) => attested(url.startsWith(ATTESTATIONS) ? url.replace("lib@1.1.0", "lib@1.0.0") : url, init);
    await expect(changes(base, head, swapped)).rejects.toThrow(/doesn't describe lib@1.1.0 as locked/);
  });

  it("judges a publisher against every copy the change replaces in that lockfile, in planning as in verification", async () => {
    // Two copies (1.0.0 by alice, 2.0.0 bob's first) both move to bob's 3.0.0, without provenance.
    const nested = (version: string) => ({ "node_modules/x/node_modules/lib": { version, resolved: `https://registry.npmjs.org/lib/-/lib-${version}.tgz`, integrity: `sha512-${sha512(`lib@${version}`).toString("base64")}` } });
    const fetch = fake({
      times: { lib: { "1.0.0": "2026-01-01T00:00:00Z", "2.0.0": "2026-06-01T00:00:00Z", "3.0.0": "2026-09-01T00:00:00Z" } },
      publishers: { "lib@1.0.0": "alice", "lib@2.0.0": "bob", "lib@3.0.0": "bob" },
    });
    const refused = ["lib@3.0.0 has no provenance and its publisher bob hadn't published any version up to the one it replaces"];
    const base = pkgs({ lib: "1.0.0" }, nested("2.0.0"));
    // Verification's baseline is every copy the change replaces, so bob's own 2.0.0 is history.
    expect(await changes(base, pkgs({ lib: "3.0.0" }, nested("3.0.0")), fetch)).toEqual([]);
    // The second copy retained: only alice's 1.0.0 is replaced, and bob had published nothing up to it.
    expect(await changes(base, pkgs({ lib: "3.0.0" }, nested("2.0.0")), fetch)).toEqual(refused);

    const planning = (lockfiles: ReadonlyArray<{ path: string; packages: ReturnType<typeof pkgs> }>) =>
      new IdentityCheck(new NpmRegistry(fetch), lockfiles.map((lockfile) => ({ ...lockfile, bundleProblems: [] })), NO_EXCEPTIONS, "2026-10-04");
    const from = { ecosystem: "npm" as const, name: "lib", version: "1.0.0" };
    const both = ["node_modules/lib", "node_modules/x/node_modules/lib"];
    // Told its unit replaces both copies, planning accepts what verification accepts.
    expect(await planning([{ path: "package-lock.json", packages: base }]).problems(from, "3.0.0", both)).toEqual([]);
    // Its own copy alone (the other retained, or moved by another unit), and by default: as verification refuses.
    expect(await planning([{ path: "package-lock.json", packages: base }]).problems(from, "3.0.0", ["node_modules/lib"])).toEqual(refused);
    expect(await planning([{ path: "package-lock.json", packages: base }]).problems(from, "3.0.0")).toEqual(refused);
    // Another lockfile's copy lends no history, even one the same unit replaces.
    const split = [{ path: "package-lock.json", packages: pkgs({ lib: "1.0.0" }) }, { path: "sub/package-lock.json", packages: pkgs({}, nested("2.0.0")) }];
    expect(await planning(split).problems(from, "3.0.0", ["node_modules/lib", "sub/node_modules/x/node_modules/lib"])).toEqual(refused);
  });

  it("fails a publisher, without provenance, who hadn't published up to the replaced version", async () => {
    expect(await changes(base, head, fake({ times, publishers: { "lib@1.1.0": "mallory" } }))).toEqual([
      "lib@1.1.0 has no provenance and its publisher mallory hadn't published any version up to the one it replaces",
    ]);
    // A release after the baseline doesn't make history.
    const primed = fake({
      times: { lib: { ...times.lib, "1.0.5": "2026-06-01T00:00:00Z" } },
      publishers: { "lib@1.0.5": "mallory", "lib@1.1.0": "mallory" },
    });
    expect(await changes(base, head, primed)).toEqual([
      "lib@1.1.0 has no provenance and its publisher mallory hadn't published any version up to the one it replaces",
    ]);
    expect(await changes(base, head, fake({ times }))).toEqual([]);
    // History is judged by valid publish times only: a malformed one fails rather than counting.
    const backdated: Fetch = async (url, init) => {
      const response = await primed(url, init);
      const body = (await response.json()) as { time: Record<string, string> };
      return respond({ ok: true, status: 200, body: { ...body, time: { ...body.time, "1.0.5": "2026" } } });
    };
    await expect(changes(base, head, backdated)).rejects.toThrow(/no valid publish time for lib@1.0.5/);
    // A package the change adds has no baseline to compare.
    const fresh = fake({ times: { fresh: { "1.0.0": "2026-01-01T00:00:00Z" } }, publishers: { "fresh@1.0.0": "mallory" } });
    expect(await changes([], pkgs({ fresh: "1.0.0" }), fresh)).toEqual([]);
  });

  it("checks gained provenance against the repository the replaced version declares", async () => {
    // Moving to trusted publishing from the declared repository: a new publisher, and fine.
    const trusted = fake({ times, publishers: { "lib@1.1.0": "GitHub Actions" }, sources: { "lib@1.1.0": RELEASE } });
    expect(await changes(base, head, trusted)).toEqual([]);
    const elsewhere = fake({ times, sources: { "lib@1.1.0": "https://github.com/evil/lib .github/workflows/release.yml" } });
    expect(await changes(base, head, elsewhere)).toEqual([
      "lib@1.1.0 was built from https://github.com/evil/lib (.github/workflows/release.yml), a repository the version it replaces (1.0.0) doesn't declare",
    ]);
  });

  it("takes the baseline only from copies shipped as their own registry tarball", async () => {
    const bundledLib = { version: "1.0.0", inBundle: true };
    const fetch = fake({
      times: { ...times, cdk: { "2.0.0": "2026-01-01T00:00:00Z", "2.1.0": "2026-09-01T00:00:00Z" } },
      sources: { "lib@1.0.0": RELEASE, "lib@1.1.0": RELEASE },
    });
    // The bundled copy has no integrity of its own to bind provenance to; it isn't a baseline.
    const bundledOnly = pkgs({ cdk: "2.0.0" }, { "node_modules/cdk/node_modules/lib": bundledLib });
    expect(await changes(bundledOnly, pkgs({ cdk: "2.1.0", lib: "1.1.0" }), fetch)).toEqual([]);
    // Bundled and independent copies of the same version: the independent copy's integrity binds.
    const both = pkgs({ cdk: "2.0.0", lib: "1.0.0" }, { "node_modules/cdk/node_modules/lib": bundledLib });
    expect(await changes(both, pkgs({ cdk: "2.1.0", lib: "1.1.0" }), fetch)).toEqual([]);
  });

  it("binds every provenance statement to the exact package, version and locked digest", async () => {
    const attested = fake({ times, sources: { "lib@1.0.0": RELEASE, "lib@1.1.0": RELEASE } });
    const forged = pkgs(
      {},
      {
        "node_modules/lib": {
          version: "1.1.0",
          resolved: "https://registry.npmjs.org/lib/-/lib-1.1.0.tgz",
          integrity: `sha512-${sha512("something else").toString("base64")}`,
        },
      },
    );
    await expect(changes(base, forged, attested)).rejects.toThrow(/doesn't describe lib@1.1.0 as locked/);
    const unlocked = pkgs({}, { "node_modules/lib": { version: "1.1.0", resolved: "https://registry.npmjs.org/lib/-/lib-1.1.0.tgz" } });
    await expect(changes(base, unlocked, attested)).rejects.toThrow(/no locked sha512/);
    // A statement served for another version can't stand in for this one.
    const swapped: Fetch = async (url, init) => attested(url.startsWith(ATTESTATIONS) ? url.replace("lib@1.1.0", "lib@1.0.0") : url, init);
    await expect(changes(base, head, swapped)).rejects.toThrow(/doesn't describe lib@1.1.0 as locked/);
  });

  it("passes a replaced version since unpublished, and a publish attestation that isn't provenance", async () => {
    expect(await changes(base, head, fake({ times: { lib: { "1.1.0": "2026-09-01T00:00:00Z" } } }))).toEqual([]);
    const publishOnly = registry({
      time: times.lib,
      versions: {
        "1.0.0": { _npmUser: { name: "m" }, dist: { attestations: { url: `${ATTESTATIONS}lib@1.0.0` } } },
        "1.1.0": { _npmUser: { name: "m" }, dist: {} },
      },
    });
    expect(await changes(base, head, publishOnly)).toEqual([]);
  });

  it("fails closed on manifests, attestations or provenance it can't read", async () => {
    const versions = (body: unknown) => registry({ time: times.lib, versions: body });
    const plain = { _npmUser: { name: "m" }, dist: {} };
    const attested = (attestations: unknown) => ({ _npmUser: { name: "m" }, dist: { attestations } });
    const run = (fetch: Fetch) => changes(base, head, fetch);
    await expect(run(versions({ "1.0.0": attested("yes"), "1.1.0": plain }))).rejects.toThrow(/malformed attestations for lib@1.0.0/);
    await expect(
      run(versions({ "1.0.0": attested({ url: `${ATTESTATIONS}x`, provenance: { predicateType: "https://example.com/p" } }), "1.1.0": plain })),
    ).rejects.toThrow(/malformed attestations/);
    await expect(
      run(versions({ "1.0.0": attested({ url: "https://evil.example/x", provenance: { predicateType: SLSA } }), "1.1.0": plain })),
    ).rejects.toThrow(/malformed attestations/);
    await expect(run(versions({ "1.0.0": plain }))).rejects.toThrow(/no valid manifest for lib@1.1.0/);
    await expect(run(versions({ "1.0.0": "x", "1.1.0": plain }))).rejects.toThrow(/no valid manifest for lib@1.0.0/);
    await expect(run(versions({ "1.0.0": plain, "1.1.0": { dist: {} } }))).rejects.toThrow(/names no publisher for lib@1.1.0/);
    await expect(run(fake({ times, sources: { "lib@1.0.0": RELEASE, "lib@1.1.0": "" } }))).rejects.toThrow(/unrecognized provenance/);
  });
});

describe("config", () => {
  it("defaults everything and rejects unknown fields and malformed values", () => {
    expect(parseConfig({})).toEqual(DEFAULT_CONFIG);
    expect(() => parseConfig({ npm: { lockfile: "x" } })).toThrow("npm has unknown field(s): lockfile");
    expect(() => parseConfig({ releaseAgeDays: -1 })).toThrow("nonnegative integer");
    expect(() => parseConfig({ ownPackages: { npm: { scopes: ["leanish"] } } })).toThrow("not an @scope");
    expect(() => parseConfig({ repositories: { "snappy-java": "xerial/snappy-java" } })).toThrow("isn't <ecosystem>:<package>");
    expect(() => parseConfig({ repositories: { "npm:lib": "../.." } })).toThrow("must map to owner/repo");
    expect(parseConfig({ repositories: { "Maven:org.xerial.snappy:snappy-java": "xerial/snappy-java" } }).repositories).toEqual(
      new Map([["Maven|org.xerial.snappy:snappy-java", "xerial/snappy-java"]]),
    );
  });
});
