/**
 * Keeping an open PR whose recorded plan moves a package, companions included, that can't be decided this run (its
 * publisher identity, its carrier move, its direct-peer set, or several): the recomputed plan lacks that move only
 * because a check failed, so reusing the PR would rewrite it as if the move were no longer needed. Shared by bump-it and
 * secure-it; keys are `ecosystem|name`, bump-it's `Gradle Wrapper` ecosystem included.
 */

/** A move as either tool's recorded plan keeps it. */
export interface RecordedMove {
  readonly ecosystem: string;
  readonly name: string;
}

const keyOf = (move: RecordedMove) => `${move.ecosystem}|${move.name}`;

/** Causes by package key, each once and in the order first seen: a key with more than one keeps them all. */
export function byPackage(entries: ReadonlyArray<readonly [string, string]>): ReadonlyMap<string, ReadonlyArray<string>> {
  const causes = new Map<string, string[]>();
  for (const [key, cause] of entries) {
    const known = causes.get(key) ?? [];
    if (!known.includes(cause)) causes.set(key, [...known, cause]);
  }
  return causes;
}

/**
 * Throws, keeping the PR, when `recorded` (the moves of the plan an open PR records) moves a package `undecided` names
 * (package key → what can't be decided): one clause per package, in the order of its first move.
 */
export function assertNoUndecidedMoves(recorded: ReadonlyArray<RecordedMove> | undefined, undecided: ReadonlyMap<string, ReadonlyArray<string>>): void {
  const lost = new Map((recorded ?? []).filter((move) => undecided.has(keyOf(move))).map((move) => [keyOf(move), move]));
  if (lost.size === 0) return;
  throw new Error([...lost.values()].map((move) => `${move.ecosystem} ${move.name}'s ${undecided.get(keyOf(move))!.join(" and ")} can't be decided; keeping the PR`).join("; "));
}
