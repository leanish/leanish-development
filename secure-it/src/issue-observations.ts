/**
 * What a run saw on the default branch, for its issues, without any I/O: every finding of the scan, one per package and
 * advisory group. A vulnerability exception doesn't take a finding out: it only lets the gate pass the version, so an
 * excepted finding is tracked and fixed like any other.
 */
import { severityRank } from "@leanish/gate/candidates";
import { findingsOf, type Located } from "@leanish/gate/findings";
import type { Snapshot } from "@leanish/gate/snapshot";

import type { ObservedFinding } from "./issue-model.ts";

interface Group {
  readonly ecosystem: ObservedFinding["ecosystem"];
  readonly name: string;
  readonly ids: Set<string>;
  readonly versions: Set<string>;
  reviewed: boolean;
  malicious: boolean;
  severity: string | undefined;
}

/**
 * The scan's findings, read from the same state candidate planning uses (`readScanState`): one per package and advisory
 * group, with every version and alias seen. Sorted.
 */
export function observationsOf(packages: ReadonlyArray<Located>, snapshot: Snapshot): ReadonlyArray<ObservedFinding> {
  const groups = new Map<string, Group>();
  for (const finding of findingsOf(packages, snapshot)) {
    const key = `${finding.ecosystem}|${finding.name}|${finding.advisory}`;
    const group = groups.get(key) ?? { ecosystem: finding.ecosystem, name: finding.name, ids: new Set<string>(), versions: new Set<string>(), reviewed: false, malicious: false, severity: undefined };
    for (const id of finding.ids) group.ids.add(id);
    group.ids.add(finding.advisory);
    group.versions.add(finding.version);
    group.reviewed ||= finding.reviewed;
    group.malicious ||= finding.malicious;
    if (severityRank(finding.severity) > severityRank(group.severity)) group.severity = finding.severity;
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group): ObservedFinding => ({
      ecosystem: group.ecosystem, name: group.name, ids: [...group.ids].sort(), versions: [...group.versions].sort(),
      reviewed: group.reviewed, malicious: group.malicious, severity: group.severity,
    }))
    .sort((a, b) => `${a.ecosystem}|${a.name}|${a.ids[0]}`.localeCompare(`${b.ecosystem}|${b.name}|${b.ids[0]}`));
}
