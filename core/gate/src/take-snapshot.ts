/**
 * Takes the advisory snapshot for a set of package versions: OSV-Scanner
 * over all npm and Maven ones in one run, GitHub's advisory database for
 * GitHub Actions (OSV can't match their versions), plus the published
 * advisories of each one's source repository. Each version's findings are
 * combined: where OSV (GitHub, for an action) reports a repository
 * advisory's alias group for that version, its record stands and the
 * repository's is left out; for a version only the repository's range
 * names, the repository's record is kept. A repository advisory marked as
 * malware is always kept: OSV might not classify it the same way.
 */
import type { ActionsGitHub } from "./actions-github.ts";
import { mapLimited } from "./http.ts";
import { scanWithOsvScanner, type OsvRecord, type OsvScannerOptions } from "./osv-scanner.ts";
import { packageKey, type PackageVersion, uniqueVersions, versionKey } from "./package-version.ts";
import { matchRepositoryAdvisories, type RepositoryAdvisory, type RepositoryAdvisoryOptions } from "./repository-advisories.ts";
import { type Advisory, aliasGroups, isMalware, Snapshot } from "./snapshot.ts";
import { sourceRepositories, type SourceRepoOptions } from "./source-repos.ts";

export interface SnapshotOptions {
  readonly osv: OsvScannerOptions;
  readonly sourceRepos: SourceRepoOptions;
  readonly repositoryAdvisories: RepositoryAdvisoryOptions;
  /** GitHub's advisory database, for GitHub Actions. */
  readonly actions: ActionsGitHub;
  readonly now: () => Date;
}

/**
 * `candidates` (young-fix candidates) join the scan; their source repository
 * is the one of another version of the same package in `packages`, and their
 * coverage gaps aren't reported again.
 */
export async function takeSnapshot(
  packages: ReadonlyArray<PackageVersion>,
  options: SnapshotOptions,
  candidates: ReadonlyArray<PackageVersion> = [],
): Promise<Snapshot> {
  const takenAt = options.now();
  const listed = uniqueVersions(packages);
  const listedKeys = new Set(listed.map(versionKey));
  const extra = uniqueVersions(candidates).filter((pkg) => !listedKeys.has(versionKey(pkg)));
  const repos = await sourceRepositories(listed, options.sourceRepos);
  const repoOfPackage = new Map<string, string>();
  for (const pkg of listed) {
    const repo = repos.get(versionKey(pkg));
    if (repo !== undefined && !repoOfPackage.has(packageKey(pkg))) repoOfPackage.set(packageKey(pkg), repo);
  }
  for (const pkg of extra) repos.set(versionKey(pkg), repoOfPackage.get(packageKey(pkg)));
  const unique = [...listed, ...extra];
  const repository = await matchRepositoryAdvisories(unique, repos, options.repositoryAdvisories, new Set(extra.map(versionKey)));
  const osv = await scanWithOsvScanner(unique.filter((pkg) => pkg.ecosystem !== "GitHub Actions"), options.osv);
  const actions = unique.filter((pkg) => pkg.ecosystem === "GitHub Actions");
  const fromGitHub = await mapLimited(actions, 8, (pkg) => options.actions.advisories(pkg.name, pkg.version));
  const github = new Map(actions.map((pkg, i) => [versionKey(pkg), fromGitHub[i]!]));
  const reviewed = new Map<string, Advisory[]>();
  const own = new Map<string, Advisory[]>();
  for (const pkg of unique) {
    const key = versionKey(pkg);
    reviewed.set(key, [...(osv.get(key) ?? []).map(fromOsv), ...(github.get(key) ?? [])]);
    own.set(key, (repository.affecting.get(key) ?? []).map(fromRepository));
  }
  // Grouped over every version's records: another version's record may be what links two ids. The snapshot groups
  // only what's kept, never more coarsely, so a repository record kept here never merges into a reported group.
  const groups = aliasGroups([...reviewed.values(), ...own.values()].flat());
  const groupOf = (id: string) => groups.get(id) ?? id;
  const affecting = new Map<string, Advisory[]>();
  for (const pkg of unique) {
    const key = versionKey(pkg);
    affecting.set(key, combine(reviewed.get(key)!, own.get(key)!, groupOf));
  }
  return new Snapshot(affecting, repository.gaps, takenAt);
}

/**
 * One version's advisories: OSV's or GitHub's, then each repository advisory
 * whose alias group they don't report for this version (malware always). A
 * group both report is one finding either way; leaving the repository's
 * record out keeps the group's source the reviewed one.
 */
function combine(reviewed: ReadonlyArray<Advisory>, own: ReadonlyArray<Advisory>, groupOf: (id: string) => string): Advisory[] {
  const reported = new Set(reviewed.map((advisory) => groupOf(advisory.id)));
  return [...reviewed, ...own.filter((advisory) => advisory.malicious || !reported.has(groupOf(advisory.id)))];
}

export function fromOsv(record: OsvRecord): Advisory {
  const ids = [record.id, ...record.aliases];
  return {
    id: record.id,
    ids,
    source: "osv",
    malicious: isMalware(ids, record.cweIds),
    summary: record.summary,
    severity: record.severity,
  };
}

export function fromRepository(advisory: RepositoryAdvisory): Advisory {
  const ids = [advisory.ghsaId, ...(advisory.cveId === undefined ? [] : [advisory.cveId])];
  return {
    id: advisory.ghsaId,
    ids,
    source: "repository",
    malicious: isMalware(ids, advisory.cweIds),
    summary: advisory.summary,
    severity: advisory.severity,
  };
}
