import { describe, expect, it } from "vitest";

import type { Tree } from "../../ci/src/tree.ts";
import { strictPinsChanged } from "../src/edit-checks.ts";

const tree = (files: Record<string, string>): Tree => ({ id: "fixture", read: async (path) => files[path], list: async () => [] });
const KTS = 'dependencies {\n  implementation("g:plain:1.0")\n  implementation("g:pinned") { version { strictly("1.0") } }\n}\n';
const GROOVY = 'dependencies {\n  implementation "g:plain:1.0"\n  implementation("g:pinned") { version { strictly "1.0" } }\n}\n';
const CATALOG = '[libraries]\nplain = "g:plain:1.0"\npinned = { module = "g:pinned", version = { strictly = "1.0" } }\n';

describe("strict pins", () => {
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
});
