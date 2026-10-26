// Adapted from leanish/leanish-development-incubator core/runtime/src/skill/validate-compat.ts at 17883e3; see
// PROVENANCE.md.
// Local changes: the coding agent and the skill names come as arguments instead of the agent descriptor, and the
// issues as a `SkillCompatibilityError` instead of a `DescriptorValidationError`, which the incubator is to map.
import { EntrypointSchemaError, RuntimeError } from "../errors.ts";

import type { SkillLoader } from "./skill-loader.ts";

/** The skills a host will call, by role: an entrypoint must load with its schemas, a support skill only load. */
export interface SkillsToValidate {
  readonly codingAgent: string;
  readonly entrypoints: ReadonlyArray<string>;
  readonly supportSkills: ReadonlyArray<string>;
}

export type SkillRole = "entrypoints" | "support";

export type SkillCompatibilityIssueCategory = "incompatible-coding-agent" | "entrypoint-schema" | "unknown-skill";

export interface SkillCompatibilityIssue {
  readonly role: SkillRole;
  readonly skill: string;
  readonly category: SkillCompatibilityIssueCategory;
  readonly message: string;
}

/** The skills failed validation at startup; one issue per failing skill, in the order checked. */
export class SkillCompatibilityError extends RuntimeError {
  readonly issues: ReadonlyArray<SkillCompatibilityIssue>;

  constructor(issues: ReadonlyArray<SkillCompatibilityIssue>) {
    super(`skills failed compatibility validation (${issues.length} issue${issues.length === 1 ? "" : "s"})`);
    this.issues = issues;
  }
}

/**
 * Loads each entrypoint (with `loadEntrypoint`, so its input and output
 * schemas are required and checked) and each support skill (with `load`), and
 * rejects the set when any skill's `compatibleCodingAgents` allowlist excludes
 * `codingAgent`.
 *
 * Throws `SkillCompatibilityError` listing every mismatch and every skill
 * that failed to load. This runs at startup, before any skill is called.
 */
export async function validateSkillsCompatibility(skills: SkillsToValidate, skillLoader: Pick<SkillLoader, "load" | "loadEntrypoint">): Promise<void> {
  const issues: SkillCompatibilityIssue[] = [];
  const all = [
    ...skills.entrypoints.map((name) => ({ name, role: "entrypoints" as const })),
    ...skills.supportSkills.map((name) => ({ name, role: "support" as const })),
  ];
  for (const { name, role } of all) {
    try {
      const skill = role === "entrypoints" ? await skillLoader.loadEntrypoint(name) : await skillLoader.load(name);
      const allowed = skill.compatibleCodingAgents;
      if (allowed !== undefined && !allowed.includes(skills.codingAgent)) {
        issues.push({
          role,
          skill: name,
          category: "incompatible-coding-agent",
          message: `skill '${name}' is compatible with [${allowed.join(", ")}] but codingAgent='${skills.codingAgent}'`,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A skill that loads but has an invalid input/output schema is an
      // `entrypoint-schema` problem, not a missing skill — preserve the
      // distinction so callers can triage the two differently.
      const category = err instanceof EntrypointSchemaError ? "entrypoint-schema" : "unknown-skill";
      issues.push({ role, skill: name, category, message: `failed to load skill '${name}': ${message}` });
    }
  }
  if (issues.length > 0) throw new SkillCompatibilityError(issues);
}
