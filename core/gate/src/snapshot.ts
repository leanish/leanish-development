/**
 * One advisory snapshot: the advisories affecting every package version a
 * comparison looks at, gathered once from every source, with ids grouped by
 * their aliases. Base and head are both read from the same snapshot, so a
 * package version that didn't change gets the same findings on both sides
 * even if an advisory is published while the gate runs.
 */
import { label, type PackageVersion, versionKey } from "./package-version.ts";

export type AdvisorySource = "osv" | "github" | "repository";

export interface Advisory {
  /** The id its source uses (`GHSA-…`, `MAL-…`, `CVE-…`). */
  readonly id: string;
  /** `id` plus every alias the source lists. */
  readonly ids: ReadonlyArray<string>;
  readonly source: AdvisorySource;
  readonly malicious: boolean;
  readonly summary: string | undefined;
  readonly severity: string | undefined;
}

/**
 * OpenSSF's malicious-packages feed publishes `MAL-*` entries; GitHub
 * publishes malware as ordinary GHSA advisories tagged CWE-506.
 */
export function isMalware(ids: ReadonlyArray<string>, cweIds: ReadonlyArray<string>): boolean {
  return ids.some((id) => id.startsWith("MAL-")) || cweIds.includes("CWE-506");
}

export class Snapshot {
  private readonly affecting: ReadonlyMap<string, ReadonlyArray<Advisory>>;
  private readonly groups: ReadonlyMap<string, string>;
  /** Per package (`ecosystem|name`), per alias group: the ids its own advisories name, whichever version they affect. */
  private readonly packageAliases: ReadonlyMap<string, ReadonlyMap<string, ReadonlyArray<string>>>;
  readonly gaps: ReadonlyArray<string>;
  readonly takenAt: Date;

  constructor(affecting: ReadonlyMap<string, ReadonlyArray<Advisory>>, gaps: ReadonlyArray<string>, takenAt: Date) {
    this.affecting = affecting;
    this.groups = aliasGroups([...affecting.values()].flat());
    const byPackage = new Map<string, Map<string, Set<string>>>();
    for (const [key, advisories] of affecting) {
      const pkg = key.slice(0, key.lastIndexOf("|"));
      const groups = byPackage.get(pkg) ?? new Map<string, Set<string>>();
      for (const advisory of advisories) {
        const ids = groups.get(this.group(advisory.id)) ?? new Set<string>();
        for (const id of advisory.ids) ids.add(id);
        groups.set(this.group(advisory.id), ids);
      }
      byPackage.set(pkg, groups);
    }
    this.packageAliases = new Map([...byPackage].map(([pkg, groups]) => [pkg, new Map([...groups].map(([group, ids]) => [group, [...ids].sort()]))]));
    this.gaps = gaps;
    this.takenAt = takenAt;
  }

  /** The advisories affecting `pkg`; it must be one the snapshot was taken for. */
  advisories(pkg: PackageVersion): ReadonlyArray<Advisory> {
    const found = this.affecting.get(versionKey(pkg));
    if (found === undefined) throw new Error(`the advisory snapshot doesn't cover ${pkg.ecosystem} ${label(pkg)}`);
    return found;
  }

  covers(pkg: PackageVersion): boolean {
    return this.affecting.has(versionKey(pkg));
  }

  /** The canonical id of the alias group `id` belongs to; an id no advisory mentions is its own group. */
  group(id: string): string {
    return this.groups.get(id) ?? id;
  }

  /**
   * The ids of `id`'s alias group that `pkg`'s own advisories name, at any version the snapshot covers (another
   * version's record may be what links a CVE to its GHSA), sorted; another package's ids are left out, being other
   * advisories of the group. Empty when none of `pkg`'s does.
   */
  aliases(id: string, pkg: Pick<PackageVersion, "ecosystem" | "name">): ReadonlyArray<string> {
    return this.packageAliases.get(`${pkg.ecosystem}|${pkg.name}`)?.get(this.group(id)) ?? [];
  }
}

/**
 * Union-find over each advisory's ids. A group's canonical id is its smallest
 * GHSA id, else its smallest id, so the choice doesn't depend on order.
 */
function aliasGroups(advisories: ReadonlyArray<Advisory>): Map<string, string> {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    for (let node = id; node !== root; ) {
      const next = parent.get(node)!;
      parent.set(node, root);
      node = next;
    }
    return root;
  };
  for (const advisory of advisories) {
    for (const id of advisory.ids) if (!parent.has(id)) parent.set(id, id);
    const [first, ...rest] = advisory.ids;
    for (const id of rest) {
      const a = find(first!);
      const b = find(id);
      if (a !== b) parent.set(a, b);
    }
  }
  const members = new Map<string, string[]>();
  for (const id of parent.keys()) members.set(find(id), [...(members.get(find(id)) ?? []), id]);
  const canonical = new Map<string, string>();
  for (const ids of members.values()) {
    const sorted = [...ids].sort();
    const chosen = sorted.find((id) => id.startsWith("GHSA-")) ?? sorted[0]!;
    for (const id of ids) canonical.set(id, chosen);
  }
  return canonical;
}
