// Lints regular expressions only: the gate and the tools run them on repository-controlled input (topics, lockfile
// paths, versions, advisory text), so an unsafe or wrong one is a bug. Types and style are left to tsc and review.
import regexp from "eslint-plugin-regexp";

import * as typescriptParser from "./eslint-typescript-parser.js";

export default [
  {
    files: ["**/*.ts", "**/*.mjs", "**/*.js"],
    linterOptions: { reportUnusedDisableDirectives: "error" },
    plugins: { regexp },
    rules: {
      // Safety: polynomial backtracking, or quadratic scanning when a match is searched for.
      "regexp/no-super-linear-backtracking": "error",
      "regexp/no-super-linear-move": "error",
      // Correctness: the plugin's "Possible Errors" rules.
      "regexp/no-contradiction-with-assertion": "error",
      "regexp/no-control-character": "error",
      "regexp/no-dupe-disjunctions": "error",
      "regexp/no-empty-alternative": "error",
      "regexp/no-empty-capturing-group": "error",
      "regexp/no-empty-character-class": "error",
      "regexp/no-empty-group": "error",
      "regexp/no-empty-lookarounds-assertion": "error",
      "regexp/no-escape-backspace": "error",
      "regexp/no-invalid-regexp": "error",
      "regexp/no-lazy-ends": "error",
      "regexp/no-misleading-capturing-group": "error",
      "regexp/no-misleading-unicode-character": "error",
      "regexp/no-missing-g-flag": "error",
      "regexp/no-optional-assertion": "error",
      "regexp/no-potentially-useless-backreference": "error",
      "regexp/no-useless-assertions": "error",
      "regexp/no-useless-backreference": "error",
      "regexp/no-useless-dollar-replacements": "error",
      "regexp/strict": "error",
    },
  },
  {
    files: ["**/*.ts"],
    languageOptions: { parser: typescriptParser },
  },
];
