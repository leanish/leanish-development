/**
 * The standard notice a held PR's warning carries about the advisories behind
 * its young versions: where each one appears, as read after the verification,
 * and a fixed line saying whether a reviewed record (OSV, or GitHub's reviewed
 * advisory database) still backs each fix. The tool writes all of it; an agent
 * never does.
 *
 * A held fix's targets are reviewed advisories by the time it's proposed (one
 * only a project's repository publishes triggers nothing); this re-reads them.
 * A record "backs" a fix when it puts the replaced versions the comparison found
 * affected among the affected ones and none of the proposed versions.
 */
import { backsFix, type EvidenceRecord, type GroupEvidence, type SourceEvidence, type TargetEvidence } from "@leanish/gate/advisory-evidence";

import type { PlannedHold } from "./plan.ts";

export const REVIEWED =
  "Every advisory this fixes is still backed by a reviewed record as read now: OSV or GitHub's reviewed advisory database lists the replaced versions as affected and the proposed version, if any, as not. Candidates ruled out by advisories no reviewed source corroborates are noted in the plan below, where recorded.";

export const EVIDENCE_DIFFERS =
  "**The reviewed advisories read after the comparison don't back this fix as the comparison did.** For the rows marked ⚠ below, no reviewed record (OSV, or GitHub's reviewed advisory database) lists the replaced versions as affected and the proposed one as not, or one was withdrawn or couldn't be read. The comparison's verdict stands; check the table before taking this early.";

export const NOT_RECORDED = "Where these advisories appear wasn't recorded for this plan.";

const JUSTIFIED = new Set<PlannedHold["justification"]>(["security-fix", "bundle-fix"]);
const COLUMNS: ReadonlyArray<SourceEvidence["source"]> = ["repository", "github", "osv"];

/** The notice, without the `> ` quote prefix: its paragraphs for the top, its table and gaps for after the holds. */
export interface AdvisoryNotice {
  readonly paragraphs: ReadonlyArray<string>;
  readonly details: ReadonlyArray<string>;
}

/** Empty when no hold is a security or bundle fix. */
export function advisoryNotice(held: ReadonlyArray<PlannedHold>): AdvisoryNotice {
  const fixes = held.filter((entry) => JUSTIFIED.has(entry.justification));
  const rows = fixes.flatMap((entry) => (entry.evidence?.targets ?? []).flatMap((target) => target.groups.map((group) => ({ entry, target, group }))));
  const paragraphs: string[] = [];
  if (rows.some(({ target, group }) => !backed(target, group))) paragraphs.push(EVIDENCE_DIFFERS);
  else if (rows.length > 0) paragraphs.push(REVIEWED);
  const details: string[] = [];
  if (rows.length > 0) {
    const collected = fixes.flatMap((entry) => (entry.evidence === undefined ? [] : [entry.evidence.collectedAt])).sort()[0]!;
    details.push(`**Where the advisories behind these versions appear**, as read during this verification (${collected.slice(0, 10)} ${collected.slice(11, 16)} UTC), each source as it says:`, "");
    details.push("| Advisory | Package | Project's repository | GitHub database | OSV |", "|---|---|---|---|---|");
    for (const { entry, target, group } of rows) {
      const mark = backed(target, group) ? "" : "⚠ ";
      const sources = COLUMNS.map((name) => sourceCell(group.sources.find((source) => source.source === name), group, target));
      details.push(`| ${mark}${cell(group.ids.join(", "))} | ${packageCell(entry, group, target)} | ${sources.join(" | ")} |`);
    }
  }
  const failures = fixes.flatMap((entry) => (entry.evidenceFailure === undefined ? [] : [`- ${entry.name}@${entry.version}: ${cell(entry.evidenceFailure)}`]));
  if (failures.length > 0) details.push(...(details.length === 0 ? [] : [""]), "Where these advisories appear couldn't be read for:", ...failures);
  if (fixes.some((entry) => entry.evidence === undefined && entry.evidenceFailure === undefined)) details.push(...(details.length === 0 ? [] : [""]), NOT_RECORDED);
  return { paragraphs, details };
}

/** Some reviewed record, read now, still backs the fix the comparison proved: OSV's, or a GitHub-reviewed one. */
function backed(target: TargetEvidence, group: GroupEvidence): boolean {
  const reviewed = (source: SourceEvidence) => source.source === "osv" || source.source === "github";
  return group.sources.some((source) => reviewed(source) && source.records.some((record) => record.reviewed !== false && backsFix(record, group, target)));
}

function packageCell(entry: PlannedHold, group: GroupEvidence, target: TargetEvidence): string {
  const to = target.proposed.length === 0 ? "removed" : target.proposed.join(", ");
  const where = target.bundled ? ` (bundled in \`${cell(entry.name)}\` ${cell(entry.version)})` : "";
  return `\`${cell(target.name)}\` ${cell(group.replaced.join(", "))} → ${cell(to)}${where}`;
}

function sourceCell(source: SourceEvidence | undefined, group: GroupEvidence, target: TargetEvidence): string {
  if (source === undefined || source.lookup === "not-queried") return `not checked${source?.reason === undefined ? "" : `: ${cell(source.reason)}`}`;
  const records = source.records.map((record) => `${cell(record.id)}: ${recordText(record, group, target)}`);
  if (source.lookup === "incomplete") return [...records, `couldn't be fully checked: ${cell(source.reason ?? "unknown")}`].join("; ");
  return records.length === 0 ? "not found" : records.join("; ");
}

function recordText(record: EvidenceRecord, group: GroupEvidence, target: TargetEvidence): string {
  if (record.withdrawn) return "withdrawn";
  if (!record.namesPackage) return "doesn't name this package";
  const fix = record.declaredFixes.length === 0 ? "no fixed version declared" : `declares the fix ${record.declaredFixes.map(cell).join(", ")}`;
  const verdicts = [...group.replaced, ...target.proposed].map((version) => `${cell(version)} ${VERDICT_TEXT[record.verdicts[version] ?? "unknown"]}`);
  return [...(record.reviewed === false ? ["unreviewed"] : []), fix, verdicts.join(", ")].join(", ");
}

const VERDICT_TEXT: Readonly<Record<EvidenceRecord["verdicts"][string], string>> = { affected: "affected", "not-affected": "not affected", unknown: "unknown" };

function cell(text: string): string {
  return text.replaceAll("|", "\\|").replace(/\s+/g, " ");
}
