import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { clean } from "../scripts/clean.mjs";

const KEPT = [
  "package.json",
  "package-lock.json",
  ".claude/settings.local.json",
  "core/gate/package.json",
  "core/gate/src/gate.ts",
  "core/gate/node_modules/dep/index.js",
  "tool/package.json",
  "tool/test/coverage/fixture.json",
  "node_modules/dep/index.js",
  "old/coverage/index.html",
];
const GENERATED = [
  "coverage/index.html",
  "node_modules/.vite/vitest/results.json",
  "node_modules/.vite-temp/config.mjs",
  "core/gate/coverage/lcov.info",
  "core/gate/node_modules/.vite/vitest/results.json",
  "tool/node_modules/.vite-temp/config.mjs",
];

function workspace(workspaces = ["core/*", "tool"]) {
  const root = mkdtempSync(join(tmpdir(), "clean-"));
  for (const file of [...KEPT, ...GENERATED]) {
    mkdirSync(join(root, dirname(file)), { recursive: true });
    writeFileSync(join(root, file), file === "package.json" ? JSON.stringify({ workspaces }) : "{}");
  }
  mkdirSync(join(root, "core", "no-manifest", "coverage"), { recursive: true });
  return root;
}

const present = (root, files) => files.filter((file) => existsSync(join(root, file)));

test("clean removes generated outputs of the root and its workspaces and keeps everything else", (t) => {
  const root = workspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  clean(root);
  assert.deepEqual(present(root, GENERATED), []);
  assert.deepEqual(present(root, KEPT), KEPT);
  assert.ok(existsSync(join(root, "core", "no-manifest", "coverage")), "a directory without package.json isn't a workspace");
});

test("clean is idempotent", (t) => {
  const root = workspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const removed = ["coverage", "node_modules/.vite", "node_modules/.vite-temp", "core/gate/coverage", "core/gate/node_modules/.vite", "tool/node_modules/.vite-temp"];
  assert.deepEqual(clean(root).sort(), removed.map((target) => join(root, target)).sort());
  assert.deepEqual(clean(root), []);
  assert.deepEqual(present(root, KEPT), KEPT);
});

test("clean with deps also removes node_modules and keeps sources, manifests and lockfiles", (t) => {
  const root = workspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  clean(root, { deps: true });
  const dependencies = KEPT.filter((file) => file.includes("node_modules"));
  assert.deepEqual(present(root, [...GENERATED, ...dependencies]), []);
  assert.deepEqual(present(root, KEPT), KEPT.filter((file) => !dependencies.includes(file)));
  assert.deepEqual(clean(root, { deps: true }), []);
});

test("clean refuses workspaces outside the root, through a parent path or a symbolic link", (t) => {
  const outside = mkdtempSync(join(tmpdir(), "clean-outside-"));
  const root = workspace(["../*", "linked"]);
  t.after(() => [root, outside].forEach((directory) => rmSync(directory, { recursive: true, force: true })));
  mkdirSync(join(outside, "coverage"));
  writeFileSync(join(outside, "package.json"), "{}");
  assert.throws(() => clean(root), /workspaces outside/);
  writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: ["linked"] }));
  symlinkSync(outside, join(root, "linked"));
  assert.throws(() => clean(root), /workspaces outside/);
  assert.ok(existsSync(join(outside, "coverage")));
});

test("the command rejects unknown arguments before removing anything", () => {
  const script = fileURLToPath(new URL("../scripts/clean.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "--all"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage: node scripts\/clean.mjs \[--deps\] \(unknown: --all\)/);
});
