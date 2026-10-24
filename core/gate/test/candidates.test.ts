import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bumpCandidates, IdentityCheck, type SecurityFix, securityCandidates, untrustedActionReleases } from "../src/candidates.ts";
import { parseConfig } from "../src/config.ts";
import { NO_EXCEPTIONS } from "../src/exceptions.ts";
import type { GateEnvironment } from "../src/gate.ts";
import { NPM_REGISTRY } from "../src/npm-lock.ts";
import type { NpmRegistry } from "../src/npm-registry.ts";
import { runProcess, type RunProcess } from "../src/process.ts";
import { workingTree } from "../src/tree.ts";
import { fakeFetch } from "./fake-fetch.ts";
import { archive, manifest, serving } from "./tarballs.ts";

const NOW = new Date("2026-10-07T12:00:00Z");
const OLD = "2026-01-01T00:00:00Z";
const YESTERDAY = "2026-10-06T00:00:00Z";

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "supply-chain-candidates-"));
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

async function tree(locked: Record<string, string>, files: Record<string, string> = {}, root: object = { name: "app" }, extra: Record<string, object> = {}) {
  const packages: Record<string, object> = { "": root, ...extra };
  for (const [name, version] of Object.entries(locked)) {
    packages[`node_modules/${name}`] = { version, resolved: `https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${version}.tgz`, integrity: "sha512-AAAA" };
  }
  await writeFile(join(repo, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages }));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), content);
  }
  return workingTree(repo);
}

/** Every version of `name` the registry lists, with its publish time. */
type Registry = Record<string, Record<string, string>>;

/** Fake osv-scanner answering from `affected` (`name@version` → ids), fake npm registry from `registry`; records scans. */
function environment(affected: Record<string, string[]>, registry: Registry, scans: string[][] = [], manifests: Record<string, object> = {}): GateEnvironment {
  const run: RunProcess = async (command, args, options) => {
    if (command !== "osv-scanner") return runProcess(command, args, options);
    if (args[0] === "--version") return { code: 0, stdout: "osv-scanner version: 2.6.0\n", stderr: "" };
    const inventory = JSON.parse(await readFile(args[args.indexOf("--lockfile") + 1]!.replace(/^osv-scanner:/, ""), "utf8")) as {
      results: Array<{ packages: Array<{ package: { name: string; version: string; ecosystem: string } }> }>;
    };
    const requested = inventory.results[0]!.packages.map(({ package: pkg }) => pkg);
    scans.push(requested.map((pkg) => `${pkg.name}@${pkg.version}`).sort());
    const packages = requested.map((pkg) => ({
      package: pkg,
      // An entry is an id, optionally `!SEVERITY`, optionally `=ALIAS,ALIAS`.
      vulnerabilities: (affected[`${pkg.name}@${pkg.version}`] ?? []).map((entry) => {
        const [named, aliases] = entry.split("=");
        const [id, severity] = named!.split("!");
        return {
          id,
          summary: `${id} summary`,
          ...(aliases === undefined ? {} : { aliases: aliases.split(",") }),
          ...(severity === undefined ? {} : { database_specific: { severity } }),
        };
      }),
    }));
    return { code: 1, stdout: JSON.stringify({ results: [{ packages }] }), stderr: "" };
  };
  const manifest = { _npmUser: { name: "maintainer" }, dist: {} };
  const routes = Object.fromEntries(
    Object.entries(registry).flatMap(([name, versions]) => [
      [
        `https://registry.npmjs.org/${encodeURIComponent(name)}`,
        { body: { time: versions, versions: Object.fromEntries(Object.keys(versions).map((version) => [version, { ...manifest, ...manifests[`${name}@${version}`] }])) } },
      ],
      // Each version's manifest, for its source repository (none here).
      ...Object.keys(versions).map((version) => [`https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`, { body: {} }]),
    ]),
  );
  return { run, fetch: fakeFetch(routes), now: () => NOW, osvScanner: "osv-scanner", githubToken: undefined };
}

function moves(fixes: ReadonlyArray<SecurityFix>): Array<[string, string | undefined, string | undefined]> {
  return fixes.map((fix) => [`${fix.name}@${fix.from}`, fix.to?.version, fix.problem]);
}

describe("securityCandidates", () => {
  it("judges dtv-shaped coupled directs on the security batch's snapshot, reading each registry document once", async () => {
    const names = ["vitest", "@vitest/ui", "@vitest/coverage-v8"];
    const versions = ["4.1.7", "4.1.11", "4.1.12"];
    const manifests = Object.fromEntries(names.flatMap((name) => versions.map((version) => [
      `${name}@${version}`, name === "vitest" ? {} : { peerDependencies: { vitest: version } },
    ])));
    const lock = { lockfileVersion: 3, packages: {
      "": { devDependencies: Object.fromEntries(names.map((name) => [name, "^4.1.7"])) },
      ...Object.fromEntries(names.map((name) => [`node_modules/${name}`, {
        version: "4.1.7", resolved: `https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-4.1.7.tgz`, integrity: "sha512-AAAA", ...manifests[`${name}@4.1.7`],
      }])),
    } };
    const head = await tree({}, { "package-lock.json": JSON.stringify(lock) });
    const scans: string[][] = [];
    const registry = Object.fromEntries(names.map((name) => [name, Object.fromEntries(versions.map((version) => [version, OLD]))]));
    const env = environment({ "vitest@4.1.7": ["GHSA-a"] }, registry, scans, manifests);
    const fetched: string[] = [];
    const found = await securityCandidates(head, { ...env, fetch: async (url, init) => {
      fetched.push(String(url));
      return env.fetch(url, init);
    } });
    const resolved = await found.npmPeers!.resolve(found.fixes.map((fix) => ({ ...fix, to: fix.to!.version })));
    expect(resolved.additions.map((move) => [move.name, move.to])).toEqual([["@vitest/coverage-v8", "4.1.11"], ["@vitest/ui", "4.1.11"]]);
    expect(scans).toHaveLength(2);
    expect(scans[1]).toContain("@vitest/coverage-v8@4.1.11");
    expect(scans[1]).toContain("vitest@4.1.11");
    for (const name of names) expect(fetched.filter((url) => url === `https://registry.npmjs.org/${encodeURIComponent(name)}`)).toHaveLength(1);
    const bumps = await bumpCandidates(head, environment({}, registry, [], manifests));
    const major = bumps.bumps.find((bump) => bump.name === "vitest")!;
    const coupled = await bumps.npmPeers!.resolve([{ name: major.name, from: major.from, to: major.minor!.version, locations: ["node_modules/vitest"] }]);
    expect(coupled.additions.map((move) => move.to)).toEqual(["4.1.12", "4.1.12"]);
  });

  it("picks the lowest aged fix in the version's own line, scanning every candidate with it in one snapshot", async () => {
    const scans: string[][] = [];
    const affected = { "lib@1.0.0": ["GHSA-a"], "lib@1.0.1": ["GHSA-a"] };
    const registry = { lib: { "1.0.0": OLD, "1.0.1": OLD, "1.0.2": OLD, "1.1.0": OLD, "2.0.0": OLD } };
    const found = await securityCandidates(await tree({ lib: "1.0.0" }), environment(affected, registry, scans));
    expect(found.fixes).toEqual([
      {
        ecosystem: "npm",
        name: "lib",
        from: "1.0.0",
        locations: ["node_modules/lib"],
        targets: ["GHSA-a"],
        unfixable: [],
        malicious: false,
        severity: undefined,
        to: { version: "1.0.2", line: "1", aged: true, major: false, blockers: [] },
        problem: undefined,
      },
    ]);
    expect(scans).toEqual([["lib@1.0.0"], ["lib@1.0.0", "lib@1.0.1", "lib@1.0.2", "lib@1.1.0", "lib@2.0.0"]]);
  });

  it("takes a young fix when no fix in the line is old enough, and prefers a young backport to an aged major", async () => {
    const affected = { "lib@1.9.4": ["GHSA-a"] };
    const registry = { lib: { "1.9.4": OLD, "1.9.5": YESTERDAY, "2.0.0": OLD } };
    const found = await securityCandidates(await tree({ lib: "1.9.4" }), environment(affected, registry));
    expect(found.fixes[0]?.to).toEqual({ version: "1.9.5", line: "1", aged: false, major: false, blockers: [] });
  });

  it("moves to the lowest fixing major when only a major fixes, flagged for the agent", async () => {
    const affected = { "lib@1.0.0": ["GHSA-a"], "lib@1.5.0": ["GHSA-a"] };
    const registry = { lib: { "1.0.0": OLD, "1.5.0": OLD, "2.0.0": YESTERDAY, "2.1.0": OLD, "3.0.0": OLD } };
    const found = await securityCandidates(await tree({ lib: "1.0.0" }), environment(affected, registry));
    expect(found.fixes[0]?.to).toEqual({ version: "2.1.0", line: "2", aged: true, major: true, blockers: [] });
  });

  it("fixes A and leaves B when nothing fixes B, never adding an advisory", async () => {
    const affected = { "lib@1.0.0": ["GHSA-a", "GHSA-b"], "lib@1.0.1": ["GHSA-b", "GHSA-new"], "lib@1.0.2": ["GHSA-b"], "lib@1.0.3": [] };
    const registry = { lib: { "1.0.0": OLD, "1.0.1": OLD, "1.0.2": OLD } };
    const found = await securityCandidates(await tree({ lib: "1.0.0" }), environment(affected, registry));
    expect(found.fixes[0]).toMatchObject({ targets: ["GHSA-a", "GHSA-b"], unfixable: ["GHSA-b"], to: { version: "1.0.2" } });
  });

  it("leaves a malicious version for the nearest clean aged one: newer in its line, else older, else a newer line", async () => {
    const affected = { "evil@1.0.1": ["MAL-2026-1"], "evil@1.0.2": ["MAL-2026-1"] };
    const newer = await securityCandidates(
      await tree({ evil: "1.0.1" }),
      environment(affected, { evil: { "1.0.0": OLD, "1.0.1": OLD, "1.0.2": OLD, "1.0.3": YESTERDAY, "1.0.4": OLD } }),
    );
    expect(newer.fixes[0]).toMatchObject({ malicious: true, to: { version: "1.0.4", aged: true, major: false } });
    const older = await securityCandidates(
      await tree({ evil: "1.0.1" }),
      environment(affected, { evil: { "0.9.0": OLD, "1.0.0": OLD, "1.0.1": OLD, "1.0.2": OLD, "2.0.0": OLD } }),
    );
    expect(older.fixes[0]?.to?.version).toBe("1.0.0");
    const none = await securityCandidates(await tree({ evil: "1.0.1" }), environment(affected, { evil: { "1.0.1": OLD, "1.0.3": YESTERDAY } }));
    expect(moves(none.fixes)).toEqual([["evil@1.0.1", undefined, "no clean version of evil at least 7 days old to leave the malicious 1.0.1 for"]]);
  });

  it("lets own packages skip the wait, and leaves excepted findings alone", async () => {
    const affected = { "@acme/lib@1.0.0": ["GHSA-a"], "other@1.0.0": ["GHSA-x"] };
    const registry = { "@acme/lib": { "1.0.0": OLD, "1.0.1": YESTERDAY, "1.0.2": OLD }, other: { "1.0.0": OLD, "1.0.1": OLD } };
    const exceptions = {
      vulnerabilities: [{ id: "GHSA-x", package: "other", version: "1.0.0", paths: ["node_modules/other"], reason: "dev only", expires: "2026-12-31" }],
    };
    const head = await tree(
      { "@acme/lib": "1.0.0", other: "1.0.0" },
      {
        ".github/supply-chain.json": JSON.stringify({ ownPackages: { npm: { scopes: ["@acme"] } } }),
        ".github/supply-chain-exceptions.json": JSON.stringify(exceptions),
      },
    );
    const found = await securityCandidates(head, environment(affected, registry));
    expect(moves(found.fixes)).toEqual([["@acme/lib@1.0.0", "1.0.1", undefined]]);
  });

  it("says why when nothing fixes, or an older fix's publish time is unknown", async () => {
    const affected = { "lib@1.0.0": ["GHSA-a"], "lib@1.1.0": ["GHSA-a"], "odd@1.0.0": ["GHSA-o"] };
    const registry = { lib: { "1.0.0": OLD, "1.1.0": OLD }, odd: { "1.0.0": OLD, "1.0.2": OLD } };
    const head = await tree({ lib: "1.0.0", odd: "1.0.0" });
    const env = environment(affected, registry);
    const withUndated: GateEnvironment = {
      ...env,
      fetch: async (url, init) => {
        if (url === "https://registry.npmjs.org/odd") {
          const manifest = { _npmUser: { name: "maintainer" }, dist: {} };
          const body = { time: { "1.0.0": OLD, "1.0.2": OLD }, versions: { "1.0.0": manifest, "1.0.1": manifest, "1.0.2": manifest } };
          return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
        }
        return env.fetch(url, init);
      },
    };
    const found = await securityCandidates(head, withUndated);
    expect(moves(found.fixes)).toEqual([
      ["lib@1.0.0", undefined, "no version above 1.0.0 fixes GHSA-a"],
      ["odd@1.0.0", undefined, "the publish time of 1.0.1 (fixing, line 1) is unknown, so the rule can't tell which fix is old enough"],
    ]);
  });
});

/** `environment` plus `lib`'s own repository (acme/lib) publishing `advisories`, which OSV doesn't have. */
function withRepositoryAdvisories(env: GateEnvironment, advisories: object[]): GateEnvironment {
  return { ...env, fetch: async (url, init) => {
    if (/^https:\/\/registry\.npmjs\.org\/lib\/[^/]+$/.test(String(url))) return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ repository: "github:acme/lib" }), text: async () => "" };
    if (String(url) === "https://api.github.com/repos/acme/lib/security-advisories?state=published&per_page=100") {
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => advisories, text: async () => "" };
    }
    return env.fetch(url, init);
  } };
}
const repositoryAdvisory = (id: string, range: string) => ({ ghsa_id: id, state: "published", vulnerabilities: [{ package: { ecosystem: "npm", name: "lib" }, vulnerable_version_range: range }] });

describe("securityCandidates and repository-only advisories", () => {
  it("proposes no fix for an advisory only the project's repository publishes, and says so", async () => {
    const env = withRepositoryAdvisories(environment({}, { lib: { "1.0.0": OLD, "1.0.1": OLD } }), [repositoryAdvisory("GHSA-repo", "< 1.0.1")]);
    const found = await securityCandidates(await tree({ lib: "1.0.0" }), env);
    expect(moves(found.fixes)).toEqual([[
      "lib@1.0.0", undefined,
      "lib@1.0.0 is affected by GHSA-repo, only in the project's repository advisories (not corroborated by the sources this decision used): no fix is proposed until a reviewed source lists it",
    ]]);
  });

  it("notes another version's unreviewed advisory on the package's reviewed fix, without blocking it", async () => {
    const lock = { lockfileVersion: 3, packages: { "": { name: "app" },
      "node_modules/lib": { version: "1.0.0", resolved: "https://registry.npmjs.org/lib/-/lib-1.0.0.tgz", integrity: "sha512-AAAA" },
      "node_modules/other/node_modules/lib": { version: "2.0.0", resolved: "https://registry.npmjs.org/lib/-/lib-2.0.0.tgz", integrity: "sha512-AAAA" },
      "node_modules/other": { version: "1.0.0", resolved: "https://registry.npmjs.org/other/-/other-1.0.0.tgz", integrity: "sha512-AAAA" } } };
    const registry = { lib: { "1.0.0": OLD, "1.0.1": OLD, "2.0.0": OLD, "2.0.1": OLD }, other: { "1.0.0": OLD } };
    const env = withRepositoryAdvisories(environment({ "lib@1.0.0": ["GHSA-a"] }, registry), [repositoryAdvisory("GHSA-repo", ">= 2.0.0, < 2.0.1")]);
    const fixes = (await securityCandidates(await tree({}, { "package-lock.json": JSON.stringify(lock) }), env)).fixes;
    expect(moves(fixes)).toEqual([["lib@1.0.0", "1.0.1", undefined]]);
    expect(fixes[0]?.notes).toEqual([expect.stringContaining("lib@2.0.0 is affected by GHSA-repo, only in the project's repository advisories")]);
  });

  it("notes an unreviewed advisory on the very version a reviewed fix moves, whether the move leaves it or not", async () => {
    const note = "lib@1.0.0 is affected by GHSA-repo, only in the project's repository advisories (not corroborated by the sources this decision used): these advisories alone don't trigger an update";
    for (const range of ["< 1.0.1", "< 2.0.0"]) {
      const env = withRepositoryAdvisories(environment({ "lib@1.0.0": ["GHSA-a"] }, { lib: { "1.0.0": OLD, "1.0.1": OLD } }), [repositoryAdvisory("GHSA-repo", range)]);
      const fixes = (await securityCandidates(await tree({ lib: "1.0.0" }), env)).fixes;
      expect(moves(fixes)).toEqual([["lib@1.0.0", "1.0.1", undefined]]);
      expect(fixes[0]?.notes).toEqual([note]);
    }
    // With the reviewed fix blocked, it's reported like the rest.
    const blocked = withRepositoryAdvisories(environment({ "lib@1.0.0": ["GHSA-a"] }, { lib: { "1.0.0": OLD } }), [repositoryAdvisory("GHSA-repo", "< 2.0.0")]);
    const reported = (await securityCandidates(await tree({ lib: "1.0.0" }), blocked)).fixes;
    expect(reported.map((fix) => fix.problem)).toEqual([
      expect.stringContaining("no version above 1.0.0 fixes"),
      "lib@1.0.0 is affected by GHSA-repo, only in the project's repository advisories (not corroborated by the sources this decision used): no fix is proposed until a reviewed source lists it",
    ]);
  });

  it("lets one rule a candidate out, records the veto, and may steer to a young version", async () => {
    const registry = { lib: { "1.0.0": OLD, "1.0.1": OLD, "1.0.2": YESTERDAY } };
    const env = withRepositoryAdvisories(environment({ "lib@1.0.0": ["GHSA-a"] }, registry), [repositoryAdvisory("GHSA-b", ">= 1.0.1, < 1.0.2")]);
    const [fix] = (await securityCandidates(await tree({ lib: "1.0.0" }), env)).fixes;
    expect(fix).toMatchObject({ targets: ["GHSA-a"], to: { version: "1.0.2", aged: false }, vetoed: [{ version: "1.0.1", advisories: ["GHSA-b"] }] });
  });

  it("records the veto on an own package's move too", async () => {
    // An aged 1.0.3 too: the rule would take it for anyone else; an own package takes the lowest fix, 1.0.2.
    const registry = { "@leanish/lib": { "1.0.0": OLD, "1.0.1": YESTERDAY, "1.0.2": YESTERDAY, "1.0.3": OLD } };
    const env = environment({ "@leanish/lib@1.0.0": ["GHSA-a"] }, registry);
    const advisories = [{ ghsa_id: "GHSA-b", state: "published", vulnerabilities: [{ package: { ecosystem: "npm", name: "@leanish/lib" }, vulnerable_version_range: ">= 1.0.1, < 1.0.2" }] }];
    const own = { ...env, fetch: async (url: string, init?: Parameters<typeof env.fetch>[1]) => {
      if (/^https:\/\/registry\.npmjs\.org\/%40leanish%2Flib\/[^/]+$/.test(url)) return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ repository: "github:leanish/lib" }), text: async () => "" };
      if (url === "https://api.github.com/repos/leanish/lib/security-advisories?state=published&per_page=100") return { ok: true, status: 200, headers: { get: () => null }, json: async () => advisories, text: async () => "" };
      return env.fetch(url, init);
    } };
    const head = await tree({ "@leanish/lib": "1.0.0" }, { ".github/supply-chain.json": JSON.stringify({ ownPackages: { npm: { scopes: ["@leanish"] } } }) });
    const [fix] = (await securityCandidates(head, own)).fixes;
    expect(fix).toMatchObject({ to: { version: "1.0.2" }, vetoed: [{ version: "1.0.1", advisories: ["GHSA-b"] }] });
  });
});

describe("securityCandidates, regressions", () => {
  it("regroups targets on the second snapshot, where a candidate can link an alias into another canonical id", async () => {
    const affected = { "lib@1.0.0": ["CVE-2026-1"], "lib@1.0.1": ["GHSA-a=CVE-2026-1"] };
    const registry = { lib: { "1.0.0": OLD, "1.0.1": OLD, "1.0.2": OLD } };
    const found = await securityCandidates(await tree({ lib: "1.0.0" }), environment(affected, registry));
    expect(found.fixes[0]).toMatchObject({ targets: ["GHSA-a"], to: { version: "1.0.2" } });
  });

  it("reports the highest severity among a version's failing advisories", async () => {
    const affected = { "lib@1.0.0": ["GHSA-a!MODERATE", "GHSA-b!CRITICAL", "GHSA-c"] };
    const found = await securityCandidates(await tree({ lib: "1.0.0" }), environment(affected, { lib: { "1.0.0": OLD, "1.0.1": OLD } }));
    expect(found.fixes[0]?.severity).toBe("CRITICAL");
  });

  it("lets an own package leave malware for a clean version however young", async () => {
    const affected = { "@acme/lib@1.0.1": ["MAL-2026-2"] };
    const registry = { "@acme/lib": { "1.0.1": OLD, "1.0.2": YESTERDAY } };
    const head = await tree({ "@acme/lib": "1.0.1" }, { ".github/supply-chain.json": JSON.stringify({ ownPackages: { npm: { scopes: ["@acme"] } } }) });
    const found = await securityCandidates(head, environment(affected, registry));
    expect(found.fixes[0]).toMatchObject({ malicious: true, to: { version: "1.0.2", aged: false } });
  });

  it("keeps a publisher identity break the gate would reject as a blocker on the move", async () => {
    const affected = { "lib@1.0.0": ["GHSA-a"] };
    const env = environment(affected, { lib: { "1.0.0": OLD, "1.0.1": OLD } });
    const manifest = (publisher: string) => ({ _npmUser: { name: publisher }, dist: { tarball: "https://registry.npmjs.org/lib/-/lib.tgz", integrity: "sha512-BBBB" } });
    const withPublishers: GateEnvironment = {
      ...env,
      fetch: async (url, init) => {
        if (url !== "https://registry.npmjs.org/lib") return env.fetch(url, init);
        const body = { time: { "1.0.0": OLD, "1.0.1": "2026-02-01T00:00:00Z" }, versions: { "1.0.0": manifest("maintainer"), "1.0.1": manifest("stranger") } };
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
      },
    };
    const found = await securityCandidates(await tree({ lib: "1.0.0" }), withPublishers);
    expect(found.fixes[0]?.to?.version).toBe("1.0.1");
    expect(found.fixes[0]?.to?.blockers).toEqual([expect.stringContaining("stranger")]);
  });

  it("says when the inventory is incomplete, so an empty list can't read as clean", async () => {
    const head = await tree({}, { "settings.gradle": "" });
    const gradle = {
      head: {
        tree: "worktree",
        builds: [
          {
            build: ".",
            configurations: [
              {
                id: ":runtimeClasspath",
                kind: "project" as const,
                resolved: [],
                unresolved: [{ requested: "com.acme:gone:1.0", failure: "Could not resolve com.acme:gone:1.0" }],
                declared: [],
                error: undefined,
              },
            ],
          },
        ],
      },
    };
    const found = await securityCandidates(head, environment({}, {}), gradle as never);
    expect(found.fixes).toEqual([]);
    expect(found.incomplete).toEqual([expect.stringContaining("Could not resolve com.acme:gone:1.0")]);
  });
});

describe("bumpCandidates", () => {
  it("moves only Gradle dependencies the repository's sources name, in every build, noting the rest", async () => {
    const head = await tree({}, {
      "settings.gradle.kts": 'includeBuild("included")',
      "build.gradle.kts": 'plugins { `kotlin-dsl` }\ndependencies { implementation("com.acme:shared:1.0") }',
      "included/build.gradle.kts": "plugins { java }",
    });
    const configuration = (id: string, declared: Array<[string, string, string]>) => ({ id, kind: "project" as const, resolved: [], unresolved: [], error: undefined,
      declared: declared.map(([group, name, version]) => ({ group, name, version, reason: undefined })) });
    const gradle = { head: { tree: "worktree", builds: [
      // The Kotlin DSL plugin adds kotlin-stdlib; the build never names it.
      { build: ".", configurations: [configuration(":compileClasspath", [["com.acme", "shared", "1.0"], ["org.jetbrains.kotlin", "kotlin-stdlib", "2.4.10"]])] },
      // The evidence is repository-wide: the included build counts as declaring com.acme:shared too.
      { build: "included", configurations: [configuration(":compileClasspath", [["com.acme", "shared", "1.0"]])] },
    ] } };
    const found = await bumpCandidates(head, environment({}, {}), gradle as never);
    expect(found.bumps.map((bump) => [bump.name, bump.locations])).toEqual([["com.acme:shared", [":compileClasspath", "included/:compileClasspath"]]]);
    expect(found.notes).toEqual([
      "org.jetbrains.kotlin:kotlin-stdlib@2.4.10: not named in the repository's Gradle sources (:compileClasspath), so it isn't moved automatically; a plugin may add it, or it uses notation bump-it doesn't read",
    ]);
  });

  it("never moves a coordinate pinned with strictly(...) anywhere, declared or as a constraint, noting the pins", async () => {
    const head = await tree({}, {
      "build.gradle.kts": 'dependencies { implementation("com.acme:shared:1.0"); implementation("com.acme:pinned:1.0"); implementation("com.acme:free:1.0") }',
    });
    const declared = (name: string, strict = false) => ({ group: "com.acme", name, version: "1.0", reason: undefined, ...(strict ? { strict: true as const } : {}) });
    const gradle = { head: { tree: "worktree", builds: [{ build: ".", configurations: [
      // Strict in one configuration only: its plain declaration elsewhere doesn't move either.
      { id: ":compileClasspath", kind: "project" as const, resolved: [], unresolved: [], error: undefined, declared: [declared("pinned", true), declared("shared"), declared("free")] },
      { id: ":testCompileClasspath", kind: "project" as const, resolved: [], unresolved: [], error: undefined, declared: [declared("pinned"), declared("shared"), declared("free")],
        strictConstraints: [{ group: "com.acme", name: "shared", version: "1.0" }] },
      // As Gradle pins its embedded Kotlin on every buildscript classpath: no declaration of it there, so free moves.
      { id: ":buildscript.classpath", kind: "buildscript" as const, resolved: [], unresolved: [], error: undefined, declared: [],
        strictConstraints: [{ group: "com.acme", name: "free", version: "1.0" }] },
    ] }] } };
    const found = await bumpCandidates(head, environment({}, {}), gradle as never);
    expect(found.bumps.map((bump) => bump.name)).toEqual(["com.acme:free"]);
    expect(found.notes).toEqual([
      "com.acme:pinned is pinned with strictly(...) at :compileClasspath: the owner's pin, which the tools never move",
      "com.acme:shared is pinned with strictly(...) at :testCompileClasspath: the owner's pin, which the tools never move",
    ]);
  });

  it.each(["24.19.0", "22.0.0"])("caps Node types from %s at the runtime minimum before choosing routine and major targets", async (from) => {
    const versions = ["22.0.0", "22.1.0", "24.19.0", "24.20.0", "26.6.3"];
    const root = { engines: { node: ">=24" }, devDependencies: { "@types/node": `^${from}` } };
    const head = await tree({ "@types/node": from }, { "package.json": JSON.stringify(root) }, root);
    const scans: string[][] = [];
    const found = await bumpCandidates(head, environment({}, { "@types/node": Object.fromEntries(versions.map((version) => [version, OLD])) }, scans));
    expect(found.bumps[0]?.minor?.version).toBe(from === "24.19.0" ? "24.20.0" : "22.1.0");
    expect(found.bumps[0]?.major?.version).toBe(from === "24.19.0" ? undefined : "24.20.0");
    expect(found.bumps[0]?.problems).toContainEqual(expect.stringContaining("lowest supported Node major (24"));
    expect(scans.flat()).not.toContain("@types/node@26.6.3");
  });

  it("caps an aliased Node types declaration using the repository's pinned runtime", async () => {
    const root = { devDependencies: { "node-types": "npm:@types/node@^22.0.0" } };
    const lock = { lockfileVersion: 3, packages: {
      "": root,
      "node_modules/node-types": { name: "@types/node", version: "22.0.0", resolved: "https://registry.npmjs.org/@types/node/-/node-22.0.0.tgz", integrity: "sha512-AAAA" },
    } };
    const head = await tree({}, { ".node-version": "24.10.0", "package-lock.json": JSON.stringify(lock) });
    const found = await bumpCandidates(head, environment({}, { "@types/node": { "22.0.0": OLD, "24.19.0": OLD, "26.6.3": OLD } }));
    expect(found.bumps[0]).toMatchObject({ name: "@types/node", major: { version: "24.19.0" }, declarations: [{ declaredAs: "node-types" }] });
  });

  it("keeps the current type major and reports unreadable runtime metadata", async () => {
    const root = { devDependencies: { "@types/node": "^24.19.0" } };
    const head = await tree({ "@types/node": "24.19.0" }, { ".nvmrc": "lts/*" }, root);
    const registry = { "@types/node": { "24.19.0": OLD, "24.20.0": OLD, "26.6.3": OLD } };
    const found = await bumpCandidates(head, environment({}, registry));
    expect(found.bumps[0]).toMatchObject({ minor: { version: "24.20.0" }, major: undefined });
    expect(found.bumps[0]?.problems).toContainEqual(expect.stringContaining("cannot read a supported Node major"));
  });

  it("does not make a routine move above the runtime even when the existing type major is already too new", async () => {
    const root = { engines: { node: ">=24 <25" }, devDependencies: { "@types/node": "^26.0.0" } };
    const head = await tree({ "@types/node": "26.0.0" }, { "package.json": JSON.stringify(root) }, root);
    const found = await bumpCandidates(head, environment({}, { "@types/node": { "26.0.0": OLD, "26.1.0": OLD } }));
    expect(found.bumps[0]).toMatchObject({ minor: undefined, major: undefined });
    expect(found.bumps[0]?.problems).toContainEqual(expect.stringContaining("lowest supported Node major (24"));
  });

  it("skips deprecated routine and major releases, including aws-cdk's accidental major", async () => {
    const registry = { "aws-cdk": { "2.1000.0": OLD, "2.1143.0": OLD, "2.1144.0": OLD, "3.0.0": OLD } };
    const head = await tree({ "aws-cdk": "2.1000.0" }, {}, { dependencies: { "aws-cdk": "^2.1000.0" } });
    const found = await bumpCandidates(head, environment({}, registry, [], {
      "aws-cdk@2.1144.0": { deprecated: "Bad release" },
      "aws-cdk@3.0.0": { deprecated: "This version was published accidentally. Please use 2.x.x instead." },
    }));
    expect(found.bumps[0]).toMatchObject({ minor: { version: "2.1143.0" }, major: undefined });
  });

  it("moves each direct dependency to its line's highest aged version and its highest newer line's, leaving transitives alone", async () => {
    const scans: string[][] = [];
    const registry = {
      lib: { "1.0.0": OLD, "1.2.0": OLD, "1.3.0": YESTERDAY, "2.0.0": OLD, "3.0.0": OLD, "3.1.0": OLD },
      dev: { "0.5.0": OLD, "0.5.1": OLD, "0.6.0": OLD },
      transitive: { "1.0.0": OLD, "1.5.0": OLD },
    };
    const head = await tree({ lib: "1.0.0", dev: "0.5.0", transitive: "1.0.0" }, {}, { name: "app", dependencies: { lib: "^1.0.0" }, devDependencies: { dev: "~0.5.0" } });
    const found = await bumpCandidates(head, environment({}, registry, scans));
    expect(found.bumps).toEqual([
      // npm's caret line for 0.x is the minor: 0.6.0 is a "major" move.
      {
        ecosystem: "npm",
        name: "dev",
        from: "0.5.0",
        locations: ["package-lock.json#."],
        declarations: [{ lockfile: "package-lock.json", workspace: ".", declaredAs: "dev", spec: "~0.5.0" }],
        minor: { version: "0.5.1", line: "0.5" },
        major: { version: "0.6.0", line: "0.6" },
        problems: [],
      },
      {
        ecosystem: "npm",
        name: "lib",
        from: "1.0.0",
        locations: ["package-lock.json#."],
        declarations: [{ lockfile: "package-lock.json", workspace: ".", declaredAs: "lib", spec: "^1.0.0" }],
        minor: { version: "1.2.0", line: "1" },
        major: { version: "3.1.0", line: "3" },
        problems: [],
      },
    ]);
    expect(scans[1]).toEqual(["dev@0.5.0", "dev@0.5.1", "dev@0.6.0", "lib@1.0.0", "lib@1.2.0", "lib@3.0.0", "lib@3.1.0"]);
  });

  it("skips versions that add an advisory or malware, and says so when a whole line does", async () => {
    const affected = { "lib@1.2.0": ["GHSA-new"], "lib@2.0.0": ["MAL-2026-9"], "lib@1.0.0": ["GHSA-old"], "lib@1.1.0": ["GHSA-old"] };
    const registry = { lib: { "1.0.0": OLD, "1.1.0": OLD, "1.2.0": OLD, "2.0.0": OLD } };
    const head = await tree({ lib: "1.0.0" }, {}, { name: "app", dependencies: { lib: "^1.0.0" } });
    const found = await bumpCandidates(head, environment(affected, registry));
    expect(found.bumps).toEqual([
      {
        ecosystem: "npm",
        name: "lib",
        from: "1.0.0",
        locations: ["package-lock.json#."],
        declarations: [{ lockfile: "package-lock.json", workspace: ".", declaredAs: "lib", spec: "^1.0.0" }],
        minor: { version: "1.1.0", line: "1" },
        major: undefined,
        problems: ["each of the 1 newest versions of line 2 old enough adds an advisory, is malicious or breaks identity"],
      },
    ]);
  });

  it("reads workspaces' own copies, lets own packages skip the wait, and ignores non-registry specs", async () => {
    const registry = { "@acme/kit": { "1.0.0": OLD, "1.0.1": YESTERDAY }, shared: { "2.0.0": OLD, "2.1.0": OLD } };
    const head = await tree(
      { "@acme/kit": "1.0.0", shared: "2.1.0" },
      { ".github/supply-chain.json": JSON.stringify({ ownPackages: { npm: { scopes: ["@acme"] } } }) },
      { name: "app", workspaces: ["tools/x"], dependencies: { "@acme/kit": "^1.0.0", local: "file:../local" } },
      {
        "tools/x": { name: "x", dependencies: { shared: "^2.0.0", gh: "github:owner/repo" } },
        "tools/x/node_modules/shared": { version: "2.0.0", resolved: "https://registry.npmjs.org/shared/-/shared-2.0.0.tgz", integrity: "sha512-AAAA" },
        "node_modules/x": { resolved: "tools/x", link: true },
      },
    );
    const found = await bumpCandidates(head, environment({}, registry));
    expect(found.bumps.map((bump) => [bump.name, bump.from, bump.locations, bump.minor?.version])).toEqual([
      ["@acme/kit", "1.0.0", ["package-lock.json#."], "1.0.1"],
      ["shared", "2.0.0", ["package-lock.json#tools/x"], "2.1.0"],
    ]);
  });

  it("tries newer lines from the highest down until one has an acceptable version", async () => {
    const affected = { "lib@3.0.0": ["GHSA-three"] };
    const registry = { lib: { "1.0.0": OLD, "2.0.0": OLD, "3.0.0": OLD, "4.0.0": YESTERDAY } };
    const head = await tree({ lib: "1.0.0" }, {}, { name: "app", dependencies: { lib: "^1.0.0" } });
    const found = await bumpCandidates(head, environment(affected, registry));
    expect(found.bumps[0]).toMatchObject({ minor: undefined, major: { version: "2.0.0", line: "2" } });
  });

  it("reads a nested workspace's copy from its parent workspace, and keeps npm aliases under their target's name", async () => {
    const registry = { lib: { "1.0.0": OLD, "1.1.0": OLD, "2.0.0": OLD } };
    const tarball = (version: string) => ({ resolved: `https://registry.npmjs.org/lib/-/lib-${version}.tgz`, integrity: "sha512-AAAA" });
    const head = await tree(
      {},
      {},
      { name: "app", workspaces: ["apps/a", "apps/a/b"], dependencies: { compat: "npm:lib@^1.0.0" }, devDependencies: { any: "npm:lib", scoped: "npm:@acme/kit" } },
      {
        "node_modules/lib": { version: "2.0.0", ...tarball("2.0.0") },
        "node_modules/compat": { name: "lib", version: "1.0.0", ...tarball("1.0.0") },
        "node_modules/any": { name: "lib", version: "1.0.0", ...tarball("1.0.0") },
        "node_modules/scoped": { name: "@acme/kit", version: "1.0.0", resolved: "https://registry.npmjs.org/@acme/kit/-/kit-1.0.0.tgz", integrity: "sha512-AAAA" },
        "apps/a": { name: "a", dependencies: { lib: "^1.0.0" } },
        "apps/a/node_modules/lib": { version: "1.0.0", ...tarball("1.0.0") },
        "apps/a/b": { name: "b", dependencies: { lib: "^1.0.0" } },
      },
    );
    const found = await bumpCandidates(head, environment({}, { ...registry, "@acme/kit": { "1.0.0": OLD, "1.1.0": OLD } }));
    expect(found.bumps.map((bump) => [bump.name, bump.from, bump.declarations.map((d) => `${d.workspace}:${d.declaredAs}=${d.spec}`), bump.minor?.version])).toEqual([
      ["@acme/kit", "1.0.0", [".:scoped=npm:@acme/kit"], "1.1.0"],
      ["lib", "1.0.0", [".:any=npm:lib", ".:compat=npm:lib@^1.0.0", "apps/a:lib=^1.0.0", "apps/a/b:lib=^1.0.0"], "1.1.0"],
    ]);
  });
});

describe("securityCandidates, bundled copies", () => {
  const carrierTarball = (version: string) => `https://registry.npmjs.org/carrier/-/carrier-${version}.tgz`;
  const archives = {
    "1.0.0": archive([{ path: "package/package.json", body: manifest("carrier", "1.0.0") }, { path: "package/node_modules/brace/package.json", body: manifest("brace", "5.0.9") }]),
    "1.1.0": archive([{ path: "package/package.json", body: manifest("carrier", "1.1.0") }, { path: "package/node_modules/brace/package.json", body: manifest("brace", "5.0.12") }]),
  };
  const carrierManifests = Object.fromEntries(Object.entries(archives).map(([version, { integrity }]) => [`carrier@${version}`, { dist: { integrity } }]));
  const head = (braceAtRoot = false) => tree(braceAtRoot ? { brace: "5.0.9" } : {}, {}, { name: "app", dependencies: { carrier: "^1.0.0" } }, {
    "node_modules/carrier": { version: "1.0.0", resolved: carrierTarball("1.0.0"), integrity: archives["1.0.0"].integrity },
    "node_modules/carrier/node_modules/brace": { version: "5.0.9", inBundle: true },
  });
  const registry: Registry = { carrier: { "1.0.0": OLD, "1.1.0": OLD }, brace: { "5.0.9": OLD, "5.0.12": OLD } };
  const withArchives = (env: GateEnvironment): GateEnvironment => ({ ...env, fetchArchive: serving({ [carrierTarball("1.0.0")]: archives["1.0.0"].bytes, [carrierTarball("1.1.0")]: archives["1.1.0"].bytes }) });

  it("moves the carrier for a bundled copy, and fixes the same package's own copy apart", async () => {
    const found = await securityCandidates(await head(true), withArchives(environment({ "brace@5.0.9": ["GHSA-brace"] }, registry, [], carrierManifests)));
    expect(moves(found.fixes)).toEqual([["brace@5.0.9", "5.0.12", undefined], ["carrier@1.0.0", "1.1.0", undefined]]);
    expect(found.fixes.find((fix) => fix.name === "carrier")).toMatchObject({
      locations: ["node_modules/carrier"], targets: [], unfixable: [],
      carries: [{ name: "brace", from: ["5.0.9"], to: ["5.0.12"], locations: ["node_modules/carrier/node_modules/brace"], advisories: ["GHSA-brace"] }],
    });
  });

  it("keeps a carrier a carrier when its bundle's only advisory is unreviewed, so its own fix still checks the bundle", async () => {
    const env = withArchives(environment({ "carrier@1.0.0": ["GHSA-own"] }, registry, [], carrierManifests));
    const advisories = [{ ghsa_id: "GHSA-brace-repo", state: "published", vulnerabilities: [{ package: { ecosystem: "npm", name: "brace" }, vulnerable_version_range: "< 5.0.12" }] }];
    const fetch: GateEnvironment["fetch"] = async (url, init) => {
      if (url === "https://registry.npmjs.org/brace/5.0.9") return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ repository: "github:acme/brace" }), text: async () => "" };
      if (url === "https://api.github.com/repos/acme/brace/security-advisories?state=published&per_page=100") return { ok: true, status: 200, headers: { get: () => null }, json: async () => advisories, text: async () => "" };
      return env.fetch(url, init);
    };
    const found = await securityCandidates(await head(), { ...env, fetch });
    // The carrier's own reviewed advisory is the target, decided as a carrier (`carries`), the bundled one reported.
    expect(found.fixes.find((fix) => fix.name === "carrier")).toMatchObject({ targets: ["GHSA-own"], carries: [], to: { version: "1.1.0" } });
    expect(found.fixes.find((fix) => fix.name === "brace")).toMatchObject({ to: undefined, problem: expect.stringContaining("only in the project's repository advisories") });
    // An own advisory no version fixes, and nothing reviewed in the bundle: no move that fixes nothing.
    const stuck = withArchives(environment({ "carrier@1.0.0": ["GHSA-own"], "carrier@1.1.0": ["GHSA-own"] }, registry, [], carrierManifests));
    const unfixed = await securityCandidates(await head(), { ...stuck, fetch: async (url, init) => (url.includes("brace") ? fetch(url, init) : stuck.fetch(url, init)) });
    expect(unfixed.fixes.find((fix) => fix.name === "carrier")).toMatchObject({ to: undefined, unfixable: ["GHSA-own"], problem: "no version of carrier fixes GHSA-own" });
  });

  it("leaves the carrier's own advisory no version fixes, without holding back the bundled fix", async () => {
    const affected = { "brace@5.0.9": ["GHSA-brace"], "carrier@1.0.0": ["GHSA-forever"], "carrier@1.1.0": ["GHSA-forever"] };
    const found = await securityCandidates(await head(), withArchives(environment(affected, registry, [], carrierManifests)));
    expect(found.fixes).toEqual([expect.objectContaining({ name: "carrier", targets: ["GHSA-forever"], unfixable: ["GHSA-forever"], to: expect.objectContaining({ version: "1.1.0" }) })]);
  });

  it("brings a carrier's choice into the peer closure, so a peer it needs moves with it", async () => {
    const peerRegistry: Registry = { ...registry, host: { "1.0.0": OLD, "1.5.0": OLD } };
    const manifests = { ...carrierManifests, "carrier@1.0.0": { ...carrierManifests["carrier@1.0.0"], peerDependencies: { host: "^1.0.0" } }, "carrier@1.1.0": { ...carrierManifests["carrier@1.1.0"], peerDependencies: { host: "^1.5.0" } } };
    const root = { name: "app", dependencies: { carrier: "^1.0.0", host: "^1.0.0" } };
    const withHost = await tree({ host: "1.0.0" }, {}, root, {
      "node_modules/carrier": { version: "1.0.0", resolved: carrierTarball("1.0.0"), integrity: archives["1.0.0"].integrity, peerDependencies: { host: "^1.0.0" } },
      "node_modules/carrier/node_modules/brace": { version: "5.0.9", inBundle: true },
    });
    const found = await securityCandidates(withHost, withArchives(environment({ "brace@5.0.9": ["GHSA-brace"] }, peerRegistry, [], manifests)));
    const carrier = found.fixes.find((fix) => fix.name === "carrier")!;
    const peers = await found.npmPeers!.resolve([{ ...carrier, to: carrier.to!.version }]);
    expect(peers.additions).toEqual([expect.objectContaining({ name: "host", to: "1.5.0" })]);
  });

  it("reports a carrier it can't decide on, without failing the rest", async () => {
    const env = withArchives(environment({ "brace@5.0.9": ["GHSA-brace"] }, registry, [], carrierManifests));
    // The carrier search's own advisory scans fail; the batch's don't include the carrier's candidates once it fails.
    const failing: GateEnvironment = { ...env, run: async (command, args, options) => {
      if (command === "osv-scanner" && args[0] !== "--version" && (await readFile(args[args.indexOf("--lockfile") + 1]!.replace(/^osv-scanner:/, ""), "utf8")).includes('"version":"1.1.0"')) throw new Error("scanner crashed");
      return env.run(command, args, options);
    } };
    const found = await securityCandidates(await head(true), failing);
    expect(moves(found.fixes)).toEqual([["brace@5.0.9", "5.0.12", undefined], ["carrier@1.0.0", undefined, expect.stringContaining("carrier move can't be decided")]]);
  });
});

describe("actions without a trusted age", () => {
  const checkout = { ecosystem: "GitHub Actions" as const, name: "actions/checkout", version: "v7.0.1", locations: [], declarations: [] };
  // Only immutable releases are dated; v7.0.2 and v7.1.0 here aren't.
  const catalog = {
    versions: async () => ["v7.0.1", "v7.0.2", "v7.1.0", "v7.2.0"],
    published: async (pkg: { version: string }) => (pkg.version === "v7.2.0" ? new Date("2026-01-01T00:00:00Z") : undefined),
  };

  it("names the newer releases a bump skips because they have no immutable release", async () => {
    expect(await untrustedActionReleases(checkout, ["v7.0.2", "v7.1.0", "v7.2.0"], catalog, parseConfig({}))).toEqual([
      "actions/checkout v7.0.2, v7.1.0: no immutable GitHub release, so the age can't be trusted and the tools don't pick it; update it by hand, or wait for immutable releases",
    ]);
  });

  it("says nothing for npm, own actions, or when every newer release is dated", async () => {
    expect(await untrustedActionReleases({ ...checkout, ecosystem: "npm" }, ["v7.0.2"], catalog, parseConfig({}))).toEqual([]);
    const own = parseConfig({ ownPackages: { "GitHub Actions": { owners: ["actions"] } } });
    expect(await untrustedActionReleases(checkout, ["v7.0.2"], catalog, own)).toEqual([]);
    expect(await untrustedActionReleases(checkout, ["v7.2.0"], catalog, parseConfig({}))).toEqual([]);
  });
});

describe("action compatible lines", () => {
  it("selects a v-prefixed next major separately from the current line's minor", async () => {
    const sha = "1".repeat(40);
    const head = await tree({}, {
      ".github/workflows/ci.yml": `jobs:\n  test:\n    steps:\n      - uses: acme/tool@${sha} # v1.2.0\n`,
      ".github/supply-chain.json": JSON.stringify({ compatibleLines: { "GitHub Actions:acme/tool": 1 } }),
    });
    const env = environment({}, {});
    const found = await bumpCandidates(head, { ...env, fetch: fakeFetch({
      "https://api.github.com/repos/acme/tool/git/ref/tags/v1.2.0": { body: { object: { type: "commit", sha } } },
      "https://api.github.com/repos/acme/tool/releases?per_page=100&page=1": {
        body: ["v1.2.0", "v1.3.0", "v2.2.0"].map((tag_name) => ({ tag_name, published_at: OLD, draft: false, immutable: true })),
      },
    }) });
    expect(found.incomplete).toEqual([]);
    expect(found.bumps).toEqual([expect.objectContaining({
      name: "acme/tool", from: "v1.2.0", minor: expect.objectContaining({ version: "v1.3.0" }), major: expect.objectContaining({ version: "v2.2.0" }),
    })]);
  });

  it("selects only full release tags, which a pin's comment can name, over a newer partial one", async () => {
    const sha = "1".repeat(40);
    const head = await tree({}, { ".github/workflows/ci.yml": `jobs:\n  test:\n    steps:\n      - uses: acme/tool@${sha} # v1.0.0\n` });
    const env = environment({}, {});
    const found = await bumpCandidates(head, { ...env, fetch: fakeFetch({
      "https://api.github.com/repos/acme/tool/git/ref/tags/v1.0.0": { body: { object: { type: "commit", sha } } },
      "https://api.github.com/repos/acme/tool/releases?per_page=100&page=1": {
        body: ["v1.0.0", "v1.0.1", "v1.1"].map((tag_name) => ({ tag_name, published_at: OLD, draft: false, immutable: true })),
      },
    }) });
    expect(found.bumps).toEqual([expect.objectContaining({ name: "acme/tool", from: "v1.0.0", minor: expect.objectContaining({ version: "v1.0.1" }) })]);
  });
});

describe("IdentityCheck", () => {
  it("checks a replacement against the first integrity among the registry copies the lockfiles ship of the replaced version", async () => {
    const seen: Array<ReadonlyMap<string, string | undefined>> = [];
    const registry = {
      packument: async () => ({ versions: { "1.1.0": { dist: { tarball: `${NPM_REGISTRY}/a/-/a-1.1.0.tgz`, integrity: "sha512-new" } } } }),
      identityProblems: async (_pkg: unknown, shipped: ReadonlyMap<string, string | undefined>) => {
        seen.push(shipped);
        return [];
      },
    } as unknown as NpmRegistry;
    const copy = (path: string, version: string, integrity: string | undefined, resolved = `${NPM_REGISTRY}/a/-/a-${version}.tgz`, bundled = false) =>
      ({ name: "a", version, path, resolved, bundled, integrity });
    const lockfiles = [
      { path: "package-lock.json", bundleProblems: [], packages: [copy("node_modules/a", "1.0.0", undefined), copy("node_modules/x/node_modules/a", "1.0.0", "sha512-first")] },
      { path: "sub/package-lock.json", bundleProblems: [], packages: [
        copy("node_modules/a", "1.0.0", "sha512-later"),
        copy("node_modules/b/node_modules/a", "0.9.0", "sha512-bundled", undefined, true),
        copy("node_modules/c/node_modules/a", "0.8.0", "sha512-git", "git+https://github.com/o/a.git"),
      ] },
    ];
    const check = new IdentityCheck(registry, lockfiles, NO_EXCEPTIONS, "2026-10-16");
    for (const from of ["1.0.0", "0.9.0", "0.8.0"]) await check.problems({ ecosystem: "npm", name: "a", version: from }, "1.1.0");
    expect(seen.map((shipped) => [...shipped])).toEqual([[["1.0.0", "sha512-first"]], [], []]);
    expect(await check.problems({ ecosystem: "Maven", name: "a", version: "1.0.0" }, "1.1.0")).toEqual([]);
    expect(seen).toHaveLength(3);
  });
});
