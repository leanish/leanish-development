/**
 * The exceptions an upgrade leaves unused: entries of `.github/supply-chain-exceptions.json` that cover something in
 * the base and nothing in the head. Both tools write their removal after the edit (`writeExceptionsCleanup`), and the
 * policy fence admits a change to the file only when it is exactly this text, recomputed from the verified head.
 *
 * Only removals, and only what the change made unused: an entry already unused in the base, one still covering a copy,
 * and an expired one that still covers a version all stay. An entry covers what the gate would match it against:
 *
 *   - `vulnerabilities`: its package and version (in its ecosystem, any when absent) at one of its `paths`;
 *   - `releaseAge`: its package and version, anywhere;
 *   - `identity`: its npm package and version, anywhere.
 *
 * Locations come from the gate's own inventory (`located`, `actionsLocated`). Evidence the inventory can't complete in
 * either tree (an unrecorded bundle, a Gradle configuration that didn't resolve, ignored ones included, an action whose
 * version can't be told) skips the whole cleanup: an entry could look unused only because its copy wasn't seen.
 *
 * The removal deletes each entry's text and the separator next to it, keeping every other byte: the file isn't
 * reserialized, so formatting and fields `parseExceptions` doesn't read stay.
 */
import { isDeepStrictEqual } from "node:util";

import { isMap, isScalar, isSeq, parseDocument, type YAMLSeq } from "yaml";

import { ActionsGitHub } from "@leanish/gate/actions-github";
import { actionGaps, actionsLocated, resolveUses } from "@leanish/gate/actions-changes";
import type { Config } from "@leanish/gate/config";
import { EXCEPTIONS_PATH, type GateEnvironment, type GradleInputs, readSettings } from "@leanish/gate/gate";
import type { Located } from "@leanish/gate/findings";
import { gradleResolutionProblems } from "@leanish/gate/gradle";
import { located, readInventory, sourcesOf } from "@leanish/gate/inventory";
import type { Tree } from "@leanish/gate/tree";

/** The three lists, in the file's order. */
const LISTS = ["vulnerabilities", "releaseAge", "identity"] as const;
type List = (typeof LISTS)[number];

/** One entry the cleanup removes, as the PR's reader would name it. */
export interface RemovedException {
  readonly list: List;
  readonly label: string;
}

export type ExceptionsCleanup =
  /** Nothing to remove: no file, or every entry is still used (or was already unused). */
  | { readonly kind: "none" }
  /** The cleanup can't be judged (incomplete evidence, a file it can't edit in place): nothing is removed. */
  | { readonly kind: "skipped"; readonly why: string }
  /** The file without the entries the change left unused. */
  | { readonly kind: "removal"; readonly text: string; readonly removed: ReadonlyArray<RemovedException> };

/** The exceptions file `base` has, without the entries that cover something in `base` and nothing in `head`. */
export async function exceptionsCleanup(base: Tree, head: Tree, gradle: GradleInputs, env: GateEnvironment): Promise<ExceptionsCleanup> {
  const text = await base.read(EXCEPTIONS_PATH);
  if (text === undefined) return { kind: "none" };
  // The base's settings: its exceptions parse, and its config locates both trees (the fence keeps head's the same).
  const { config } = await readSettings(base);
  const github = new ActionsGitHub(env.fetch, env.githubToken);
  const before = await packagesOf(base, gradle.base, config, github);
  if (typeof before === "string") return { kind: "skipped", why: `the base's ${before}` };
  const after = await packagesOf(head, gradle.head, config, github);
  if (typeof after === "string") return { kind: "skipped", why: `the head's ${after}` };
  return unusedRemoval(text, before, after);
}

/** `text` without the entries that cover something in `before` and nothing in `after`. */
export function unusedRemoval(text: string, before: ReadonlyArray<Located>, after: ReadonlyArray<Located>): ExceptionsCleanup {
  const doc = parseDocument(text);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { kind: "skipped", why: `${EXCEPTIONS_PATH} isn't JSON` };
  }
  if (doc.errors.length > 0 || !isMap(doc.contents)) return { kind: "skipped", why: `${EXCEPTIONS_PATH} can't be edited in place` };
  const edits: Array<{ readonly start: number; readonly end: number; readonly text: string }> = [];
  const removed: RemovedException[] = [];
  const expected: Record<string, unknown> = { ...parsed };
  for (const list of LISTS) {
    const node = doc.contents.get(list, true);
    if (node === undefined) continue;
    if (!isSeq(node) || !Array.isArray(parsed[list])) return { kind: "skipped", why: `${EXCEPTIONS_PATH}'s \`${list}\` isn't a list` };
    const entries = parsed[list] as Array<Record<string, unknown>>;
    const unused = entries.map((entry) => covers(list, entry, before) && !covers(list, entry, after));
    if (!unused.includes(true)) continue;
    const ranges = itemRanges(node);
    if (ranges === undefined || ranges.length !== entries.length) return { kind: "skipped", why: `${EXCEPTIONS_PATH}'s \`${list}\` can't be edited in place` };
    edits.push(...listEdits(node, ranges, unused));
    entries.forEach((entry, i) => { if (unused[i]) removed.push({ list, label: labelOf(list, entry) }); });
    expected[list] = entries.filter((_, i) => !unused[i]);
  }
  if (removed.length === 0) return { kind: "none" };
  let written = text;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) written = written.slice(0, edit.start) + edit.text + written.slice(edit.end);
  // The same file, less exactly those entries: a range read wrong would show here.
  let result: unknown;
  try {
    result = JSON.parse(written);
  } catch {
    return { kind: "skipped", why: `removing the unused entries from ${EXCEPTIONS_PATH} in place didn't leave valid JSON` };
  }
  if (!isDeepStrictEqual(result, expected)) return { kind: "skipped", why: `removing the unused entries from ${EXCEPTIONS_PATH} in place changed more than them` };
  return { kind: "removal", text: written, removed };
}

/** Every located version of `tree`, or why its inventory isn't complete enough to tell an entry unused. */
async function packagesOf(tree: Tree, gradle: GradleInputs["head"], config: Config, github: ActionsGitHub): Promise<Located[] | string> {
  let inventory;
  try {
    inventory = await readInventory(tree, await sourcesOf(tree, config), { gradle });
  } catch (err) {
    return `inventory can't be read: ${(err as Error).message}`;
  }
  const incomplete = [
    ...inventory.npm.flatMap((lockfile) => lockfile.bundleProblems.map((problem) => `${lockfile.path}: ${problem}`)),
    // Ignored configurations count too: the gate doesn't judge them, but an exception can still name them.
    ...(inventory.gradle === undefined ? [] : gradleResolutionProblems(inventory.gradle, [])),
  ];
  let resolutions;
  try {
    resolutions = await resolveUses([inventory.actions], github);
  } catch (err) {
    // A failed lookup (a rate limit, GitHub down) costs the cleanup, never the edit: the gate's own comparison judges it.
    return `actions can't be resolved: ${(err as Error).message}`;
  }
  incomplete.push(...actionGaps(inventory.actions, resolutions));
  if (incomplete.length > 0) return `inventory is incomplete (${incomplete[0]}${incomplete.length > 1 ? `, and ${incomplete.length - 1} more` : ""})`;
  return [...located(inventory), ...actionsLocated(inventory.actions, resolutions)];
}

/**
 * Whether `entry` names a version among `packages` where the gate would look for it. The advisory isn't compared: an
 * entry whose version is gone serves nothing, whatever it names, and one still there is kept, even if its advisory no
 * longer matches anything (that's for a person to judge).
 */
function covers(list: List, entry: Record<string, unknown>, packages: ReadonlyArray<Located>): boolean {
  const ecosystem = list === "identity" ? "npm" : (entry["ecosystem"] as string | undefined);
  const paths = list === "vulnerabilities" ? (entry["paths"] as ReadonlyArray<string>) : undefined;
  return packages.some((pkg) =>
    (ecosystem === undefined || ecosystem === pkg.ecosystem) &&
    pkg.name === entry["package"] &&
    pkg.version === entry["version"] &&
    (paths === undefined || pkg.locations.some((location) => paths.includes(location))));
}

function labelOf(list: List, entry: Record<string, unknown>): string {
  const pkg = `${String(entry["package"])}@${String(entry["version"])}`;
  if (list === "vulnerabilities") return `${String(entry["id"])} on ${pkg}`;
  if (list === "releaseAge") return `${pkg}'s release age (${String(entry["advisory"])})`;
  return `${pkg}'s publisher identity`;
}

/** Each item's text span, start to end, or undefined when one has no range. */
function itemRanges(node: YAMLSeq): Array<readonly [number, number]> | undefined {
  const ranges: Array<readonly [number, number]> = [];
  for (const item of node.items) {
    if (!isMap(item) && !isScalar(item) && !isSeq(item)) return undefined;
    const range = item.range;
    if (range === undefined || range === null) return undefined;
    ranges.push([range[0], range[1]]);
  }
  return ranges;
}

/**
 * The edits removing the `unused` items of a list: every item gone leaves `[]`; otherwise each run of removed items
 * goes with the separator before it (from the kept item before it), or, at the start of the list, with the one after it
 * (up to the kept item after it), so the kept items keep their own text and indentation.
 */
function listEdits(node: YAMLSeq, ranges: ReadonlyArray<readonly [number, number]>, unused: ReadonlyArray<boolean>): Array<{ start: number; end: number; text: string }> {
  if (unused.every(Boolean)) return [{ start: node.range![0], end: node.range![1], text: "[]" }];
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (let first = 0; first < unused.length; first++) {
    if (!unused[first]) continue;
    let last = first;
    while (last + 1 < unused.length && unused[last + 1]) last++;
    edits.push(first > 0 ? { start: ranges[first - 1]![1], end: ranges[last]![1], text: "" } : { start: ranges[first]![0], end: ranges[last + 1]![0], text: "" });
    first = last;
  }
  return edits;
}

/**
 * What the policy fence admits for the exceptions file: the cleanup recomputed from the verified `head`, when the edit
 * changed the file; undefined when it didn't.
 */
export async function admittedCleanup(changedFiles: ReadonlyArray<string>, base: Tree, head: Tree, gradle: GradleInputs, env: GateEnvironment): Promise<ExceptionsCleanup | undefined> {
  return changedFiles.includes(EXCEPTIONS_PATH) ? exceptionsCleanup(base, head, gradle, env) : undefined;
}

/** What `writeExceptionsCleanup` did: whether it rewrote the file, and the entries the file now lacks. */
export interface WrittenCleanup {
  readonly wrote: boolean;
  readonly removed: ReadonlyArray<RemovedException>;
}

/**
 * Writes the exceptions file the edit's head should have, through `write`: the base's, less the entries the head leaves
 * unused (the base's as it is when there are none, or the cleanup can't be judged). Whatever the file holds is replaced,
 * so a merge that kept an earlier cleanup, or one the new base no longer justifies, is recomputed over the base. The
 * agent can't have put it there: `keepingExceptions` refuses an agent pass that changed it. A head with the file where
 * the base has none is left for the policy fence to refuse.
 */
export async function writeExceptionsCleanup(
  base: Tree,
  head: Tree,
  gradle: GradleInputs,
  env: GateEnvironment,
  write: (text: string) => Promise<void>,
): Promise<WrittenCleanup> {
  const original = await base.read(EXCEPTIONS_PATH);
  if (original === undefined) return { wrote: false, removed: [] };
  const cleanup = await exceptionsCleanup(base, head, gradle, env);
  const target = cleanup.kind === "removal" ? cleanup.text : original;
  const removed = cleanup.kind === "removal" ? cleanup.removed : [];
  if (await head.read(EXCEPTIONS_PATH) === target) return { wrote: false, removed };
  await write(target);
  return { wrote: true, removed };
}

/**
 * Runs an agent pass, refusing it when it changed the exceptions file: only the tool's cleanup changes that file, and
 * it runs after the agent, so a removal the agent made itself never reaches verification as the tool's.
 */
export async function keepingExceptions<T>(working: Tree, pass: () => Promise<T>): Promise<T> {
  const before = await working.read(EXCEPTIONS_PATH);
  const result = await pass();
  if (await working.read(EXCEPTIONS_PATH) !== before) {
    throw new Error(`the agent changed ${EXCEPTIONS_PATH}: only the tool removes the exceptions an edit leaves unused`);
  }
  return result;
}
