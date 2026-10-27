import { describe, expect, it } from "vitest";

import { ActionsGitHub } from "../src/actions-github.ts";
import { compareFindings, findingsOf } from "../src/findings.ts";
import type { PackageVersion } from "../src/package-version.ts";
import type { RunProcess } from "../src/process.ts";
import { MAVEN_CENTRAL } from "../src/source-repos.ts";
import { type SnapshotOptions, takeSnapshot } from "../src/take-snapshot.ts";
import { fakeFetch } from "./fake-fetch.ts";

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

  it("counts OSV's record under another id of the alias group as reporting it", async () => {
    // OSV knows the advisory by its CVE at 8.3.1; a record on 8.2.0 links GHSA-other-id to the CVE too.
    const snapshot = await takeSnapshot([OLD_VITE, VITE], options(
      [repositoryAdvisory("GHSA-repo-ghsa", ">=8.0.0,<8.3.3", [], "CVE-2026-7"), repositoryAdvisory("GHSA-linked-by-other", ">=8.3.0,<8.3.3")],
      {
        "vite@8.3.1": [{ id: "CVE-2026-7" }, { id: "PYSEC-2026-1", aliases: ["CVE-2026-9"] }],
        "vite@8.2.0": [{ id: "GHSA-linked-by-other", aliases: ["CVE-2026-9"] }],
      },
    ));
    expect(sources(snapshot.advisories(VITE))).toEqual([["CVE-2026-7", "osv"], ["PYSEC-2026-1", "osv"]]);
    expect(sources(snapshot.advisories(OLD_VITE))).toEqual([["GHSA-linked-by-other", "osv"], ["GHSA-repo-ghsa", "repository"]]);
    expect(snapshot.group("CVE-2026-7")).toBe("GHSA-repo-ghsa");
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

  it("applies the same rule to base, head and young candidates, so an unchanged group stays inherited", async () => {
    // Base 8.2.0 is only in the repository's range, head 8.3.1 is in OSV's too, and candidate 8.3.2 is in neither scan.
    const snapshot = await takeSnapshot([OLD_VITE, VITE], options(
      [repositoryAdvisory("GHSA-wider-in-repo", ">=8.0.0,<=8.3.2")],
      { "vite@8.3.1": [{ id: "GHSA-wider-in-repo" }] },
    ), [YOUNG_VITE]);
    const base = findingsOf([{ ...OLD_VITE, locations: ["package-lock.json"] }], snapshot);
    const head = findingsOf([{ ...VITE, locations: ["package-lock.json"] }], snapshot);
    const comparison = compareFindings(base, head);
    expect(comparison.added).toEqual([]);
    expect(comparison.inherited.map((finding) => [finding.version, finding.advisory])).toEqual([["8.3.1", "GHSA-wider-in-repo"]]);
    expect(sources(snapshot.advisories(YOUNG_VITE))).toEqual([["GHSA-wider-in-repo", "repository"]]);
  });
});
