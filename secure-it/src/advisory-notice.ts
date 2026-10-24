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

export const INCOMPLETE =
  "**Some of these fixes couldn't be checked**, as listed below, so this notice can't say a reviewed record still backs every fix. The comparison's verdict stands; check those before taking this early.";

/** Why a fix's evidence is missing, for the list INCOMPLETE points to. */
export const NOT_RECORDED = "not recorded for this plan";

/** Where the table went when it was left out; the plan's block keeps the evidence either way. */
export const TABLE_LEFT_OUT = "The table of where each advisory appears is left out: with it, this PR's body would exceed GitHub's limit. The plan's block keeps all of it.";

/** The ⚠ packages named in place of the table's rows, the unchecked fixes listed, and a reason's length (in characters), before the rest is counted. */
const NAMED_LIMIT = 20;
const LISTED_LIMIT = 10;
const REASON_LIMIT = 300;

const JUSTIFIED = new Set<PlannedHold["justification"]>(["security-fix", "bundle-fix"]);
const COLUMNS: ReadonlyArray<SourceEvidence["source"]> = ["repository", "github", "osv"];

/** The notice, without the `> ` quote prefix: its paragraphs for the top, its table and gaps for after the holds. */
export interface AdvisoryNotice {
  readonly paragraphs: ReadonlyArray<string>;
  readonly details: ReadonlyArray<string>;
}

/**
 * Empty when no hold is a security or bundle fix. Each claim covers every fix: one whose evidence failed, wasn't
 * recorded, or has a target with no advisory group is unchecked, so the notice never says all are backed. Without
 * `table`, the rows give way (the PR body is too long) and the ⚠ packages are named instead.
 */
export function advisoryNotice(held: ReadonlyArray<PlannedHold>, options: { readonly table?: boolean } = {}): AdvisoryNotice {
  const table = options.table ?? true;
  const fixes = held.filter((entry) => JUSTIFIED.has(entry.justification));
  const rows = fixes.flatMap((entry) => (entry.evidence?.targets ?? []).flatMap((target) => target.groups.map((group) => ({ entry, target, group }))));
  const unchecked = fixes.flatMap((entry) => uncheckedOf(entry).map((reason) => `- ${cell(entry.name)}@${cell(entry.version)}: ${bounded(reason)}`));
  const differing = rows.filter(({ target, group }) => !backed(target, group));
  const paragraphs: string[] = [];
  if (differing.length > 0) paragraphs.push(table ? EVIDENCE_DIFFERS : differsFor(differing));
  if (unchecked.length > 0) paragraphs.push(INCOMPLETE);
  if (paragraphs.length === 0 && rows.length > 0) paragraphs.push(REVIEWED);
  const details: string[] = [];
  if (rows.length > 0 && !table) details.push(TABLE_LEFT_OUT);
  if (rows.length > 0 && table) {
    const collected = fixes.flatMap((entry) => (entry.evidence === undefined ? [] : [entry.evidence.collectedAt])).sort()[0]!;
    details.push(`**Where the advisories behind these versions appear**, as read during this verification (${collected.slice(0, 10)} ${collected.slice(11, 16)} UTC), each source as it says:`, "");
    details.push("| Advisory | Package | Project's repository | GitHub database | OSV |", "|---|---|---|---|---|");
    for (const { entry, target, group } of rows) {
      const mark = backed(target, group) ? "" : "⚠ ";
      const sources = COLUMNS.map((name) => sourceCell(group.sources.find((source) => source.source === name), group, target));
      details.push(`| ${mark}${cell(group.ids.join(", "))} | ${packageCell(entry, group, target)} | ${sources.join(" | ")} |`);
    }
  }
  if (unchecked.length > 0) {
    const more = unchecked.length > LISTED_LIMIT ? [`- and ${unchecked.length - LISTED_LIMIT} more`] : [];
    details.push(...(details.length === 0 ? [] : [""]), "These fixes couldn't be checked:", ...unchecked.slice(0, LISTED_LIMIT), ...more);
  }
  return { paragraphs, details };
}

/** Why a fix's evidence doesn't cover it: none at all, or a target the evidence has no advisory group for. */
function uncheckedOf(entry: PlannedHold): string[] {
  if (entry.evidenceFailure !== undefined) return [entry.evidenceFailure];
  if (entry.evidence === undefined) return [NOT_RECORDED];
  if (entry.evidence.targets.length === 0) return ["no advisory recorded for it"];
  return entry.evidence.targets.filter((target) => target.groups.length === 0).map((target) => `no advisory recorded for \`${cell(target.name)}\``);
}

/** EVIDENCE_DIFFERS without the table it points to: the ⚠ packages, named. */
function differsFor(rows: ReadonlyArray<{ readonly entry: PlannedHold; readonly target: TargetEvidence; readonly group: GroupEvidence }>): string {
  const names = [...new Set(rows.map(({ entry, group, target }) => packageCell(entry, group, target)))];
  const shown = names.slice(0, NAMED_LIMIT).join("; ");
  const more = names.length > NAMED_LIMIT ? ` and ${names.length - NAMED_LIMIT} more` : "";
  return `**The reviewed advisories read after the comparison don't back this fix as the comparison did** for ${shown}${more}: no reviewed record (OSV, or GitHub's reviewed advisory database) lists the replaced versions as affected and the proposed one as not, or one was withdrawn or couldn't be read. The comparison's verdict stands; look into these before taking this early.`;
}

/** At most REASON_LIMIT characters, cut by code point before escaping, so no surrogate pair or `\|` is split. */
function bounded(reason: string): string {
  const characters = Array.from(reason.replace(/\s+/g, " "));
  return characters.length <= REASON_LIMIT ? cell(reason) : `${cell(characters.slice(0, REASON_LIMIT).join(""))}…`;
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
