/** The table rows for a plan's lockfile copy changes: one per path, or a re-hoisted package's versions shown as moved. */
import { literal } from "@leanish/tool-runtime/pr-text";

import type { CopyChange } from "./npm-compute.ts";
import { rehoistKey } from "./rehoists.ts";

/** Text from elsewhere (names, versions, paths) in a table cell, as a literal code span. */
export const cell = (text: string) => literal(text, { table: true });

/** A table row of cells already rendered: literal spans, or the tool's own words for a copy added, removed or moved. */
export const row = (name: string, from: string, to: string, locations: string) => `| ${name} | ${from} | ${to} | ${locations} |`;

/**
 * One row per copy change, except that a package listed in `rehoisted` is shown as each version moving from its old
 * paths to its new ones. That needs the whole list (`complete`), and is dropped for a package whose moved rows would be
 * more numerous, or longer in characters, than its per-path rows. The plan's section renderer uses grouped rows only
 * when the whole section fits without dropping any lines; otherwise every package keeps its per-path rows.
 */
export function changeRows(changes: ReadonlyArray<CopyChange>, complete: boolean, rehoisted: ReadonlySet<string>): string[] {
  const groups = Map.groupBy(changes, (change) => rehoistKey(change.lockfile, change.name));
  const moved = new Map<string, string[]>();
  for (const [key, group] of groups) {
    if (complete && rehoisted.has(key)) {
      const rows = movedRows(group);
      const plain = group.map(copyRow);
      if (rows.length > 0 && rows.length <= plain.length && text(rows).length <= text(plain).length) {
        moved.set(key, rows);
      }
    }
  }
  const placed = new Set<string>();
  return changes.flatMap((change) => {
    const key = rehoistKey(change.lockfile, change.name);
    const rows = moved.get(key);
    if (rows === undefined) {
      return [copyRow(change)];
    }
    // The moved rows stand for all of the package's changes, at the place of its first.
    return placed.has(key) ? [] : (placed.add(key), rows);
  });
}

const text = (rows: ReadonlyArray<string>) => rows.join("\n");

function copyRow(change: CopyChange): string {
  return row(cell(change.name), change.from === undefined ? "new" : cell(change.from), change.to === undefined ? "removed" : cell(change.to), at(change.lockfile, change.path));
}

const at = (lockfile: string, path: string) => cell(`${lockfile}:${path}`);

function versions(changes: ReadonlyArray<CopyChange>, side: "from" | "to"): Set<string> {
  return new Set(changes.flatMap((change) => change[side] ?? []));
}

function movedRows(changes: ReadonlyArray<CopyChange>): string[] {
  const { lockfile, name } = changes[0]!;
  return [...versions(changes, "from")].sort().flatMap((version) => {
    const from = changes.filter((change) => change.from === version).map((change) => change.path);
    const to = changes.filter((change) => change.to === version).map((change) => change.path);
    const moved = row(cell(name), cell(version), "moved", `${cell(lockfile)}: ${from.map(cell).join(", ")} → ${to.map(cell).join(", ")}`);
    return from.length === to.length ? [moved] : [moved, copiesRow(name, version, to.length - from.length)];
  });
}

/** After a move, `version` has this many more (positive) or fewer (negative) copies than before. */
function copiesRow(name: string, version: string, difference: number): string {
  const count = Math.abs(difference);
  const copies = `${count} ${count === 1 ? "copy" : "copies"}`;
  return difference > 0
    ? row(cell(name), "new", cell(version), `${copies} more than before`)
    : row(cell(name), cell(version), "removed", `${copies} fewer than before`);
}
