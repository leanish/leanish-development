/**
 * The standard notice a held PR's warning carries about the advisories behind
 * its young versions: where each one appears, as read after the verification,
 * and fixed paragraphs saying how far to trust the most trusted source that
 * lists it, or that the evidence no longer backs the fix. The tool writes all
 * of it; an agent never does.
 */
import { backsFix, type EvidenceRecord, type GroupEvidence, type SourceEvidence, type TargetEvidence } from "@leanish/gate/advisory-evidence";

import type { PlannedHold } from "./plan.ts";

/*
 * Two levels of trust. Reviewed: OSV, or GitHub's database once GitHub reviewed the advisory (OSV imports those, so
 * for npm and Maven they're mostly the same review, apart from import lag). Unreviewed: a project's own repository
 * advisories, which whoever controls the repository publishes at will, in minutes.
 */

export const REVIEWED = "The advisories behind these versions are reviewed: OSV or GitHub's reviewed advisory database lists them.";

export const REPOSITORY_ONLY =
  "**Only in the project's own repository advisories: neither OSV nor GitHub's reviewed advisory database lists it.** Whoever controls the project's repository can publish such an advisory in minutes, with no review, so a fake one is the quickest way to get a release carrying an attack installed before the release-age wait ends: publish the \"fixed\" version, then an advisory pointing at it. Don't take this early on the advisory's word.";

export const REPOSITORY_ONLY_UNCHECKED =
  "**Found only in the project's own repository advisories so far; OSV or GitHub's advisory database couldn't be checked.** Treat it as unreviewed: whoever controls the project's repository can publish a fake advisory in minutes to get a release carrying an attack installed before the release-age wait ends.";

export const EVIDENCE_DIFFERS =
  "**The advisories read after the comparison don't back this fix as the comparison did.** For the rows marked ⚠ below, no source lists every replaced version as affected and the proposed one as not, or a record was withdrawn. The comparison's verdict stands; check the table before taking this early.";

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
  const tiers = rows.filter(({ target, group }) => backed(target, group)).map(({ group }) => tierOf(group));
  if (tiers.some((entry) => entry.tier === "repository" && entry.checked)) paragraphs.push(REPOSITORY_ONLY);
  if (tiers.some((entry) => entry.tier === "repository" && !entry.checked)) paragraphs.push(REPOSITORY_ONLY_UNCHECKED);
  if (tiers.length > 0 && tiers.every((entry) => entry.tier === "reviewed")) paragraphs.push(REVIEWED);
  const details: string[] = [];
  if (rows.length > 0) {
    const collected = fixes.flatMap((entry) => (entry.evidence === undefined ? [] : [entry.evidence.collectedAt])).sort()[0]!;
    details.push(`**Where the advisories behind these versions appear**, as read during this verification (${collected.slice(0, 10)} ${collected.slice(11, 16)} UTC), each source as it says:`, "");
    details.push("| Advisory | Package | Project's repository | GitHub database | OSV |", "|---|---|---|---|---|");
    for (const { entry, target, group } of rows) {
      const mark = backed(target, group) ? "" : "⚠ ";
      const sources = COLUMNS.map((name) => sourceCell(group.sources.find((source) => source.source === name), target));
      details.push(`| ${mark}${cell(group.ids.join(", "))} | ${packageCell(entry, target)} | ${sources.join(" | ")} |`);
    }
  }
  const failures = fixes.flatMap((entry) => (entry.evidenceFailure === undefined ? [] : [`- ${entry.name}@${entry.version}: ${cell(entry.evidenceFailure)}`]));
  if (failures.length > 0) details.push(...(details.length === 0 ? [] : [""]), "Where these advisories appear couldn't be read for:", ...failures);
  if (fixes.some((entry) => entry.evidence === undefined && entry.evidenceFailure === undefined)) details.push(...(details.length === 0 ? [] : [""]), NOT_RECORDED);
  return { paragraphs, details };
}

/** Some source, read now, still backs the fix the comparison proved. */
function backed(target: TargetEvidence, group: GroupEvidence): boolean {
  return group.sources.some((source) => source.records.some((record) => backsFix(record, target)));
}

interface Tier {
  /** The most trusted level listing it for the package; `none` when no source does. */
  readonly tier: "reviewed" | "repository" | "none";
  /** Whether every reviewed source was checked, so its absence there is established. */
  readonly checked: boolean;
}

/** A GitHub record counts once GitHub reviewed it; an unreviewed one isn't GitHub's word. */
function tierOf(group: GroupEvidence): Tier {
  const of = (name: SourceEvidence["source"]) => group.sources.find((source) => source.source === name);
  const listed = (source: SourceEvidence | undefined) => source?.records.some((record) => !record.withdrawn && record.namesPackage && record.reviewed !== false) ?? false;
  if (listed(of("osv")) || listed(of("github"))) return { tier: "reviewed", checked: true };
  const checked = of("osv")?.lookup === "checked" && of("github")?.lookup === "checked";
  return { tier: listed(of("repository")) ? "repository" : "none", checked };
}

function packageCell(entry: PlannedHold, target: TargetEvidence): string {
  const to = target.proposed.length === 0 ? "removed" : target.proposed.join(", ");
  const where = target.bundled ? ` (bundled in \`${cell(entry.name)}\` ${cell(entry.version)})` : "";
  return `\`${cell(target.name)}\` ${cell(target.replaced.join(", "))} → ${cell(to)}${where}`;
}

function sourceCell(source: SourceEvidence | undefined, target: TargetEvidence): string {
  if (source === undefined || source.lookup === "not-queried") return `not checked${source?.reason === undefined ? "" : `: ${cell(source.reason)}`}`;
  const records = source.records.map((record) => `${cell(record.id)}: ${recordText(record, target)}`);
  if (source.lookup === "incomplete") return [...records, `couldn't be fully checked: ${cell(source.reason ?? "unknown")}`].join("; ");
  return records.length === 0 ? "not found" : records.join("; ");
}

function recordText(record: EvidenceRecord, target: TargetEvidence): string {
  if (record.withdrawn) return "withdrawn";
  if (!record.namesPackage) return "doesn't name this package";
  const fix = record.declaredFixes.length === 0 ? "no fixed version declared" : `declares the fix ${record.declaredFixes.map(cell).join(", ")}`;
  const verdicts = [...target.replaced, ...target.proposed].map((version) => `${cell(version)} ${VERDICT_TEXT[record.verdicts[version] ?? "unknown"]}`);
  return [...(record.reviewed === false ? ["unreviewed"] : []), fix, verdicts.join(", ")].join(", ");
}

const VERDICT_TEXT: Readonly<Record<EvidenceRecord["verdicts"][string], string>> = { affected: "affected", "not-affected": "not affected", unknown: "unknown" };

function cell(text: string): string {
  return text.replaceAll("|", "\\|").replace(/\s+/g, " ");
}
