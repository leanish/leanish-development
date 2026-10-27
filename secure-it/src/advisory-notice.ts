/**
 * The standard notice a held PR's warning carries about the advisories behind
 * its young versions: where each one appears, as read after the verification,
 * and what's wrong with them: the ones no reviewed record (OSV, or GitHub's
 * reviewed advisory database) backs as read now, and the fixes that couldn't be
 * checked. It reports problems only, so a gap in it shows less, never a false
 * all-clear. The tool writes all of it; an agent never does.
 *
 * A held fix's targets are reviewed advisories by the time it's proposed (one
 * only a project's repository publishes triggers nothing), except the one a
 * release-age exception names, whichever source lists it; this re-reads them.
 * A record "backs" a fix when it puts the replaced versions the comparison found
 * affected among the affected ones and none of the proposed versions.
 */
import { backsFix, type EvidenceRecord, type GroupEvidence, type SourceEvidence, type TargetEvidence } from "@leanish/gate/advisory-evidence";
import { literal } from "@leanish/tool-runtime/pr-text";

import type { PlannedHold } from "./plan.ts";

export const EVIDENCE_DIFFERS =
  "**Some advisories recorded for these held fixes are not backed by reviewed records as read now.** For the advisories marked ⚠ in the table below (the plan's block keeps every row, should the table be cut), no reviewed record (OSV, or GitHub's reviewed advisory database) lists the replaced versions as affected and the proposed one as not, or one was withdrawn or couldn't be read. The comparison's verdict stands; check them before taking this early.";

export const INCOMPLETE =
  "**Some of these fixes couldn't be checked**, as listed below. The comparison's verdict stands; check those before taking this early.";

/** Why a fix's evidence is missing, for the list INCOMPLETE points to. */
export const NOT_RECORDED = "not recorded for this plan";

/** Why a fix's evidence is missing when the PR body couldn't be written with it (`withPlanSection`). */
export const EVIDENCE_LEFT_OUT = "its evidence was left out: with it, this PR's body or plan would exceed its limit";

/** What the table says when its last rows were left out; the plan's block keeps the evidence either way. */
export function tableCut(left: number, total: number): string {
  return `${left} of the table's ${total} rows are left out: with them, this PR's body would exceed GitHub's limit. The plan's block keeps all of it.`;
}

/** How many unchecked fixes are listed, and the length (in characters) a reason, a name and a version are cut to before they are shown. */
const LISTED_LIMIT = 10;
const REASON_LIMIT = 300;
const NAME_LIMIT = 120;
const VERSION_LIMIT = 40;

const COLUMNS: ReadonlyArray<SourceEvidence["source"]> = ["repository", "github", "osv"];

/** The notice, without the `> ` quote prefix: its paragraphs for the top, its table and gaps for after the holds. */
export interface AdvisoryNotice {
  readonly paragraphs: ReadonlyArray<string>;
  readonly details: ReadonlyArray<string>;
}

/**
 * Empty when no hold records advisories it fixes (`targets`). A hold whose evidence failed, wasn't recorded, or has a
 * target with no advisory group is listed as unchecked. The table shows its ⚠ rows first and at most `rows` rows (all
 * by default), so a cut to fit the PR body leaves out backed rows before any ⚠ one.
 */
export function advisoryNotice(held: ReadonlyArray<PlannedHold>, options: { readonly rows?: number } = {}): AdvisoryNotice {
  const fixes = held.filter((entry) => (entry.targets?.length ?? 0) > 0);
  const rows = tableRows(fixes);
  const shown = rows.slice(0, options.rows ?? rows.length);
  const unchecked = fixes.flatMap((entry) => uncheckedOf(entry).map((reason) => `- ${bounded(entry.name, NAME_LIMIT)}@${bounded(entry.version, VERSION_LIMIT)}: ${bounded(reason, REASON_LIMIT)}`));
  const paragraphs: string[] = [];
  if (rows.some((row) => !row.backed)) paragraphs.push(EVIDENCE_DIFFERS);
  if (unchecked.length > 0) paragraphs.push(INCOMPLETE);
  const details: string[] = [];
  if (shown.length > 0) {
    const collected = fixes.flatMap((entry) => (entry.evidence === undefined ? [] : [entry.evidence.collectedAt])).sort()[0]!;
    details.push(`**Where the advisories behind these versions appear**, as read during this verification (${collected.slice(0, 10)} ${collected.slice(11, 16)} UTC), each source as it says:`, "");
    details.push("| Advisory | Package | Project's repository | GitHub database | OSV |", "|---|---|---|---|---|");
    for (const { entry, target, group, backed } of shown) {
      const sources = COLUMNS.map((name) => sourceCell(group.sources.find((source) => source.source === name), group, target));
      details.push(`| ${backed ? "" : "⚠ "}${cell(group.ids.join(", "))} | ${packageCell(entry, group, target)} | ${sources.join(" | ")} |`);
    }
  }
  if (shown.length < rows.length) details.push(...(details.length === 0 ? [] : [""]), tableCut(rows.length - shown.length, rows.length));
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
  // Unescaped: the reason is bounded and escaped once where it's shown.
  return entry.evidence.targets.filter((target) => target.groups.length === 0).map((target) => `no advisory recorded for ${target.name}`);
}

interface TableRow {
  readonly entry: PlannedHold;
  readonly target: TargetEvidence;
  readonly group: GroupEvidence;
  readonly backed: boolean;
}

/** One row per advisory group of the holds' evidence: the ⚠ ones first, each part in its stored order. */
function tableRows(fixes: ReadonlyArray<PlannedHold>): TableRow[] {
  const rows = fixes.flatMap((entry) => (entry.evidence?.targets ?? []).flatMap((target) =>
    target.groups.map((group) => ({ entry, target, group, backed: backed(target, group) }))));
  return [...rows.filter((row) => !row.backed), ...rows.filter((row) => row.backed)];
}

/** How many rows the notice's table has before any cut. */
export function tableRowCount(held: ReadonlyArray<PlannedHold>): number {
  return tableRows(held.filter((entry) => (entry.targets?.length ?? 0) > 0)).length;
}

/** `text` as a literal, at most `limit` characters, cut by code point before it's rendered, so no surrogate pair is split. */
function bounded(text: string, limit: number): string {
  const characters = Array.from(text.replace(/\s+/g, " "));
  return characters.length <= limit ? literal(text) : `${literal(characters.slice(0, limit).join(""))}…`;
}

/** Some reviewed record, read now, still backs the fix the comparison proved: OSV's, or a GitHub-reviewed one. */
function backed(target: TargetEvidence, group: GroupEvidence): boolean {
  const reviewed = (source: SourceEvidence) => source.source === "osv" || source.source === "github";
  return group.sources.some((source) => reviewed(source) && source.records.some((record) => record.reviewed !== false && backsFix(record, group, target)));
}

function packageCell(entry: PlannedHold, group: GroupEvidence, target: TargetEvidence): string {
  const to = target.proposed.length === 0 ? "removed" : cell(target.proposed.join(", "));
  const where = target.bundled ? ` (bundled in ${cell(entry.name)} ${cell(entry.version)})` : "";
  return `${cell(target.name)} ${cell(group.replaced.join(", "))} → ${to}${where}`;
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

/** Text from elsewhere in a table cell. */
const cell = (text: string) => literal(text, { table: true });
