import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { gradleLocation, type GradleInventory, runGradleInventory } from "../../ci/src/gradle.ts";
import { runProcess } from "../../ci/src/process.ts";

// secure-it's real-Gradle suites share this file on purpose: vitest runs files in parallel, and two real Gradle
// builds at once made one time out connecting to its daemon in CI. Suites of one file run one after the other.
const WRAPPER = fileURLToPath(new URL("../../ci/test/fixtures/gradle-wrapper", import.meta.url));
const REMOVE_FLOORS = fileURLToPath(new URL("../gradle/remove-floors.init.gradle", import.meta.url));

/** group:artifact:version → its dependencies, each a POM-only module. */
const MODULES: Record<string, string[]> = {
  "fixture:plugin-lib:1.0": ["fixture:t:1.0"],
  "fixture:t:1.0": [],
  "fixture:t:2.0": [],
};

function pom(coordinates: string, dependencies: string[]): string {
  const [group, artifact, version] = coordinates.split(":");
  const deps = dependencies.map((dependency) => {
    const [g, a, v] = dependency.split(":");
    return `<dependency><groupId>${g}</groupId><artifactId>${a}</artifactId><version>${v}</version></dependency>`;
  }).join("");
  return `<project><modelVersion>4.0.0</modelVersion><groupId>${group}</groupId><artifactId>${artifact}</artifactId><version>${version}</version><packaging>pom</packaging><dependencies>${deps}</dependencies></project>`;
}

async function write(root: string, path: string, content: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

function at(inventory: GradleInventory, location: string) {
  const found = inventory.builds.flatMap((entry) => entry.configurations.map((configuration) => ({ location: gradleLocation(entry.build, configuration.id), configuration })))
    .find((entry) => entry.location === location)?.configuration;
  if (found === undefined) throw new Error(`no ${location}`);
  return {
    resolved: found.resolved.map((module) => `${module.name}:${module.version}`).sort(),
    declared: found.declared.map((declared) => `${declared.name}:${declared.version}`).sort(),
  };
}

let root: string;
let build: string;

describe.skipIf(process.env["SUPPLY_CHAIN_GRADLE_TESTS"] !== "1")("Gradle floor removal, with real Gradle", () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "secure-it-floor-removal-"));
    const repo = join(root, "repo");
    for (const [coordinates, dependencies] of Object.entries(MODULES)) {
      const [group, artifact, version] = coordinates.split(":");
      await write(repo, `${group!.replaceAll(".", "/")}/${artifact}/${version}/${artifact}-${version}.pom`, pom(coordinates, dependencies));
    }
    build = join(root, "build");
    await cp(WRAPPER, build, { recursive: true });
    // Each script classpath resolves while its script compiles, before any project is evaluated.
    const classpath = `buildscript {
  repositories { maven { url = uri("${repo}") } }
  dependencies {
    classpath "fixture:plugin-lib:1.0"
    classpath("fixture:t:2.0") { because("GHSA-t: plugin-lib brings a vulnerable t") }
  }
}
`;
    await write(build, "settings.gradle", `${classpath}rootProject.name = "fixture"\n`);
    await write(build, "build.gradle", `${classpath}plugins { id "java" }\n`);
  }, 600_000);

  afterAll(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  it.each([":buildscript.classpath", "settings.classpath"])("removes a floor declared on %s, which resolves before projects are evaluated", async (location) => {
    const file = join(root, `removal-${location}.json`);
    await writeFile(file, JSON.stringify({ repositoryRoot: build, floors: [{ package: "fixture:t", version: "2.0", advisories: ["GHSA-t"], locations: [location] }] }));
    const inventory = await runGradleInventory(build, ["."], "worktree", runProcess, { additionalInitScripts: [REMOVE_FLOORS], systemProperties: { "supplyChain.removeFloors.file": file } });
    expect(at(inventory, location)).toEqual({ resolved: ["plugin-lib:1.0", "t:1.0"], declared: ["plugin-lib:1.0"] });
    // The other classpath keeps its floor.
    const other = location === "settings.classpath" ? ":buildscript.classpath" : "settings.classpath";
    expect(at(inventory, other)).toEqual({ resolved: ["plugin-lib:1.0", "t:2.0"], declared: ["plugin-lib:1.0", "t:2.0"] });
  }, 600_000);
});
