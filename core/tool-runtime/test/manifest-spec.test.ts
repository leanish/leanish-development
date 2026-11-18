import { describe, expect, it } from "vitest";

import { withOverride } from "../src/manifest-spec.ts";

describe("withOverride", () => {
  it("rewrites only the top-level override, keeping npm's formatting", () => {
    const text = `${JSON.stringify({ name: "app", dependencies: { lib: "11.0.1" }, overrides: { lib: "11.0.1" } }, null, 2)}\n`;
    const result = JSON.parse(withOverride(text, "lib", "11.0.1", "11.0.8", "package.json"));
    expect(result).toEqual({ name: "app", dependencies: { lib: "11.0.1" }, overrides: { lib: "11.0.8" } });
  });

  it("replaces the pair in place in a manifest npm wouldn't format that way", () => {
    const text = `{ "name": "app",\n  "overrides": { "lib":   "11.0.1" } }\n`;
    expect(withOverride(text, "lib", "11.0.1", "11.0.8", "package.json")).toBe(`{ "name": "app",\n  "overrides": { "lib":   "11.0.8" } }\n`);
  });

  it("refuses an in-place replacement that would change another field", () => {
    // The override's text is escaped, so the only literal match is another field with the same key and value.
    const text = `{"config":{"lib":"11.0.1"},"overrides":{"lib":"11.0.\\u0031"}}\n`;
    expect(() => withOverride(text, "lib", "11.0.1", "11.0.8", "package.json")).toThrow("package.json: replacing 'lib: 11.0.1' in place would change something else");
  });

  it("refuses an override that isn't there at that value", () => {
    const text = `${JSON.stringify({ overrides: { lib: "^11.0.1" } }, null, 2)}\n`;
    expect(() => withOverride(text, "lib", "11.0.1", "11.0.8", "package.json")).toThrow("package.json has no top-level override lib at '11.0.1'");
  });
});
