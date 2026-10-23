import { describe, expect, it } from "vitest";

import { backsFix, heldEvidence, isAdvisoryEvidence, type SourceEvidence } from "../src/advisory-evidence.ts";
import type { HeldVersion } from "../src/release-age.ts";
import { fakeFetch, type FakeResponse } from "./fake-fetch.ts";

const NOW = new Date("2026-10-23T16:57:00.000Z");
const PKG = "tools.jackson.core:jackson-databind";
const REPO_LIST = "https://api.github.com/repos/fasterxml/jackson-databind/security-advisories?per_page=100";

const held = (ids: string[] = ["GHSA-m8xf-2cr7-77ph"], name = PKG): HeldVersion => ({
  ecosystem: "Maven", name, version: "3.2.4", replaced: ["3.2.3"],
  published: "2026-10-18T23:01:30.000Z", eligibleAt: "2026-10-25T23:01:30.000Z", justification: "security-fix",
  targets: [{ name, bundled: false, replaced: ["3.2.3"], proposed: ["3.2.4"], groups: [{ ids, replaced: ["3.2.3"] }] }],
});

const repositoryAdvisory = (overrides: Record<string, unknown> = {}) => ({
  ghsa_id: "GHSA-m8xf-2cr7-77ph", cve_id: "CVE-2026-110879", state: "published",
  vulnerabilities: [{ package: { ecosystem: "maven", name: PKG }, vulnerable_version_range: ">= 3.2.0, <= 3.2.3", patched_versions: "3.2.4" }],
  ...overrides,
});

async function evidence(routes: Record<string, FakeResponse>, target = held(), overrides: ReadonlyMap<string, string> = new Map([[`Maven|${PKG}`, "fasterxml/jackson-databind"]])) {
  const found = await heldEvidence(target, {
    fetch: fakeFetch(routes), token: undefined, now: () => NOW,
    sourceRepos: { fetch: fakeFetch({}), overrides, mavenRepositories: [] },
  });
  return found!;
}

const source = (groups: ReadonlyArray<{ sources: ReadonlyArray<SourceEvidence> }>, name: SourceEvidence["source"]) =>
  groups[0]!.sources.find((entry) => entry.source === name)!;

describe("the evidence behind a held version", () => {
  it("finds an advisory only in the project's repository, the other sources checked", async () => {
    const found = await evidence({ [REPO_LIST]: { body: [repositoryAdvisory()] } });
    expect(found.collectedAt).toBe(NOW.toISOString());
    const [target] = found.targets;
    expect(target).toMatchObject({ ecosystem: "Maven", name: PKG, bundled: false, replaced: ["3.2.3"], proposed: ["3.2.4"] });
    const repository = source(target!.groups, "repository");
    expect(repository).toMatchObject({ lookup: "checked", repository: "fasterxml/jackson-databind" });
    expect(repository.records).toEqual([{
      id: "GHSA-m8xf-2cr7-77ph", aliases: ["CVE-2026-110879"], withdrawn: false, namesPackage: true, declaredFixes: ["3.2.4"],
      verdicts: { "3.2.3": "affected", "3.2.4": "not-affected" },
    }]);
    expect(backsFix(repository.records[0]!, target!.groups[0]!, target!)).toBe(true);
    // Both checked, nothing found: absence is established, not assumed.
    expect(source(target!.groups, "github")).toEqual({ source: "github", lookup: "checked", records: [] });
    expect(source(target!.groups, "osv")).toEqual({ source: "osv", lookup: "checked", records: [] });
  });

  it("reads GitHub's reviewed record and OSV's, each with its own fix and ranges", async () => {
    const found = await evidence({
      [REPO_LIST]: { body: [] },
      "https://api.github.com/advisories/GHSA-m8xf-2cr7-77ph": { body: {
        ghsa_id: "GHSA-m8xf-2cr7-77ph", cve_id: "CVE-2026-110879", type: "reviewed", withdrawn_at: null,
        vulnerabilities: [{ package: { ecosystem: "maven", name: PKG }, vulnerable_version_range: ">= 3.2.0, <= 3.2.3", first_patched_version: "3.2.4" }],
      } },
      "https://api.osv.dev/v1/vulns/GHSA-m8xf-2cr7-77ph": { body: {
        id: "GHSA-m8xf-2cr7-77ph", aliases: ["CVE-2026-110879"],
        // OSV says 3.2.5: the disagreement stays visible.
        affected: [{ package: { ecosystem: "Maven", name: PKG }, ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "3.2.0" }, { fixed: "3.2.5" }] }] }],
      } },
    });
    const groups = found.targets[0]!.groups;
    expect(source(groups, "github").records).toEqual([{
      id: "GHSA-m8xf-2cr7-77ph", aliases: ["CVE-2026-110879"], withdrawn: false, reviewed: true, namesPackage: true, declaredFixes: ["3.2.4"],
      verdicts: { "3.2.3": "affected", "3.2.4": "not-affected" },
    }]);
    const osv = source(groups, "osv").records[0]!;
    expect(osv).toMatchObject({ declaredFixes: ["3.2.5"], verdicts: { "3.2.3": "affected", "3.2.4": "affected" } });
    expect(backsFix(osv, found.targets[0]!.groups[0]!, found.targets[0]!)).toBe(false);
    expect(source(groups, "repository")).toMatchObject({ lookup: "checked", records: [] });
  });

  it("follows an alias a response names, looking each id up once", async () => {
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    const routes: Record<string, FakeResponse> = {
      [REPO_LIST]: { body: [repositoryAdvisory({ ghsa_id: "GHSA-repo-only-0001" })] },
      "https://api.osv.dev/v1/vulns/CVE-2026-110879": { body: { id: "CVE-2026-110879", aliases: [], affected: [] } },
    };
    const found = await heldEvidence(held(["CVE-2026-110879"]), {
      fetch: fakeFetch(routes, requests), token: undefined, now: () => NOW,
      sourceRepos: { fetch: fakeFetch({}), overrides: new Map([[`Maven|${PKG}`, "fasterxml/jackson-databind"]]), mavenRepositories: [] },
    });
    const groups = found!.targets[0]!.groups;
    // The repository advisory matched by its CVE brings in its GHSA id, which GitHub and OSV are then asked about.
    expect(source(groups, "repository").records.map((record) => record.id)).toEqual(["GHSA-repo-only-0001"]);
    expect(source(groups, "github").lookup).toBe("checked");
    // The CVE's OSV record names no package: recorded as such, never as backing the fix.
    expect(source(groups, "osv").records).toEqual([{ id: "CVE-2026-110879", aliases: [], withdrawn: false, namesPackage: false, declaredFixes: [], verdicts: { "3.2.3": "unknown", "3.2.4": "unknown" } }]);
    const urls = requests.map((request) => request.url);
    expect(urls.filter((url) => url.endsWith("/GHSA-repo-only-0001"))).toHaveLength(2);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("keeps a withdrawn record, and reads a range it can't judge as unknown", async () => {
    const found = await evidence({
      [REPO_LIST]: { body: [repositoryAdvisory({ state: "withdrawn", withdrawn_at: "2026-10-22T00:00:00Z" })] },
      "https://api.osv.dev/v1/vulns/GHSA-m8xf-2cr7-77ph": { body: {
        id: "GHSA-m8xf-2cr7-77ph", affected: [{ package: { ecosystem: "Maven", name: PKG }, ranges: [{ type: "GIT", events: [{ introduced: "abc" }, { fixed: "def" }] }] }],
      } },
    });
    const groups = found.targets[0]!.groups;
    const repository = source(groups, "repository").records[0]!;
    expect(repository.withdrawn).toBe(true);
    expect(backsFix(repository, found.targets[0]!.groups[0]!, found.targets[0]!)).toBe(false);
    expect(source(groups, "osv").records[0]!.verdicts).toEqual({ "3.2.3": "unknown", "3.2.4": "unknown" });
  });

  it("records a failed lookup as incomplete, never as absent", async () => {
    const found = await evidence({
      [REPO_LIST]: { status: 500, body: {} },
      "https://api.github.com/advisories/GHSA-m8xf-2cr7-77ph": { status: 502, body: {} },
    });
    const groups = found.targets[0]!.groups;
    expect(source(groups, "repository")).toMatchObject({ lookup: "incomplete", repository: "fasterxml/jackson-databind", reason: expect.stringContaining("HTTP 500") });
    expect(source(groups, "github")).toMatchObject({ lookup: "incomplete", reason: expect.stringContaining("HTTP 502") });
    expect(source(groups, "osv").lookup).toBe("checked");
  });

  it("follows next pages only on GitHub's API host, and only so far", async () => {
    const offHost = await evidence({ [REPO_LIST]: { body: [], headers: { link: '<https://evil.example/page2>; rel="next"' } } });
    // Refused, not followed, and the list it cut short isn't complete.
    expect(source(offHost.targets[0]!.groups, "repository")).toMatchObject({ lookup: "incomplete", reason: expect.stringContaining("off GitHub's API host") });
    const endless = await evidence({ [REPO_LIST]: { body: [], headers: { link: `<${REPO_LIST}>; rel="next"` } } });
    expect(source(endless.targets[0]!.groups, "repository")).toMatchObject({ lookup: "incomplete", reason: expect.stringContaining("run past 20 pages") });
  });

  it("never reads a fix from an OSV range it can't judge", async () => {
    const record = (affected: unknown) => ({ "https://api.osv.dev/v1/vulns/GHSA-m8xf-2cr7-77ph": { body: { id: "GHSA-m8xf-2cr7-77ph", affected: [{ package: { ecosystem: "Maven", name: PKG }, ...affected as object }] } } });
    const verdicts = async (affected: unknown) => source((await evidence({ [REPO_LIST]: { body: [] }, ...record(affected) })).targets[0]!.groups, "osv").records[0]!.verdicts;
    // 3.2.3 listed explicitly; the range that should say whether 3.2.4 is affected has no events.
    expect(await verdicts({ versions: ["3.2.3"], ranges: [{ type: "ECOSYSTEM" }] })).toEqual({ "3.2.3": "affected", "3.2.4": "unknown" });
    expect(await verdicts({ ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "3.2.0" }, { limit: "3.2.4" }] }] })).toEqual({ "3.2.3": "unknown", "3.2.4": "unknown" });
    expect(await verdicts({})).toEqual({ "3.2.3": "unknown", "3.2.4": "unknown" });
    for (const events of [[], [{}], [{ introduced: 42 }], [{ introduced: "3.2.0", fixed: "3.2.4" }]]) {
      expect(await verdicts({ versions: ["3.2.3"], ranges: [{ type: "ECOSYSTEM", events }] })).toEqual({ "3.2.3": "affected", "3.2.4": "unknown" });
    }
    expect(await verdicts({ ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { last_affected: "3.2.3" }] }] })).toEqual({ "3.2.3": "affected", "3.2.4": "not-affected" });
  });

  it("doesn't ask GitHub without a GHSA id, nor a repository it can't name", async () => {
    const found = await evidence({}, held(["CVE-2026-1"]), new Map());
    const groups = found.targets[0]!.groups;
    expect(source(groups, "github")).toMatchObject({ lookup: "not-queried", reason: "no GHSA id is known for it" });
    expect(source(groups, "repository")).toMatchObject({ lookup: "not-queried", reason: "no GitHub source repository is named for it" });
  });

  it("tells evidence it could have written from an edited one", async () => {
    const found = await evidence({ [REPO_LIST]: { body: [repositoryAdvisory()] } });
    expect(isAdvisoryEvidence(JSON.parse(JSON.stringify(found)))).toBe(true);
    expect(isAdvisoryEvidence({ ...found, collectedAt: "soon" })).toBe(false);
    const edited = JSON.parse(JSON.stringify(found));
    edited.targets[0].groups[0].sources[0].records[0].verdicts["3.2.4"] = "fixed";
    expect(isAdvisoryEvidence(edited)).toBe(false);
    edited.targets[0].groups[0].sources[0] = { source: "nvd", lookup: "checked", records: [] };
    expect(isAdvisoryEvidence(edited)).toBe(false);
  });

  it("has nothing to say about a hold without targets", async () => {
    const { targets: _targets, ...bare } = held();
    expect(await heldEvidence({ ...bare, justification: "exception" }, {
      fetch: fakeFetch({}), token: undefined, now: () => NOW, sourceRepos: { fetch: fakeFetch({}), overrides: new Map(), mavenRepositories: [] },
    })).toBeUndefined();
  });
});
