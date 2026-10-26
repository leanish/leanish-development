import assert from "node:assert/strict";
import { globSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { parseSync } from "rolldown/utils";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const readManifest = (directory) => JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));

function repositoryFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (["node_modules", ".git"].includes(entry.name)) return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "fixtures" && relative(ROOT, directory).split(sep).some((part) => ["test", "tests"].includes(part))) return [];
      return repositoryFiles(path);
    }
    return entry.isFile() ? [path] : [];
  });
}

function workspaceProblems(packages, workspaces) {
  const problems = [];
  for (const [directory, manifest] of packages) {
    if (!workspaces.includes(directory)) problems.push(`${directory}: missing from workspaces`);
    if (typeof manifest.scripts?.check !== "string" || manifest.scripts.check.trim() === "") problems.push(`${directory}: missing check script`);
  }
  for (const directory of workspaces) {
    if (!packages.has(directory)) problems.push(`${directory}: workspace has no package.json`);
  }
  return problems;
}

// Parse TypeScript directly so type-only imports stay visible and examples inside comments/strings are ignored.
function moduleSpecifiers(source, filename = "module.ts") {
  const parsed = parseSync(filename, source);
  assert.deepEqual(parsed.errors, [], filename);
  const specifiers = [];
  function visit(node) {
    if (node === null || typeof node !== "object") return;
    let source;
    if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration", "ImportExpression", "TSImportType"].includes(node.type)) source = node.source;
    if (node.type === "TSExternalModuleReference") source = node.expression;
    if (node.type === "CallExpression") {
      const callee = node.callee;
      const member = callee.type === "MemberExpression";
      const mock = member && ["vi", "vitest"].includes(callee.object.name) && ["mock", "doMock", "importActual", "importMock"].includes(callee.property.name);
      const resolver = member && callee.property.name === "resolve" && (callee.object.name === "require" || callee.object.type === "MetaProperty");
      if (callee.name === "require" || mock || resolver) source = node.arguments[0];
    }
    if (source?.type === "Literal" && typeof source.value === "string") specifiers.push(source.value);
    if (source?.type === "TemplateLiteral" && source.expressions.length === 0) specifiers.push(source.quasis[0].value.cooked);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value !== null && typeof value === "object") visit(value);
    }
  }
  visit(parsed.program);
  return specifiers;
}

function relativeImportProblem(directory, file, specifier) {
  if (!specifier.startsWith(".")) return undefined;
  const target = resolve(dirname(file), specifier);
  if (target !== directory && !target.startsWith(`${directory}${sep}`)) return `${file}: relative import leaves its package: ${specifier}`;
  return undefined;
}

const ALLOWED = {
  "@leanish/agent-runtime": [],
  "@leanish/gate": [],
  "@leanish/tool-runtime": ["@leanish/agent-runtime", "@leanish/gate"],
  "@leanish/setup": ["@leanish/tool-runtime", "@leanish/gate"],
  "@leanish/bump-it": ["@leanish/agent-runtime", "@leanish/gate", "@leanish/tool-runtime"],
  "@leanish/secure-it": ["@leanish/agent-runtime", "@leanish/gate", "@leanish/tool-runtime"],
};

// Published packages' public API that may have no consumer in this repository; every other export needs one.
const PUBLIC_EXPORTS = {
  "@leanish/agent-runtime": ["./guard-dir"],
};

function directionProblem(source, target, testFile = false) {
  if (target === "@leanish/setup" && testFile && source !== target) return undefined;
  return ALLOWED[source]?.includes(target) ? undefined : `${source} must not import ${target}`;
}

const files = repositoryFiles(ROOT);
const packages = new Map(files.filter((file) => file !== join(ROOT, "package.json") && file.endsWith(`${sep}package.json`))
  .map((file) => [dirname(file), readManifest(dirname(file))]));
const workspaces = readManifest(ROOT).workspaces.flatMap((pattern) => globSync(pattern, { cwd: ROOT }).map((directory) => resolve(ROOT, directory)));
const imports = files.filter((file) => /\.(?:[cm]?[jt]s|[jt]sx)$/.test(extname(file))).flatMap((file) => {
  const directory = [...packages.keys()].find((directory) => file.startsWith(`${directory}${sep}`));
  if (directory === undefined) return [];
  return moduleSpecifiers(readFileSync(file, "utf8"), file).map((specifier) => ({ file, directory, specifier }));
});

test("every package is a workspace with a check script", () => {
  assert.deepEqual(workspaceProblems(packages, workspaces), []);
});

test("package imports never cross a boundary by relative path", () => {
  assert.deepEqual(imports.map(({ directory, file, specifier }) => relativeImportProblem(directory, file, specifier)).filter(Boolean), []);
});

test("package imports follow the dependency direction and declare their dependencies", () => {
  const problems = [];
  for (const { file, directory, specifier } of imports) {
    if (!specifier.startsWith("@leanish/")) continue;
    const source = packages.get(directory);
    const target = specifier.split("/").slice(0, 2).join("/");
    const testFile = relative(directory, file).split(sep).some((part) => ["test", "tests"].includes(part));
    const problem = directionProblem(source.name, target, testFile);
    if (problem !== undefined) problems.push(`${file}: ${problem}`);
    if (source.dependencies?.[target] !== "0.0.0" && source.devDependencies?.[target] !== "0.0.0") problems.push(`${file}: undeclared workspace dependency ${target}`);
  }
  assert.deepEqual(problems, []);
});

test("exports list exactly the TypeScript modules consumed by other packages, plus the named public API", () => {
  for (const [directory, manifest] of packages) {
    const consumed = new Set(imports.filter((entry) => entry.directory !== directory && entry.specifier.startsWith(`${manifest.name}/`))
      .map((entry) => `.${entry.specifier.slice(manifest.name.length)}`));
    for (const subpath of PUBLIC_EXPORTS[manifest.name] ?? []) consumed.add(subpath);
    assert.deepEqual(Object.keys(manifest.exports).sort(), [...consumed].sort(), manifest.name);
    for (const [subpath, target] of Object.entries(manifest.exports)) {
      assert.ok(target.startsWith("./") && target.endsWith(".ts") && !target.includes("*"), `${manifest.name}/${subpath}: explicit TypeScript source required`);
      assert.equal(relativeImportProblem(directory, join(directory, "package.json"), target), undefined);
      readFileSync(resolve(directory, target));
    }
    assert.equal(manifest.private, true, manifest.name);
    assert.equal(manifest.version, "0.0.0", manifest.name);
  }
});

test("workspace guard rejects omitted packages and missing check scripts", () => {
  const sample = new Map([["core/gate", { scripts: { check: "npm test" } }], ["new-tool", {}]]);
  assert.deepEqual(workspaceProblems(sample, ["core/gate"]), ["new-tool: missing from workspaces", "new-tool: missing check script"]);
  assert.deepEqual(workspaceProblems(new Map(), ["missing-tool"]), ["missing-tool: workspace has no package.json"]);
  assert.deepEqual(workspaceProblems(new Map([["empty", { scripts: { check: " " } }]]), ["empty"]), ["empty: missing check script"]);
});

test("import scanning covers static, type-only, dynamic, re-export and mocked modules", () => {
  const source = [
    'import "./side-effect.ts";',
    'import { value } from "./value.ts";',
    'import type { Value } from "./type.ts";',
    'export type { Value } from "./export.ts";',
    'const load = import("./dynamic.ts");',
    'type Loaded = import("./dynamic-type.ts").Value;',
    'const required = require("./required.cjs");',
    'vi.mock("./mock.ts");',
    'vi.doMock("./do-mock.ts");',
    'vi.importActual("./actual.ts");',
    'import.meta.resolve("./resolved.ts");',
    '// import "./comment.ts";',
    '/* export * from "./comment-export.ts"; */',
    'const example = \'import "./example.ts";\';',
  ].join("\n");
  assert.deepEqual(moduleSpecifiers(source), ["./side-effect.ts", "./value.ts", "./type.ts", "./export.ts", "./dynamic.ts", "./dynamic-type.ts", "./required.cjs", "./mock.ts", "./do-mock.ts", "./actual.ts", "./resolved.ts"]);
});

test("relative boundary guard rejects sibling packages and paths through parents", () => {
  const directory = join(ROOT, "bump-it");
  const file = join(directory, "src", "cli.ts");
  assert.equal(relativeImportProblem(directory, file, "./plan.ts"), undefined);
  assert.equal(relativeImportProblem(directory, file, "../test/fixtures.ts"), undefined);
  assert.equal(relativeImportProblem(directory, file, "@leanish/gate/process"), undefined);
  assert.match(relativeImportProblem(directory, file, "../../secure-it/src/cli.ts"), /relative import leaves its package/);
  assert.match(relativeImportProblem(directory, file, "../../core/gate/src/process.ts"), /relative import leaves its package/);
});

test("direction guard rejects reverse dependencies, tool-to-tool imports and package self-imports", () => {
  const forbidden = [
    ["@leanish/gate", "@leanish/agent-runtime"],
    ["@leanish/gate", "@leanish/tool-runtime"],
    ["@leanish/agent-runtime", "@leanish/gate"],
    ["@leanish/agent-runtime", "@leanish/tool-runtime"],
    ["@leanish/tool-runtime", "@leanish/bump-it"],
    ["@leanish/tool-runtime", "@leanish/secure-it"],
    ["@leanish/bump-it", "@leanish/secure-it"],
    ["@leanish/secure-it", "@leanish/bump-it"],
    ["@leanish/new-tool", "@leanish/gate"],
  ];
  for (const [source, target] of forbidden) assert.match(directionProblem(source, target), /must not import/);
  for (const source of Object.keys(ALLOWED)) assert.match(directionProblem(source, source), /must not import/);
  for (const source of ["@leanish/tool-runtime", "@leanish/bump-it", "@leanish/secure-it"]) {
    for (const target of ["@leanish/gate", "@leanish/agent-runtime"]) assert.equal(directionProblem(source, target), undefined);
  }
  for (const tool of ["@leanish/bump-it", "@leanish/secure-it"]) assert.equal(directionProblem(tool, "@leanish/tool-runtime"), undefined);
});

test("setup can consume only the tool runtime and gate; only tests may consume setup", () => {
  for (const source of Object.keys(ALLOWED)) {
    assert.match(directionProblem(source, "@leanish/setup"), /must not import/);
    if (source !== "@leanish/setup") assert.equal(directionProblem(source, "@leanish/setup", true), undefined);
  }
  for (const target of ["@leanish/tool-runtime", "@leanish/gate"]) assert.equal(directionProblem("@leanish/setup", target), undefined);
  for (const target of ["@leanish/agent-runtime", "@leanish/bump-it", "@leanish/secure-it"]) assert.match(directionProblem("@leanish/setup", target), /must not import/);
});
