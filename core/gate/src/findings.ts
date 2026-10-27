/**
 * Findings and the base/head comparison. A finding is a package version an
 * advisory group affects; two findings are "the same" when ecosystem, package
 * and advisory group match, whatever the version or location, so an upgrade
 * that fixes A and leaves B passes, and B shows up as inherited.
 *
 * Review status qualifies inheritance, it isn't identity (`inherits`): a
 * reviewed finding is inherited only from reviewed evidence of the same key on
 * the baseline; one only the project's repository advisories publish inherits
 * from either. So a repository record whose range is wider than OSV's can't make
 * a reviewed finding on the new version look inherited.
 */
import type { PackageVersion } from "./package-version.ts";
import type { Snapshot } from "./snapshot.ts";
import type { Ecosystem } from "./versions.ts";

export interface Located extends PackageVersion {
  /** Where this version is installed or resolved: lockfile paths, Gradle configuration ids, workflow files. */
  readonly locations: ReadonlyArray<string>;
}

export interface Finding {
  readonly ecosystem: Ecosystem | "GitHub Actions";
  readonly name: string;
  readonly version: string;
  /** Canonical id of the advisory group. */
  readonly advisory: string;
  /** Every id this group has across the advisories that hit this version. */
  readonly ids: ReadonlyArray<string>;
  readonly malicious: boolean;
  /** Some advisory of the group on this version comes from a reviewed source, not only the project's repository. */
  readonly reviewed: boolean;
  readonly summary: string | undefined;
  readonly severity: string | undefined;
  readonly locations: ReadonlyArray<string>;
}

/** `npm|lib|GHSA-…`: what makes two findings the same finding. */
export function findingKey(finding: Pick<Finding, "ecosystem" | "name" | "advisory">): string {
  return `${finding.ecosystem}|${finding.name}|${finding.advisory}`;
}

/**
 * What a baseline has, for inheritance: per key (a finding key, an advisory group of one package, a bundled
 * `name|group` pair), whether some of its records there come from a reviewed source. Keys the baseline lacks are absent.
 */
export type Evidence = ReadonlyMap<string, boolean>;

/** The evidence of `[key, reviewed]` entries: a key is reviewed when any of its entries is, whatever their order. */
export function evidenceOf(entries: Iterable<readonly [string, boolean]>): Map<string, boolean> {
  const evidence = new Map<string, boolean>();
  for (const [key, reviewed] of entries) evidence.set(key, reviewed || evidence.get(key) === true);
  return evidence;
}

/**
 * The inheritance rule, everywhere a finding or a candidate's group may count as "already there": `key` is inherited
 * from `baseline` when the baseline has it and, if it is `reviewed` here, it is reviewed there too. A record only the
 * project's repository advisories publish on the baseline doesn't make a reviewed one inherited.
 */
export function inherits(baseline: Evidence, key: string, reviewed: boolean): boolean {
  const before = baseline.get(key);
  return before !== undefined && (before || !reviewed);
}

/** Every finding on these packages, one per package version and advisory group. */
export function findingsOf(packages: ReadonlyArray<Located>, snapshot: Snapshot): Finding[] {
  const findings: Finding[] = [];
  for (const pkg of packages) {
    const byGroup = new Map<string, { ids: Set<string>; malicious: boolean; reviewed: boolean; summary?: string; severity?: string }>();
    for (const advisory of snapshot.advisories(pkg)) {
      const group = snapshot.group(advisory.id);
      const entry = byGroup.get(group) ?? { ids: new Set<string>(), malicious: false, reviewed: false };
      for (const id of advisory.ids) entry.ids.add(id);
      entry.malicious ||= advisory.malicious;
      entry.reviewed ||= advisory.source !== "repository";
      entry.summary ??= advisory.summary;
      entry.severity ??= advisory.severity;
      byGroup.set(group, entry);
    }
    for (const [group, entry] of byGroup) {
      findings.push({
        ecosystem: pkg.ecosystem,
        name: pkg.name,
        version: pkg.version,
        advisory: group,
        ids: [...entry.ids].sort(),
        malicious: entry.malicious,
        reviewed: entry.reviewed,
        summary: entry.summary,
        severity: entry.severity,
        locations: pkg.locations,
      });
    }
  }
  return findings;
}

export interface Comparison {
  /** In head, and not inherited from base (`inherits`): these fail unless excepted. */
  readonly added: ReadonlyArray<Finding>;
  /** In head, inherited from base's findings with its key (`inherits`): warnings. */
  readonly inherited: ReadonlyArray<Finding>;
  /** In base, with a key head no longer has. */
  readonly fixed: ReadonlyArray<Finding>;
}

export function compareFindings(base: ReadonlyArray<Finding>, head: ReadonlyArray<Finding>): Comparison {
  // Every base finding with a key counts together: one reviewed among them is enough, in any order.
  const baseline = evidenceOf(base.map((finding) => [findingKey(finding), finding.reviewed]));
  const headKeys = new Set(head.map(findingKey));
  const inherited = (finding: Finding) => inherits(baseline, findingKey(finding), finding.reviewed);
  return {
    added: head.filter((finding) => !inherited(finding)),
    inherited: head.filter(inherited),
    fixed: base.filter((finding) => !headKeys.has(findingKey(finding))),
  };
}
