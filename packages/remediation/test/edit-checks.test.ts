import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { StrictCallParser } from "../src/strict-calls.ts";
import type { Tree } from "../../ci/src/tree.ts";
import { isDependencyFile, isMechanical, strictPinsChanged } from "../src/edit-checks.ts";
import { LOCAL_GRADLE, LOCAL_WRAPPER as WRAPPER, localGradleParser } from "./local-gradle-parser.ts";
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


describe("strict-pin script selection", () => {
  it.each([
    ["base only", "strictly('1.0')", ""],
    ["head only", "", "strictly('1.0')"],
  ])("parses both sides of an arbitrary file mentioning strictly in %s", async (_side, before, after) => {
    const parse = vi.fn<StrictCallParser>(textStrictCalls);
    const path = "gradle/pins.groovy";
    expect(await strictPinsChanged([path], tree({ [path]: before }), tree({ [path]: after }), parse))
      .toEqual([expect.stringContaining(`pin in ${path}:`)]);
    expect(parse.mock.calls.map(([files]) => files)).toEqual([[{ path, text: before }], [{ path, text: after }]]);
  });

  it("leaves other changed files without strictly alone, without calling a parser", async () => {
    const parse = vi.fn<StrictCallParser>();
    expect(await strictPinsChanged(["README.md", "pins.kts", "gradle/pins.groovy"], tree({ "README.md": "Before" }),
      tree({ "README.md": "After", "pins.kts": "not even valid Kotlin!", "gradle/pins.groovy": "[broken" }), parse)).toEqual([]);
    expect(parse).not.toHaveBeenCalled();
  });
});

describe.skipIf(LOCAL_GRADLE === undefined)("strict pins in build scripts, parsed with Gradle's compilers", { timeout: 120_000 }, () => {
  let state: string;
  beforeAll(async () => { state = await mkdtemp(join(tmpdir(), "strict-parser-test-")); });
  afterAll(async () => { if (state !== undefined) await rm(state, { recursive: true, force: true }); });
  const parse: ReturnType<typeof localGradleParser> = (files, tree) => localGradleParser(state)(files, tree);
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

  it("refuses a build script that doesn't parse, and one without a Gradle wrapper", async () => {
    expect((await check("build.gradle.kts", KTS, "val x = = 3\n"))[0]).toMatch(/^build\.gradle\.kts: doesn't parse, so its strict pins can't be checked: it doesn't parse as Kotlin$/);
    const missing = await strictPinsChanged(["build.gradle"], tree({ "build.gradle": GROOVY }), tree({ "build.gradle": GROOVY.replace("1.0", "2.0") }), parse);
    expect(missing[0]).toContain("no Gradle wrapper names the distribution");
  });

  it("blames only the script that doesn't parse, with the first line of the reason, and reads a byte-order mark as nothing", async () => {
    const files = ["build.gradle", "sub/build.gradle", "other/build.gradle.kts"];
    const base = tree({ ...WRAPPER, "build.gradle": GROOVY, "sub/build.gradle": GROOVY, "other/build.gradle.kts": KTS });
    const head = tree({ ...WRAPPER, "build.gradle": "\uFEFF" + GROOVY, "sub/build.gradle": "dependencies {\n", "other/build.gradle.kts": KTS.replace("g:plain:1.0", "g:plain:1.1") });
    const problems = await strictPinsChanged(files, base, head, parse);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^sub\/build\.gradle: doesn't parse, so its strict pins can't be checked: [^\n]+$/);
    expect(problems[0]).not.toContain("strict-calls-");
    // Broken on both sides, with the same error, a moved pin still can't pass; nor can an edit that fixes the base.
    const broken = "dependencies {\n  implementation('g:a') { version { strictly '1.0' } }\n";
    expect(await check("build.gradle", broken, broken.replace("'1.0'", "'2.0'"))).toEqual([expect.stringContaining("build.gradle: doesn't parse")]);
    expect(await check("build.gradle", broken, GROOVY)).toEqual([expect.stringContaining("can't be checked: the base ")]);
  });

  it("says when Java isn't there to parse with", async () => {
    const noJava = localGradleParser(state, async () => { throw new Error("couldn't run java: spawn java ENOENT"); });
    await expect(noJava([{ path: "build.gradle", text: GROOVY }], tree(WRAPPER))).rejects.toThrow("Java isn't available to parse the build files (couldn't run java: spawn java ENOENT)");
  });

  it("says when the parser was stopped rather than reporting a parse error", async () => {
    const stopped = localGradleParser(state, async () => ({ code: 128, stdout: "", stderr: "" }));
    await expect(stopped([{ path: "build.gradle", text: GROOVY }], tree(WRAPPER))).rejects.toThrow("was stopped, past its 120s limit");
  });

  it.each([
    ["module method", "def pinned(Closure c = { strictly('1.0') }) { c() }\n"],
    ["class method", "class Pins { def pinned(Closure c = { strictly('1.0') }) { c() } }\n"],
    ["constructor", "class Pins { Pins(Closure c = { strictly('1.0') }) { c() } }\n"],
    ["closure parameter", "def pinned = { Closure c = { strictly('1.0') } -> c() }\n"],
  ])("visits %s defaults without refusing an unrelated change", async (_kind, before) => {
    expect(await check("build.gradle", before, before.replace("'1.0'", "'2.0'"))).toEqual(changed("build.gradle"));
    expect(await check("build.gradle", before, before + "// unrelated\n")).toEqual([]);
  });

  it.each([
    ["build.gradle", "def strictly = { v -> v }\nstrictly('1.0')\n"],
    ["build.gradle", "@Something(strictly = '1.0')\nclass Pins {}\nstrictly('2.0')\n"],
    ["build.gradle.kts", 'val `strictly` = { v: String -> v }\n`strictly`("1.0")\n'],
    ["build.gradle.kts", '@Something(strictly = "1.0")\nclass Pins\nstrictly("2.0")\n'],
    // IntelliJ's containsOffset includes the end; the identifier immediately after a string is outside it.
    ["build.gradle.kts", '"strictly"strictly"1.0"\n'],
  ])("refuses the whole %s file for mentions the visitor can't attribute, even alongside an accounted call", async (path, before) => {
    const findings = (await parse([{ path, text: before }], tree(WRAPPER))).get(path)!;
    expect(findings.filter((line) => line.startsWith("file\t"))).toHaveLength(1);
    expect(findings).toContain(`file\t${createHash("sha256").update(before).digest("hex")}`);
    expect(await check(path, before, before + "// unrelated\n")).toEqual(changed(path));
  });

  it.each([
    ["build.gradle", "this.'strictly'('1.0')\n"],
    ["build.gradle.kts", 'this.`strictly`("1.0")\n'],
  ])("accounts for quoted or backticked call names in %s", async (path, before) => {
    expect(await check(path, before, before.replace("1.0", "2.0"))).toEqual(changed(path));
    expect(await check(path, before, before + "// unrelated\n")).toEqual([]);
  });

  it("reads leading whitespace, continuations and CRLF in wrapper properties, using only the version", async () => {
    const wrapper = { "gradle/wrapper/gradle-wrapper.properties": `  distributionUrl = https\\://untrusted.example/ignored/\\\r\n   gradle-${LOCAL_GRADLE!.version}-all.zip\r\n` };
    expect(await parse([{ path: "build.gradle", text: GROOVY }], tree(wrapper)))
      .toEqual(await parse([{ path: "build.gradle", text: GROOVY }], tree(WRAPPER)));
  });

  it.each([
    ["gradle/pins.groovy", "strictly('1.0')\n"],
    ["pins.kts", 'val kotlinOnly: String = "value"\nstrictly("1.0")\n'],
  ])("refuses a changed pin in %s with the real parser", async (path, before) => {
    expect(await check(path, before, before.replace("1.0", "2.0"))).toEqual(changed(path));
    expect(await check(path, before, before + "// unrelated\n")).toEqual([]);
  });

  it("refuses prose mentioning strictly when it doesn't parse as Groovy, naming that file", async () => {
    const before = "# Strict pins\nWe strictly preserve the owner's versions.\n";
    expect(await check("README.md", before, before + "Another sentence.\n"))
      .toEqual([expect.stringMatching(/^README\.md: doesn't parse, so its strict pins can't be checked:/)]);
  });
});

describe("isMechanical", () => {
  it("takes the base's side for the dependency files a move touches, workflows aside, matching the catalog by whole folder", () => {
    for (const path of ["package-lock.json", "web/package.json", "npm-shrinkwrap.json", "gradle.lockfile", "app/buildscript-gradle.lockfile", "build.gradle", "app/build.gradle.kts", "gradle/libs.versions.toml", "app/gradle/libs.versions.toml", ".github/dependency-floors.json"]) {
      expect(isMechanical(path), path).toBe(true);
    }
    for (const path of ["xgradle/libs.versions.toml", "app/xgradle/libs.versions.toml", ".github/workflows/ci.yml", "action.yml", "README.md"]) {
      expect(isMechanical(path), path).toBe(false);
    }
    expect(isDependencyFile(".github/workflows/ci.yml", true)).toBe(true);
  });
});
