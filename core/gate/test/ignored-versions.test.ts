import { describe, expect, it } from "vitest";

import { bumpCandidates, securityCandidates } from "../src/candidates.ts";
import { ignoredVersionReason, parseConfig } from "../src/config.ts";
import { hasIgnoredVersionRefusal, IGNORED_VERSION_REFUSAL } from "../src/ignored-versions.ts";
import { runCompare, runScan } from "../src/gate.ts";
import type { GradleInventory } from "../src/gradle.ts";
import type { Ecosystem } from "../src/versions.ts";
import { environment, json, locked, metadata, OLD, tree } from "./required-fixture.ts";

const entry = { package: "npm:lib", versions: ["1.0.1"], reason: "upstream regression" };

describe("ignoredVersions policy", () => {
  it("defaults to empty and matches exact spellings and packages", () => {
    expect(parseConfig({}).ignoredVersions).toEqual([]);
    const config = parseConfig({ ignoredVersions: [entry, { package: "GitHub Actions:Acme/Tool", versions: ["v1.0.1"], reason: "broken" }] });
    expect(ignoredVersionReason(config, { ecosystem: "npm", name: "lib", version: "1.0.1" })).toBe(entry.reason);
    expect(ignoredVersionReason(config, { ecosystem: "npm", name: "lib-extra", version: "1.0.1" })).toBeUndefined();
    expect(ignoredVersionReason(config, { ecosystem: "npm", name: "lib", version: "v1.0.1" })).toBeUndefined();
    expect(ignoredVersionReason(config, { ecosystem: "GitHub Actions", name: "acme/tool", version: "v1.0.1" })).toBe("broken");
  });

  it("keeps Maven version spellings literal, including a real v prefix", () => {
    const config = parseConfig({ ignoredVersions: [{ ...entry, package: "Maven:g:lib", versions: ["v1.0.1"] }] });
    expect(ignoredVersionReason(config, { ecosystem: "Maven", name: "g:lib", version: "v1.0.1" })).toBe(entry.reason);
    expect(ignoredVersionReason(config, { ecosystem: "Maven", name: "g:lib", version: "1.0.1" })).toBeUndefined();
  });

  it("matches Actions tags exactly, without stripping v", () => {
    const config = parseConfig({ ignoredVersions: [{ ...entry, package: "GitHub Actions:acme/tool", versions: ["v1.0.1"] }] });
    expect(ignoredVersionReason(config, { ecosystem: "GitHub Actions", name: "acme/tool", version: "v1.0.1" })).toBe(entry.reason);
    expect(ignoredVersionReason(config, { ecosystem: "GitHub Actions", name: "acme/tool", version: "1.0.1" })).toBeUndefined();
  });

  it("recognizes only refusal prefixes, not markers embedded in reasons", () => {
    expect(hasIgnoredVersionRefusal([`${IGNORED_VERSION_REFUSAL} npm:lib@1.0.1 at node_modules/lib: broken`])).toBe(true);
    expect(hasIgnoredVersionRefusal([`cannot read lib: upstream reason mentions ${IGNORED_VERSION_REFUSAL}`])).toBe(false);
  });

  it.each([
    null, {}, [null], [{ ...entry, package: "Gradle Wrapper:gradle/gradle" }],
    [{ ...entry, package: "npm:*" }], [{ ...entry, package: "npm:@scope/*" }], [{ ...entry, package: "Maven:g:*" }],
    [{ ...entry, package: "GitHub Actions:acme/*" }], [{ ...entry, package: "npm:" }],
    [{ ...entry, reason: undefined }], [{ ...entry, reason: "  " }], [{ ...entry, versions: undefined }],
    [{ ...entry, versions: [] }], [{ ...entry, versions: ["1.0.1", "1.0.1"] }],
    [{ ...entry, versions: ["v1.0.1"] }], [{ ...entry, versions: ["^1.0.1"] }], [{ ...entry, versions: ["1.x"] }], [{ ...entry, versions: ["latest"] }],
    [{ ...entry, package: "Maven:g:a", versions: ["[1,2)"] }], [{ ...entry, package: "Maven:g:a", versions: ["1.x"] }],
    [{ ...entry, package: "GitHub Actions:acme/tool", versions: ["v1"] }],
    [{ ...entry, expires: "2027-01-01" }], [{ ...entry, typo: true }],
  ])("rejects malformed or extended policy: %j", (ignoredVersions) => {
    expect(() => parseConfig({ ignoredVersions })).toThrow("ignoredVersions");
  });
});

function fixture(ecosystem: Ecosystem, ignored = ["1.0.1", "1.0.3"], advisory = "GHSA-fixed") {
  const name = ecosystem === "Maven" ? "g:lib" : ecosystem === "GitHub Actions" ? "acme/tool" : "lib";
  const version = (value: string) => ecosystem === "GitHub Actions" ? `v${value}` : value;
  const versions = ["1.0.0", "1.0.1", "1.0.2", "1.0.3"].map(version);
  const config = { releaseAgeDays: 0, maven: { repositories: ["https://repo1.maven.org/maven2"] }, ignoredVersions: [{ package: `${ecosystem}:${name}`, versions: ignored.map(version), reason: entry.reason }] };
  const files: Record<string, string> = { ".github/supply-chain.json": json(config) };
  let gradle: GradleInventory | undefined;
  const routes: NonNullable<Parameters<typeof environment>[0]>["routes"] = {};
  if (ecosystem === "npm") {
    files["package-lock.json"] = json({ lockfileVersion: 3, packages: { "": { dependencies: { lib: "^1.0.0" } }, "node_modules/lib": locked("lib", "1.0.0") } });
  } else if (ecosystem === "Maven") {
    files["build.gradle.kts"] = 'dependencies { implementation("g:lib:1.0.0") }';
    gradle = { schemaVersion: 3, tree: "base", builds: [{ build: ".", configurations: [{ id: ":runtimeClasspath", kind: "project", resolved: [{ group: "g", name: "lib", version: "1.0.0" }], declared: [{ group: "g", name: "lib", version: "1.0.0", reason: undefined }], unresolved: [], error: undefined }] }] };
    routes["https://repo1.maven.org/maven2/g/lib/maven-metadata.xml"] = { text: `<metadata><versioning><versions>${versions.map((at) => `<version>${at}</version>`).join("")}</versions></versioning></metadata>` };
    for (const at of versions) routes[`https://repo1.maven.org/maven2/g/lib/${at}/lib-${at}.pom`] = { text: "<project/>", headers: { "last-modified": "Tue, 01 Sep 2026 00:00:00 GMT" } };
  } else {
    const sha = "a".repeat(40);
    files[".github/workflows/ci.yml"] = `jobs:\n  test:\n    steps:\n      - uses: acme/tool@${sha} # v1.0.0\n`;
    routes["https://api.github.com/repos/acme/tool/git/ref/tags/v1.0.0"] = { body: { object: { type: "commit", sha } } };
    routes[`https://api.github.com/advisories?ecosystem=actions&affects=${encodeURIComponent("acme/tool@v1.0.0")}&type=reviewed&per_page=100`] = { body: [{ ghsa_id: "GHSA-fixed", type: "reviewed" }] };
    routes["https://api.github.com/repos/acme/tool/releases?per_page=100&page=1"] = { body: versions.map((tag_name) => ({ tag_name, published_at: OLD, draft: false, immutable: true })) };
  }
  const { env, scans } = environment({ docs: { lib: { time: Object.fromEntries(versions.map((at) => [at, OLD])), versions: Object.fromEntries(versions.map((at) => [at, metadata])) } }, affected: { [`${name}@${version("1.0.0")}`]: [advisory] }, routes });
  return { head: { ...tree(files), list: async (dir: string) => Object.keys(files).filter((path) => dir === "." || path.startsWith(`${dir}/`)) }, env, scans, gradle: { head: gradle }, version };
}

describe.each<Ecosystem>(["npm", "Maven", "GitHub Actions"])("%s tool choices", (ecosystem) => {
  it("skips ignored fixes without losing evidence, and notes ignored newer bumps", async () => {
    const h = fixture(ecosystem);
    const security = await securityCandidates(h.head, h.env, h.gradle);
    expect(security.fixes).toHaveLength(1);
    expect(security.fixes[0]).toMatchObject({ to: { version: h.version("1.0.2") }, unfixable: [], notes: expect.arrayContaining([expect.stringContaining("a fix exists but is ignored by policy")]) });
    const bump = await bumpCandidates(h.head, h.env, h.gradle);
    expect(bump.bumps[0]?.minor?.version).toBe(h.version("1.0.2"));
    expect(bump.notes.join()).toContain("ignored candidate by policy");
    if (ecosystem !== "GitHub Actions") expect(h.scans.flat().join()).toContain(h.version("1.0.1"));
  });

  it("reports an ignored fix rather than claiming no fix exists", async () => {
    const h = fixture(ecosystem, ["1.0.1", "1.0.2", "1.0.3"]);
    const security = await securityCandidates(h.head, h.env, h.gradle);
    expect(security.fixes[0]).toMatchObject({ to: undefined, unfixable: [], problem: expect.stringContaining("a fix exists but is ignored by policy") });
  });
});

it("CI permits a human to introduce an ignored version and to scan it", async () => {
  const config = json({ releaseAgeDays: 0, ignoredVersions: [entry] });
  const files = (version: string) => ({ ".github/supply-chain.json": config, "package-lock.json": json({ lockfileVersion: 3, packages: { "": {}, "node_modules/lib": locked("lib", version) } }) });
  const { env } = environment({ docs: { lib: { time: { "1.0.0": OLD, "1.0.1": OLD }, versions: { "1.0.0": metadata, "1.0.1": metadata } } }, affected: {} });
  expect((await runCompare(tree(files("1.0.0")), tree(files("1.0.1"), "head"), env)).failures).toEqual([]);
  expect((await runScan(tree(files("1.0.1")), env)).failures).toEqual([]);
});

it("prominently names the ignore policy when it blocks every eligible malware fix", async () => {
  const h = fixture("npm", ["1.0.1", "1.0.2", "1.0.3"], "MAL-2026-1");
  const [fix] = (await securityCandidates(h.head, h.env)).fixes;
  expect(fix).toMatchObject({ malicious: true, to: undefined, problem: expect.stringContaining("MALWARE REMAINS:") });
  expect(fix?.problem).toContain("ignoredVersions entry npm:lib");
  expect(fix?.problem).toContain(entry.reason);
  expect((await runScan(h.head, h.env)).failures.join()).toContain("MAL-2026-1");
});

it("still offers a non-ignored clean malware fix", async () => {
  const h = fixture("npm", ["1.0.1", "1.0.3"], "MAL-2026-1");
  expect((await securityCandidates(h.head, h.env)).fixes[0]).toMatchObject({ malicious: true, to: { version: "1.0.2" } });
});

it("the gate independently refuses a new action use without its version comment", async () => {
  const h = fixture("GitHub Actions");
  const head = { ...h.head, id: "head", read: async (path: string) => {
    const text = await h.head.read(path);
    return path === ".github/workflows/ci.yml" ? text?.replace(" # v1.0.0", "") : text;
  } };
  expect((await runCompare(h.head, head, h.env)).failures.join()).toContain("comment names its full version");
});
