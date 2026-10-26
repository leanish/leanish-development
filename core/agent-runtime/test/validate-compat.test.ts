// Adapted from leanish/leanish-development-incubator core/runtime/test/unit/validate-compat.test.ts at 17883e3; see
// PROVENANCE.md.
// Local changes: imports this package's modules from `../src/` instead of `../../src/`; the skills come as arguments
// instead of a descriptor, and the `buildRuntime` cases stay in the incubator; new cases for support skills, schema and
// load failures, and every issue reported.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RuntimeError } from "../src/errors.ts";
import { SkillLoader } from "../src/skill/skill-loader.ts";
import { SkillCompatibilityError, validateSkillsCompatibility } from "../src/skill/validate-compat.ts";

const SCHEMAS = `inputSchema:
  type: object
  required: [q]
  properties:
    q: { type: string }
outputSchema:
  type: object
  required: [a]
  properties:
    a: { type: string }
`;

async function writeSkill(dir: string, name: string, frontmatter: string): Promise<void> {
  await mkdir(join(dir, name), { recursive: true });
  await writeFile(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: test\n${frontmatter}---\n\n# ${name}\n`);
}

async function rejection(promise: Promise<void>): Promise<SkillCompatibilityError> {
  const error = await promise.then(() => undefined, (err: unknown) => err);
  expect(error).toBeInstanceOf(SkillCompatibilityError);
  return error as SkillCompatibilityError;
}

describe("validateSkillsCompatibility", () => {
  let skillsDir: string;
  let loader: SkillLoader;

  beforeAll(async () => {
    skillsDir = await mkdtemp(join(tmpdir(), "agent-runtime-compat-"));
    await writeSkill(skillsDir, "ask", `compatibleCodingAgents: [claude-code]\n${SCHEMAS}`);
    await writeSkill(skillsDir, "any", SCHEMAS);
    await writeSkill(skillsDir, "helper", "compatibleCodingAgents: [codex]\n");
    await writeSkill(skillsDir, "schemaless", "");
    loader = new SkillLoader({ skillsDirs: [skillsDir] });
  });

  afterAll(async () => {
    await rm(skillsDir, { recursive: true, force: true });
  });

  it("accepts skills whose allowlist includes the coding agent, or that have none", async () => {
    await expect(validateSkillsCompatibility({ codingAgent: "claude-code", entrypoints: ["ask", "any"], supportSkills: ["schemaless"] }, loader)).resolves.toBeUndefined();
  });

  it("rejects an entrypoint whose allowlist excludes the coding agent", async () => {
    const error = await rejection(validateSkillsCompatibility({ codingAgent: "codex", entrypoints: ["ask"], supportSkills: [] }, loader));
    expect(error).toBeInstanceOf(RuntimeError);
    expect(error.issues).toEqual([
      { role: "entrypoints", skill: "ask", category: "incompatible-coding-agent", message: "skill 'ask' is compatible with [claude-code] but codingAgent='codex'" },
    ]);
  });

  it("loads support skills without requiring schemas, and checks their allowlist too", async () => {
    const error = await rejection(validateSkillsCompatibility({ codingAgent: "claude-code", entrypoints: [], supportSkills: ["schemaless", "helper"] }, loader));
    expect(error.issues).toEqual([expect.objectContaining({ role: "support", skill: "helper", category: "incompatible-coding-agent" })]);
  });

  it("tells an entrypoint without schemas apart from a skill that doesn't exist, and reports every issue", async () => {
    const error = await rejection(validateSkillsCompatibility({ codingAgent: "codex", entrypoints: ["schemaless", "ask"], supportSkills: ["missing"] }, loader));
    expect(error.issues.map(({ role, skill, category }) => ({ role, skill, category }))).toEqual([
      { role: "entrypoints", skill: "schemaless", category: "entrypoint-schema" },
      { role: "entrypoints", skill: "ask", category: "incompatible-coding-agent" },
      { role: "support", skill: "missing", category: "unknown-skill" },
    ]);
    expect(error.issues[0]?.message).toContain("failed to load skill 'schemaless': ");
    expect(error.message).toBe("skills failed compatibility validation (3 issues)");
  });
});
