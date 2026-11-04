import { describe, expect, it } from "vitest";

import { withPlannedDependencyFields } from "../src/npm-file-checks.ts";

describe("withPlannedDependencyFields", () => {
  const current = `{\n    "name": "app",\n    "scripts": { "test": "vitest" },\n    "dependencies": { "lib": "^1.0.0" },\n    "overrides": { "old": "1.0.0" }\n}\n`;

  it("keeps the current bytes when the planned dependency fields are what it already has", () => {
    const planned = JSON.stringify({ name: "elsewhere", dependencies: { lib: "^1.0.0" }, overrides: { old: "1.0.0" } });
    expect(withPlannedDependencyFields(current, planned)).toBe(current);
  });

  it("takes the planned dependency fields, removes the ones it lacks, and keeps everything else and the formatting", () => {
    const planned = JSON.stringify({ name: "elsewhere", scripts: { test: "jest" }, dependencies: { lib: "^1.2.0" }, devDependencies: { tool: "2.0.0" } });
    expect(withPlannedDependencyFields(current, planned)).toBe(
      `{\n    "name": "app",\n    "scripts": {\n        "test": "vitest"\n    },\n    "dependencies": {\n        "lib": "^1.2.0"\n    },\n    "devDependencies": {\n        "tool": "2.0.0"\n    }\n}\n`,
    );
  });

  it("keeps CRLF line endings and a missing final newline", () => {
    const crlf = `{\r\n  "dependencies": {\r\n    "lib": "^1.0.0"\r\n  }\r\n}`;
    expect(withPlannedDependencyFields(crlf, JSON.stringify({ dependencies: { lib: "^2.0.0" } }))).toBe(`{\r\n  "dependencies": {\r\n    "lib": "^2.0.0"\r\n  }\r\n}`);
  });

  it("fails on a manifest that isn't JSON, rather than writing over it", () => {
    expect(() => withPlannedDependencyFields("{ not json", JSON.stringify({ dependencies: {} }))).toThrow(SyntaxError);
    expect(() => withPlannedDependencyFields(current, "{ not json")).toThrow(SyntaxError);
  });
});
