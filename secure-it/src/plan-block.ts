/**
 * The plan in a PR's body: a table for people, and the plan itself as JSON in
 * a hidden comment, so a later run can tell whether its new plan is the same
 * (then it leaves the PR to its review tick) and the review tick can re-apply
 * and verify it exactly. A plan the cooldown holds also opens the body with
 * a warning, kept in step with the plan.
 */
import { createHash } from "node:crypto";

import { isAdvisoryEvidence } from "@leanish/gate/advisory-evidence";
import { heldEntry, heldUntil } from "@leanish/gate/cooldown";
import { assertBodyFits, BODY_LIMIT, defused, planPayload, planSection as sectionOf, withPlanSection as replaced } from "@leanish/tool-runtime/plan-blocks";

import { advisoryNotice } from "./advisory-notice.ts";
import { floorIdentity, validRemoval } from "./floor-removal.ts";
import type { ChangePlan, PlannedHold, PlannedMove } from "./plan.ts";

const HEADING = "### What secure-it moved";
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
      `| ${move.ecosystem} | \`${move.name}\` | ${move.from} → ${move.to}${move.major ? " (major)" : ""} | ${move.mechanism} | ${fixesLabel(plan, move)} | ${move.locations.map((location) => `\`${location}\``).join(", ")} |`,
  );
  const people = [
    "| Ecosystem | Package | Version | How | Fixes | Where |",
    "|---|---|---|---|---|---|",
    ...rows,
    ...omittedSection(plan),
    ...plan.moves.flatMap(vetoLines),
    ...(plan.notes ?? []).map((note) => `- ${note.replace(/\s+/g, " ")}`),
  ].join("\n");
  const footer = "Security targets are the versions the supply-chain gate's rule picks (`supply-chain candidates --rule security`); code chose any required direct-peer companions at their lowest safe compatible versions. The gate verified the change before it was published.";
  return sectionOf({ heading: HEADING, people, footer, payload: plan, name: "security plan" });
}

function removalSection(plan: ChangePlan): string {
  const removal = plan.floorRemoval!;
  const escape = (text: string) => text.replaceAll("|", "\\|").replace(/\s+/g, " ");
  const rows = removal.floors.map((floor) => `| ${floor.ecosystem} | ${escape(floor.package)} | ${floor.version} | ${escape(floor.declaredIn)} | ${floor.advisories.join(", ")} |`);
  const people = ["Security floors removed after one joint resolution without dependency locks kept every recorded advisory fixed.", "",
    "| Ecosystem | Package | Floor | Declaration | Advisories |", "|---|---|---|---|---|", ...rows, "",
    ...removal.notes.map((note) => `- ${escape(note)}`)].join("\n");
  const footer = "Compatibility floors are preserved. All induced versions are judged by compare before publication.";
  return sectionOf({ heading: HEADING, people, footer, payload: plan, name: "floor-removal plan" });
}

/** A companion aligns the direct-peer set rather than claiming to fix an advisory itself. */
function fixesLabel(plan: ChangePlan, move: PlannedMove): string {
  if (move.carries !== undefined) {
    const own = move.advisories;
    const where = move.ecosystem === "npm" ? "in bundled" : "in the";
    const brought = move.ecosystem === "npm" ? "" : " it brings";
    const inside = move.carries.map((entry) => `${entry.advisories.join(", ")} ${where} \`${entry.name}\`${brought} ${entry.from.join(", ")} → ${entry.to.length === 0 ? "removed" : entry.to.join(", ")}`);
    return [...(own.length === 0 ? [] : [own.join(", ")]), ...inside].join("; ");
  }
  if (move.unblocks !== undefined && move.advisories.length === 0) return `a range admitting the fix at ${move.unblocks.map((location) => `\`${location}\``).join(", ")}`;
  if (move.advisories.length > 0 || plan.malware) return move.advisories.join(", ");
  if (plan.requiredNpm?.some((target) => target.name === move.name && target.version === move.to)) return "required dependency compatibility";
  const coupled = plan.coupled?.some((set) => set.includes(`${move.ecosystem}|${move.name}`));
  return coupled ? "direct peer compatibility" : "";
}

/** A fixed line per candidate the gate ruled out only by advisories no reviewed source corroborates. */
function vetoLines(move: PlannedMove): string[] {
  return (move.vetoed ?? []).map((veto) =>
    `- ${move.name} ${veto.version} was ruled out by ${veto.advisories.join(", ")}, not corroborated by the sources this decision used; this takes ${move.to}.`);
}

/** Omissions are visible to reviewers as well as the command report and persisted plan. */
function omittedSection(plan: ChangePlan): string[] {
  if (plan.leftOut === undefined || plan.leftOut.length === 0) return [];
  return [
    "",
    "#### Left out after verification failed",
    "",
    ...plan.leftOut.flatMap((entry) => [
      ...entry.moves.map((move) => `- ${move.ecosystem} \`${move.name}\` ${move.from} → ${move.to}: omitted from this batch's explicit moves.`),
      ...entry.problems.map((problem) => `  - ${problem.replace(/\s+/g, " ")}`),
    ]),
    "",
    "The remaining batch was re-applied from the base and verified. npm may still induce transitive changes; omitted explicit moves are not claimed as completed.",
  ];
}

/** `body` with its plan section replaced by `plan`'s (or `plan`'s appended when it has none), and the cooldown warning on top while it holds. */
export function withPlanSection(body: string, plan: ChangePlan): string {
  const held = plan.cooldown ?? [];
  const warning = cooldownWarning(held);
  const rest = replaced(withoutWarning(body), HEADING, planSection(plan));
  if (warning === undefined) return rest;
  const warned = `${warning}\n\n${rest}`;
  if (warned.length <= BODY_LIMIT) return warned;
  // Only the evidence table gives way: the plan's block below keeps the evidence, and the rest of the warning stays.
  const shorter = `${cooldownWarning(held, { table: false })!}\n\n${rest}`;
  assertBodyFits(shorter);
  return shorter;
}

function withoutWarning(body: string): string {
  const start = body.indexOf(WARNING_START);
  const end = body.indexOf(WARNING_END);
  if (start === -1 || end < start) return body;
  return `${body.slice(0, start)}${body.slice(end + WARNING_END.length)}`.replace(/^\s+/, "");
}

/** The warning a held PR opens with: what came early, why, what to check, and how the hold ends; `table` as in advisoryNotice. */
export function cooldownWarning(held: ReadonlyArray<PlannedHold>, options: { readonly table?: boolean } = {}): string | undefined {
  const until = heldUntil(held);
  if (until === undefined) return undefined;
  // `<` too: a name or signal from elsewhere can't open a comment that hides the rest, or end the warning early.
  const cell = (text: string) => text.replaceAll("|", "\\|").replaceAll("<", "&lt;").replace(/\s+/g, " ");
  const minute = (instant: string) => `${instant.slice(0, 10)} ${instant.slice(11, 16)}`;
  const why = { "security-fix": "the security fix the version rule picks", "bundle-fix": "the carrier version the rule picks for advisories in its bundle", required: "required by a security fix", exception: "a release-age exception", unjustified: "not justified: the gate fails it" } as const;
  const rows = held.map((entry) =>
    `> | ${entry.ecosystem} \`${cell(entry.name)}\` | ${entry.replaced.length === 0 ? "new" : cell(entry.replaced.join(", "))} → ${cell(entry.version)} | ${minute(entry.published)} | ${minute(entry.eligibleAt)} | ${why[entry.justification]} | ${cell(entry.signals.join("; ")) || "—"} |`);
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
  if (plan.notes !== undefined && (!Array.isArray(plan.notes) || !plan.notes.every((note) => typeof note === "string"))) return false;
  if (plan.cooldown !== undefined && !validHolds(plan.cooldown)) return false;
  if (plan.requiredNpm !== undefined && (!Array.isArray(plan.requiredNpm) || !plan.requiredNpm.every((target) =>
    target !== null && typeof target === "object" && typeof target.exempt === "boolean" && [target.name, target.version, target.path, target.lockfile, target.key, target.range, target.reason, target.parent?.name, target.parent?.version, target.parent?.path, target.root?.name, target.root?.version, target.root?.path].every((value) => typeof value === "string")))) return false;
  if (plan.kind !== undefined && !["routine", "major", "malware"].includes(plan.kind)) return false;
  if (plan.members !== undefined && (!Array.isArray(plan.members) || !plan.members.every((key: unknown) => typeof key === "string"))) return false;
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
    (m["vetoed"] === undefined || (Array.isArray(m["vetoed"]) && m["vetoed"].every(isVeto)));
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
