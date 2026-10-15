import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Tree } from "../../ci/src/tree.ts";
import { strictPinsChanged } from "../src/edit-checks.ts";
import { gradleStrictCalls } from "../src/strict-calls.ts";
import { textStrictCalls } from "./strict-calls-fake.ts";

const tree = (files: Record<string, string>): Tree => ({ id: "fixture", read: async (path) => files[path], list: async () => [] });
const KTS = 'dependencies {\n  implementation("g:plain:1.0")\n  implementation("g:pinned") { version { strictly("1.0") } }\n}\n';
const GROOVY = 'dependencies {\n  implementation "g:plain:1.0"\n  implementation("g:pinned") { version { strictly "1.0" } }\n}\n';
const CATALOG = '[libraries]\nplain = "g:plain:1.0"\npinned = { module = "g:pinned", version = { strictly = "1.0" } }\n';

describe("parsed catalog strict pins", () => {
  const path = "gradle/libs.versions.toml";
  const check = (before: string, after: string) => strictPinsChanged([path], tree({ [path]: before }), tree({ [path]: after }), textStrictCalls);
  const changed = `the edit changed a Gradle strictly(...) pin in ${path}: strict versions are the owner's, which no plan moves`;

  it("refuses moving a strict version to another dependency, directly or through version.ref", async () => {
    const direct = '[libraries]\noptional = { module = "org.example:original", version = { strictly = "1.0" } }\n';
    expect(await check(direct, direct.replace("original", "replacement"))).toEqual([changed]);
    const referenced = '[versions]\npinned = { strictly = "1.0" }\n[libraries]\nlib = { module = "org.example:original", version.ref = "pinned" }\nother = { module = "org.example:other", version = "2.0" }\n';
    expect(await check(referenced, referenced.replace("org.example:original", "org.example:replacement"))).toEqual([changed]);
    expect(await check(referenced, referenced.replace('version = "2.0"', 'version = "2.1"'))).toEqual([]);
  });

  it("refuses a changed multiline TOML strict value", async () => {
    const before = 'lib.strictly = """\n1.0"""\n';
    expect(await check(before, before.replace("1.0", "9.0"))).toEqual([changed]);
  });

  it.each([
    'lib.strictly = "1.0"\n',
    'lib = { version = { strictly = "1.0" } }\n',
    '[libraries.lib.version]\nstrictly = "1.0"\n',
    '[[libraries]]\nversion = { strictly = "1.0" }\n',
    'lib."\\u0073trictly" = "1.0"\n',
  ])("refuses changed strict values at any depth: %s", async (before) => {
    expect(await check(before, before.replace("1.0", "9.0"))).toEqual([changed]);
  });

  it("allows unrelated changes and equivalent formatting around unchanged strict values", async () => {
    const before = 'lib.strictly = "1.0"\nother = "2.0"\n';
    expect(await check(before, before.replace("2.0", "3.0"))).toEqual([]);
    expect(await check(before, 'lib.strictly = """1.0""" # same value\nother = "3.0"\n')).toEqual([]);
  });

  it("refuses added, removed, moved, reordered or differently typed strict values", async () => {
    const before = 'first.strictly = "1.0"\nsecond.strictly = "2.0"\n';
    for (const after of [
      `${before}third.strictly = "3.0"\n`,
      'first.strictly = "1.0"\n',
      before.replace("first.strictly", "third.strictly"),
      'second.strictly = "2.0"\nfirst.strictly = "1.0"\n',
      before.replace('"1.0"', "1.0"),
    ]) expect(await check(before, after)).toEqual([changed]);
  });

  it.each(["base", "head"])("refuses a non-parsing %s catalog visibly", async (side) => {
    const valid = 'lib.strictly = "1.0"\n';
    const invalid = 'lib.strictly = "unterminated\n';
    expect(await check(side === "base" ? invalid : valid, side === "head" ? invalid : valid))
      .toEqual([expect.stringContaining(`${path}:`)]);
  });

  it("protects strict values when a whole catalog is added or removed", async () => {
    const catalog = tree({ [path]: 'lib.strictly = "1.0"\n' });
    expect(await strictPinsChanged([path], tree({}), catalog, textStrictCalls)).toEqual([changed]);
    expect(await strictPinsChanged([path], catalog, tree({}), textStrictCalls)).toEqual([changed]);
  });
});


// The parser runs on the Gradle distribution the wrapper names, found where the tools keep it; this machine's
// ~/.gradle stands in for their build cache. Skipped without that distribution, like the other real-Gradle tests.
const gradleHome = join(homedir(), ".gradle");
// Any Gradle 8 or 9 distribution a real-Gradle test downloaded: its compilers parse these scripts the same way.
const GRADLE_VERSION = (() => {
  try {
    return readdirSync(join(gradleHome, "wrapper", "dists")).map((name) => /^gradle-([89]\.[\d.]+)-bin$/.exec(name)?.[1]).find((version) => version !== undefined);
  } catch {
    return undefined;
  }
})();
const hasGradle = GRADLE_VERSION !== undefined;
const WRAPPER = { "gradle/wrapper/gradle-wrapper.properties": `distributionUrl=https\\://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip\n` };

describe.skipIf(!hasGradle)("strict pins in build scripts, parsed with Gradle's compilers", { timeout: 120_000 }, () => {
  const parse = gradleStrictCalls(gradleHome);
  const check = (path: string, before: string | undefined, after: string | undefined) =>
    strictPinsChanged([path], tree({ ...WRAPPER, ...(before === undefined ? {} : { [path]: before }) }), tree({ ...WRAPPER, ...(after === undefined ? {} : { [path]: after }) }), parse);
  const changed = (path: string) => [`the edit changed a Gradle strictly(...) pin in ${path}: strict versions are the owner's, which no plan moves`];

  it.each([
    ["build.gradle.kts", KTS],
    ["build.gradle", GROOVY],
  ])("passes an edit that leaves %s's pins as they were, and refuses one that changes a pin, its dependency or its presence", async (path, text) => {
    expect(await check(path, text, text.replace("g:plain:1.0", "g:plain:1.1"))).toEqual([]);
    expect(await check(path, text, `// a comment\n${text}`)).toEqual([]);
    expect(await check(path, text, text.replace('"1.0"', '"2.0"').replace('"1.0"', '"2.0"'))).toEqual(changed(path));
    expect(await check(path, text, text.replace("g:pinned", "g:other"))).toEqual(changed(path));
    expect(await check(path, text, undefined)).toEqual(changed(path));
    expect(await check(path, undefined, text)).toEqual(changed(path));
  });

  it("sees pins the hand lexer lost behind slashy strings, nested comments and interpolations", async () => {
    const groovy = "def pattern = /\"/\nif (false) {\n  dependencies { implementation('g:a') { version { strictly('1.0') } } }\n}\n";
    expect(await check("build.gradle", groovy, groovy.replace("'1.0'", "'9.0'"))).toEqual(changed("build.gradle"));
    const kotlin = '/* outer /* nested */ " */\ndependencies { implementation("g:a") { version { strictly("1.0") } } }\n';
    expect(await check("build.gradle.kts", kotlin, kotlin.replace('"1.0"', '"9.0"'))).toEqual(changed("build.gradle.kts"));
    // An interpolation on a pin's line no longer refuses an unrelated edit.
    const interpolated = 'val v = "1.0"\ndependencies {\n  implementation("g:a:${v}") { version { strictly("1.0") } }\n  implementation("g:b:1.0")\n}\n';
    expect(await check("build.gradle.kts", interpolated, interpolated.replace("g:b:1.0", "g:b:1.1"))).toEqual([]);
  });

  it("reads pins in the script's own classes and multiline calls", async () => {
    const groovy = "class Pins {\n  static void apply(def deps) { deps.implementation('g:a') { version { strictly(\n    '1.0'\n  ) } } }\n}\n";
    expect(await check("build.gradle", groovy, groovy.replace("'1.0'", "'9.0'"))).toEqual(changed("build.gradle"));
  });

  it("compares indirect forms as written, and any change to a file that takes a reference to strictly", async () => {
    const invoked = "this.invokeMethod('strictly', ['1.0'] as Object[])\n";
    expect(await check("build.gradle", invoked, invoked.replace("'1.0'", "'2.0'"))).toEqual(changed("build.gradle"));
    const pointer = "def f = this.&strictly\nf('1.0')\ndependencies { implementation 'g:b:1.0' }\n";
    expect(await check("build.gradle", pointer, pointer.replace("g:b:1.0", "g:b:1.1"))).toEqual(changed("build.gradle"));
    // A version that reaches a pin through a variable is still read only where the inventory sees it.
    const variable = "def pin = '1.0'\ndependencies { implementation('g:a') { version { strictly pin } } }\n";
    expect(await check("build.gradle", variable, variable.replace("'1.0'", "'2.0'"))).toEqual([]);
  });

  it("refuses a build script that doesn't parse, and one whose Gradle distribution isn't there", async () => {
    expect((await check("build.gradle.kts", KTS, "val x = = 3\n"))[0]).toContain("couldn't be parsed");
    const missing = await strictPinsChanged(["build.gradle"], tree({ "build.gradle": GROOVY }), tree({ "build.gradle": GROOVY.replace("1.0", "2.0") }), gradleStrictCalls(join(gradleHome, "missing")));
    expect(missing[0]).toContain("no Gradle wrapper names the distribution");
  });

  it("ignores files that aren't Gradle build, settings or catalog files", async () => {
    expect(await strictPinsChanged(["README.md"], tree({}), tree({ "README.md": 'strictly("2.0")' }), parse)).toEqual([]);
  });
});
