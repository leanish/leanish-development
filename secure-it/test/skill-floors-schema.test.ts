import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// The skill embeds the floors file's schema (the agent can't know our format otherwise, and Claude Code hides a
// skill's frontmatter): the copy must be the gate's own schema.
describe("secure-it skill", () => {
  it("embeds the gate's dependency-floors schema", () => {
    const skill = readFileSync(new URL("../skills/secure-it/SKILL.md", import.meta.url), "utf8");
    const section = skill.slice(skill.indexOf("## The floors file"));
    const block = /```json\n([\s\S]*?)\n```/.exec(section)?.[1];
    const schema = readFileSync(new URL("../../core/gate/dependency-floors.schema.json", import.meta.url), "utf8");
    expect(block).toBeDefined();
    expect(JSON.parse(block!)).toEqual(JSON.parse(schema));
  });
});
