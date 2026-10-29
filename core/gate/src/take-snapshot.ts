/**
 * Takes the advisory snapshot for a set of package versions: OSV-Scanner
 * over all npm and Maven ones in one run, GitHub's advisory database for
 * GitHub Actions (OSV can't match their versions), plus the published
 * advisories of each one's source repository. Each version's findings are
 * combined: a reported reviewed alias group replaces the repository record.
 * For remaining repository records, a reviewed id lookup distinguishes an
 * advisory not yet known from a package the reviewed ranges clear: a known
 * group must name that package and every matching record must clear the version. Withdrawn,
 * affected and unknown records stay. Decisions are notes; failed lookups keep
 * the repository record with a coverage gap. Malware is always kept.
 * Id lookups are shared across every version in this snapshot.
 */
import type { ActionsGitHub } from "./actions-github.ts";
import { AdvisoryRecords, type EvidenceRecord } from "./advisory-records.ts";
import { mapLimited } from "./http.ts";
import { scanWithOsvScanner, type OsvRecord, type OsvScannerOptions } from "./osv-scanner.ts";
import { label, packageKey, type PackageVersion, uniqueVersions, versionKey } from "./package-version.ts";
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
 * repository-discovery coverage gaps aren't reported again.
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
  const own = new Map([...repository.affecting].map(([key, records]) => [key, records.map(fromRepository)]));
  const affecting = new Map<string, Advisory[]>();
  for (const pkg of unique) {
    const key = versionKey(pkg);
    const reviewed = [...(osv.get(key) ?? []).map(fromOsv), ...(github.get(key) ?? [])];
    affecting.set(key, combine(reviewed, own.get(key) ?? []));
  }
  const known = new Snapshot(affecting, repository.gaps, takenAt, [], own);
  const reconciled = await applyReviewedRecords(unique, repos, known, options);
  return new Snapshot(reconciled.affecting, [...known.gaps, ...reconciled.gaps], takenAt, reconciled.notes, own);
}

/**
 * Reconcile only repository records the per-version scan didn't replace. A separate reviewed-id read must
 * confirm the package and clear this version too; a scan omission alone cannot remove a finding.
 */
async function applyReviewedRecords(
  packages: ReadonlyArray<PackageVersion>,
  repos: ReadonlyMap<string, string | undefined>,
  snapshot: Snapshot,
  options: SnapshotOptions,
): Promise<{ affecting: Map<string, Advisory[]>; gaps: string[]; notes: string[] }> {
  const records = new AdvisoryRecords(options.repositoryAdvisories);
  const checked = await mapLimited(packages, 8, async (pkg) => {
    const kept: Advisory[] = [];
    const notes: Array<{ key: string; text: string }> = [];
    const gaps: Array<{ key: string; text: string }> = [];
    for (const advisory of snapshot.advisories(pkg)) {
      if (advisory.source !== "repository" || advisory.malicious) {
        kept.push(advisory);
        continue;
      }
      const group = snapshot.group(advisory.id);
      const at = `${advisory.id} (${repos.get(versionKey(pkg))!}) for ${label(pkg)}`;
      // Seed from this package's complete snapshot evidence, including other versions and removed-record metadata.
      const ids = [advisory.id, ...snapshot.aliases(advisory.id, pkg)];
      const reviewed = await reviewedGroup(ids, pkg, records);
      if (reviewed.problems.length === 0 && reviewed.records.length > 0
        && reviewed.records.every((record) => !record.withdrawn && record.verdicts[pkg.version] === "not-affected")) {
        notes.push({ key: `drop:${group}`, text: `${at}: its reviewed ranges clear this version; the reviewed ranges apply` });
        continue;
      }
      kept.push(advisory);
      if (reviewed.records.some((record) => record.withdrawn)) notes.push({ key: `withdrawn:${packageKey(pkg)}|${group}`, text: `${at}: its reviewed record was withdrawn; repository record kept` });
      if (reviewed.records.some((record) => !record.withdrawn && record.verdicts[pkg.version] === "affected")) notes.push({ key: `disagreement:${packageKey(pkg)}|${group}`, text: `${at}: its reviewed record says affected but the scan didn't report it; repository record kept` });
      if (reviewed.problems.length > 0) gaps.push({ key: `${packageKey(pkg)}|${group}`, text: `${at}: the reviewed database couldn't be asked (${reviewed.problems.join("; ").slice(0, 300)}); repository record kept` });
    }
    return { key: versionKey(pkg), kept, gaps, notes };
  });
  return {
    affecting: new Map(checked.map((result) => [result.key, result.kept])),
    gaps: distinctMessages(checked.flatMap((result) => result.gaps)),
    notes: distinctMessages(checked.flatMap((result) => result.notes)),
  };
}

/** Stable order and bounded messages; a failed lookup is reported for each package and group. */
function distinctMessages(messages: ReadonlyArray<{ key: string; text: string }>): string[] {
  const unique = new Map<string, string>();
  for (const message of messages) if (!unique.has(message.key)) unique.set(message.key, message.text.slice(0, 600));
  return [...unique.values()];
}

/** Every known and discovered alias is checked: one clearing response cannot hide another's contradiction. */
async function reviewedGroup(ids: ReadonlyArray<string>, pkg: PackageVersion, records: AdvisoryRecords): Promise<{ records: EvidenceRecord[]; problems: string[] }> {
  const known = new Set(ids);
  const found: EvidenceRecord[] = [];
  const problems: string[] = [];
  let lookedUp = 0;
  for (const id of known) {
    if (++lookedUp > 16) {
      problems.push("more than 16 ids to look up");
      break;
    }
    try {
      const record = await records.reviewed(id, pkg);
      if (record === undefined) continue;
      if (record.namesPackage) found.push(record);
      for (const alias of [record.id, ...record.aliases]) known.add(alias);
    } catch (error) {
      problems.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { records: found, problems };
}

/**
 * One version's advisories: OSV's or GitHub's, then each repository advisory
 * whose alias group they don't report for this version (malware always),
 * before reviewed-id reconciliation.
 * Groups are built from this version's records alone, so the decision
 * doesn't depend on which other versions share the snapshot. The snapshot
 * groups across versions, so another version's record may still link a kept
 * repository record to a reported one: it's then one finding, and reviewed.
 * Reconciliation subsequently uses aliases known across this package's versions.
 */
function combine(reviewed: ReadonlyArray<Advisory>, own: ReadonlyArray<Advisory>): Advisory[] {
  const groups = aliasGroups([...reviewed, ...own]);
  const groupOf = (id: string) => groups.get(id) ?? id;
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
