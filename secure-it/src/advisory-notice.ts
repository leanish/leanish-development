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
import { versionScheme } from "@leanish/gate/versions";

import type { PlannedHold } from "./plan.ts";

export const REVIEWED =
  "Every advisory this fixes is still backed by a reviewed record as read now: OSV or GitHub's reviewed advisory database lists the replaced versions as affected and the proposed version, if any, as not. Candidates ruled out by advisories no reviewed source corroborates are noted in the plan below, where recorded.";

export const EVIDENCE_DIFFERS =
  "**The reviewed advisories read after the comparison don't back this fix as the comparison did.** For the rows marked ⚠ below, no reviewed record (OSV, or GitHub's reviewed advisory database) lists the replaced versions as affected and the proposed one as not, or one was withdrawn or couldn't be read. The comparison's verdict stands; check the table before taking this early.";

export const INCOMPLETE =
  "**Some of these fixes couldn't be checked**, as listed below, so this notice can't say a reviewed record still backs every fix. The comparison's verdict stands; check those before taking this early.";

/** Why a fix's evidence is missing, for the list INCOMPLETE points to. */
export const NOT_RECORDED = "not recorded for this plan";

/** Why a fix's evidence is missing when the PR body couldn't be written with it (`withPlanSection`). */
export const EVIDENCE_LEFT_OUT = "its evidence was left out: with it, this PR's body or plan would exceed its limit";

/** Where the table went when it was left out; the plan's block keeps the evidence either way. */
export const TABLE_LEFT_OUT = "The table of where each advisory appears is left out: with it, this PR's body would exceed GitHub's limit. The plan's block keeps all of it.";

/**
 * What the notice shows without its table, so the notice itself stays bounded (the warning's hold rows are as before):
 * the ⚠ moves named and each one's proposed versions, the unchecked fixes listed, and the length (in characters) of a
 * reason, a name and a version shown.
 */
const NAMED_LIMIT = 20;
const VERSIONS_SHOWN = 3;
const LISTED_LIMIT = 10;
const REASON_LIMIT = 300;
const NAME_LIMIT = 120;
const VERSION_LIMIT = 40;

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
  const unchecked = fixes.flatMap((entry) => uncheckedOf(entry).map((reason) => `- ${bounded(entry.name, NAME_LIMIT)}@${bounded(entry.version, VERSION_LIMIT)}: ${bounded(reason, REASON_LIMIT)}`));
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
  // Unescaped: the reason is bounded and escaped once where it's shown.
  return entry.evidence.targets.filter((target) => target.groups.length === 0).map((target) => `no advisory recorded for \`${target.name}\``);
}

/**
 * EVIDENCE_DIFFERS without the table it points to: the ⚠ moves, each named once by the version it proposes, not by
 * the versions it replaces (a package's groups can each list hundreds); a bundled one with its carrier.
 */
function differsFor(rows: ReadonlyArray<{ readonly entry: PlannedHold; readonly target: TargetEvidence; readonly group: GroupEvidence }>): string {
  // Told apart by the whole move, shown cut: two long names alike for their first characters are still two moves.
  const moves = new Map<string, string>();
  for (const { entry, target } of rows) {
    // Sorted as text, so the same set is one move whatever order it was stored in; versions only shown are ordered below.
    const identity = JSON.stringify([target.name, [...target.proposed].sort(), target.bundled ? [entry.name, entry.version] : null]);
    if (moves.has(identity)) continue;
    // A bundle can propose hundreds of versions: the newest few are shown, the rest counted (the plan's block has them all).
    const { versions, rest } = newestFirst(target);
    const more = versions.length > VERSIONS_SHOWN ? ` (+${versions.length - VERSIONS_SHOWN} ${rest})` : "";
    const to = versions.length === 0 ? "removed" : `${versions.slice(0, VERSIONS_SHOWN).map((version) => bounded(version, VERSION_LIMIT)).join(", ")}${more}`;
    const carrier = target.bundled ? ` (bundled in \`${bounded(entry.name, NAME_LIMIT)}\` ${bounded(entry.version, VERSION_LIMIT)})` : "";
    moves.set(identity, `\`${bounded(target.name, NAME_LIMIT)}\` → ${to}${carrier}`);
  }
  const names = [...moves.values()];
  const shown = names.slice(0, NAMED_LIMIT).join("; ");
  const more = names.length > NAMED_LIMIT ? ` and ${names.length - NAMED_LIMIT} more` : "";
  return `**The reviewed advisories read after the comparison don't back this fix as the comparison did** for ${shown}${more}: no reviewed record (OSV, or GitHub's reviewed advisory database) lists the replaced versions as affected and the proposed one as not, or one was withdrawn or couldn't be read. The comparison's verdict stands; look into these before taking this early.`;
}

/**
 * The proposed versions by the ecosystem's order, newest first: the stored lists are sorted as text (1.10.0 before
 * 1.9.0), and versions of equal precedence (Maven's 1.0 and 1.0.0) stay as text sorts them. One the scheme can't
 * read leaves the text order, and the rest are then counted without calling them older.
 */
function newestFirst(target: TargetEvidence): { readonly versions: ReadonlyArray<string>; readonly rest: string } {
  const scheme = versionScheme(target.ecosystem);
  const text = [...target.proposed].sort();
  try {
    return { versions: text.sort((a, b) => scheme.compare(b, a)), rest: "older" };
  } catch {
    return { versions: [...target.proposed].sort(), rest: "more, not in version order" };
  }
}

/** `text` escaped for a cell, at most `limit` characters, cut by code point before escaping, so no surrogate pair or `\|` is split. */
function bounded(text: string, limit: number): string {
  const characters = Array.from(text.replace(/\s+/g, " "));
  return characters.length <= limit ? cell(text) : `${cell(characters.slice(0, limit).join(""))}…`;
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

/** Advisory text comes from elsewhere: `<` is escaped so it can't open a comment that hides the rest, or end the warning. */
function cell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll("<", "&lt;").replace(/\s+/g, " ");
}
