import { describe, expect, it } from "vitest";

import type { Tree } from "../../ci/src/tree.ts";
import { strictPinsChanged } from "../src/edit-checks.ts";

const tree = (files: Record<string, string>): Tree => ({ id: "fixture", read: async (path) => files[path], list: async () => [] });
const KTS = 'dependencies {\n  implementation("g:plain:1.0")\n  implementation("g:pinned") { version { strictly("1.0") } }\n}\n';
const GROOVY = 'dependencies {\n  implementation "g:plain:1.0"\n  implementation("g:pinned") { version { strictly "1.0" } }\n}\n';
const CATALOG = '[libraries]\nplain = "g:plain:1.0"\npinned = { module = "g:pinned", version = { strictly = "1.0" } }\n';

describe("parsed catalog strict pins", () => {
  const path = "gradle/libs.versions.toml";
  const check = (before: string, after: string) => strictPinsChanged([path], tree({ [path]: before }), tree({ [path]: after }));
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
    expect(await strictPinsChanged([path], tree({}), catalog)).toEqual([changed]);
    expect(await strictPinsChanged([path], catalog, tree({}))).toEqual([changed]);
  });
});

describe("strict pins", () => {
  it("refuses nested block comments that could hide a pin in Kotlin, where they nest", async () => {
    const path = "build.gradle.kts";
    const before = '/* outer /* nested */ " */\nstrictly("1.0")\n';
    const base = tree({ [path]: before });
    expect(await strictPinsChanged([path], base, tree({ [path]: before.replace('strictly("1.0")', 'strictly("2.0")') })))
      .toEqual([`${path}: a nested block comment can't be verified`]);
    expect(await strictPinsChanged([path], base, base)).toEqual([`${path}: a nested block comment can't be verified`]);
  });

  it("reads a Groovy block comment holding `/*` as one comment, since Groovy's don't nest", async () => {
    const path = "build.gradle";
    const before = '/* exclude src/**/*.java from the scan */\nimplementation "g:a:1.0"\nstrictly "1.0"\n';
    const base = tree({ [path]: before });
    expect(await strictPinsChanged([path], base, tree({ [path]: before.replace('"g:a:1.0"', '"g:a:1.1"') }))).toEqual([]);
    expect(await strictPinsChanged([path], base, tree({ [path]: before.replace('strictly "1.0"', 'strictly "2.0"') })))
      .toEqual([`the edit changed a Gradle strictly(...) pin in ${path}: strict versions are the owner's, which no plan moves`]);
  });

  it("passes an edit that moves other declarations and leaves every strictly line as it was", async () => {
    const base = tree({ "build.gradle.kts": KTS, "build.gradle": GROOVY, "gradle/libs.versions.toml": CATALOG });
    const head = tree({ "build.gradle.kts": KTS.replace("plain:1.0", "plain:2.0"), "build.gradle": GROOVY.replace("plain:1.0", "plain:2.0"),
      "gradle/libs.versions.toml": CATALOG.replace("plain:1.0", "plain:2.0") });
    expect(await strictPinsChanged(["build.gradle.kts", "build.gradle", "gradle/libs.versions.toml"], base, head)).toEqual([]);
  });

  it.each(["build.gradle.kts", "build.gradle"])("protects inactive multiline pins in %s", async (path) => {
    const before = 'if (hasProperty("legacy")) {\n  dependencies {\n    implementation("g:pinned") { version {\n      strictly(\n        "1.0" // parentheses in strings and comments do not balance: )\n        /* } )\n           { ( */\n      )\n    } }\n  }\n}\n';
    const check = (after: string) => strictPinsChanged([path], tree({ [path]: before }), tree({ [path]: after }));
    expect(await check(before)).toEqual([]);
    expect(await check(before.replace('"1.0"', '"2.0"'))).toHaveLength(1);
    expect(await check(before.replace(/      strictly\([\s\S]*?      \)\n/, ""))).toHaveLength(1);
  });

  describe.each([
    ["build.gradle.kts", '"""'],
    ["build.gradle.kts", '"'],
    ["build.gradle", '"'],
  ])("a strict pin inside a %s %s string interpolation", (path, quote) => {
    const before = `val note = ${quote}\${run { constraints { implementation("g:a") { version { strictly("1.0") } } } }}${quote}\n`;
    it("fails the check, changed or not", async () => {
      expect(await strictPinsChanged([path], tree({ [path]: before }), tree({ [path]: before.replace('"1.0"', '"2.0"') })))
        .toEqual([`${path}: a strictly(...) on a line with a string interpolation can't be verified`]);
    });
  });

  it("fails a line with an interpolation that mentions strictly anywhere, even outside the interpolation", async () => {
    const path = "build.gradle.kts";
    const before = 'because("${reason} keeps it strictly pinned")\n';
    expect(await strictPinsChanged([path], tree({ [path]: before }), tree({ [path]: `${before}// changed\n` })))
      .toEqual([`${path}: a strictly(...) on a line with a string interpolation can't be verified`]);
  });

  it("lets ordinary interpolations and escaped dollars through, and still sees pins after them", async () => {
    const path = "build.gradle.kts";
    const before = 'val v = "${project.version} ${mapOf("a" to "}").size} \\${literal}"\nstrictly("1.0")\n';
    expect(await strictPinsChanged([path], tree({ [path]: before }), tree({ [path]: before.replace("project.version", "rootProject.version") }))).toEqual([]);
    expect(await strictPinsChanged([path], tree({ [path]: before }), tree({ [path]: before.replace('strictly("1.0")', 'strictly("2.0")') })))
      .toEqual([expect.stringContaining("strictly(...) pin")]);
  });

  it("fails a changed file with an interpolation spanning lines, which could hide a pin", async () => {
    const path = "build.gradle.kts";
    const before = 'val note = """${\n  run { strictly("1.0") }\n}"""\n';
    expect(await strictPinsChanged([path], tree({ [path]: before }), tree({ [path]: before.replace('"1.0"', '"2.0"') })))
      .toEqual([`${path}: a string interpolation spanning lines can't be verified`]);
  });

  it.each([
    ["build.gradle.kts", 'val note = """${run { /* }} */ strictly("1.0"); "" }}"""\n'],
    ["build.gradle.kts", 'val note = "${run { f("\\"}}") ; strictly("1.0") }}"\n'],
    // An inner triple-quoted string whose braces end the interpolation early, as the scanner would read it.
    ["build.gradle", `def note = """\${{ -> def text = ''' '}} '''; strictly('1.0'); '' }()}"""\n`],
  ])("fails an interpolation whose comments, escapes or inner strings could hide a pin: %s %s", async (path, before) => {
    expect(await strictPinsChanged([path], tree({ [path]: before }), tree({ [path]: before.replace("1.0", "2.0") })))
      .toEqual([expect.stringMatching(/^build\.gradle(\.kts)?: a (strictly|string interpolation)/)]);
  });

  it("reads Groovy's single-quoted strings and TOML strings as plain text", async () => {
    for (const [path, text] of [["build.gradle", "def s = '${strictly(1)}'\n"], ["gradle/libs.versions.toml", 'note = "${strictly}"\n']] as const) {
      const comment = path.endsWith(".toml") ? "# changed\n" : "// changed\n";
      expect(await strictPinsChanged([path], tree({ [path]: text }), tree({ [path]: `${text}${comment}` }))).toEqual([]);
    }
  });

  it("protects an inactive Kotlin pin after a raw string containing a quote", async () => {
    const path = "build.gradle.kts";
    const before = 'val pattern = """[^"]+""".toRegex()\nif (hasProperty("legacy")) {\n  dependencies { implementation("g:pinned") { version { strictly("1.0") } } }\n}\n';
    expect(await strictPinsChanged([path], tree({ [path]: before }), tree({ [path]: before.replace('strictly("1.0")', 'strictly("2.0")') })))
      .toEqual([expect.stringContaining("strictly(...) pin")]);
  });

  describe.each([
    ["build.gradle.kts", '"""'],
    ["build.gradle", '"""'],
    ["build.gradle", "'''"],
  ])("triple-quoted strings in %s with %s", (path, quote) => {
    const declaration = path.endsWith(".kts") ? "val" : "def";
    it.each(["; ", "\n"])("protects a real pin after the string with separator %j", async (separator) => {
      const before = `${declaration} pattern = ${quote}[^${quote[0]}]+${quote}${separator}strictly("1.0")\n`;
      expect(await strictPinsChanged([path], tree({ [path]: before }), tree({ [path]: before.replace('strictly("1.0")', 'strictly("2.0")') })))
        .toEqual([expect.stringContaining("strictly(...) pin")]);
    });

    it("ignores strictly and delimiters inside a multiline string", async () => {
      const before = `${declaration} text = ${quote}\n  strictly(\n  ${quote[0]} // /* #\n  1.0\n${quote}\n`;
      expect(await strictPinsChanged([path], tree({ [path]: before }), tree({ [path]: before.replace("1.0", "2.0") }))).toEqual([]);
    });

    it.each(["; ", "\n"])("resumes scanning after a multiline string with separator %j", async (separator) => {
      const before = `${declaration} text = ${quote}\n  strictly(\n  ${quote[0]} // /* #\n${quote}${separator}strictly("1.0")\n`;
      expect(await strictPinsChanged([path], tree({ [path]: before }), tree({ [path]: before.replace('strictly("1.0")', 'strictly("2.0")') })))
        .toEqual([expect.stringContaining("strictly(...) pin")]);
    });
  });

  it("does not escape the closing quotes of a Kotlin raw string", async () => {
    const path = "build.gradle.kts";
    const before = String.raw`val text = """ends in a backslash\"""; strictly("1.0")`;
    expect(await strictPinsChanged([path], tree({ [path]: before }), tree({ [path]: before.replace('strictly("1.0")', 'strictly("2.0")') })))
      .toEqual([expect.stringContaining("strictly(...) pin")]);
  });

  it.each([4, 5])("resumes scanning after a Kotlin raw string ending with %i quotes", async (count) => {
    const path = "build.gradle.kts";
    const before = `val text = """ends in quotes${'"'.repeat(count)}; strictly("1.0")\n`;
    expect(await strictPinsChanged([path], tree({ [path]: before }), tree({ [path]: before.replace('strictly("1.0")', 'strictly("2.0")') })))
      .toEqual([expect.stringContaining("strictly(...) pin")]);
  });

  it.each(['"""', "'''"])("honors escaped quotes in a Groovy %s string", async (quote) => {
    const path = "build.gradle";
    const before = `def text = ${quote}escaped \\${quote}\nstrictly(1.0\n${quote}; strictly("1.0")\n`;
    expect(await strictPinsChanged([path], tree({ [path]: before }), tree({ [path]: before.replace("strictly(1.0", "strictly(2.0") }))).toEqual([]);
    expect(await strictPinsChanged([path], tree({ [path]: before }), tree({ [path]: before.replace('strictly("1.0")', 'strictly("2.0")') })))
      .toEqual([expect.stringContaining("strictly(...) pin")]);
  });

  it.each(['"""', "'''"])("skips TOML multiline %s values before a strict key", async (quote) => {
    const path = "gradle/libs.versions.toml";
    for (const count of [3, 4, 5]) {
      const before = `text = ${quote}\nstrictly(1.0\n${quote === "'''" ? "\\" : ""}${quote[0]!.repeat(count)}\npinned = { strictly = "1.0" }\n`;
      expect(await strictPinsChanged([path], tree({ [path]: before }), tree({ [path]: before.replace("strictly(1.0", "strictly(2.0") }))).toEqual([]);
      expect(await strictPinsChanged([path], tree({ [path]: before }), tree({ [path]: before.replace('strictly = "1.0"', 'strictly = "2.0"') })))
        .toEqual([expect.stringContaining("strictly(...) pin")]);
    }
  });

  it("captures nested call and brace continuations, ignoring delimiters inside strings", async () => {
    const path = "build.gradle";
    const before = 'strictly(\n  providers.provider {\n    "1.0) }"\n  }.get()\n)\n';
    expect(await strictPinsChanged([path], tree({ [path]: before }), tree({ [path]: before.replace("1.0", "2.0") }))).toHaveLength(1);
  });

  it("fails closed on unbalanced or over-budget strict statements", async () => {
    const path = "build.gradle.kts";
    for (const text of ['strictly(\n "1.0"\n', `strictly(\n${"\n".repeat(129)})`, `strictly("${"1".repeat(64 * 1024)}")`]) {
      expect(await strictPinsChanged([path], tree({ [path]: text }), tree({ [path]: text }))).toHaveLength(1);
    }
  });

  it("refuses a changed, removed, added or reformatted strictly line in build files and any catalog", async () => {
    const changed = (path: string, before: string, after: string) => strictPinsChanged([path], tree({ [path]: before }), tree({ [path]: after }));
    expect(await changed("build.gradle.kts", KTS, KTS.replace('strictly("1.0")', 'strictly("2.0")'))).toEqual([expect.stringContaining("build.gradle.kts")]);
    expect(await changed("sub/build.gradle", GROOVY, GROOVY.replace('strictly "1.0"', 'strictly "2.0"'))).toEqual([expect.stringContaining("sub/build.gradle")]);
    expect(await changed("gradle/custom.versions.toml", CATALOG, CATALOG.replace('strictly = "1.0"', 'strictly = "2.0"'))).toHaveLength(1);
    expect(await changed("build.gradle.kts", KTS, KTS.replace(/.*strictly.*\n/, ""))).toHaveLength(1);
    expect(await changed("build.gradle.kts", KTS, `${KTS}dependencies { implementation("g:other") { version { strictly("3.0") } } }\n`)).toHaveLength(1);
    expect(await changed("build.gradle.kts", KTS, KTS.replace('{ version { strictly("1.0") } }', '{ version {  strictly("1.0") } }'))).toHaveLength(1);
  });

  it("refuses reordering two different strictly lines", async () => {
    const other = 'dependencies { implementation("g:other") { version { strictly("2.0") } } }\n';
    expect(await strictPinsChanged(["build.gradle.kts"], tree({ "build.gradle.kts": `${KTS}${other}` }), tree({ "build.gradle.kts": `${other}${KTS}` }))).toHaveLength(1);
  });

  it("lets a line that only says the word through, such as a floor's because(...) about a strict parent", async () => {
    const floor = '  implementation("g:okio:3.4.0") { because("GHSA-x: okhttp is strictly pinned to 4.9.3") }\n';
    expect(await strictPinsChanged(["build.gradle.kts"], tree({ "build.gradle.kts": KTS }), tree({ "build.gradle.kts": KTS.replace("}\n", `}\n${floor}`) }))).toEqual([]);
  });

  it("counts strictly wherever it's code, in any argument form, and only there", async () => {
    const groovy = [
      "dependencies {",
      "  implementation('g:a') { version { strictly pinVersion } } // the owner's",
      "  implementation('g:b') { version { strictly getPinnedVersion() } }",
      "  implementation('g:c') { version { strictly versions[\"pinned\"] } }",
      "  // strictly pinned above; see the owner",
      "}",
    ].join("\n");
    const changed = (after: string) => strictPinsChanged(["build.gradle"], tree({ "build.gradle": groovy }), tree({ "build.gradle": after }));
    expect(await changed(groovy.replace("strictly pinVersion", "strictly otherVersion"))).toHaveLength(1);
    expect(await changed(groovy.replace("getPinnedVersion()", "getNewerVersion()"))).toHaveLength(1);
    expect(await changed(groovy.replace('versions["pinned"]', 'versions["newer"]'))).toHaveLength(1);
    expect(await changed(groovy.replace("  implementation('g:a')", "  // implementation('g:a')"))).toHaveLength(1);
    expect(await changed(groovy.replace("see the owner", "ask the owner"))).toEqual([]);
    const inline = 'dependencies {\n  implementation("g:d") { version { /* owner pin */ strictly("1.0") } }\n}\n';
    expect(await strictPinsChanged(["build.gradle.kts"], tree({ "build.gradle.kts": inline }), tree({ "build.gradle.kts": inline.replace('"1.0"', '"2.0"') }))).toHaveLength(1);
    const quotedCall = "dependencies {\n  if (project.hasProperty('optional')) { implementation('g:e') { version { delegate.\"strictly\"('1.0') } } }\n}\n";
    expect(await strictPinsChanged(["build.gradle"], tree({ "build.gradle": quotedCall }), tree({ "build.gradle": quotedCall.replace("'1.0'", "'2.0'") }))).toHaveLength(1);
    const bareCall = quotedCall.replace(`"strictly"('1.0')`, `"strictly" '1.0'`);
    expect(await strictPinsChanged(["build.gradle"], tree({ "build.gradle": bareCall }), tree({ "build.gradle": bareCall.replace("'1.0'", "'2.0'") }))).toHaveLength(1);
    const catalog = '[versions]\npinned = { "strictly" = "1.0" }\n';
    expect(await strictPinsChanged(["gradle/libs.versions.toml"], tree({ "gradle/libs.versions.toml": catalog }), tree({ "gradle/libs.versions.toml": catalog.replace('"1.0"', '"2.0"') }))).toHaveLength(1);
  });

  it("counts duplicate strictly lines, so dropping one of two identical pins is refused", async () => {
    const twice = `${KTS}${KTS}`;
    expect(await strictPinsChanged(["build.gradle.kts"], tree({ "build.gradle.kts": twice }), tree({ "build.gradle.kts": KTS }))).toHaveLength(1);
  });

  it("covers whole files the edit added or deleted", async () => {
    expect(await strictPinsChanged(["extra.gradle.kts"], tree({}), tree({ "extra.gradle.kts": KTS }))).toHaveLength(1);
    expect(await strictPinsChanged(["extra.gradle.kts"], tree({ "extra.gradle.kts": KTS }), tree({}))).toHaveLength(1);
  });

  it("ignores files that aren't Gradle build, settings or catalog files, and files the edit didn't change", async () => {
    const before = tree({ "README.md": "strictly 1.0", "build.gradle.kts": KTS });
    const after = tree({ "README.md": "strictly 2.0", "build.gradle.kts": KTS.replace('strictly("1.0")', 'strictly("2.0")') });
    expect(await strictPinsChanged(["README.md"], before, after)).toEqual([]);
  });

  it("keeps capturing when a line closes one strictly call and opens another across lines", async () => {
    const kts = 'dependencies {\n  if (project.hasProperty("legacy")) {\n    constraints { implementation("g:a") { version { strictly("1.0") } }; implementation("g:b") { version { strictly(\n      "1.0"\n    ) } } }\n  }\n}\n';
    expect(await strictPinsChanged(["build.gradle.kts"], tree({ "build.gradle.kts": kts }), tree({ "build.gradle.kts": kts.replace('      "1.0"', '      "2.0"') }))).toHaveLength(1);
  });
});
