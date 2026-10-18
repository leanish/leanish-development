import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { SETUP_COMMANDS } from "../src/contracts.ts";
import { USAGE } from "../src/arguments.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const names = ["install-bump-it", "install-secure-it", "add-repository"];

describe("project installer skills", () => {
  it.each(names)("keeps the Claude and Codex copies of %s identical", (name) => {
    const claude = readFileSync(resolve(root, `.claude/skills/${name}/SKILL.md`), "utf8");
    expect(readFileSync(resolve(root, `.agents/skills/${name}/SKILL.md`), "utf8")).toBe(claude);
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(claude)?.[1];
    expect(frontmatter).toBeDefined();
    expect(parse(frontmatter!)).toMatchObject({ name, description: expect.any(String) });
    const link = /\]\(([^)]+install\.md)\)/.exec(claude)?.[1];
    expect(link).toBeDefined();
    expect(existsSync(resolve(root, `.claude/skills/${name}`, link!))).toBe(true);
  });

  it("mentions only existing CLI commands in skills and their shared workflow", () => {
    const files = ["core/setup/install.md", ...names.map((name) => `.claude/skills/${name}/SKILL.md`)];
    const mentioned = new Set(files.flatMap((path) => [...readFileSync(resolve(root, path), "utf8").matchAll(/node core\/setup\/src\/cli\.ts ([a-z-]+)/g)].map((match) => match[1]!)));
    expect(mentioned.size).toBeGreaterThan(1);
    for (const command of mentioned) {
      expect(SETUP_COMMANDS).toContain(command);
      expect(USAGE).toMatch(new RegExp(`\\n  ${command}(?: |\\n)`));
    }
  });

});
