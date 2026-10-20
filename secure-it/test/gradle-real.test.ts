import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { SecurityFix } from "@leanish/gate/candidates";
import { parseConfig } from "@leanish/gate/config";
import type { GateEnvironment } from "@leanish/gate/gate";
import { gradleLocation, type GradleInventory, runGradleInventory } from "@leanish/gate/gradle";
import { gradleSourceIndex } from "@leanish/gate/gradle-sources";
import { runProcess, type RunProcess } from "@leanish/gate/process";
import { workingTree } from "@leanish/gate/tree";
import { fakeFetch } from "@leanish/gate/test/fake-fetch";
import type { GradleTransform } from "@leanish/tool-runtime/inventories";
import { withGradleParents } from "../src/gradle-parents.ts";
import { planFor } from "../src/plan.ts";

// secure-it's real-Gradle suites share this file on purpose: vitest runs files in parallel, and two real Gradle
// builds at once made one time out connecting to its daemon in CI. Suites of one file run one after the other.
const WRAPPER = fileURLToPath(new URL("../../core/gate/test/fixtures/gradle-wrapper", import.meta.url));
const REMOVE_FLOORS = fileURLToPath(new URL("../gradle/remove-floors.init.gradle", import.meta.url));

/** group:artifact:version → its dependencies, each a POM-only module. */
const MODULES: Record<string, string[]> = {
  "fixture:plugin-lib:1.0": ["fixture:t:1.0"],
  "fixture:t:1.0": [],
  "fixture:t:2.0": [],
  "fixture:tool:1.0": [],
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
    // Default dependencies, as plugins such as checkstyle give their tool's configuration.
    await write(build, "build.gradle", `${classpath}plugins { id "java" }
repositories { maven { url = uri("${repo}") } }
// tool also declares its default, lazily as checkstyle's users do; defaultTool relies on it; inheritedTool relies on it beside an inherited dependency;
// lateTool gets tool added after the floor removal ran.
def toolDefaults = { dependencies -> dependencies.add(project.dependencies.create("fixture:tool:1.0")) }
configurations {
  tool { defaultDependencies(toolDefaults) }
  defaultTool { defaultDependencies(toolDefaults) }
  toolParent
  inheritedTool { extendsFrom(toolParent); defaultDependencies(toolDefaults) }
  lateTool
}
// After the init script's own projectsEvaluated, where the floor removal runs.
gradle.projectsEvaluated { configurations.lateTool.dependencies.add(project.dependencies.create("fixture:tool:1.0")) }
dependencies {
  tool(providers.provider { "fixture:tool:1.0" })
  tool("fixture:plugin-lib:1.0")
  tool("fixture:t:2.0") { because("GHSA-t: plugin-lib brings a vulnerable t") }
  defaultTool("fixture:t:2.0") { because("GHSA-t: plugin-lib brings a vulnerable t") }
  toolParent("fixture:plugin-lib:1.0")
  inheritedTool("fixture:t:2.0") { because("GHSA-t: plugin-lib brings a vulnerable t") }
  lateTool("fixture:plugin-lib:1.0")
  lateTool("fixture:t:2.0") { because("GHSA-t: plugin-lib brings a vulnerable t") }
}
`);
    await write(build, "buildSrc/build.gradle", classpath);
  }, 600_000);

  afterAll(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  it.each([":buildscript.classpath", "settings.classpath", "buildSrc/:buildscript.classpath"])("removes a floor declared on %s, which resolves before projects are evaluated", async (location) => {
    const file = join(root, `removal-${location.replaceAll("/", "_")}.json`);
    await writeFile(file, JSON.stringify({ repositoryRoot: build, floors: [{ package: "fixture:t", version: "2.0", advisories: ["GHSA-t"], locations: [location] }] }));
    const inventory = await runGradleInventory(build, ["."], "worktree", runProcess, { additionalInitScripts: [REMOVE_FLOORS], systemProperties: { "supplyChain.removeFloors.file": file } });
    expect(at(inventory, location)).toEqual({ resolved: ["plugin-lib:1.0", "t:1.0"], declared: ["plugin-lib:1.0"] });
    // The other classpaths keep their floors.
    for (const other of [":buildscript.classpath", "settings.classpath", "buildSrc/:buildscript.classpath"].filter((each) => each !== location)) {
      expect(at(inventory, other)).toEqual({ resolved: ["plugin-lib:1.0", "t:2.0"], declared: ["plugin-lib:1.0", "t:2.0"] });
    }
  }, 600_000);

  // Once the floor goes, each configuration declares tool once: its own declaration, its default, or the late one.
  it.each([
    [":tool", ["plugin-lib:1.0", "tool:1.0"]],
    [":defaultTool", ["tool:1.0"]],
    [":inheritedTool", ["plugin-lib:1.0", "tool:1.0"]],
    [":lateTool", ["plugin-lib:1.0", "tool:1.0"]],
  ])("removes a floor from %s, declaring its tool once", async (location, declared) => {
    const file = join(root, `removal-${location.slice(1)}.json`);
    await writeFile(file, JSON.stringify({ repositoryRoot: build, floors: [{ package: "fixture:t", version: "2.0", advisories: ["GHSA-t"], locations: [location] }] }));
    const inventory = await runGradleInventory(build, ["."], "worktree", runProcess, { additionalInitScripts: [REMOVE_FLOORS], systemProperties: { "supplyChain.removeFloors.file": file } });
    const resolved = declared.includes("plugin-lib:1.0") ? ["plugin-lib:1.0", "t:1.0", "tool:1.0"] : ["tool:1.0"];
    expect(at(inventory, location)).toEqual({ resolved, declared });
  }, 600_000);
});

const CENTRAL = "https://repo1.maven.org/maven2";

/** group:artifact:version → its dependencies, each a POM-only module: d's versions bring x 1.0, 1.5 and 2.0. */
const PARENT_MODULES: Record<string, string[]> = {
  "fixture:d:1.0": ["fixture:x:1.0"],
  "fixture:d:1.1": ["fixture:x:1.5"],
  "fixture:d:1.2": ["fixture:x:2.0"],
  "fixture:x:1.0": [],
  "fixture:x:1.5": [],
  "fixture:x:2.0": [],
};
/** x below 2.0 has the advisory. */
const AFFECTED: Record<string, string[]> = { "fixture:x@1.0": ["GHSA-x"], "fixture:x@1.5": ["GHSA-x"] };

/** Fake osv-scanner from AFFECTED; d's versions listed and dated (all aged) as Maven Central would. */
function environment(): GateEnvironment {
  const run: RunProcess = async (command, args, options) => {
    if (command !== "osv-scanner") return runProcess(command, args, options);
    if (args[0] === "--version") return { code: 0, stdout: "osv-scanner version: 2.6.0\n", stderr: "" };
    const inventory = JSON.parse(await readFile(args[args.indexOf("--lockfile") + 1]!.replace(/^osv-scanner:/, ""), "utf8")) as {
      results: Array<{ packages: Array<{ package: { name: string; version: string; ecosystem: string } }> }>;
    };
    const packages = inventory.results[0]!.packages.map(({ package: pkg }) => ({
      package: pkg, vulnerabilities: (AFFECTED[`${pkg.name}@${pkg.version}`] ?? []).map((id) => ({ id, summary: id })),
    }));
    return { code: 1, stdout: JSON.stringify({ results: [{ packages }] }), stderr: "" };
  };
  const routes: Parameters<typeof fakeFetch>[0] = {
    [`${CENTRAL}/fixture/d/maven-metadata.xml`]: { text: "<metadata><versioning><versions><version>1.0</version><version>1.1</version><version>1.2</version></versions></versioning></metadata>" },
  };
  for (const coordinates of Object.keys(PARENT_MODULES)) {
    const [, artifact, version] = coordinates.split(":");
    routes[`${CENTRAL}/fixture/${artifact}/${version}/${artifact}-${version}.pom`] = { headers: { "last-modified": "Mon, 01 Jun 2026 00:00:00 GMT" }, text: "<project></project>" };
  }
  return { run, fetch: fakeFetch(routes), now: () => new Date("2026-10-10T12:00:00Z"), osvScanner: "osv-scanner", githubToken: undefined };
}

let parentsRoot: string;
let parentsBuild: string;

describe.skipIf(process.env["SUPPLY_CHAIN_GRADLE_TESTS"] !== "1")("Gradle parents, with real Gradle", () => {
  beforeAll(async () => {
    parentsRoot = await mkdtemp(join(tmpdir(), "secure-it-gradle-parents-"));
    const repo = join(parentsRoot, "repo");
    for (const [coordinates, dependencies] of Object.entries(PARENT_MODULES)) {
      const [group, artifact, version] = coordinates.split(":");
      await write(repo, `${group!.replaceAll(".", "/")}/${artifact}/${version}/${artifact}-${version}.pom`, pom(coordinates, dependencies));
    }
    parentsBuild = join(parentsRoot, "build");
    await cp(WRAPPER, parentsBuild, { recursive: true });
    await write(parentsBuild, "settings.gradle", `rootProject.name = "fixture"\n`);
    await write(parentsBuild, "build.gradle", `plugins { id "java" }
repositories { maven { url = uri("${repo}") } }
dependencies { implementation "fixture:d:1.0" }
`);
  }, 600_000);

  afterAll(async () => {
    if (parentsRoot !== undefined) await rm(parentsRoot, { recursive: true, force: true });
  });

  it("proves d's versions with real reference resolutions and moves it to the first that brings a fixed x", async () => {
    const base = await runGradleInventory(parentsBuild, ["."], "worktree", runProcess);
    const probes: string[] = [];
    // The tool's reference resolution, run unsandboxed on the fixture build.
    const inventories = {
      ofCommit: async (_tree: unknown, change?: { readonly transform?: GradleTransform }): Promise<GradleInventory> => {
        const transform = change!.transform!;
        const plan = join(parentsRoot, `plan-${probes.length}.json`);
        const content = transform.content(parentsBuild) as { moves: Array<{ to: string }> };
        probes.push(content.moves[0]!.to);
        await writeFile(plan, JSON.stringify(content));
        return runGradleInventory(parentsBuild, ["."], "worktree", runProcess, { additionalInitScripts: [transform.initScript], systemProperties: { [transform.property]: plan } });
      },
    };
    const tree = workingTree(parentsBuild);
    const { named } = await gradleSourceIndex(tree);
    const fix: SecurityFix = {
      ecosystem: "Maven", name: "fixture:x", from: "1.0", locations: [":compileClasspath", ":runtimeClasspath", ":testCompileClasspath", ":testRuntimeClasspath"],
      targets: ["GHSA-x"], unfixable: [], malicious: false, severity: "HIGH", to: { version: "2.0", line: "2", aged: true, major: true, blockers: [] }, problem: undefined,
    };
    const fixes = await withGradleParents([fix], { base: tree, gradle: base, named, inventories, env: environment(), config: parseConfig({}) });
    expect(probes).toEqual(["1.1", "1.2"]);
    const plan = await planFor(fixes, { named, lockfiles: new Map(), gradle: base, tagCommit: async () => undefined });
    expect(plan.moves).toEqual([expect.objectContaining({
      name: "fixture:d", from: "1.0", to: "1.2", mechanism: "gradle-declared",
      carries: [expect.objectContaining({ name: "fixture:x", from: ["1.0"], to: ["2.0"] })],
    })]);
  }, 600_000);
});
