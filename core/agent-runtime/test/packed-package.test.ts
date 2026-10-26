// The package as npm would publish it: packed by scripts/pack.mjs, installed into a consumer outside this repository,
// then loaded by plain Node and type-checked against its declarations.
import { execFileSync, spawnSync } from "node:child_process";
import { globSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { guardDir } from "../src/guard-dir.ts";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const NAME = "@leanish/agent-runtime";
const require = createRequire(import.meta.url);
const repoExports: Record<string, string> = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")).exports;
const subpaths = Object.keys(repoExports).sort();

let workDir: string;
let tarball: string;
let installed: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "agent-runtime-packed-"));
  tarball = execFileSync(process.execPath, [join(PACKAGE_DIR, "scripts", "pack.mjs"), "--out", join(workDir, "tarball")], {
    encoding: "utf8",
  }).trim();
  const consumer = join(workDir, "consumer");
  mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }));
  // ajv and yaml come from the npm cache that installing this repository filled, so no registry is needed.
  execFileSync("npm", ["install", "--prefer-offline", "--no-audit", "--no-fund", tarball], { cwd: consumer, stdio: ["ignore", "ignore", "inherit"] });
  installed = realpathSync(join(consumer, "node_modules", ...NAME.split("/")));
}, 120_000);

afterAll(() => {
  if (workDir !== undefined) rmSync(workDir, { recursive: true, force: true });
});

describe("guardDir", () => {
  it("points at this package's guard directory when run from src", () => {
    expect(guardDir()).toBe(join(PACKAGE_DIR, "guard"));
  });
});

describe("the packed package", () => {
  it("contains the compiled modules, the guards and the docs, and no sources or tests", () => {
    const modules = globSync("**/*.ts", { cwd: join(PACKAGE_DIR, "src") }).map((file) => file.slice(0, -".ts".length));
    const expected = [
      "package.json",
      "LICENSE",
      "README.md",
      "PROVENANCE.md",
      "guard/gh",
      "guard/git",
      "guard/lib.sh",
      ...modules.flatMap((module) => [`dist/${module}.js`, `dist/${module}.d.ts`]),
    ];
    const listed = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).trim().split("\n");
    expect(listed.map((entry) => entry.replace(/^package\//, "")).sort()).toEqual(expected.sort());
  });

  it("publishes every in-repo export as compiled JavaScript with declarations", () => {
    const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
    expect(manifest.private).toBeUndefined();
    expect(manifest.version).toBe(JSON.parse(readFileSync(join(PACKAGE_DIR, "..", "..", "package.json"), "utf8")).version);
    expect(manifest.devDependencies).toBeUndefined();
    expect(manifest.scripts).toBeUndefined();
    // Its declarations name Node's types, so a consumer's compiler gets them through this peer.
    expect(manifest.peerDependencies).toEqual({ "@types/node": ">=24" });
    expect(Object.keys(manifest.exports).sort()).toEqual(subpaths);
    for (const subpath of subpaths) {
      const module = repoExports[subpath]!.replace(/^\.\/src\//, "").replace(/\.ts$/, "");
      expect(manifest.exports[subpath]).toEqual({ types: `./dist/${module}.d.ts`, default: `./dist/${module}.js` });
    }
  });

  it("loads every export with plain Node, with the same runtime exports as the sources", async () => {
    const script = `
const subpaths = ${JSON.stringify(subpaths)};
const loaded = {};
for (const subpath of subpaths) loaded[subpath] = Object.keys(await import(${JSON.stringify(NAME)} + subpath.slice(1))).sort();
const { guardDir } = await import(${JSON.stringify(`${NAME}/guard-dir`)});
console.log(JSON.stringify({ loaded, guardDir: guardDir() }));
`;
    const consumer = join(workDir, "consumer");
    writeFileSync(join(consumer, "load.mjs"), script);
    const result = JSON.parse(execFileSync(process.execPath, ["load.mjs"], { cwd: consumer, encoding: "utf8" }));
    for (const subpath of subpaths) {
      const source: Record<string, unknown> = await import(join(PACKAGE_DIR, repoExports[subpath]!));
      expect(result.loaded[subpath], subpath).toEqual(Object.keys(source).sort());
    }
    expect(result.guardDir).toBe(join(installed, "guard"));
  });

  it("ships the guards executable", () => {
    for (const guard of ["gh", "git"]) expect(statSync(join(installed, "guard", guard)).mode & 0o100, guard).toBe(0o100);
  });

  it("type-checks a consumer against its declarations", () => {
    const consumer = join(workDir, "consumer");
    const imports = subpaths.map((subpath, index) => `import * as module${index} from "${NAME}${subpath.slice(1)}";`);
    writeFileSync(join(consumer, "consumer.ts"), `${imports.join("\n")}
import { guardDir } from "${NAME}/guard-dir";
import { FakeCodingAgentRunner } from "${NAME}/skill/fake-runner";
import type { CodingAgentRunner } from "${NAME}/skill/runner";
import type { Logger } from "${NAME}/types/logger";
import { assertRepoSourceId, type RepoSource } from "${NAME}/types/repo-source";
import { parseModelPrices, type ModelPriceTable } from "${NAME}/usage/model-prices";

export const modules = [${subpaths.map((_, index) => `module${index}`).join(", ")}];
export const guards: string = guardDir();
export const runner: CodingAgentRunner = new FakeCodingAgentRunner("codex");
export const prices: ModelPriceTable = parseModelPrices({}, "consumer");
const source: RepoSource = { id: "owner/repo", source: { url: "https://example.invalid/owner/repo.git", branch: "main" } };
assertRepoSourceId(source.id);
export function log(logger: Logger): Logger {
  return logger.with({ repo: source.id });
}
// @ts-expect-error A RepoSource needs its source; this fails only while the declarations are really checked.
export const incomplete: RepoSource = { id: "owner/repo" };
`);
    const typeRoots = dirname(dirname(require.resolve("@types/node/package.json")));
    writeFileSync(join(consumer, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        target: "ES2024",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        skipLibCheck: false,
        noEmit: true,
        // The consumer would install @types/node itself; this repository's copy stands in for it.
        types: ["node"],
        typeRoots: [typeRoots],
      },
      files: ["consumer.ts"],
    }));
    const tsc = join(dirname(require.resolve("typescript/package.json")), "bin", "tsc");
    const check = spawnSync(process.execPath, [tsc, "--project", join(consumer, "tsconfig.json")], { cwd: consumer, encoding: "utf8" });
    expect(check.stdout + check.stderr).toBe("");
    expect(check.status).toBe(0);
  });
});
