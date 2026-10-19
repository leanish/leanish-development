/**
 * Checks both tools run on an edit before publishing it, whatever the plan:
 *
 *   - the policy fence: the gate's own config, exceptions and every workflow
 *     and action file stay as they are, except, in a file a planned action
 *     pin names, that pin's ref and comment (checked first, since `compare`
 *     reads its policy from head);
 *   - planned action pins landed (the tag's commit with `# <tag>`), and no
 *     other action use changed;
 *   - the declared npm versions, per declaration, to compare base with head;
 *   - which files are dependency files (an edit that isn't a major may only
 *     touch those) and which conflicted files take the base's side when the
 *     default branch is merged in.
 */
import { basename } from "node:path";

import { isAlias, isMap, isScalar, isSeq, parseDocument, Scalar } from "yaml";

import { commentTag, parseUses, readActionsInventory } from "@leanish/gate/actions-inventory";
import type { Floor } from "@leanish/gate/floors";
import { gradleLocation, type GradleConfiguration, type GradleInventory } from "@leanish/gate/gradle";
import { directDependencies } from "@leanish/gate/npm-lock";
import type { Tree } from "@leanish/gate/tree";
import { versionScheme } from "@leanish/gate/versions";

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

/** The first configuration of the inventory's builds at `location`, if there is one. */
function configurationAt(gradle: GradleInventory | undefined, location: string): GradleConfiguration | undefined {
  for (const build of gradle?.builds ?? []) {
    for (const configuration of build.configurations) {
      if (gradleLocation(build.build, configuration.id) === location) return configuration;
    }
  }
  return undefined;
}

/** The versions a configuration declares (or inherits) for `name`, one per declaration (`UNVERSIONED` for one without). */
export function declaredAt(gradle: GradleInventory | undefined, location: string, name: string): string[] {
  const configuration = configurationAt(gradle, location);
  if (configuration === undefined) return [];
  return configuration.declared.filter((declared) => `${declared.group}:${declared.name}` === name).map((declared) => declared.version ?? UNVERSIONED);
}

/** The version a configuration resolves for `name`, if it resolves it. */
export function resolvedAt(gradle: GradleInventory | undefined, location: string, name: string): string | undefined {
  const configuration = configurationAt(gradle, location);
  return configuration?.resolved.find((component) => `${component.group}:${component.name}` === name)?.version;
}

/** Expected entries absent from actual, counting each occurrence separately. */
export function missingOccurrences(expected: ReadonlyArray<string>, actual: ReadonlyArray<string>): string[] {
  const remaining = [...actual];
  return expected.filter((entry) => {
    const index = remaining.indexOf(entry);
    if (index === -1) return true;
    remaining.splice(index, 1);
    return false;
  });
}

/**
 * For security floors, preserve every base declaration (including unversioned ones), allowing plugin-added declarations without
 * provenance. Head must resolve at least the recorded floor by Maven ordering; losing a base resolution fails.
 * The separate Gradle reference comparison still requires any additions to come from the plan.
 */
export function preservedMavenFloorProblems(floor: Pick<Floor, "package" | "version" | "locations">,
  base: GradleInventory | undefined, head: GradleInventory | undefined): string[] {
  const problems: string[] = [];
  for (const location of floor.locations) {
    const missing = missingOccurrences(declaredAt(base, location, floor.package), declaredAt(head, location, floor.package));
    for (const version of missing) problems.push(`floor declaration for ${floor.package} ${version} was removed or changed at ${location}`);
    const resolved = resolvedAt(head, location, floor.package);
    if (resolved === undefined) {
      const before = resolvedAt(base, location, floor.package);
      if (before !== undefined) problems.push(`floor resolution for ${floor.package} disappeared at ${location} (base resolved ${before})`);
    } else if (versionScheme("Maven").compare(resolved, floor.version) < 0) {
      problems.push(`floor resolution for ${floor.package} at ${location} is ${resolved}, below ${floor.version}`);
    }
  }
  return problems;
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
  const walk = (node: unknown): void => {
    if (isMap(node)) {
      for (const pair of node.items) {
        const value = pair.value;
        if (isScalar(pair.key) && pair.key.value === "uses" && isScalar(value) && typeof value.value === "string" && value.range !== undefined && value.range !== null) {
          const action = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/.exec(value.value)?.[1]?.toLowerCase();
          const at = text.indexOf("@", value.range[0]);
          if (action !== undefined && actions.has(action) && at !== -1 && at < value.range[1]) {
            // From the ref on, then whatever follows the scalar on its line if that's only a comment. A CRLF line's
            // `\r` isn't part of it (a regex `.` never matches one), so a CRLF file's comment is masked like an LF one.
            const lineEnd = text.indexOf("\n", value.range[1]);
            const end = lineEnd === -1 ? text.length : text[lineEnd - 1] === "\r" ? lineEnd - 1 : lineEnd;
            const rest = text.slice(value.range[1], end);
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

/** The gate's own reusable workflow, as an adopter's caller names it: `uses: <name>/<path>@<sha> # <tag>`. */
export const GATE_WORKFLOW = { name: "leanish/leanish-development", path: ".github/workflows/supply-chain.yml" } as const;

/** One planned pin to write: `name`'s uses whose comment names `from` go to `commitSha # to`. */
export interface PinWrite {
  readonly name: string;
  readonly from: string;
  readonly to: string;
  readonly commitSha: string;
}

/** What may follow a pinned `uses:` on its line: a comment naming only its version. */
const VERSION_TAIL = /^(\s*)#\s*(\S+)\s*$/;

/**
 * The file with each planned pin written in place: the ref of every `uses:` of `name` (any path under it) whose
 * comment names `from` becomes `commitSha`, and that comment `# to`; every other byte is kept, other versions of the
 * same action included. `uses:` keys come from parsing the YAML, so a script's text is never taken for one. Throws
 * when a planned action's use can't be rewritten in place (an alias, a block scalar, an escaped ref, a comment naming
 * more than its version), rather than guessing.
 */
export function writtenPins(text: string, file: string, pins: ReadonlyArray<PinWrite>): string {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) throw new Error(`${file} isn't valid YAML`);
  const planned = new Set(pins.map((pin) => pin.name.toLowerCase()));
  const edits: Array<{ readonly start: number; readonly end: number; readonly text: string }> = [];
  const walk = (node: unknown): void => {
    if (isMap(node)) {
      for (const pair of node.items) {
        const value = pair.value;
        if (isScalar(pair.key) && pair.key.value === "uses") {
          const literal = isScalar(value) && typeof value.value === "string" ? value.value : undefined;
          const action = (literal === undefined ? undefined : /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/.exec(literal)?.[1])?.toLowerCase();
          if (isAlias(value)) {
            const resolved = value.resolve(doc);
            const target = isScalar(resolved) && typeof resolved.value === "string" ? /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/.exec(resolved.value)?.[1]?.toLowerCase() : undefined;
            if (target !== undefined && planned.has(target)) throw new Error(`${file}: an aliased \`uses:\` of ${target} can't be rewritten in place`);
          } else if (action !== undefined && planned.has(action) && isScalar(value) && value.range !== undefined && value.range !== null) {
            const lineEnd = text.indexOf("\n", value.range[1]);
            const tailEnd = lineEnd === -1 ? text.length : text[lineEnd - 1] === "\r" ? lineEnd - 1 : lineEnd;
            const tail = VERSION_TAIL.exec(text.slice(value.range[1], tailEnd));
            const pin = tail === null ? undefined : pins.find((candidate) => candidate.name.toLowerCase() === action && candidate.from === tail[2]);
            if (pin !== undefined) {
              if (value.type !== Scalar.PLAIN && value.type !== Scalar.QUOTE_DOUBLE && value.type !== Scalar.QUOTE_SINGLE) throw new Error(`${file}: a block-scalar \`uses:\` of ${action} can't be rewritten in place`);
              const at = text.indexOf("@", value.range[0]);
              const ref = literal!.slice(literal!.indexOf("@") + 1);
              if (at === -1 || at >= value.range[1] || text.slice(at + 1, at + 1 + ref.length) !== ref) throw new Error(`${file}: a \`uses:\` of ${action} isn't written literally`);
              edits.push({ start: at + 1, end: at + 1 + ref.length, text: pin.commitSha });
              edits.push({ start: value.range[1], end: tailEnd, text: `${tail![1] || " "}# ${pin.to}` });
            }
          }
        }
        walk(value);
      }
    } else if (isSeq(node)) {
      for (const item of node.items) walk(item);
    }
  };
  walk(doc.contents);
  let written = text;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) written = written.slice(0, edit.start) + edit.text + written.slice(edit.end);
  // Same check the policy fence makes: nothing changed but the planned actions' refs and comments.
  if (pinsMasked(written, planned) !== pinsMasked(text, planned)) throw new Error(`writing ${file}'s pins would change more than them`);
  // And every planned use moved: one whose comment names its version among other words was left for the agent.
  const left = parseUses(written, file).uses.filter((use) => pins.some((pin) => pin.name.toLowerCase() === use.name && commentTag(use) === pin.from));
  if (left.length > 0) throw new Error(`${file}: a \`uses:\` of ${left[0]!.name} at ${commentTag(left[0]!)} can't be rewritten in place`);
  return written;
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
  return isDependencyFile(path, false);
}
