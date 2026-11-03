/**
 * What a secure-it issue says: a title and a body written by the tool alone, with the issue's record in the hidden
 * block that plan sections use. External text (package names, versions, advisory ids, a blocked fix's reason) only
 * appears as `literal()` code spans; the caller still cleans local paths from the body before publishing it
 * (`cleanBody`), and the record holds only structured data, never free text, so nothing local can hide in it.
 *
 * The part that authorizes `take-early` (the decision's exact moves and the young versions they take) comes first and
 * always shows whole: planSection shortens a section from its end, and a body that would lose any of it is refused
 * rather than published with a shorter scope than the one a label would authorize.
 */
import { planPayload, planSection, TooLargeError } from "@leanish/tool-runtime/plan-blocks";
import { literal } from "@leanish/tool-runtime/pr-text";

import type { IssueWriter } from "./issue-reconcile.ts";
import { type IssueRecord, type ObservedFinding, parseRecord, type SubjectAssessment, subjectPackages } from "./issue-model.ts";

const HEADING = "## secure-it";
/** The label a person adds, after a `take-early: <reason>` comment, to let secure-it fix a waiting decision now. */
export const TAKE_EARLY_LABEL = "take-early";
/**
 * The label on every issue the tool opens: its listing reads only these, never the login's PRs or other issues. A person
 * who removes it takes the issue out of the tool's sight, and a run opens another for what it tracked.
 */
export const ISSUE_LABEL = "leanish:secure-it-issue";

export const ISSUE_WRITER: IssueWriter = { render, withRecord };

/**
 * GitHub closes an issue a merged PR's text or commit names after a closing keyword (`Fixes #12`, `closes
 * owner/repo#12`, `resolves https://github.com/owner/repo/issues/12`). The tool's issues resolve only through an
 * assessment, so such a reference, an agent's say, becomes a code span, which GitHub neither links nor acts on.
 */
const CLOSING = /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)(:\s*|\s+(?::\s*)?)((?:[\w.-]+\/[\w.-]+)?#\d+|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+)/gi;

export function withoutClosingKeywords(text: string): string {
  return text.replace(CLOSING, (_match, keyword: string, separator: string, reference: string) => `${keyword}${separator}\`${reference}\``);
}

const TRACKS_LINE = /^Tracks #\d+(?:, taken early)?\.$\n?/gm;

/**
 * A PR's title, description and commit message as published for the issue it tracks: no closing keyword, and exactly
 * one `Tracks #N.` line, the last, the tool's; any other such line (an agent's, an older one) goes. A PR an early
 * attempt published says so in it (`Tracks #N, taken early.`): review then needs that attempt on the issue to go on,
 * whatever the gate's cooldown holds.
 */
export function trackingContent<T extends { readonly title: string; readonly body: string; readonly commitMessage: string }>(content: T, issue: number, early = false): T {
  const body = withoutClosingKeywords(content.body.replace(TRACKS_LINE, "")).trimEnd();
  return { ...content, title: withoutClosingKeywords(content.title), commitMessage: withoutClosingKeywords(content.commitMessage), body: `${body}\n\nTracks #${issue}${early ? ", taken early" : ""}.` };
}

/** The hidden marker a notice comment ends with, so each notice is posted once however often a run retries. */
export const noticeMarker = (id: string): string => `<!-- leanish:notice ${id} -->`;

/**
 * The record an issue body carries, or undefined when it has none this release reads. A body with a block anywhere but
 * at the end of its secure-it section, or with more than one, is ambiguous: a person pasted one, so none is read.
 */
export function recordOf(body: string): IssueRecord | undefined {
  const heading = body.indexOf(HEADING);
  const first = body.indexOf(BLOCK_OPENING);
  if (heading === -1 || first < heading || body.indexOf(BLOCK_OPENING, first + 1) !== -1) return undefined;
  // The block ends the secure-it section: another heading before it means it sits in someone else's.
  if (/\n#{1,6} /.test(body.slice(heading + HEADING.length, first))) return undefined;
  return parseRecord(planPayload(body));
}

const BLOCK_OPENING = "<!-- leanish:plan";

function render(assessment: SubjectAssessment, record: IssueRecord, sha: string): { readonly title: string; readonly body: string } {
  const essential = essentialLines(assessment, record);
  const people = [...essential, "", ...progressLines(record), "", ...findingLines(assessment.findings), "", `_Assessed at \`${sha.slice(0, 12)}\`._`].join("\n");
  const section = planSection({ heading: HEADING, people, payload: record, name: "secure-it's issue record" });
  // planSection cuts from the end when it must: what a label would authorize has to survive whole.
  const missing = essential.filter((line) => line !== "" && !section.includes(line));
  if (missing.length > 0) throw new TooLargeError(`the issue's decision doesn't fit its body (${missing.length} line(s) of it would be cut)`);
  return { title: titleOf(assessment), body: section };
}

/**
 * The body again, from its own people's part and `record`: the whole body is the tool's, so nothing else is kept. A
 * larger record must not push the decision's lines out: when the people's part no longer shows whole, it's refused.
 */
function withRecord(body: string, record: IssueRecord): string {
  const people = sectionPeople(body);
  const section = planSection({ heading: HEADING, people, payload: record, name: "secure-it's issue record" });
  if (!section.includes(people)) throw new TooLargeError("the issue's record no longer fits beside its text; it would cut the decision it shows");
  return section;
}

/**
 * The people's part of a body this module wrote: between the heading and the hidden block. Empty when a person rewrote
 * the body past finding it: the record still gets written (in a fresh section), since an ended episode or a closing
 * must never be lost to an edit.
 */
function sectionPeople(body: string): string {
  const start = body.indexOf(HEADING);
  const block = body.indexOf(BLOCK_OPENING);
  if (start === -1 || block === -1 || block < start) return "";
  return body.slice(start + HEADING.length, block).trim();
}

/**
 * A title can't hold a code span safely: names keep only the characters package names are made of (scopes, groups,
 * dots, dashes), so nothing in one renders, links or mentions.
 */
function titleOf(assessment: SubjectAssessment): string {
  const packages = subjectPackages(assessment.subject);
  const plain = (name: string) => name.replace(/[^A-Za-z0-9@/._:-]/g, "").replace(/^@/, "");
  const names = packages.slice(0, 3).map((pkg) => plain(pkg.name)).join(", ") + (packages.length > 3 ? ` and ${packages.length - 3} more` : "");
  const ecosystem = packages[0]!.ecosystem;
  // A title can't hold Markdown: names stay plain, cut to fit GitHub's title limit with room for the rest.
  const shown = names.length > 160 ? `${names.slice(0, 157)}...` : names;
  return assessment.subject.kind === "decision" ? `secure-it: fixing ${shown} (${ecosystem})` : `secure-it: advisories on ${shown} (${ecosystem})`;
}

function essentialLines(assessment: SubjectAssessment, record: IssueRecord): string[] {
  const { status, subject } = assessment;
  const lines: string[] = [];
  switch (status.kind) {
    case "informational":
      lines.push("**Reported only.** Only the package's own repository publishes these advisories: secure-it doesn't act on them until GitHub's advisory database or OSV does.");
      break;
    case "blocked":
      lines.push(`**Blocked:** ${blockedReason(status.reason)} ${literal(status.detail)}`);
      break;
    case "waiting":
      if (record.attempts.length > 0) {
        // Taken early: something ran, so the issue never says nothing did.
        lines.push("**Taken early.** A `take-early` authorization let secure-it carry out these moves before the wait ends; see the attempts below. The versions still inside the wait are listed after the moves.");
        break;
      }
      lines.push(
        "**Waiting for the release-age wait.** The fix takes versions published too recently; secure-it opens its PR once they're past the wait. Until then the vulnerable versions stay installed.",
        "",
        "The fix was chosen from registry and advisory metadata only: nothing was resolved, built or tested yet.",
      );
      break;
    case "eligible":
      lines.push(status.pr === undefined
        ? "**Ready.** secure-it opens a PR for this fix on its next run."
        : `**In progress:** #${status.pr.number}. This issue stays open until the fix is merged and an assessment confirms it.`);
      if (status.trusted.length > 0) {
        lines.push("", `Trusted-package exception (no release-age wait for these): ${status.trusted.map((pkg) => literal(`${pkg.name}@${pkg.version}`)).join(", ")}.`);
      }
      break;
  }
  if (subject.kind === "decision") {
    lines.push("", "| Package | From | To |", "| --- | --- | --- |", ...[...subject.moves]
      .sort((a, b) => `${a.ecosystem}|${a.name}`.localeCompare(`${b.ecosystem}|${b.name}`))
      .map((move) => `| ${literal(`${move.ecosystem} ${move.name}`, { table: true })} | ${literal(move.from, { table: true })} | ${literal(move.to, { table: true })} |`));
  }
  if (status.kind === "waiting") {
    lines.push("", "Still inside the wait:", ...status.young.map((young) => `- ${literal(`${young.ecosystem} ${young.name}@${young.version}`)}, past it on ${literal(young.eligibleAt)}`));
    lines.push(
      "",
      `To take it early: someone with write access comments \`${TAKE_EARLY_LABEL}: <reason>\`, then adds the \`${TAKE_EARLY_LABEL}\` label. It covers exactly the moves above; if they change, this issue is superseded and the label doesn't carry over.`,
    );
  }
  return lines;
}

function blockedReason(reason: "no-fix" | "refused" | "unassessed"): string {
  switch (reason) {
    case "no-fix":
      return "no published version fixes it.";
    case "refused":
      return "the security rule refused every candidate.";
    case "unassessed":
      return "the fix couldn't be assessed this run.";
  }
}

function progressLines(record: IssueRecord): string[] {
  const lines: string[] = [];
  if (record.grant !== undefined) lines.push(`Authorized early by ${literal(record.grant.actor)} on ${literal(record.grant.at)}.`);
  for (const attempt of record.attempts) {
    const pr = attempt.pr === undefined ? "" : `, #${attempt.pr}`;
    lines.push(`Early attempt ${literal(attempt.id)} started ${literal(attempt.startedAt)}${pr}${attempt.outcome === undefined ? "" : `: ${attempt.outcome}`}.`);
  }
  return lines;
}

function findingLines(findings: ReadonlyArray<ObservedFinding>): string[] {
  if (findings.length === 0) return [];
  const rows = [...findings]
    .sort((a, b) => `${a.name}|${a.ids[0]}`.localeCompare(`${b.name}|${b.ids[0]}`))
    .map((finding) => {
      const source = finding.malicious ? "malware" : finding.reviewed ? "reviewed" : "package repository only";
      return `| ${literal(finding.name, { table: true })} | ${literal(finding.ids.join(", "), { table: true })} | ${literal(finding.versions.join(", "), { table: true })} | ${source} | ${literal(finding.severity ?? "unknown", { table: true })} |`;
    });
  return ["| Package | Advisory | Installed | Source | Severity |", "| --- | --- | --- | --- | --- |", ...rows];
}
