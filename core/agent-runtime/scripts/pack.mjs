// Packs @leanish/agent-runtime for npm as compiled JavaScript plus declarations. The in-repo manifest keeps exporting
// src, which the tools run directly with Node's type stripping, so the published manifest is generated in a staging
// directory outside the checkout instead.
//
// Usage: node scripts/pack.mjs [--version <version>] [--out <directory>]
// The version defaults to the repository's (the root package.json); the tarball's path is printed on stdout.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const ROOT = resolve(PACKAGE_DIR, "..", "..");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

/** Each in-repo export `./src/x.ts` becomes `./dist/x.js` with its declarations, so the two maps can't drift apart. */
function publishedExports(exports) {
  return Object.fromEntries(Object.entries(exports).map(([subpath, target]) => {
    const module = /^\.\/src\/(.+)\.ts$/.exec(target)?.[1];
    if (module === undefined) throw new Error(`${subpath}: expected an export of ./src/<module>.ts, got ${target}`);
    return [subpath, { types: `./dist/${module}.d.ts`, default: `./dist/${module}.js` }];
  }));
}

function publishedManifest(manifest, version) {
  const { name, private: _private, version: _version, scripts: _scripts, devDependencies: _devDependencies, exports, ...kept } = manifest;
  // The declarations name Node's types (`NodeJS.WritableStream`), so a consumer's compiler needs them too.
  const peerDependencies = { "@types/node": ">=24" };
  return { name, version, ...kept, peerDependencies, files: ["dist", "guard", "PROVENANCE.md"], exports: publishedExports(exports) };
}

function build(outDir) {
  // TypeScript 7's package exports don't expose bin/, so it's found next to its package.json.
  const tsc = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc");
  execFileSync(process.execPath, [tsc, "--project", join(PACKAGE_DIR, "tsconfig.build.json"), "--outDir", outDir], {
    // tsc reports on stdout, which carries only the tarball's path.
    stdio: ["ignore", process.stderr, "inherit"],
  });
}

function pack(stagingDir, outDir) {
  const output = execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", outDir], {
    cwd: stagingDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  return join(outDir, JSON.parse(output)[0].filename);
}

const { values } = parseArgs({ options: { version: { type: "string" }, out: { type: "string" } } });
const version = values.version ?? readJson(join(ROOT, "package.json")).version;
const outDir = resolve(values.out ?? mkdtempSync(join(tmpdir(), "agent-runtime-tarball-")));
const stagingDir = mkdtempSync(join(tmpdir(), "agent-runtime-staging-"));
try {
  build(join(stagingDir, "dist"));
  // cpSync keeps file modes, so the guards stay executable.
  cpSync(join(PACKAGE_DIR, "guard"), join(stagingDir, "guard"), { recursive: true });
  for (const file of ["README.md", "PROVENANCE.md"]) cpSync(join(PACKAGE_DIR, file), join(stagingDir, file));
  cpSync(join(ROOT, "LICENSE"), join(stagingDir, "LICENSE"));
  writeFileSync(join(stagingDir, "package.json"), `${JSON.stringify(publishedManifest(readJson(join(PACKAGE_DIR, "package.json")), version), null, 2)}\n`);
  mkdirSync(outDir, { recursive: true });
  console.log(pack(stagingDir, outDir));
} finally {
  rmSync(stagingDir, { recursive: true, force: true });
}
