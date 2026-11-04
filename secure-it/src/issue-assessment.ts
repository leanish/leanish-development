/**
 * The run's assessment for its issues, without any I/O but the publication dates it's given: one subject per planned
 * unit (an exact decision: its moves, whatever their age) and one per package whose findings no unit covers. Every
 * observed finding lands in exactly one subject, so nothing a scan sees goes untracked.
 *
 * A decision's age comes from its fixes as the rule chose them: a target the rule took younger than the wait, or a
 * required npm companion that is, makes it wait; a trusted package's ordinary fix is a trusted exception, never
 * "aged"; a malware destination always waited (`candidates.ts`). An undated choice never gets here: the rule refuses it,
 * so its package is blocked.
 */
import type { Ecosystem } from "@leanish/gate/versions";
import { uniqueVersions, versionKey } from "@leanish/gate/package-version";

import type { Assessment, DecisionMove, ObservedFinding, PackageVersion, SubjectAssessment, YoungVersion } from "./issue-model.ts";
import { type ChangePlan, packageKey, type SecurityUnit, type Selection } from "./plan.ts";
import { youngAt } from "./young-at.ts";

/** A unit as the run planned it, from metadata only: its fixes and its plan's moves. */
export interface PlannedUnit {
  readonly unit: SecurityUnit;
  readonly plan: ChangePlan;
}

export interface AssessmentInputs {
  readonly sha: string;
  /** No inventory problem and no coverage gap: only then may a finding be concluded gone. */
  readonly complete: boolean;
  readonly observations: ReadonlyArray<ObservedFinding>;
  readonly units: ReadonlyArray<PlannedUnit>;
  readonly blocked: Selection["blocked"];
  /** Known planning failures by full package key, for findings no decision covers this run. */
  readonly planningCauses: ReadonlyMap<string, string>;
  readonly trusted: (pkg: { readonly ecosystem: Ecosystem; readonly name: string }) => boolean;
  /** When a young version is past the wait (UTC ISO), or undefined when its publication date can't be read. */
  readonly eligibleAt: (pkg: PackageVersion) => Promise<string | undefined>;
  /** The assessment's time: a version a parent probe resolved counts as young until then. */
  readonly now: Date;
  /**
   * The open PR carrying a unit's decision: the one recording exactly its moves, or else the one the unit's run reuses,
   * whatever decision it records now (one a retry reduced to part of this one, say), since the run redoes it whole.
   */
  readonly prOf: (planned: PlannedUnit) => { readonly number: number; readonly url: string } | undefined;
}

export async function assessmentOf(inputs: AssessmentInputs): Promise<Assessment> {
  const subjects: SubjectAssessment[] = [];
  const covered = new Set<ObservedFinding>();
  for (const { unit, plan } of inputs.units) {
    const moves = decisionMoves(plan);
    if (moves.length === 0) continue;
    const packages = new Set([...moves.map(packageKey), ...plan.moves.flatMap((move) => (move.carries ?? []).map((carried) => `${move.ecosystem}|${carried.name}`))]);
    const findings = inputs.observations.filter((finding) => packages.has(packageKey(finding)) && !covered.has(finding));
    for (const finding of findings) covered.add(finding);
    const young = await youngOf(unit, plan, inputs);
    const status: SubjectAssessment["status"] = young.length > 0
      ? { kind: "waiting", young }
      : { kind: "eligible", trusted: trustedOf(unit, inputs), ...prField(inputs.prOf({ unit, plan })) };
    subjects.push({ subject: { kind: "decision", moves }, findings, status });
  }

  // Every other finding, by package: blocked by the rule, reported only, or waiting for other work this run.
  const rest = new Map<string, ObservedFinding[]>();
  for (const finding of inputs.observations) if (!covered.has(finding)) rest.set(packageKey(finding), [...rest.get(packageKey(finding)) ?? [], finding]);
  for (const [key, findings] of rest) {
    const { ecosystem, name } = findings[0]!;
    const blocked = inputs.blocked.find((group) => group.packages.includes(key));
    const cause = inputs.planningCauses.get(key);
    const status: SubjectAssessment["status"] = blocked !== undefined
      ? { kind: "blocked", reason: "refused", detail: blocked.reasons.join("; ") }
      : findings.every((finding) => !finding.reviewed && !finding.malicious)
        ? { kind: "informational" }
        : { kind: "blocked", reason: "unassessed", detail: cause === undefined
          ? "no fix was planned for it this run (malware goes first, or its planning failed)"
          : `no fix was planned for it this run: ${cause}` };
    subjects.push({ subject: { kind: "package", ecosystem, name }, findings, status });
  }
  return { sha: inputs.sha, at: inputs.now.toISOString(), complete: inputs.complete, subjects };
}

/** The plan's moves as a decision: exactly what it changes, each once. */
export function decisionMoves(plan: ChangePlan): DecisionMove[] {
  const seen = new Map<string, DecisionMove>();
  for (const move of plan.moves) seen.set(`${move.ecosystem}|${move.name}|${move.from}|${move.to}`, { ecosystem: move.ecosystem, name: move.name, from: move.from, to: move.to });
  for (const required of plan.requiredNpm ?? []) {
    seen.set(`npm|${required.name}|${required.version}`, { ecosystem: "npm", name: required.name, from: `required by ${required.root.name}`, to: required.version });
  }
  return [...seen.values()].filter((move) => move.from !== move.to);
}

/**
 * The young versions a decision takes: rule-chosen young targets (never trusted ones), young required companions, and
 * what a parent probe resolved that is still younger than the wait, or whose date can't be read.
 */
export async function youngOf(unit: SecurityUnit, plan: ChangePlan, inputs: Pick<AssessmentInputs, "trusted" | "eligibleAt" | "now">): Promise<YoungVersion[]> {
  const young: PackageVersion[] = [
    ...unit.work.filter((fix) => fix.to !== undefined && !fix.to.aged && !inputs.trusted(fix)).map((fix) => ({ ecosystem: fix.ecosystem, name: fix.name, version: fix.to!.version })),
    ...(plan.requiredNpm ?? []).filter((target) => target.exempt).map((target) => ({ ecosystem: "npm" as const, name: target.name, version: target.version })),
  ];
  const induced = unit.work.flatMap((fix) => (fix.induced ?? []).map((entry) => ({ ecosystem: "Maven" as const, ...entry })))
    .filter((pkg) => !inputs.trusted(pkg));
  // A date that can't be read is unknown, never a reason to fail: the version counts as young either way.
  const dateOf = (pkg: PackageVersion) => inputs.eligibleAt(pkg).catch(() => undefined);
  const dated: YoungVersion[] = [];
  for (const pkg of uniqueVersions(young)) dated.push({ ...pkg, eligibleAt: (await dateOf(pkg)) ?? "unknown" });
  for (const pkg of induced) {
    if (dated.some((entry) => versionKey(entry) === versionKey(pkg))) continue;
    const eligibleAt = await dateOf(pkg);
    if (youngAt(eligibleAt, inputs.now)) dated.push({ ...pkg, eligibleAt: eligibleAt ?? "unknown" });
  }
  return dated;
}

/** A trusted package's ordinary fix: it skipped the wait, and says so. A malware destination waited, so it isn't one. */
function trustedOf(unit: SecurityUnit, inputs: AssessmentInputs): PackageVersion[] {
  return unit.work
    .filter((fix) => fix.to !== undefined && !fix.malicious && inputs.trusted(fix))
    .map((fix) => ({ ecosystem: fix.ecosystem, name: fix.name, version: fix.to!.version }));
}

function prField(pr: { readonly number: number; readonly url: string } | undefined) {
  return pr === undefined ? {} : { pr };
}
