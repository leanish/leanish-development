/**
 * What a run observed on the default branch, for its issues: every finding no valid exception covers, read from the
 * same scan state candidate planning uses (`readScanState`), before planning can fail. An excepted finding is a
 * decision the owner already wrote down, so it gets no issue.
 */
import { unexcusedProblem } from "@leanish/gate/exceptions";
import { findingsOf } from "@leanish/gate/findings";
import type { ScanState } from "@leanish/gate/gate";
import { severityRank } from "@leanish/gate/candidates";

import type { ObservedFinding } from "./issue-model.ts";

/**
 * One observed finding per package and advisory group: its installed versions, ids (every alias seen), whether any
 * record is reviewed or malware, and the highest severity. Sorted, so the same scan always reads the same.
 */
export function observationsOf(scan: ScanState, today: string): ObservedFinding[] {
  const groups = new Map<string, { ecosystem: ObservedFinding["ecosystem"]; name: string; ids: Set<string>; versions: Set<string>; reviewed: boolean; malicious: boolean; severity: string | undefined }>();
  for (const finding of findingsOf(scan.packages, scan.snapshot)) {
    if (unexcusedProblem(finding, scan.settings.exceptions, scan.snapshot, today) === undefined) continue;
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
    .map((group) => ({
      ecosystem: group.ecosystem, name: group.name, ids: [...group.ids].sort(), versions: [...group.versions].sort(),
      reviewed: group.reviewed, malicious: group.malicious, severity: group.severity,
    }))
    .sort((a, b) => `${a.ecosystem}|${a.name}|${a.ids[0]}`.localeCompare(`${b.ecosystem}|${b.name}|${b.ids[0]}`));
}
