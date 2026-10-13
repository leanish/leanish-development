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
