import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { ESLint } from "eslint";

import { parseForESLint } from "../eslint-typescript-parser.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// The repository's own eslint.config.js, on a path its TypeScript block matches; the file needn't exist.
const eslint = new ESLint({ cwd: ROOT });
const FILE = join(ROOT, "core/gate/src/lint-fixture.ts");

async function lint(source) {
  const [result] = await eslint.lintText(source, { filePath: FILE });
  return result.messages;
}

/** 1-based line and column of `needle` in `source`, as ESLint reports them. */
function position(source, needle) {
  const lines = source.split("\n");
  const line = lines.findIndex((text) => text.includes(needle));
  assert.notEqual(line, -1, needle);
  return { line: line + 1, column: lines[line].indexOf(needle) + 1 };
}

test("finds a super-linear regex in typed TypeScript through the repository's config", async () => {
  const source = [
    "interface Box<T> { readonly value: T }",
    "const pick = <T,>(box: Box<T>): T => box.value;",
    "export const r: RegExp = pick<RegExp>({ value: /(a+)+$/ });",
    "",
  ].join("\n");
  const messages = await lint(source);
  assert.ok(messages.length > 0);
  assert.ok(messages.every((message) => message.ruleId?.startsWith("regexp/") && message.severity === 2), JSON.stringify(messages));
  const backtracking = messages.find((message) => message.ruleId === "regexp/no-super-linear-backtracking");
  // At the original line and column: the types stripped before the regex leave its position unchanged.
  assert.deepEqual({ line: backtracking?.line, column: backtracking?.column }, position(source, "a+)+$"));
});

test("applies disable directives and reports an unused one", async () => {
  const source = [
    "// eslint-disable-next-line regexp/no-super-linear-backtracking, regexp/no-super-linear-move, regexp/no-misleading-capturing-group -- fixture",
    "export const a: RegExp = /(a+)+$/;",
    "// eslint-disable-next-line regexp/no-super-linear-move -- fixture",
    "export const b: string = 'x';",
    "",
  ].join("\n");
  const messages = await lint(source);
  assert.equal(messages.length, 1, JSON.stringify(messages));
  assert.equal(messages[0].line, 3);
  assert.equal(messages[0].severity, 2);
  assert.match(messages[0].message, /^Unused eslint-disable directive/);
});

test("reports syntax that isn't erasable, or doesn't parse, as a parsing error", async () => {
  for (const [source, reason] of [
    ["export enum Kind { A }\n", /enum is not supported in strip-only mode/],
    ["export const = 1;\n", /Unexpected token/],
  ]) {
    assert.throws(() => parseForESLint(source), reason);
    const messages = await lint(source);
    assert.equal(messages.length, 1, JSON.stringify(messages));
    assert.equal(messages[0].fatal, true);
    assert.match(messages[0].message, reason);
  }
});

test("drops only stripTypeScriptTypes' experimental warning", () => {
  const parser = new URL("../eslint-typescript-parser.js", import.meta.url).href;
  const script = [
    `const { parseForESLint } = await import(${JSON.stringify(parser)});`,
    'parseForESLint("const a: number = 1;");',
    'process.emitWarning("another experiment", "ExperimentalWarning");',
  ].join("\n");
  const run = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /ExperimentalWarning: another experiment/);
  assert.doesNotMatch(run.stderr, /stripTypeScriptTypes/);
});
