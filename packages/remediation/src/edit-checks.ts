/**
 * Checks both tools run on an edit before publishing it, whatever the plan:
 *
 *   - the policy fence: the gate's own config, exceptions and every workflow
 *     and action file stay as they are, except, in a file a planned action
 *     pin names, that pin's ref and comment (checked first, since `compare`
 *     reads its policy from head);
 *   - planned action pins landed (the tag's commit with `# <tag>`), and no
 *     other action use changed;
 *   - no Gradle `strictly(...)` pin changed;
 *   - the declared npm versions, per declaration, to compare base with head;
 *   - which files are dependency files (an edit that isn't a major may only
 *     touch those) and which conflicted files take the base's side when the
 *     default branch is merged in.
 */
import { basename } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { isMap, isScalar, isSeq, parseDocument } from "yaml";

import { commentTag, readActionsInventory } from "../../ci/src/actions-inventory.ts";
import { gradleLocation, type GradleInventory } from "../../ci/src/gradle.ts";
import { directDependencies } from "../../ci/src/npm-lock.ts";
import type { Tree } from "../../ci/src/tree.ts";

import { lockfilesOf } from "./inventories.ts";

export const FLOORS_FILE = ".github/dependency-floors.json";

/** An action pin a plan makes: `name`'s uses in `locations` go to `commitSha # to`. */
export interface PlannedPin {
  readonly name: string;
  readonly to: string;
  readonly commitSha: string | undefined;
  readonly locations: ReadonlyArray<string>;
}

/** The policy files the edit changed beyond its planned pins; empty when it kept to them. */
export async function policyFence(changedFiles: ReadonlyArray<string>, pins: ReadonlyArray<PlannedPin>, base: Tree, head: Tree): Promise<string[]> {
  const pinned = new Set(pins.flatMap((pin) => pin.locations));
  const policy = changedFiles.filter((path) => isPolicyFile(path) && !pinned.has(path));
  if (policy.length > 0) return [`the edit changed ${policy.join(", ")}: the gate's own policy, which no plan may change`];
  const actions = new Set(pins.map((pin) => pin.name.toLowerCase()));
  for (const path of changedFiles.filter((changed) => pinned.has(changed))) {
    const before = pinsMasked(await base.read(path), actions);
    const after = pinsMasked(await head.read(path), actions);
    if (before === undefined || after === undefined || before !== after) {
      return [`the edit changed ${path} beyond its planned action pins: the gate's own policy, which no plan may change`];
    }
  }
  return [];
}

/** Every use of each planned action in its planned files is at the tag's commit with `# <to>`. */
export async function pinsLanded(pins: ReadonlyArray<PlannedPin>, head: Tree): Promise<string[]> {
  if (pins.length === 0) return [];
  const uses = (await readActionsInventory(head)).uses;
  const problems: string[] = [];
  for (const pin of pins) {
    for (const location of pin.locations) {
      const found = uses.filter((use) => use.file === location && use.name === pin.name.toLowerCase());
      if (found.length === 0) problems.push(`${location} no longer uses ${pin.name}`);
      for (const use of found) {
        if (use.ref !== pin.commitSha || commentTag(use) !== pin.to) problems.push(`${location} uses ${pin.name}@${use.ref} (${use.comment ?? "no comment"}), not ${pin.commitSha} # ${pin.to}`);
      }
    }
  }
  return problems;
}

/** Action uses that changed outside the plan: a use of an unplanned action, or of a planned one in an unplanned file. */
export async function actionsOutsidePlan(pins: ReadonlyArray<PlannedPin>, base: Tree, head: Tree): Promise<string[]> {
  const planned = new Map<string, Set<string>>();
  for (const pin of pins) planned.set(pin.name.toLowerCase(), new Set([...(planned.get(pin.name.toLowerCase()) ?? []), ...pin.locations]));
  const outside = (use: { name: string; file: string }) => !planned.get(use.name)?.has(use.file);
  // Counted by a structured key (a crafted path can't blur two uses together), reported by a readable label.
  const labels = new Map<string, string>();
  const occurrences = async (tree: Tree) =>
    (await readActionsInventory(tree)).uses.filter(outside).map((use) => {
      const key = JSON.stringify([use.file, use.name, use.path ?? null, use.ref, use.comment ?? null]);
      labels.set(key, `${use.file}: ${use.name}${use.path === undefined ? "" : `/${use.path}`}@${use.ref}${use.comment === undefined ? "" : ` # ${use.comment}`}`);
      return key;
    });
  const count = (list: string[]) => list.reduce((map, entry) => map.set(entry, (map.get(entry) ?? 0) + 1), new Map<string, number>());
  const was = count(await occurrences(base));
  const now = count(await occurrences(head));
  const changed = [...new Set([...was.keys(), ...now.keys()])].filter((entry) => was.get(entry) !== now.get(entry)).map((entry) => labels.get(entry)!).sort();
  return changed.map((label) => `the action use ${label} changed outside the plan`);
}

/**
 * Whether `strictly` appears in the line's code, not inside a string or a comment: `strictly("1.0")`, Groovy's
 * `strictly pinVersion`, a catalog's `strictly = "1.0"` count; a `because("… strictly pinned …")` or a comment doesn't.
 * Strings and block comments keep their state across continuation lines.
 */
interface CodeState {
  quote?: string;
  quoted: string;
  member: boolean;
  blockComment: boolean;
}

function lineCode(line: string, state: CodeState): string {
  let code = "";
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (state.blockComment) {
      if (char === "*" && line[i + 1] === "/") { state.blockComment = false; i++; }
      continue;
    }
    if (state.quote !== undefined) {
      if (char === "\\") i++;
      else if (char === state.quote) {
        state.quote = undefined;
        // A quoted name is still code: a catalog key (`"strictly" = "1.0"`), or a Groovy member (`delegate."strictly"`,
        // called with or without parentheses).
        code += state.member || /^\s*[=(]/.test(line.slice(i + 1)) ? state.quoted : char;
      } else state.quoted += char;
      continue;
    }
    if (char === '"' || char === "'") {
      state.quote = char;
      state.quoted = "";
      state.member = /\.\s*$/.test(code);
      code += char;
      continue;
    }
    if (char === "/" && line[i + 1] === "*") {
      state.blockComment = true;
      i++;
      code += " ";
      continue;
    }
    if (char === "#" || (char === "/" && line[i + 1] === "/")) break;
    code += char;
  }
  return code;
}

const MAX_STRICT_LINES = 128;
const MAX_STRICT_BYTES = 64 * 1024;

function strictStatements(text: string | undefined): string[] {
  const lines = (text ?? "").split("\n");
  const state: CodeState = { quoted: "", member: false, blockComment: false };
  const statements: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const code = lineCode(lines[i]!, state);
    const at = /\bstrictly\b/.exec(code);
    if (at === null) continue;
    const statement = [lines[i]!];
    const opened: string[] = [];
    balanceStrict(code.slice(at.index), opened);
    while (opened.length > 0 && i + 1 < lines.length) {
      if (statement.length >= MAX_STRICT_LINES || Buffer.byteLength(statement.join("\n")) > MAX_STRICT_BYTES) {
        throw new Error("a strictly statement exceeds the continuation limit");
      }
      statement.push(lines[++i]!);
      balanceStrict(lineCode(lines[i]!, state), opened);
    }
    if (opened.length > 0) throw new Error("an unbalanced strictly statement can't be verified");
    const captured = statement.join("\n");
    if (Buffer.byteLength(captured) > MAX_STRICT_BYTES) throw new Error("a strictly statement exceeds the continuation limit");
    statements.push(captured);
  }
  return statements;
}

/** Balances the whole rest of the line: a second `strictly(` opened after the first closes keeps the statement going. */
function balanceStrict(code: string, opened: string[]): void {
  for (const char of code) {
    if (char === "(" || char === "{") opened.push(char);
    else if (char === ")" || char === "}") {
      if (opened.length === 0) continue;
      if (opened.pop() !== (char === ")" ? "(" : "{")) throw new Error("a mismatched strictly statement can't be verified");
    }
  }
}

/**
 * The Gradle build, settings and catalog files where the edit changed a line with `strictly` in its code: a strict version is its
 * owner's deliberate pin, which no plan moves. A line counts when `strictly` is in its code, outside strings and comments.
 * Each strict statement, including balanced continuation lines, must stay the same, in order and byte for byte.
 * A changed variable outside the statement or moving an unchanged pin within its file still escapes this textual guard.
 */
export async function strictPinsChanged(changedFiles: ReadonlyArray<string>, base: Tree, head: Tree): Promise<string[]> {
  const problems: string[] = [];
  for (const path of changedFiles.filter(isGradleVersionFile)) {
    try {
      if (!isDeepStrictEqual(strictStatements(await base.read(path)), strictStatements(await head.read(path)))) {
        problems.push(`the edit changed a Gradle strictly(...) pin in ${path}: strict versions are the owner's, which no plan moves`);
      }
    } catch (err) {
      problems.push(`${path}: ${(err as Error).message}`);
    }
  }
  return problems;
}

function isGradleVersionFile(path: string): boolean {
  const name = basename(path);
  return name.endsWith(".gradle") || name.endsWith(".gradle.kts") || name.endsWith(".versions.toml");
}

/** `npm|name|where` → version, for every direct npm declaration: per lockfile, workspace and key. Gradle's are compared with the plan's reference (`gradle-reference.ts`). */
export async function directVersions(tree: Tree): Promise<Map<string, string>> {
  const versions = new Map<string, string>();
  for (const [path, lock] of await lockfilesOf(tree)) {
    for (const dependency of directDependencies(lock)) {
      versions.set(`npm|${dependency.name}|${path}#${dependency.workspace || "."}:${dependency.declaredAs}`, dependency.version);
    }
  }
  return versions;
}

/**
 * Direct declarations whose version changed (or that came or went) between
 * `before` and `after` (from `directVersions`), except the packages
 * `planned` (`ecosystem|name`) covers.
 */
export function directChangesOutside(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>, planned: (ecosystem: string, name: string, where: string) => boolean): string[] {
  const problems: string[] = [];
  const parts = (key: string) => {
    const [ecosystem, name, ...where] = key.split("|");
    return { ecosystem: ecosystem!, name: name!, where: where.join("|") };
  };
  for (const [key, version] of after) {
    const { ecosystem, name, where } = parts(key);
    if (planned(ecosystem, name, where) || before.get(key) === version) continue;
    problems.push(`${name} changed from ${before.get(key) ?? "nothing"} to ${version} at ${where}, outside the plan`);
  }
  for (const [key, version] of before) {
    const { ecosystem, name, where } = parts(key);
    if (!planned(ecosystem, name, where) && !after.has(key)) problems.push(`${name} ${version} was removed at ${where}, outside the plan`);
  }
  return problems;
}

/** How a declaration without a version (a BOM's or a constraint's to set) counts among a configuration's versions. */
export const UNVERSIONED = "(no version)";

/** The versions a configuration declares (or inherits) for `name`, one per declaration (`UNVERSIONED` for one without). */
export function declaredAt(gradle: GradleInventory | undefined, location: string, name: string): string[] {
  for (const build of gradle?.builds ?? []) {
    for (const configuration of build.configurations) {
      if (gradleLocation(build.build, configuration.id) !== location) continue;
      return configuration.declared.filter((declared) => `${declared.group}:${declared.name}` === name).map((declared) => declared.version ?? UNVERSIONED);
    }
  }
  return [];
}

/** The version a configuration resolves for `name`, if it resolves it. */
export function resolvedAt(gradle: GradleInventory | undefined, location: string, name: string): string | undefined {
  for (const build of gradle?.builds ?? []) {
    for (const configuration of build.configurations) {
      if (gradleLocation(build.build, configuration.id) !== location) continue;
      return configuration.resolved.find((component) => `${component.group}:${component.name}` === name)?.version;
    }
  }
  return undefined;
}

/**
 * A workflow's text with the ref and trailing comment of each `uses:` of
 * `actions` masked: what a planned pin may change (its `owner/repo[/path]`
 * stays, so a pin can't also switch the action or workflow it points at). The `uses:` keys come from
 * parsing the YAML, so text inside a block scalar (a `run: |` script) is never
 * taken for one. A file that doesn't parse can't be compared: undefined.
 */
export function pinsMasked(text: string | undefined, actions: ReadonlySet<string>): string | undefined {
  if (text === undefined) return undefined;
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return undefined;
  const ranges: Array<[number, number]> = [];
  const visited = new Set<unknown>();
  const walk = (node: unknown): void => {
    if (visited.has(node)) return;
    visited.add(node);
    if (isMap(node)) {
      for (const pair of node.items) {
        const value = pair.value;
        if (isScalar(pair.key) && pair.key.value === "uses" && isScalar(value) && typeof value.value === "string" && value.range !== undefined && value.range !== null) {
          const action = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/.exec(value.value)?.[1]?.toLowerCase();
          const at = text.indexOf("@", value.range[0]);
          if (action !== undefined && actions.has(action) && at !== -1 && at < value.range[1]) {
            // From the ref on, then whatever follows the scalar on its line if that's only a comment.
            const lineEnd = text.indexOf("\n", value.range[1]);
            const rest = text.slice(value.range[1], lineEnd === -1 ? text.length : lineEnd);
            ranges.push([at + 1, /^\s*(#.*)?$/.test(rest) ? value.range[1] + rest.length : value.range[1]]);
          }
        }
        walk(value);
      }
    } else if (isSeq(node)) {
      for (const item of node.items) walk(item);
    }
  };
  walk(doc.contents);
  let masked = text;
  for (const [from, to] of ranges.sort((a, b) => b[0] - a[0])) masked = `${masked.slice(0, from)}<pinned>${masked.slice(to)}`;
  return masked;
}

/** The gate's policy: its config and exceptions, and every workflow and action file (only planned pins may change one). */
export function isPolicyFile(path: string): boolean {
  const name = basename(path);
  return (
    path === ".github/supply-chain.json" ||
    path === ".github/supply-chain-exceptions.json" ||
    path.startsWith(".github/workflows/") ||
    path.startsWith(".github/actions/") ||
    name === "action.yml" ||
    name === "action.yaml"
  );
}

const DEPENDENCY_FILES = new Set(["package.json", "package-lock.json", "npm-shrinkwrap.json", "gradle.lockfile", "buildscript-gradle.lockfile"]);

/** A file a dependency move may touch: manifests, lockfiles, Gradle build, settings and catalog files, floors, and workflows when `actions`. */
export function isDependencyFile(path: string, actions: boolean): boolean {
  const name = basename(path);
  if (DEPENDENCY_FILES.has(name)) return true;
  if (name.endsWith(".gradle") || name.endsWith(".gradle.kts")) return true;
  if (path === "gradle/libs.versions.toml" || path.endsWith("/gradle/libs.versions.toml")) return true;
  if (path === FLOORS_FILE) return true;
  return actions && (path.startsWith(".github/workflows/") || path.startsWith(".github/actions/") || name === "action.yml" || name === "action.yaml");
}

/** Dependency files (lockfiles, manifests, Gradle build, settings and catalog files, floors) whose conflicts take the base's side, the plan then re-applied on top. */
export function isMechanical(path: string): boolean {
  const name = basename(path);
  return (
    ["package-lock.json", "npm-shrinkwrap.json", "package.json", "gradle.lockfile", "buildscript-gradle.lockfile"].includes(name) ||
    name.endsWith(".gradle") ||
    name.endsWith(".gradle.kts") ||
    path === FLOORS_FILE ||
    path.endsWith("gradle/libs.versions.toml")
  );
}
