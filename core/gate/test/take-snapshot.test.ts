import { describe, expect, it } from "vitest";

import { ActionsGitHub } from "../src/actions-github.ts";
import { NO_EXCEPTIONS, parseExceptions } from "../src/exceptions.ts";
import { compareFindings, findingsOf } from "../src/findings.ts";
import type { PackageVersion } from "../src/package-version.ts";
import { comparisonVerdict, scanVerdict } from "../src/policy.ts";
import type { RunProcess } from "../src/process.ts";
import { MAVEN_CENTRAL } from "../src/source-repos.ts";
import { type SnapshotOptions, takeSnapshot } from "../src/take-snapshot.ts";
import { fixes, reviewedGroups, targetsOf, unreviewedGroups } from "../src/young-fixes.ts";
import { fakeFetch, type FakeResponse } from "./fake-fetch.ts";

const VITE: PackageVersion = { ecosystem: "npm", name: "vite", version: "8.3.1" };
const OLD_VITE: PackageVersion = { ...VITE, version: "8.2.0" };
const YOUNG_VITE: PackageVersion = { ...VITE, version: "8.3.2" };
const TAKEN = new Date("2026-10-06T20:00:00Z");

/** A fake osv-scanner that reports `vulnerabilities` for every requested package. */
function scanner(vulnerabilities: Record<string, Array<{ id: string; aliases?: string[] }>>): RunProcess {
  return async (_command, args) => {
    const lockfile = args[args.indexOf("--lockfile") + 1]!.replace(/^osv-scanner:/, "");
    const { readFile } = await import("node:fs/promises");
    const inventory = JSON.parse(await readFile(lockfile, "utf8")) as { results: Array<{ packages: Array<{ package: PackageVersion }> }> };
    const packages = inventory.results[0]!.packages.map(({ package: pkg }) => ({
      package: pkg,
      vulnerabilities: vulnerabilities[`${pkg.name}@${pkg.version}`] ?? [],
    }));
    return { code: 1, stdout: JSON.stringify({ results: [{ packages }] }), stderr: "" };
  };
}

function repositoryAdvisory(ghsa: string, range: string, cweIds: string[] = [], cve: string | null = null) {
  return {
    ghsa_id: ghsa,
    cve_id: cve,
    state: "published",
    withdrawn_at: null,
    severity: "medium",
    cwe_ids: cweIds,
    vulnerabilities: [{ package: { ecosystem: "npm", name: "vite" }, vulnerable_version_range: range, patched_versions: "8.3.3" }],
  };
}

/** Options reading vite's repository advisories `published`, with OSV-Scanner reporting `scanned`. */
function options(published: unknown[], scanned: Parameters<typeof scanner>[0]): SnapshotOptions {
  const fetch = fakeFetch({
    "https://registry.npmjs.org/vite/8.2.0": { body: { repository: "github:vitejs/vite" } },
    "https://registry.npmjs.org/vite/8.3.1": { body: { repository: "github:vitejs/vite" } },
    "https://api.github.com/repos/vitejs/vite/security-advisories?state=published&per_page=100": { body: published },
  });
  return {
    osv: { binary: "osv-scanner", run: scanner(scanned) },
    sourceRepos: { fetch, overrides: new Map(), mavenRepositories: [MAVEN_CENTRAL] },
    repositoryAdvisories: { fetch, token: undefined },
    actions: new ActionsGitHub(fetch, undefined),
    now: () => TAKEN,
  };
}

const sources = (advisories: ReadonlyArray<{ id: string; source: string }>) => advisories.map((advisory) => [advisory.id, advisory.source]);

describe("advisory snapshot", () => {
  it("lets OSV's record stand where it reports the group, and keeps the repository's for a version only its range names", async () => {
    // OSV's range for GHSA-wider-in-repo stops above 8.2.0; the repository's doesn't.
    const snapshot = await takeSnapshot([OLD_VITE, VITE], options(
      [repositoryAdvisory("GHSA-new-only-repo", ">=8.3.0,<=8.3.2"), repositoryAdvisory("GHSA-wider-in-repo", ">=8.0.0,<8.3.3")],
      { "vite@8.3.1": [{ id: "GHSA-wider-in-repo" }] },
    ));
    expect(sources(snapshot.advisories(VITE))).toEqual([["GHSA-wider-in-repo", "osv"], ["GHSA-new-only-repo", "repository"]]);
    expect(sources(snapshot.advisories(OLD_VITE))).toEqual([["GHSA-wider-in-repo", "repository"]]);
    expect(snapshot.takenAt).toEqual(TAKEN);
  });

  it("counts OSV's record under another id of the alias group as reporting it, as that version's records link them", async () => {
    // At 8.3.1, OSV knows GHSA-repo-ghsa by its CVE. GHSA-linked-elsewhere shares no id with 8.3.1's records: only
    // 8.2.0's record links it to PYSEC-2026-1's CVE, so 8.3.1 keeps it, and the snapshot's groups make it one finding.
    const published = [repositoryAdvisory("GHSA-repo-ghsa", ">=8.0.0,<8.3.3", [], "CVE-2026-7"), repositoryAdvisory("GHSA-linked-elsewhere", ">=8.3.0,<8.3.3")];
    const scanned = {
      "vite@8.3.1": [{ id: "CVE-2026-7" }, { id: "PYSEC-2026-1", aliases: ["CVE-2026-9"] }],
      "vite@8.2.0": [{ id: "GHSA-linked-elsewhere", aliases: ["CVE-2026-9"] }],
    };
    const snapshot = await takeSnapshot([OLD_VITE, VITE], options(published, scanned));
    expect(sources(snapshot.advisories(VITE))).toEqual([["CVE-2026-7", "osv"], ["PYSEC-2026-1", "osv"], ["GHSA-linked-elsewhere", "repository"]]);
    expect(sources(snapshot.advisories(OLD_VITE))).toEqual([["GHSA-linked-elsewhere", "osv"], ["GHSA-repo-ghsa", "repository"]]);
    expect(snapshot.group("CVE-2026-7")).toBe("GHSA-repo-ghsa");
    expect(findingsOf([{ ...VITE, locations: ["package-lock.json"] }], snapshot).map((finding) => [finding.advisory, finding.ids])).toEqual([
      ["GHSA-repo-ghsa", ["CVE-2026-7"]],
      ["GHSA-linked-elsewhere", ["CVE-2026-9", "GHSA-linked-elsewhere", "PYSEC-2026-1"]],
    ]);
    expect(reviewedGroups(snapshot, VITE)).toEqual(new Set(["GHSA-repo-ghsa", "GHSA-linked-elsewhere"]));
  });

  it("decides a version's repository records from its own records, whatever versions share the snapshot", async () => {
    const published = [repositoryAdvisory("GHSA-linked-elsewhere", ">=8.3.0,<8.3.3")];
    const scanned = {
      "vite@8.3.1": [{ id: "PYSEC-2026-1", aliases: ["CVE-2026-9"] }],
      "vite@8.2.0": [{ id: "GHSA-linked-elsewhere", aliases: ["CVE-2026-9"] }],
    };
    const alone = await takeSnapshot([VITE], options(published, scanned));
    const together = await takeSnapshot([OLD_VITE, VITE], options(published, scanned));
    expect(together.advisories(VITE)).toEqual(alone.advisories(VITE));
    expect(sources(alone.advisories(VITE))).toEqual([["PYSEC-2026-1", "osv"], ["GHSA-linked-elsewhere", "repository"]]);
  });

  it("always keeps a repository advisory marked as malware, even where OSV reports the group without calling it malware", async () => {
    const snapshot = await takeSnapshot([OLD_VITE, VITE], options(
      [repositoryAdvisory("GHSA-malware-in-repo", ">=8.0.0", ["CWE-506"])],
      { "vite@8.3.1": [{ id: "GHSA-malware-in-repo" }] },
    ));
    expect(snapshot.advisories(VITE).map((advisory) => [advisory.id, advisory.source, advisory.malicious])).toEqual([
      ["GHSA-malware-in-repo", "osv", false],
      ["GHSA-malware-in-repo", "repository", true],
    ]);
    expect(findingsOf([{ ...VITE, locations: ["package-lock.json"] }], snapshot).map((finding) => [finding.advisory, finding.malicious])).toEqual([
      ["GHSA-malware-in-repo", true],
    ]);
    expect(sources(snapshot.advisories(OLD_VITE))).toEqual([["GHSA-malware-in-repo", "repository"]]);
  });

  it("applies the same rule to base, head and young candidates, and a base's repository-only record doesn't make head's reviewed one inherited", async () => {
    // Base 8.2.0 is only in the repository's range, head 8.3.1 is in OSV's too, and candidate 8.3.2 is in neither scan.
    const snapshot = await takeSnapshot([OLD_VITE, VITE], options(
      [repositoryAdvisory("GHSA-wider-in-repo", ">=8.0.0,<=8.3.2")],
      { "vite@8.3.1": [{ id: "GHSA-wider-in-repo" }] },
    ), [YOUNG_VITE]);
    const base = findingsOf([{ ...OLD_VITE, locations: ["package-lock.json"] }], snapshot);
    const head = findingsOf([{ ...VITE, locations: ["package-lock.json"] }], snapshot);
    expect(base.map((finding) => [finding.version, finding.advisory, finding.reviewed])).toEqual([["8.2.0", "GHSA-wider-in-repo", false]]);
    expect(head.map((finding) => [finding.version, finding.advisory, finding.reviewed])).toEqual([["8.3.1", "GHSA-wider-in-repo", true]]);
    const comparison = compareFindings(base, head);
    expect(comparison.inherited).toEqual([]);
    expect(comparison.added.map((finding) => [finding.version, finding.advisory])).toEqual([["8.3.1", "GHSA-wider-in-repo"]]);
    const verdict = comparisonVerdict(comparison, NO_EXCEPTIONS, snapshot, "2026-10-06");
    expect(verdict.failures).toEqual(["new: vite@8.3.1: GHSA-wider-in-repo has no exception"]);
    expect(verdict.warnings).toEqual([]);
    // Moving the other way, from the reviewed record to the repository-only one, inherits it.
    const back = compareFindings(head, base);
    expect(back.added).toEqual([]);
    expect(comparisonVerdict(back, NO_EXCEPTIONS, snapshot, "2026-10-06").warnings).toEqual(["inherited: vite@8.2.0: GHSA-wider-in-repo (MEDIUM)"]);
    expect(sources(snapshot.advisories(YOUNG_VITE))).toEqual([["GHSA-wider-in-repo", "repository"]]);
  });
});

const NETTY: PackageVersion = { ecosystem: "Maven", name: "io.netty:netty-codec-http", version: "4.1.138.Final" };
const NETTY_OLD: PackageVersion = { ...NETTY, version: "4.1.132.Final" };
const NETTY_GHSA = "GHSA-57rv-r2g8-2cj3";
const OSV_RECORD = `https://api.osv.dev/v1/vulns/${NETTY_GHSA}`;

function nettyAdvisory() {
  return {
    ghsa_id: NETTY_GHSA, state: "published",
    vulnerabilities: [{ package: { ecosystem: "maven", name: NETTY.name },
      vulnerable_version_range: "<=4.2.12.Final, <=4.1.132.Final", patched_versions: "4.2.13.Final, 4.1.133.Final" }],
  };
}

function nettyReviewed() {
  return {
    id: NETTY_GHSA,
    affected: [{ package: { ecosystem: "Maven", name: NETTY.name }, ranges: [
      { type: "ECOSYSTEM", events: [{ introduced: "4.2.0.Alpha1" }, { fixed: "4.2.13.Final" }] },
      { type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "4.1.133.Final" }] },
    ] }],
  };
}

function reviewedOptions(
  pkg: PackageVersion, published: unknown[], routes: Record<string, FakeResponse | (() => FakeResponse)>,
  scanned: Parameters<typeof scanner>[0] = {}, requests: Array<{ url: string; headers: Record<string, string> }> = [],
): SnapshotOptions {
  const fetch = fakeFetch({
    "https://api.github.com/repos/owner/project/security-advisories?state=published&per_page=100": { body: published },
    ...routes,
  }, requests);
  return {
    osv: { binary: "osv-scanner", run: scanner(scanned) },
    sourceRepos: { fetch, overrides: new Map([[`${pkg.ecosystem}|${pkg.name}`, "owner/project"]]), mavenRepositories: [] },
    repositoryAdvisories: { fetch, token: "test-token" },
    actions: new ActionsGitHub(fetch, "test-token"), now: () => TAKEN,
  };
}

const scanFailures = (pkg: PackageVersion, snapshot: Awaited<ReturnType<typeof takeSnapshot>>) =>
  scanVerdict(findingsOf([{ ...pkg, locations: ["lockfile"] }], snapshot), NO_EXCEPTIONS, snapshot, "2026-10-29").failures;

describe("reviewed records overriding wider repository ranges", () => {
  it("clears netty 4.1.138, keeps the reviewed finding on 4.1.132 and permits that fix", async () => {
    const snapshot = await takeSnapshot([NETTY_OLD, NETTY], reviewedOptions(NETTY, [nettyAdvisory()], {
      [OSV_RECORD]: { body: nettyReviewed() },
    }, { [`${NETTY.name}@${NETTY_OLD.version}`]: [{ id: NETTY_GHSA }] }));
    expect(snapshot.advisories(NETTY)).toEqual([]);
    expect(sources(snapshot.advisories(NETTY_OLD))).toEqual([[NETTY_GHSA, "osv"]]);
    expect(scanFailures(NETTY, snapshot)).toEqual([]);
    expect(scanFailures(NETTY_OLD, snapshot)).toHaveLength(1);
    expect(snapshot.gaps).toEqual([]);
    expect(snapshot.notes).toEqual([expect.stringContaining(`${NETTY_GHSA} (owner/project) for ${NETTY.name}@4.1.138.Final`)]);
    expect(snapshot.notes[0]).toContain("the reviewed ranges apply");
    expect(unreviewedGroups(snapshot, NETTY)).toEqual(new Set());
    expect(targetsOf(snapshot, NETTY)).toEqual([]);
    expect(fixes(snapshot, NETTY, NETTY_OLD.version, [NETTY_GHSA], NETTY.version)).toBe(true);
  });

  it("keeps a version the reviewed ranges affect even when the scanner omitted it", async () => {
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    const snapshot = await takeSnapshot([NETTY_OLD, NETTY], reviewedOptions(NETTY, [nettyAdvisory()], {
      [OSV_RECORD]: { body: nettyReviewed() },
    }, {}, requests));
    expect(sources(snapshot.advisories(NETTY_OLD))).toEqual([[NETTY_GHSA, "repository"]]);
    expect(snapshot.advisories(NETTY)).toEqual([]);
    expect(scanFailures(NETTY_OLD, snapshot)).toHaveLength(1);
    expect(snapshot.gaps).toEqual([]);
    expect(snapshot.notes).toContain(`${NETTY_GHSA} (owner/project) for ${NETTY.name}@${NETTY_OLD.version}: its reviewed record says affected but the scan didn't report it; repository record kept`);
    expect(requests.filter((request) => request.url === OSV_RECORD)).toHaveLength(1);
  });

  it.each([
    [{}, false],
    [{ ranges: [{ type: "GIT", events: [{ introduced: "abc" }, { fixed: "def" }] }] }, false],
    [{ ranges: [{ type: "ECOSYSTEM", events: [] }] }, true],
  ])("keeps a repository record when the reviewed ranges can't decide the version (%j)", async (ranges, gap) => {
    const snapshot = await takeSnapshot([NETTY], reviewedOptions(NETTY, [nettyAdvisory()], {
      [OSV_RECORD]: { body: { id: NETTY_GHSA, affected: [{ package: { ecosystem: "Maven", name: NETTY.name }, ...ranges }] } },
    }));
    expect(sources(snapshot.advisories(NETTY))).toEqual([[NETTY_GHSA, "repository"]]);
    expect(scanFailures(NETTY, snapshot)).toHaveLength(1);
    expect(snapshot.gaps).toHaveLength(gap ? 1 : 0);
  });

  it.each([[NETTY_GHSA, false], ["CVE-2026-12345", true]])("rejects only explicitly unreviewed GHSA imports from OSV (%s)", async (id, dropped) => {
    const snapshot = await takeSnapshot([NETTY], reviewedOptions(NETTY, [nettyAdvisory()], {
      [OSV_RECORD]: { body: { ...nettyReviewed(), id, aliases: [NETTY_GHSA], database_specific: { github_reviewed: false } } },
    }));
    expect(snapshot.advisories(NETTY)).toHaveLength(dropped ? 0 : 1);
    expect(snapshot.gaps).toEqual([]);
  });

  it("clears the two-entry netty repository range, which includes 4.1.138 via the 4.2 branch", async () => {
    const pkg = { ...NETTY, name: "io.netty:netty-codec-http2" };
    const id = "GHSA-fghv-69vj-qj49";
    const published = { ...nettyAdvisory(), ghsa_id: id, vulnerabilities: [
      { package: { ecosystem: "maven", name: pkg.name }, vulnerable_version_range: "<=4.1.124.Final", patched_versions: "4.1.125.Final" },
      { package: { ecosystem: "maven", name: pkg.name }, vulnerable_version_range: "<=4.2.4.Final", patched_versions: "4.2.5.Final" },
    ] };
    const snapshot = await takeSnapshot([pkg], reviewedOptions(pkg, [published], {
      [`https://api.osv.dev/v1/vulns/${id}`]: { body: { id, affected: [{ package: { ecosystem: "Maven", name: pkg.name }, ranges: [
        { type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "4.1.125.Final" }] },
        { type: "ECOSYSTEM", events: [{ introduced: "4.2.0.Alpha1" }, { fixed: "4.2.5.Final" }] },
      ] }] } },
    }));
    expect(snapshot.advisories(pkg)).toEqual([]);
    expect(snapshot.gaps).toEqual([]);
    expect(snapshot.notes).toEqual([expect.stringContaining("the reviewed ranges apply")]);
  });

  it("keeps all three unimported zstd-jni advisories on 404 and still fails", async () => {
    const pkg: PackageVersion = { ecosystem: "Maven", name: "com.github.luben:zstd-jni", version: "1.5.7-6" };
    const ids = ["GHSA-h5m7-4hv9-cvp3", "GHSA-5p5w-hg9r-gx2p", "GHSA-8v5f-66rc-52f5"];
    // Only the ids/absence are the incident's facts; a synthetic matching range exercises repository retention.
    const published = ids.map((ghsa_id) => ({ ghsa_id, state: "published", vulnerabilities: [
      { package: { ecosystem: "maven", name: pkg.name }, vulnerable_version_range: "<=1.5.7-6" },
    ] }));
    const snapshot = await takeSnapshot([pkg], reviewedOptions(pkg, published, {}));
    expect(snapshot.advisories(pkg).map((advisory) => advisory.id)).toEqual(ids);
    expect(scanFailures(pkg, snapshot)).toHaveLength(3);
    expect(snapshot.gaps).toEqual([]);
  });

  it.each([
    ["HTTP failure", { status: 500 }, "HTTP 500"],
    ["malformed record", { body: {} }, "has no id"],
    ["invalid id", { body: { ...nettyReviewed(), id: "" } }, "has no id"],
    ["null record", { body: null }, "isn't an object"],
    ["malformed package list", { body: { ...nettyReviewed(), affected: [nettyReviewed().affected[0], { package: { name: NETTY.name } }] } }, "no readable package list"],
    ["network failure", () => { throw new Error("offline"); }, "offline"],
  ] as const)("keeps the record and a gap on %s", async (_name, response, reason) => {
    const snapshot = await takeSnapshot([NETTY], reviewedOptions(NETTY, [nettyAdvisory()], { [OSV_RECORD]: response }));
    expect(sources(snapshot.advisories(NETTY))).toEqual([[NETTY_GHSA, "repository"]]);
    expect(scanFailures(NETTY, snapshot)).toHaveLength(1);
    expect(snapshot.gaps).toEqual([expect.stringContaining("the reviewed database couldn't be asked")]);
    expect(snapshot.gaps[0]).toContain(reason);
    expect(snapshot.gaps[0]).toContain("repository record kept");
  });

  it.each([
    ["same package", "Maven", NETTY.name, true],
    ["bare Maven artifact", "Maven", "netty-codec-http", false],
    ["another package", "Maven", "io.netty:netty-handler", false],
    ["another ecosystem", "npm", NETTY.name, false],
  ])("uses a CVE-only record naming %s", async (_name, ecosystem, name, dropped) => {
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    const cve = "CVE-2026-12345";
    const snapshot = await takeSnapshot([NETTY], reviewedOptions(NETTY, [{ ...nettyAdvisory(), cve_id: cve }], {
      [`https://api.osv.dev/v1/vulns/${cve}`]: { body: { id: cve, affected: [{ package: { ecosystem, name }, versions: ["4.1.132.Final"] }] } },
    }, {}, requests));
    expect(snapshot.advisories(NETTY)).toHaveLength(dropped ? 0 : 1);
    expect(snapshot.gaps).toEqual([]);
    expect(snapshot.notes).toHaveLength(dropped ? 1 : 0);
    expect(requests.filter((request) => request.url.includes("/vulns/")).map((request) => request.url)).toEqual([
      OSV_RECORD, `https://api.osv.dev/v1/vulns/${cve}`,
    ]);
  });

  it("reuses a raw record across packages without sharing their package-match decision", async () => {
    const other = { ...NETTY, name: "io.netty:netty-handler" };
    const published = nettyAdvisory();
    const advisory = { ...published, vulnerabilities: [...published.vulnerabilities, {
      ...published.vulnerabilities[0]!, package: { ecosystem: "maven", name: other.name },
    }] };
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    const options = reviewedOptions(NETTY, [advisory], { [OSV_RECORD]: { body: nettyReviewed() } }, {}, requests);
    const snapshot = await takeSnapshot([NETTY, other], { ...options, sourceRepos: {
      ...options.sourceRepos, overrides: new Map([[`Maven|${NETTY.name}`, "owner/project"], [`Maven|${other.name}`, "owner/project"]]),
    } });
    expect(snapshot.advisories(NETTY)).toEqual([]);
    expect(sources(snapshot.advisories(other))).toEqual([[NETTY_GHSA, "repository"]]);
    expect(requests.filter((request) => request.url === OSV_RECORD)).toHaveLength(1);
  });

  it("reports a shared lookup failure for every affected package, once across its versions", async () => {
    const other = { ...NETTY, name: "io.netty:netty-handler" };
    const published = nettyAdvisory();
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    const options = reviewedOptions(NETTY, [{ ...published, vulnerabilities: [...published.vulnerabilities, {
      ...published.vulnerabilities[0]!, package: { ecosystem: "maven", name: other.name },
    }] }], { [OSV_RECORD]: { status: 500 } }, {}, requests);
    const snapshot = await takeSnapshot([NETTY_OLD, NETTY, other], { ...options, sourceRepos: {
      ...options.sourceRepos, overrides: new Map([[`Maven|${NETTY.name}`, "owner/project"], [`Maven|${other.name}`, "owner/project"]]),
    } });
    expect(snapshot.gaps).toHaveLength(2);
    expect(snapshot.gaps).toEqual([expect.stringContaining(NETTY.name), expect.stringContaining(other.name)]);
    expect(snapshot.notes).toEqual([]);
    expect(requests.filter((request) => request.url === OSV_RECORD)).toHaveLength(1);
    expect([NETTY_OLD, NETTY, other].every((pkg) => snapshot.advisories(pkg).length === 1)).toBe(true);
  });

  it("applies the same reviewed-record rule to npm", async () => {
    const snapshot = await takeSnapshot([VITE], reviewedOptions(VITE, [repositoryAdvisory("GHSA-npm-reviewed", "<9.0.0")], {
      "https://api.osv.dev/v1/vulns/GHSA-npm-reviewed": { body: { id: "GHSA-npm-reviewed", affected: [
        { package: { ecosystem: "npm", name: VITE.name }, versions: ["8.2.0"] },
      ] } },
    }));
    expect(snapshot.advisories(VITE)).toEqual([]);
    expect(scanFailures(VITE, snapshot)).toEqual([]);
  });

  it("keeps a failed GHSA lookup even if its CVE would name the package", async () => {
    const snapshot = await takeSnapshot([NETTY], reviewedOptions(NETTY, [{ ...nettyAdvisory(), cve_id: "CVE-2026-12345" }], {
      [OSV_RECORD]: { status: 500 },
      "https://api.osv.dev/v1/vulns/CVE-2026-12345": { body: { ...nettyReviewed(), aliases: ["CVE-2026-12345"] } },
    }));
    expect(sources(snapshot.advisories(NETTY))).toEqual([[NETTY_GHSA, "repository"]]);
    expect(snapshot.gaps).toEqual([expect.stringContaining("HTTP 500")]);
  });

  it("follows an alias revealed by a known record that doesn't name the package", async () => {
    const snapshot = await takeSnapshot([NETTY], reviewedOptions(NETTY, [nettyAdvisory()], {
      [OSV_RECORD]: { body: { id: NETTY_GHSA, aliases: ["CVE-2026-12345"], affected: [] } },
      "https://api.osv.dev/v1/vulns/CVE-2026-12345": { body: { ...nettyReviewed(), aliases: ["CVE-2026-12345"] } },
    }));
    expect(snapshot.advisories(NETTY)).toEqual([]);
  });

  it("keeps the finding with a gap when alias traversal exceeds its budget", async () => {
    const routes: Record<string, FakeResponse> = {};
    for (let i = 0; i < 17; i++) {
      const id = i === 0 ? NETTY_GHSA : `CVE-2026-${i}`;
      routes[`https://api.osv.dev/v1/vulns/${id}`] = { body: { id, aliases: [`CVE-2026-${i + 1}`], affected: [] } };
    }
    const snapshot = await takeSnapshot([NETTY], reviewedOptions(NETTY, [nettyAdvisory()], routes));
    expect(snapshot.advisories(NETTY)).toHaveLength(1);
    expect(snapshot.gaps).toEqual([expect.stringContaining("more than 16 ids")]);
  });

  it("always keeps repository malware without consulting the reviewed record", async () => {
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    const snapshot = await takeSnapshot([NETTY], reviewedOptions(NETTY, [{ ...nettyAdvisory(), cwe_ids: ["CWE-506"] }], {
      [OSV_RECORD]: { body: nettyReviewed() },
    }, {}, requests));
    expect(snapshot.advisories(NETTY)).toMatchObject([{ id: NETTY_GHSA, malicious: true, source: "repository" }]);
    expect(requests.some((request) => request.url.includes("/vulns/"))).toBe(false);
    expect(scanFailures(NETTY, snapshot)).toHaveLength(1);
  });

  it("bounds concurrent reviewed lookups across packages", async () => {
    const packages = Array.from({ length: 20 }, (_, i): PackageVersion => ({ ecosystem: "npm", name: `pkg-${i}`, version: "1.0.0" }));
    const routes: Record<string, FakeResponse> = {};
    const published = packages.map((pkg, i) => {
      const id = `GHSA-concurrency-${i}`;
      routes[`https://api.osv.dev/v1/vulns/${id}`] = { body: { id, affected: [{ package: { ecosystem: "npm", name: pkg.name }, versions: [] }] } };
      return { ghsa_id: id, state: "published", vulnerabilities: [
        { package: { ecosystem: "npm", name: pkg.name }, vulnerable_version_range: "<2.0.0" },
      ] };
    });
    const options = reviewedOptions(packages[0]!, published, routes);
    const fetch = options.repositoryAdvisories.fetch;
    let active = 0;
    let peak = 0;
    const snapshot = await takeSnapshot(packages, { ...options,
      sourceRepos: { ...options.sourceRepos, overrides: new Map(packages.map((pkg) => [`npm|${pkg.name}`, "owner/project"])) },
      repositoryAdvisories: { ...options.repositoryAdvisories, fetch: async (url, init) => {
        if (!url.includes("/vulns/")) return fetch(url, init);
        active++;
        peak = Math.max(peak, active);
        // Let the other requests start before this fake response completes.
        await new Promise((resolve) => setTimeout(resolve, 0));
        try {
          return await fetch(url, init);
        } finally {
          active--;
        }
      } },
    });
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
    expect(packages.every((pkg) => snapshot.advisories(pkg).length === 0)).toBe(true);
  });

  it.each(["known", "unknown", "failed"])("shares lookups across base, head and candidates (%s)", async (state) => {
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    const candidate = { ...NETTY, version: "4.1.139.Final" };
    const base = { ...NETTY, version: "4.1.136.Final" };
    const snapshot = await takeSnapshot([base, NETTY], reviewedOptions(NETTY, [nettyAdvisory()], {
      [OSV_RECORD]: state === "failed" ? { status: 500 } : state === "unknown" ? { status: 404 } : { body: nettyReviewed() },
    }, {}, requests), [candidate]);
    expect([base, NETTY, candidate].map((pkg) => snapshot.advisories(pkg).length)).toEqual(state === "known" ? [0, 0, 0] : [1, 1, 1]);
    expect(snapshot.gaps).toHaveLength(state === "failed" ? 1 : 0);
    expect(snapshot.notes).toHaveLength(state === "known" ? 1 : 0);
    expect(requests.filter((request) => request.url === OSV_RECORD)).toHaveLength(1);
  });

  it.each(["osv", "github"])("keeps the repository finding when its %s record was withdrawn", async (source) => {
    const pkg = source === "github" ? { ecosystem: "GitHub Actions", name: "owner/action", version: "4.1.138" } as const : NETTY;
    const published = source === "github" ? { ...nettyAdvisory(), vulnerabilities: [
      { package: { ecosystem: "actions", name: pkg.name }, vulnerable_version_range: "<5.0.0" },
    ] } : nettyAdvisory();
    const routes: Record<string, FakeResponse> = source === "github" ? {
      [`https://api.github.com/advisories/${NETTY_GHSA}`]: { body: { ghsa_id: NETTY_GHSA, type: "reviewed", withdrawn_at: "2026-10-28", vulnerabilities: [
        { package: { ecosystem: "actions", name: pkg.name } },
      ] } },
    } : { [OSV_RECORD]: { body: { ...nettyReviewed(), withdrawn: "2026-10-28" } } };
    const snapshot = await takeSnapshot([pkg], reviewedOptions(pkg, [published], routes));
    expect(sources(snapshot.advisories(pkg))).toEqual([[NETTY_GHSA, "repository"]]);
    expect(snapshot.gaps).toEqual([]);
    expect(snapshot.notes).toEqual([expect.stringContaining("reviewed record was withdrawn; repository record kept")]);
  });

  it.each([
    ["<5.0.0", true],
    ["unreadable range", false],
  ])("keeps an Actions finding when the reviewed record doesn't clear it (%s)", async (range, affected) => {
    const pkg = { ecosystem: "GitHub Actions", name: "owner/action", version: "4.1.138" } as const;
    const snapshot = await takeSnapshot([pkg], reviewedOptions(pkg, [{ ...nettyAdvisory(), vulnerabilities: [
      { package: { ecosystem: "actions", name: pkg.name }, vulnerable_version_range: "<5.0.0" },
    ] }], {
      [`https://api.github.com/advisories/${NETTY_GHSA}`]: { body: { ghsa_id: NETTY_GHSA, type: "reviewed", vulnerabilities: [
        { package: { ecosystem: "actions", name: pkg.name }, vulnerable_version_range: range },
      ] } },
    }));
    expect(sources(snapshot.advisories(pkg))).toEqual([[NETTY_GHSA, "repository"]]);
    expect(snapshot.gaps).toEqual([]);
    expect(snapshot.notes).toHaveLength(affected ? 1 : 0);
    if (affected) expect(snapshot.notes[0]).toContain("reviewed record says affected but the scan didn't report it");
  });

  it("keeps a tokenless Actions finding with a gap when GitHub refuses the reviewed lookup", async () => {
    const pkg = { ecosystem: "GitHub Actions", name: "owner/action", version: "4.1.138" } as const;
    const options = reviewedOptions(pkg, [{ ...nettyAdvisory(), vulnerabilities: [
      { package: { ecosystem: "actions", name: pkg.name }, vulnerable_version_range: "<5.0.0" },
    ] }], { [`https://api.github.com/advisories/${NETTY_GHSA}`]: { status: 403 } });
    const snapshot = await takeSnapshot([pkg], { ...options,
      repositoryAdvisories: { ...options.repositoryAdvisories, token: undefined },
      actions: new ActionsGitHub(options.repositoryAdvisories.fetch, undefined),
    });
    expect(sources(snapshot.advisories(pkg))).toEqual([[NETTY_GHSA, "repository"]]);
    expect(snapshot.gaps).toEqual([expect.stringContaining("HTTP 403")]);
    expect(snapshot.notes).toEqual([]);
  });

  it("keeps an Actions record with a gap when the global response can't be parsed", async () => {
    const pkg = { ecosystem: "GitHub Actions", name: "owner/action", version: "4.1.138" } as const;
    const snapshot = await takeSnapshot([pkg], reviewedOptions(pkg, [{ ...nettyAdvisory(), vulnerabilities: [
      { package: { ecosystem: "actions", name: pkg.name }, vulnerable_version_range: "<5.0.0" },
    ] }], {
      [`https://api.github.com/advisories/${NETTY_GHSA}`]: { body: { ghsa_id: NETTY_GHSA, vulnerabilities: [] } },
    }));
    expect(sources(snapshot.advisories(pkg))).toEqual([[NETTY_GHSA, "repository"]]);
    expect(snapshot.gaps).toEqual([expect.stringContaining("GitHub advisory " + NETTY_GHSA + " has no readable type")]);
  });

  it.each([
    ["reviewed", "actions", "OWNER/ACTION", true],
    ["unreviewed", "actions", "owner/action", false],
    ["malware", "actions", "owner/action", false],
    ["reviewed", "npm", "owner/action", false],
    ["reviewed", "actions", "owner/other", false],
  ])("uses only a reviewed GitHub Actions record naming the action (%s, %s, %s)", async (type, ecosystem, name, dropped) => {
    const pkg = { ecosystem: "GitHub Actions", name: "owner/action", version: "4.1.138" } as const;
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    const snapshot = await takeSnapshot([pkg], reviewedOptions(pkg, [{ ...nettyAdvisory(), vulnerabilities: [
      { package: { ecosystem: "actions", name: pkg.name }, vulnerable_version_range: "<5.0.0" },
    ] }], {
      [`https://api.github.com/advisories/${NETTY_GHSA}`]: { body: { ghsa_id: NETTY_GHSA, type, vulnerabilities: [
        { package: { ecosystem, name }, vulnerable_version_range: "<4.0.0" },
      ] } },
    }, {}, requests));
    expect(snapshot.advisories(pkg)).toHaveLength(dropped ? 0 : 1);
    expect(requests.some((request) => request.url.includes("api.osv.dev"))).toBe(false);
    expect(requests.find((request) => request.url.endsWith(`/${NETTY_GHSA}`))!.headers["authorization"]).toBe("Bearer test-token");
  });
});

describe("doubtful reviewed records never authorize a drop", () => {
  const cve = "CVE-2026-12345";
  const osvPackage = { ecosystem: "Maven", name: NETTY.name };

  it.each([
    ["affected", { versions: [NETTY.version] }, undefined, "says affected", false],
    ["withdrawn", { versions: [] }, "2026-10-28", "was withdrawn", false],
    ["unknown", {}, undefined, undefined, false],
    ["malformed", { versions: [null] }, undefined, undefined, true],
    ["clear", { versions: [] }, undefined, "the reviewed ranges apply", false],
  ])("checks a discovered CVE after a clearing GHSA (%s)", async (_name, ranges, withdrawn, note, gap) => {
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    const snapshot = await takeSnapshot([NETTY], reviewedOptions(NETTY, [nettyAdvisory()], {
      [OSV_RECORD]: { body: { ...nettyReviewed(), aliases: [cve] } },
      [`https://api.osv.dev/v1/vulns/${cve}`]: { body: { id: cve, aliases: [NETTY_GHSA], withdrawn,
        affected: [{ package: osvPackage, ...ranges }],
      } },
    }, {}, requests));
    expect(snapshot.advisories(NETTY)).toHaveLength(_name === "clear" ? 0 : 1);
    expect(snapshot.gaps).toHaveLength(gap ? 1 : 0);
    if (note !== undefined) expect(snapshot.notes).toContainEqual(expect.stringContaining(note));
    expect(requests.filter((request) => request.url.includes("/vulns/")).map((request) => request.url)).toEqual([
      OSV_RECORD, `https://api.osv.dev/v1/vulns/${cve}`,
    ]);
  });

  it("reads every known alias even when a lookup fails, keeping both the gap and withdrawal note", async () => {
    const other = "CVE-2026-67890";
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    const snapshot = await takeSnapshot([NETTY], reviewedOptions(NETTY, [{ ...nettyAdvisory(), cve_id: cve }], {
      [OSV_RECORD]: { status: 500 },
      [`https://api.osv.dev/v1/vulns/${cve}`]: { body: { id: cve, aliases: [other], affected: [{ package: osvPackage, versions: [] }] } },
      [`https://api.osv.dev/v1/vulns/${other}`]: { body: { id: other, withdrawn: "2026-10-28", affected: [{ package: osvPackage, versions: [] }] } },
    }, {}, requests));
    expect(snapshot.advisories(NETTY)).toHaveLength(1);
    expect(snapshot.gaps).toEqual([expect.stringContaining("HTTP 500")]);
    expect(snapshot.notes).toEqual([expect.stringContaining("was withdrawn")]);
    expect(requests.filter((request) => request.url.includes("/vulns/"))).toHaveLength(3);
  });

  it("doesn't let a clearing record bypass the alias budget", async () => {
    const aliases = Array.from({ length: 17 }, (_, i) => `CVE-2026-${i}`);
    const snapshot = await takeSnapshot([NETTY], reviewedOptions(NETTY, [nettyAdvisory()], {
      [OSV_RECORD]: { body: { ...nettyReviewed(), aliases } },
    }));
    expect(snapshot.advisories(NETTY)).toHaveLength(1);
    expect(snapshot.gaps).toEqual([expect.stringContaining("more than 16 ids")]);
  });

  it.each([
    { withdrawn: true, affected: [{ package: osvPackage, versions: [] }] },
    { affected: [{ package: osvPackage, versions: [null] }] },
    { affected: [{ package: osvPackage, versions: "1.0.0" }] },
    { affected: [{ package: osvPackage, ranges: null, versions: [] }] },
    { affected: [{ package: osvPackage, ranges: [{ type: "ECOSYSTEM", events: [{ introduced: 0 }, { fixed: "1.0" }] }] }] },
    { affected: [{ package: osvPackage, ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "" }] }] }] },
    { aliases: [null], affected: [{ package: osvPackage, versions: [] }] },
    { database_specific: { github_reviewed: "false" }, affected: [{ package: osvPackage, versions: [] }] },
  ])("retains the finding and reports malformed decision fields (%j)", async (fields) => {
    const snapshot = await takeSnapshot([NETTY], reviewedOptions(NETTY, [nettyAdvisory()], { [OSV_RECORD]: { body: { id: NETTY_GHSA, ...fields } } }));
    expect(snapshot.advisories(NETTY)).toHaveLength(1);
    expect(scanFailures(NETTY, snapshot)).toHaveLength(1);
    expect(snapshot.gaps).toEqual([expect.stringContaining("unreadable")]);
    expect(snapshot.notes).toEqual([]);
  });

  it("rejects an OSV response for an unrelated id", async () => {
    const snapshot = await takeSnapshot([NETTY], reviewedOptions(NETTY, [nettyAdvisory()], {
      [OSV_RECORD]: { body: { ...nettyReviewed(), id: "GHSA-unrelated" } },
    }));
    expect(snapshot.advisories(NETTY)).toHaveLength(1);
    expect(snapshot.gaps).toEqual([expect.stringContaining("doesn't identify requested")]);
  });

  it("keeps a Maven prerelease affected under SEMVER despite its ECOSYSTEM ordering", async () => {
    const pkg = { ...NETTY, version: "1.0.0-sp1" };
    const snapshot = await takeSnapshot([pkg], reviewedOptions(pkg, [{ ...nettyAdvisory(), vulnerabilities: [
      { package: { ecosystem: "maven", name: pkg.name }, vulnerable_version_range: "<2.0.0" },
    ] }], {
      [OSV_RECORD]: { body: { id: NETTY_GHSA, affected: [{ package: osvPackage, ranges: [
        { type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.0.0" }] },
      ] }] } },
    }));
    expect(snapshot.advisories(pkg)).toHaveLength(1);
    expect(snapshot.notes).toEqual([expect.stringContaining("says affected")]);
    expect(snapshot.gaps).toEqual([]);
  });

  it("preserves a dropped repository record's alias bridge without keeping its finding", async () => {
    const id = "GHSA-bridge";
    const snapshot = await takeSnapshot([OLD_VITE, VITE], reviewedOptions(VITE, [repositoryAdvisory(id, ">=8.3.2, <=8.3.2", [], cve)], {
      [`https://api.osv.dev/v1/vulns/${id}`]: { body: { id, aliases: [cve], affected: [
        { package: { ecosystem: "npm", name: VITE.name }, versions: [OLD_VITE.version, VITE.version] },
      ] } },
    }, { [`vite@${OLD_VITE.version}`]: [{ id: cve }], [`vite@${VITE.version}`]: [{ id }] }), [YOUNG_VITE]);
    expect(snapshot.advisories(YOUNG_VITE)).toEqual([]);
    expect(snapshot.group(cve)).toBe(id);
    expect(snapshot.aliases(id, VITE)).toEqual([cve, id].sort());
    const located = (pkg: PackageVersion) => [{ ...pkg, locations: ["lockfile"] }];
    const base = findingsOf(located(OLD_VITE), snapshot);
    const head = findingsOf(located(VITE), snapshot);
    expect(compareFindings(base, head)).toMatchObject({ added: [], fixed: [], inherited: [expect.objectContaining({ advisory: id })] });
    const exceptions = parseExceptions({ vulnerabilities: [
      { id: cve, package: VITE.name, version: VITE.version, paths: ["lockfile"], reason: "reviewed", expires: "2026-12-31" },
    ] });
    expect(scanVerdict(head, exceptions, snapshot, "2026-10-29").failures).toEqual([]);
    expect(targetsOf(snapshot, OLD_VITE)).toEqual([id]);
    expect(fixes(snapshot, VITE, OLD_VITE.version, [id], VITE.version)).toBe(false);
    expect(fixes(snapshot, VITE, OLD_VITE.version, [id], YOUNG_VITE.version)).toBe(true);
  });
});

describe("OSV aliases describing only the source repository", () => {
  const cve = "CVE-2026-42584";
  // The reported CVE shape, abridged to two tags; hashes stand in for its four Git events.
  const sourceRecord = {
    id: cve, aliases: [NETTY_GHSA], withdrawn: null,
    affected: [{ package: null, ranges: [{ type: "GIT", repo: "https://github.com/netty/netty", events: [
      { introduced: "0" }, { fixed: "1".repeat(40) }, { introduced: "2".repeat(40) }, { fixed: "3".repeat(40) },
    ] }], versions: ["netty-4.1.132.Final", "netty-4.1.131.Final"] }],
    database_specific: { cna_assigner: "GitHub_M", cwe_ids: ["CWE-444"], osv_generated_from: "https://github.com/CVEProject/cvelistV5/..." },
  };

  it.each([true, false])("drops only with a reviewed GHSA naming and clearing the package (GHSA known: %s)", async (known) => {
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    const snapshot = await takeSnapshot([NETTY], reviewedOptions(NETTY, [{ ...nettyAdvisory(), cve_id: cve }], {
      [OSV_RECORD]: known ? { body: { ...nettyReviewed(), aliases: [cve] } } : { status: 404 },
      [`https://api.osv.dev/v1/vulns/${cve}`]: { body: sourceRecord },
    }, {}, requests));
    expect(snapshot.advisories(NETTY)).toHaveLength(known ? 0 : 1);
    expect(scanFailures(NETTY, snapshot)).toHaveLength(known ? 0 : 1);
    expect(snapshot.gaps).toEqual([]);
    expect(snapshot.notes).toHaveLength(known ? 1 : 0);
    if (known) expect(snapshot.notes[0]).toContain("the reviewed ranges apply");
    expect(requests.filter((request) => request.url === `https://api.osv.dev/v1/vulns/${cve}`)).toHaveLength(1);
  });
});

describe("aliases already known across a package's versions", () => {
  const cve = "CVE-2026-54321";

  it("checks an alias known only from base when the GHSA lookup clears head without aliases", async () => {
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    const snapshot = await takeSnapshot([NETTY_OLD, NETTY], reviewedOptions(NETTY, [nettyAdvisory()], {
      [OSV_RECORD]: { body: nettyReviewed() },
      [`https://api.osv.dev/v1/vulns/${cve}`]: { body: { id: cve, affected: [
        { package: { ecosystem: "Maven", name: NETTY.name }, versions: [NETTY.version] },
      ] } },
    }, { [`${NETTY.name}@${NETTY_OLD.version}`]: [{ id: NETTY_GHSA, aliases: [cve] }] }, requests));
    expect(sources(snapshot.advisories(NETTY))).toEqual([[NETTY_GHSA, "repository"]]);
    expect(snapshot.gaps).toEqual([]);
    expect(snapshot.notes).toEqual([expect.stringContaining("says affected but the scan didn't report it")]);
    expect(requests.filter((request) => request.url === `https://api.osv.dev/v1/vulns/${cve}`)).toHaveLength(1);
  });

  it("doesn't seed aliases known only on another package", async () => {
    const other = { ...NETTY_OLD, name: "io.netty:netty-handler" };
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    const options = reviewedOptions(NETTY, [nettyAdvisory()], {
      [OSV_RECORD]: { body: nettyReviewed() },
      [`https://api.osv.dev/v1/vulns/${cve}`]: { body: { id: cve, affected: [
        { package: { ecosystem: "Maven", name: NETTY.name }, versions: [NETTY.version] },
      ] } },
    }, { [`${other.name}@${other.version}`]: [{ id: NETTY_GHSA, aliases: [cve] }] }, requests);
    const snapshot = await takeSnapshot([NETTY, other], { ...options, sourceRepos: {
      ...options.sourceRepos, overrides: new Map([[`Maven|${NETTY.name}`, "owner/project"], [`Maven|${other.name}`, "owner/project"]]),
    } });
    expect(snapshot.advisories(NETTY)).toEqual([]);
    expect(snapshot.gaps).toEqual([]);
    expect(requests.some((request) => request.url === `https://api.osv.dev/v1/vulns/${cve}`)).toBe(false);
  });

  it("applies the lookup budget to aliases learned from another version", async () => {
    const aliases = Array.from({ length: 17 }, (_, i) => `CVE-2026-${i}`);
    const snapshot = await takeSnapshot([NETTY_OLD, NETTY], reviewedOptions(NETTY, [nettyAdvisory()], {
      [OSV_RECORD]: { body: nettyReviewed() },
    }, { [`${NETTY.name}@${NETTY_OLD.version}`]: [{ id: NETTY_GHSA, aliases }] }));
    expect(sources(snapshot.advisories(NETTY))).toEqual([[NETTY_GHSA, "repository"]]);
    expect(snapshot.gaps).toEqual([expect.stringContaining("more than 16 ids")]);
    expect(snapshot.notes).toEqual([]);
  });
});
