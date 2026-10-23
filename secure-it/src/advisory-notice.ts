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
 * advisories, which whoever controls the repository publishes at will, in minutes, and GitHub's unreviewed records.
 * A record "backs" a fix when it puts the replaced versions the comparison found affected among the affected ones and
 * none of the proposed versions (a removed package has none).
 */

export const REVIEWED =
  "Every advisory a source still backs is backed by a reviewed record: OSV or GitHub's reviewed advisory database lists the replaced versions as affected and the proposed version, if any, as not.";

export const REPOSITORY_ONLY =
  "**The project's own unreviewed repository advisories back this fix; neither OSV nor a reviewed GitHub record does.** Whoever controls the project's repository can publish such an advisory in minutes, with no review, so a fake one is the quickest way to get a release carrying an attack installed before the release-age wait ends: publish the \"fixed\" version, then an advisory pointing at it. Don't take this early on the advisory's word.";

export const REPOSITORY_ONLY_UNCHECKED =
  "**The project's own unreviewed repository advisories back this fix; neither OSV nor a reviewed GitHub record does so far, and OSV or GitHub's advisory database couldn't be fully checked.** Treat it as unreviewed: whoever controls the project's repository can publish a fake advisory in minutes to get a release carrying an attack installed before the release-age wait ends.";

export const UNREVIEWED_GITHUB =
  "**Only a record GitHub hasn't reviewed backs this fix: neither OSV nor a reviewed record in GitHub's advisory database does.** GitHub imports unreviewed records without checking them, so treat the fix as unreviewed.";

export const UNREVIEWED_GITHUB_UNCHECKED =
  "**Only a record GitHub hasn't reviewed backs this fix so far; OSV or GitHub's advisory database couldn't be fully checked.** GitHub imports unreviewed records without checking them, so treat the fix as unreviewed.";

export const EVIDENCE_DIFFERS =
  "**The advisories read after the comparison don't back this fix as the comparison did.** For the rows marked ⚠ below, no source lists the replaced versions as affected and the proposed one as not, or a record was withdrawn. The comparison's verdict stands; check the table before taking this early.";

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
  const tiers = rows.filter(({ target, group }) => backed(target, group)).map(({ target, group }) => tierOf(target, group));
  const has = (tier: Tier["tier"], checked: boolean) => tiers.some((entry) => entry.tier === tier && entry.checked === checked);
  if (has("repository", true)) paragraphs.push(REPOSITORY_ONLY);
  if (has("repository", false)) paragraphs.push(REPOSITORY_ONLY_UNCHECKED);
  if (has("unreviewed", true)) paragraphs.push(UNREVIEWED_GITHUB);
  if (has("unreviewed", false)) paragraphs.push(UNREVIEWED_GITHUB_UNCHECKED);
  if (tiers.length > 0 && tiers.every((entry) => entry.tier === "reviewed")) paragraphs.push(REVIEWED);
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

/** Some source, read now, still backs the fix the comparison proved. */
function backed(target: TargetEvidence, group: GroupEvidence): boolean {
  return group.sources.some((source) => source.records.some((record) => backsFix(record, group, target)));
}

interface Tier {
  /** The most trusted level whose records back the fix. */
  readonly tier: "reviewed" | "repository" | "unreviewed";
  /** Whether every more trusted source was checked, so that none of its records backs the fix is established. */
  readonly checked: boolean;
}

/**
 * The most trusted level whose records back the fix, not merely list the advisory: a reviewed record that puts the
 * proposed version among the affected ones doesn't vouch for it. Only called on a backed group. Among the unreviewed,
 * the project's own repository advisory is the one its controller can fake at will, so it's named first.
 */
function tierOf(target: TargetEvidence, group: GroupEvidence): Tier {
  const of = (name: SourceEvidence["source"]) => group.sources.find((source) => source.source === name);
  const backing = (name: SourceEvidence["source"], reviewed: boolean) =>
    of(name)?.records.some((record) => (record.reviewed !== false) === reviewed && backsFix(record, group, target)) ?? false;
  if (backing("osv", true) || backing("github", true)) return { tier: "reviewed", checked: true };
  if (backing("repository", true)) return { tier: "repository", checked: of("osv")?.lookup === "checked" && of("github")?.lookup === "checked" };
  return { tier: "unreviewed", checked: of("osv")?.lookup === "checked" && of("github")?.lookup === "checked" };
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
