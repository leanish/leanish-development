/**
 * What a run saw on the default branch, for its issues, without any I/O: every finding of the scan, split by whether a
 * valid exception covers it. An excepted finding is a decision the owner already wrote down, so it gets no issue and
 * no work; it's still there, though, so it's never read as gone (an issue's record doesn't take its absence, and a
 * dismissal of it holds when the exception expires).
 */
import { severityRank } from "@leanish/gate/candidates";
import { type Exceptions, excusingException } from "@leanish/gate/exceptions";
import { findingsOf, type Located } from "@leanish/gate/findings";
import type { Snapshot } from "@leanish/gate/snapshot";

import type { ExceptedFinding, FindingKey, ObservedFinding } from "./issue-model.ts";

export interface Observations {
  /** One per package and advisory group a valid exception doesn't cover, with every version and alias seen. Sorted. */
  readonly observed: ReadonlyArray<ObservedFinding>;
  /**
   * One per package and advisory group with a version a valid exception covers, with every alias seen. A group can be
   * in both, when an exception covers only some of its versions; one covering only some of a version's locations
   * excepts nothing. What each covered version's exception says comes with it. Sorted.
   */
  readonly excepted: ReadonlyArray<ExceptedFinding>;
}

interface Group {
  readonly ecosystem: ObservedFinding["ecosystem"];
  readonly name: string;
  readonly ids: Set<string>;
  readonly versions: Set<string>;
  reviewed: boolean;
  malicious: boolean;
  severity: string | undefined;
}

/** The scan's findings, read from the same state candidate planning uses (`readScanState`), split by exception. */
export function observationsOf(packages: ReadonlyArray<Located>, snapshot: Snapshot, exceptions: Exceptions, today: string): Observations {
  const observed = new Map<string, Group>();
  const excepted = new Map<string, Group>();
  const covered = new Map<string, ExceptedFinding["covered"][number][]>();
  for (const finding of findingsOf(packages, snapshot)) {
    const exception = excusingException(finding, exceptions, snapshot, today);
    const groups = exception === undefined ? observed : excepted;
    const key = `${finding.ecosystem}|${finding.name}|${finding.advisory}`;
    if (exception !== undefined) covered.set(key, [...covered.get(key) ?? [], { version: finding.version, paths: exception.paths, expires: exception.expires }]);
    const group = groups.get(key) ?? { ecosystem: finding.ecosystem, name: finding.name, ids: new Set<string>(), versions: new Set<string>(), reviewed: false, malicious: false, severity: undefined };
    for (const id of finding.ids) group.ids.add(id);
    group.ids.add(finding.advisory);
    group.versions.add(finding.version);
    group.reviewed ||= finding.reviewed;
    group.malicious ||= finding.malicious;
    if (severityRank(finding.severity) > severityRank(group.severity)) group.severity = finding.severity;
    groups.set(key, group);
  }
  return {
    observed: sorted([...observed.values()].map((group) => ({
      ecosystem: group.ecosystem, name: group.name, ids: [...group.ids].sort(), versions: [...group.versions].sort(),
      reviewed: group.reviewed, malicious: group.malicious, severity: group.severity,
    }))),
    excepted: sorted([...excepted].map(([key, group]) => ({
      ecosystem: group.ecosystem, name: group.name, ids: [...group.ids].sort(),
      covered: covered.get(key)!.sort((a, b) => a.version.localeCompare(b.version)),
    }))),
  };
}

function sorted<T extends FindingKey>(findings: T[]): T[] {
  return findings.sort((a, b) => `${a.ecosystem}|${a.name}|${a.ids[0]}`.localeCompare(`${b.ecosystem}|${b.name}|${b.ids[0]}`));
}
