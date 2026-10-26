/**
 * The plan in a PR's body: a table for people, and the plan itself as JSON in
 * a hidden comment, so a later run can tell whether its new plan is the same
 * (then it leaves the PR to its review tick) and the review tick can re-apply
 * and verify it exactly. A plan the cooldown holds also opens the body with
 * a warning, kept in step with the plan.
 */
import { createHash } from "node:crypto";

import { MAX_BODY_CHARS } from "@leanish/agent-runtime/github/github-client";
import { isAdvisoryEvidence } from "@leanish/gate/advisory-evidence";
import { heldEntry, heldUntil } from "@leanish/gate/cooldown";
import { MARKER_ROOM, stateOf } from "@leanish/tool-runtime/own-pr";
import { defused, planPayload, planSection as sectionOf, TooLargeError, withPlanSection as replaced } from "@leanish/tool-runtime/plan-blocks";

import { advisoryNotice, EVIDENCE_LEFT_OUT, tableRowCount } from "./advisory-notice.ts";
import { floorIdentity, validRemoval } from "./floor-removal.ts";
import type { ChangePlan, PlannedHold, PlannedMove } from "./plan.ts";
import { literal } from "./pr-text.ts";

const HEADING = "### What secure-it moved";
/** Fresh agent text: leave room for cleaning and the publication marker below the client's body limit. */
export const FRESH_HELD_BODY_TARGET = 61_440;
/** Already published text includes its marker; keep spare room for its replacement and any re-cleaning. */
export const PUBLISHED_HELD_BODY_TARGET = MAX_BODY_CHARS - MARKER_ROOM;
const WARNING_START = "<!-- secure-it cooldown warning -->";
const WARNING_END = "<!-- /secure-it cooldown warning -->";

/** Identity includes version targets, or exact removed floor records and the jointly resolved npm bytes. */
export function planDigest(plan: ChangePlan): string {
  const moves = [...plan.moves]
    .map((move) => ({ ...move, locations: [...move.locations].sort(), advisories: [...move.advisories].sort() }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const removal = plan.floorRemoval;
  const identity = removal === undefined ? { moves, requiredNpm: [...plan.requiredNpm ?? []].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) } : {
    floors: removal.floors.map(floorIdentity).sort(),
    files: [...removal.files].sort((a, b) => a.path.localeCompare(b.path)),
  };
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

/** The section secure-it adds to the agent's description: the moves, and the plan for later runs. */
export function planSection(plan: ChangePlan): string {
  if (plan.kind === "floor-removal" && plan.floorRemoval !== undefined) return removalSection(plan);
  const rows = plan.moves.map(
    (move) =>
      `| ${move.ecosystem} | ${cell(move.name)} | ${cell(move.from)} → ${cell(move.to)}${move.major ? " (major)" : ""} | ${move.mechanism} | ${fixesLabel(plan, move)} | ${move.locations.map(cell).join(", ")} |`,
  );
  const people = [
    "| Ecosystem | Package | Version | How | Fixes | Where |",
    "|---|---|---|---|---|---|",
    ...rows,
    ...omittedSection(plan),
    ...plan.moves.flatMap(vetoLines),
    ...(plan.notes ?? []).map((note) => `- ${literal(note)}`),
  ].join("\n");
  const footer = "Security targets are the versions the supply-chain gate's rule picks (`supply-chain candidates --rule security`); code chose any required direct-peer companions at their lowest safe compatible versions. The gate verified the change before it was published.";
  return sectionOf({ heading: HEADING, people, footer, payload: plan, name: "security plan" });
}

function removalSection(plan: ChangePlan): string {
  const removal = plan.floorRemoval!;
  const rows = removal.floors.map((floor) => `| ${floor.ecosystem} | ${cell(floor.package)} | ${cell(floor.version)} | ${cell(floor.declaredIn)} | ${cell(floor.advisories.join(", "))} |`);
  const people = ["Security floors removed after one joint resolution without dependency locks kept every recorded advisory fixed.", "",
    "| Ecosystem | Package | Floor | Declaration | Advisories |", "|---|---|---|---|---|", ...rows, "",
    ...removal.notes.map((note) => `- ${literal(note)}`)].join("\n");
  const footer = "Compatibility floors are preserved. All induced versions are judged by compare before publication.";
  return sectionOf({ heading: HEADING, people, footer, payload: plan, name: "floor-removal plan" });
}

/** A companion aligns the direct-peer set rather than claiming to fix an advisory itself. */
function fixesLabel(plan: ChangePlan, move: PlannedMove): string {
  if (move.carries !== undefined) {
    const own = move.advisories;
    const where = move.ecosystem === "npm" ? "in bundled" : "in the";
    const brought = move.ecosystem === "npm" ? "" : " it brings";
    const inside = move.carries.map((entry) => `${cell(entry.advisories.join(", "))} ${where} ${cell(entry.name)}${brought} ${cell(entry.from.join(", "))} → ${entry.to.length === 0 ? "removed" : cell(entry.to.join(", "))}`);
    return [...(own.length === 0 ? [] : [cell(own.join(", "))]), ...inside].join("; ");
  }
  if (move.unblocks !== undefined && move.advisories.length === 0) return `a range admitting the fix at ${move.unblocks.map(cell).join(", ")}`;
  if (move.advisories.length > 0 || plan.malware) return cell(move.advisories.join(", "));
  if (plan.requiredNpm?.some((target) => target.name === move.name && target.version === move.to)) return "required dependency compatibility";
  const coupled = plan.coupled?.some((set) => set.includes(`${move.ecosystem}|${move.name}`));
  return coupled ? "direct peer compatibility" : "";
}


/** Text from elsewhere in a table cell of the plan. */
function cell(text: string): string {
  return literal(text, { table: true });
}

/** A fixed line per candidate the gate ruled out only by advisories no reviewed source corroborates. */
function vetoLines(move: PlannedMove): string[] {
  const left = move.vetoesLeftOut === undefined ? [] : [
    `- ${literal(move.name)}: ${move.vetoesLeftOut} more candidates were ruled out the same way, by advisories not corroborated by the sources this decision used.`,
  ];
  return [...(move.vetoed ?? []).map((veto) =>
    `- ${literal(move.name)} ${literal(veto.version)} was ruled out by ${literal(veto.advisories.join(", "))}, not corroborated by the sources this decision used.`), ...left];
}

/** Omissions are visible to reviewers as well as the command report and persisted plan. */
function omittedSection(plan: ChangePlan): string[] {
  if (plan.leftOut === undefined || plan.leftOut.length === 0) return [];
  return [
    "",
    "#### Left out after verification failed",
    "",
    ...plan.leftOut.flatMap((entry) => [
      ...entry.moves.map((move) => `- ${move.ecosystem} ${literal(move.name)} ${literal(move.from)} → ${literal(move.to)}: omitted from this batch's explicit moves.`),
      ...entry.problems.map((problem) => `  - ${literal(problem)}`),
    ]),
    "",
    "The remaining batch was re-applied from the base and verified. npm may still induce transitive changes; omitted explicit moves are not claimed as completed.",
  ];
}

/**
 * `body` with its plan section replaced by `plan`'s (or `plan`'s appended when it has none), and the cooldown warning on
 * top while it holds. The advisory evidence is for people and never changes a verdict, so when the body can't be written
 * with it (its plan, section or body over a limit), it gives way, never the fix: written again without any, each fix that
 * had some says why it's missing. Fresh text has a smaller raw budget than text carrying a published state marker.
 * What still can't be written, and any other failure, fails as before.
 */
export function withPlanSection(body: string, plan: ChangePlan): string {
  const heldBodyTarget = stateOf(body) === undefined ? FRESH_HELD_BODY_TARGET : PUBLISHED_HELD_BODY_TARGET;
  try {
    return composed(body, plan, heldBodyTarget);
  } catch (error) {
    const lighter = error instanceof TooLargeError ? withoutEvidence(plan) : undefined;
    if (lighter === undefined) throw error;
    try {
      return composed(body, lighter, heldBodyTarget);
    } catch (retried) {
      throw retried instanceof TooLargeError ? error : retried;
    }
  }
}

/** `plan` without its holds' evidence, each hold that had some saying why; undefined when none has any. */
function withoutEvidence(plan: ChangePlan): ChangePlan | undefined {
  const held = plan.cooldown ?? [];
  if (!held.some((entry) => entry.evidence !== undefined)) return undefined;
  return { ...plan, cooldown: held.map(({ evidence, ...entry }) => (evidence === undefined ? entry : { ...entry, evidenceFailure: EVIDENCE_LEFT_OUT })) };
}

function composed(body: string, plan: ChangePlan, heldBodyTarget: number): string {
  const held = plan.cooldown ?? [];
  const rest = replaced(withoutWarning(body), HEADING, planSection(plan));
  if (cooldownWarning(held) === undefined) return rest;
  const warned = (rows?: number) => `${cooldownWarning(held, rows === undefined ? {} : { rows })!}\n\n${rest}`;
  const fits = (text: string) => text.length <= heldBodyTarget;
  const full = warned();
  if (fits(full)) return full;
  // Only the evidence table's last rows give way (the plan's block below keeps them all): the most that fit, found by
  // halving, since one row fewer never makes the body longer (a row outweighs the extra digit in the count of those cut).
  let low = 0;
  let high = tableRowCount(held) - 1;
  let most = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (fits(warned(middle))) {
      most = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  const shorter = warned(most);
  // Too large even without rows: the evidence gives way next (withPlanSection). Publication separately checks the
  // cleaned, marked body, since a raw budget cannot bound arbitrary path expansion.
  if (!fits(shorter)) throw new TooLargeError(`the PR body would be ${shorter.length} characters, over the ${heldBodyTarget} a held body is kept to`);
  return shorter;
}

function withoutWarning(body: string): string {
  const start = body.indexOf(WARNING_START);
  const end = body.indexOf(WARNING_END);
  if (start === -1 || end < start) return body;
  return `${body.slice(0, start)}${body.slice(end + WARNING_END.length)}`.replace(/^\s+/, "");
}

/** The warning a held PR opens with: what came early, why, what to check, and how the hold ends; `rows` as in advisoryNotice. */
export function cooldownWarning(held: ReadonlyArray<PlannedHold>, options: { readonly rows?: number } = {}): string | undefined {
  const until = heldUntil(held);
  if (until === undefined) return undefined;
  const minute = (instant: string) => `${instant.slice(0, 10)} ${instant.slice(11, 16)}`;
  const why = { "security-fix": "the security fix the version rule picks", "bundle-fix": "the carrier version the rule picks for advisories in its bundle", required: "required by a security fix", exception: "a release-age exception", unjustified: "not justified: the gate fails it" } as const;
  const rows = held.map((entry) =>
    `> | ${entry.ecosystem} ${cell(entry.name)} | ${entry.replaced.length === 0 ? "new" : cell(entry.replaced.join(", "))} → ${cell(entry.version)} | ${minute(entry.published)} | ${minute(entry.eligibleAt)} | ${why[entry.justification]} | ${cell(entry.signals.join("; ")) || "—"} |`);
  const notice = advisoryNotice(held, options);
  const quoted = (lines: ReadonlyArray<string>) => lines.map((line) => (line === "" ? ">" : `> ${line}`));
  // Above the plan's section, so its block must stay the body's first: the advisory text in it comes from elsewhere.
  return defused([
    WARNING_START,
    "> [!WARNING]",
    "> **Release-age cooldown bypassed.** This PR takes versions published less than the release-age wait ago. Needing them for a security fix, and passing every check, doesn't rule out malware: whoever controls a publisher can ship it inside a real fix, whatever the advisory's severity.",
    ">",
    ...notice.paragraphs.flatMap((paragraph) => [`> ${paragraph}`, ">"]),
    "> | Package | Version | Published (UTC) | Held until (UTC) | Why | Signals |",
    "> |---|---|---|---|---|---|",
    ...rows,
    ">",
    ...(notice.details.length === 0 ? [] : [...quoted(notice.details), ">"]),
    `> secure-it keeps this PR a draft, and the supply-chain gate's \`cooldown\` check stays red, until ${minute(until)} UTC. Then secure-it closes it and its next run opens a freshly verified PR (held again only if something in it is still young).`,
    ">",
    "> To take it earlier, a person decides: every other check green, the reason written in a PR comment, then an admin merge past the red `cooldown` check (where no ruleset enforces it, a merge with the same written reason).",
    WARNING_END,
  ].join("\n"));
}

/** The plan a PR's body carries, if it has one that parses. */
export function planOf(body: string): ChangePlan | undefined {
  const plan = planPayload(body) as ChangePlan | undefined;
  return plan !== undefined && typeof plan === "object" && plan !== null && Array.isArray(plan.moves) && plan.moves.every(isMove) && validMetadata(plan) ? plan : undefined;
}

function validMetadata(plan: ChangePlan): boolean {
  if (plan.kind === "floor-removal") return plan.topic === "floor-removal" && plan.malware === false && plan.moves.length === 0 && validRemoval(plan.floorRemoval);
  if (plan.floorRemoval !== undefined) return false;
  // Every plan since v0.4 has one; runs and reviews tell which PR is whose by it.
  if (typeof plan.topic !== "string") return false;
  if (plan.notes !== undefined && (!Array.isArray(plan.notes) || !plan.notes.every((note) => typeof note === "string"))) return false;
  if (plan.cooldown !== undefined && !validHolds(plan.cooldown)) return false;
  if (plan.requiredNpm !== undefined && (!Array.isArray(plan.requiredNpm) || !plan.requiredNpm.every((target) =>
    target !== null && typeof target === "object" && typeof target.exempt === "boolean" && [target.name, target.version, target.path, target.lockfile, target.key, target.range, target.reason, target.parent?.name, target.parent?.version, target.parent?.path, target.root?.name, target.root?.version, target.root?.path].every((value) => typeof value === "string")))) return false;
  if (plan.kind !== undefined && !["routine", "major", "malware"].includes(plan.kind)) return false;
  if (plan.members !== undefined && (!Array.isArray(plan.members) || !plan.members.every((key: unknown) => typeof key === "string"))) return false;
  if (plan.packages !== undefined && (!Array.isArray(plan.packages) || !plan.packages.every((key: unknown) => typeof key === "string"))) return false;
  if (plan.coupled !== undefined && (!Array.isArray(plan.coupled) || !plan.coupled.every((set) => Array.isArray(set) && set.every((name: unknown) => typeof name === "string")))) return false;
  if (plan.leftOut === undefined) return true;
  return Array.isArray(plan.leftOut) && plan.leftOut.every((entry) =>
    entry !== null && typeof entry === "object" && Array.isArray(entry.moves) && entry.moves.every(isMove) &&
    Array.isArray(entry.problems) && entry.problems.every((problem: unknown) => typeof problem === "string"));
}

function isMove(move: unknown): move is PlannedMove {
  if (typeof move !== "object" || move === null) return false;
  const m = move as Record<string, unknown>;
  return typeof m["name"] === "string" && typeof m["from"] === "string" && typeof m["to"] === "string" && typeof m["mechanism"] === "string" && Array.isArray(m["locations"]) &&
    (m["carries"] === undefined || (Array.isArray(m["carries"]) && m["carries"].every(isCarried))) &&
    (m["vetoed"] === undefined || (Array.isArray(m["vetoed"]) && m["vetoed"].every(isVeto))) &&
    // A count of the vetoes left out only stands beside some that are shown.
    (m["vetoesLeftOut"] === undefined || (Number.isSafeInteger(m["vetoesLeftOut"]) && (m["vetoesLeftOut"] as number) > 0 && Array.isArray(m["vetoed"]) && m["vetoed"].length > 0));
}

function isVeto(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const v = entry as Record<string, unknown>;
  return typeof v["version"] === "string" && Array.isArray(v["advisories"]) && v["advisories"].every((id) => typeof id === "string");
}

function isCarried(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const c = entry as Record<string, unknown>;
  const strings = (value: unknown) => Array.isArray(value) && value.every((item) => typeof item === "string");
  return typeof c["name"] === "string" && strings(c["from"]) && strings(c["to"]) && strings(c["locations"]) && strings(c["advisories"]);
}

function validHolds(held: unknown): boolean {
  if (!Array.isArray(held)) return false;
  return held.every((entry: unknown) => {
    try {
      heldEntry(entry);
    } catch {
      return false;
    }
    const { signals, evidence, evidenceFailure } = entry as PlannedHold;
    return Array.isArray(signals) && signals.every((signal) => typeof signal === "string")
      && (evidence === undefined || isAdvisoryEvidence(evidence)) && (evidenceFailure === undefined || typeof evidenceFailure === "string");
  });
}
