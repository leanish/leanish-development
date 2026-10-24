/** Attribute verification messages conservatively; a routine may drop named package groups once. */
import type { ChangePlan, OmittedMoves, PlannedMove } from "./plan.ts";

export interface ProblemMoves {
  readonly problem: string;
  readonly moves: ReadonlyArray<PlannedMove>;
}

export interface BatchRetry {
  readonly plan: ChangePlan | undefined;
  readonly named: ReadonlyArray<ProblemMoves>;
  readonly leftOut: ReadonlyArray<OmittedMoves>;
}

export function retryWithoutNamed(plan: ChangePlan, problems: ReadonlyArray<string>): BatchRetry {
  const named = namedProblems(plan, problems);
  if (plan.kind !== "routine" || plan.moves.some((move) => move.major) || problems.length === 0 || named.some((entry) => entry.moves.length === 0)) {
    return { plan: undefined, named, leftOut: [] };
  }
  const keys = new Set(named.flatMap((entry) => entry.moves.map(moveKey)));
  for (;;) {
    const size = keys.size;
    for (const set of plan.coupled ?? []) {
      if (set.some((key) => keys.has(key))) for (const key of set) keys.add(key);
    }
    if (keys.size === size) break;
  }
  for (const key of keys) if (!plan.packages.includes(key)) keys.delete(key);
  const leftOut = [...keys].sort().map((key) => ({
    moves: plan.moves.filter((move) => moveKey(move) === key),
    problems: named.filter((entry) => entry.moves.some((move) => moveKey(move) === key || (plan.coupled ?? []).some((set) => set.includes(key) && set.includes(moveKey(move))))).map((entry) => entry.problem),
  }));
  const moves = plan.moves.filter((move) => !keys.has(moveKey(move)));
  if (moves.length === 0) return { plan: undefined, named, leftOut };
  const requiredNpm = plan.requiredNpm?.filter((target) => !keys.has(`npm|${target.root.name}`));
  // The omitted moves' notes go with them: the required targets' reasons, unless a kept target shares the reason (same
  // requiring package and version, one deduplicated note), and any other note about an omitted move or a package it
  // carries (a floor, an override, an advisory note) unless that package is a kept move's too. A note is about the
  // package it starts with; others it mentions only explain it. The rest stays (the gate's, a kept fix's).
  const keptReasons = new Set((requiredNpm ?? []).map((target) => target.reason));
  const omittedReasons = new Set((plan.requiredNpm ?? []).map((target) => target.reason).filter((reason) => !keptReasons.has(reason)));
  const omitted = plan.moves.filter((move) => keys.has(moveKey(move)));
  const kept = (plan.notes ?? []).filter((note) => {
    if (keptReasons.has(note)) return true;
    if (omittedReasons.has(note)) return false;
    const subject = subjectOf(note);
    return subject === undefined || !concerns(omitted, subject) || concerns(moves, subject);
  });
  const notes = plan.notes === undefined ? undefined : kept;
  return { plan: { ...plan, moves, requiredNpm, notes, packages: plan.packages.filter((key) => !keys.has(key)), leftOut: [...(plan.leftOut ?? []), ...leftOut] }, named, leftOut };
}

export function namedProblems(plan: ChangePlan, problems: ReadonlyArray<string>): ProblemMoves[] {
  // A carried package's problem belongs to its carrier's move: only the carrier can change it.
  return problems.map((problem) => ({ problem, moves: plan.moves.filter((move) => namesMove(problem, move) || plan.requiredNpm?.some((target) =>
    target.root.name === move.name && target.root.version === move.to && namesMove(problem, { ...move, name: target.name })) ||
    (move.carries ?? []).some((carried) => namesMove(problem, { ...move, name: carried.name }))) }));
}

const moveKey = (move: PlannedMove) => `${move.ecosystem}|${move.name}`;

/**
 * The package a note is about: the name of the `name@version` it starts with (scoped npm and Maven names included);
 * undefined for a note that starts with none, such as the gate's. The version may be another copy's: only the name counts.
 */
const subjectOf = (note: string): string | undefined => /^(@?[^\s@]+)@\S/.exec(note)?.[1];

/** Whether `name` is one of `moves` or a package one of them carries. */
const concerns = (moves: ReadonlyArray<PlannedMove>, name: string) =>
  moves.some((move) => move.name === name || (move.carries ?? []).some((carried) => carried.name === name));

function namesMove(problem: string, move: PlannedMove): boolean {
  const name = move.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Version-labelled gate findings and named landing/declaration failures, not package substrings in filenames.
  const versioned = new RegExp(`(?:^|\\s)${name}@[^\\s]+`);
  const landing = new RegExp(`^${name} (?:at |changed from )`);
  const gradle = new RegExp(`(?: declares | resolves | no longer resolves )${name}(?: |$)`);
  return versioned.test(problem) || landing.test(problem) || gradle.test(problem);
}
