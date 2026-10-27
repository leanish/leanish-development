// ESLint's parser for this repository's TypeScript: Node strips the types (every workspace's tsconfig sets
// erasableSyntaxOnly), then espree parses the JavaScript left. Stripping blanks each type out with whitespace, so every
// line and column ESLint reports is the original file's. typescript-eslint's parser isn't used: it doesn't run on
// TypeScript 7. Only rules that read JavaScript (the regex lint) can run on this: types are gone.
import { stripTypeScriptTypes } from "node:module";

import * as espree from "espree";

export const meta = { name: "eslint-typescript-parser" };

const STRIP_WARNING = "stripTypeScriptTypes is an experimental feature";

/** The JavaScript left once the types are blanked out; throws on syntax that isn't erasable (an enum) or doesn't parse. */
function stripTypes(code) {
  // Node warns once per process that stripTypeScriptTypes is experimental, synchronously from the first call: that one
  // warning is dropped while the call runs, and every other warning still goes through.
  const emitWarning = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    const type = typeof rest[0] === "object" && rest[0] !== null ? rest[0].type : rest[0];
    const message = typeof warning === "string" ? warning : warning?.message;
    if (type === "ExperimentalWarning" && typeof message === "string" && message.startsWith(STRIP_WARNING)) return;
    return emitWarning.call(this, warning, ...rest);
  };
  try {
    return stripTypeScriptTypes(code, { mode: "strip" });
  } finally {
    process.emitWarning = emitWarning;
  }
}

export function parseForESLint(code) {
  const ast = espree.parse(stripTypes(code), {
    ecmaVersion: "latest",
    sourceType: "module",
    range: true,
    loc: true,
    tokens: true,
    comment: true,
  });
  return { ast };
}
