// Copied from leanish/leanish-development-incubator core/runtime/test/unit/synthesize-fixture.test.ts at 17883e3; see PROVENANCE.md.
// Local changes: imports this package's modules from `../src/` instead of `../../src/`.
import { describe, expect, it } from "vitest";

import { assertSubset } from "../src/skill/schema-subset.ts";
import { synthesizeFixture } from "../src/skill/synthesize-fixture.ts";
import { SchemaValidator } from "../src/skill/validator.ts";

describe("synthesizeFixture", () => {
  it("returns the ask skill's required answer shape", () => {
    const askOutputSchema = {
      type: "object",
      additionalProperties: false,
      required: ["answer"],
      properties: {
        answer: { type: "string", minLength: 1, maxLength: 51200 },
      },
    };
    expect(synthesizeFixture(askOutputSchema)).toEqual({ answer: "fake-fixture" });
  });

  it("respects `const` and `enum` over the type-based defaults", () => {
    expect(synthesizeFixture({ const: "exact" })).toBe("exact");
    expect(synthesizeFixture({ enum: ["a", "b", "c"] })).toBe("a");
  });

  it("respects `minimum` for numbers", () => {
    expect(synthesizeFixture({ type: "number", minimum: 7 })).toBe(7);
    expect(synthesizeFixture({ type: "integer", minimum: 0 })).toBe(0);
    expect(synthesizeFixture({ type: "integer" })).toBe(0);
  });

  it("pads strings to satisfy minLength", () => {
    const v = synthesizeFixture({ type: "string", minLength: 32 });
    expect(typeof v).toBe("string");
    expect((v as string).length).toBeGreaterThanOrEqual(32);
  });

  it("walks nested required properties", () => {
    const schema = {
      type: "object",
      required: ["meta", "items"],
      properties: {
        meta: {
          type: "object",
          required: ["count"],
          properties: { count: { type: "integer" } },
        },
        items: { type: "array" },
      },
    };
    expect(synthesizeFixture(schema)).toEqual({
      meta: { count: 0 },
      items: [],
    });
  });

  it("emits an empty object when no required keys are declared", () => {
    expect(synthesizeFixture({ type: "object" })).toEqual({});
  });

  it("synthesizes the object branch of a nullable object", () => {
    const schema = {
      type: ["object", "null"],
      required: ["title"],
      properties: { title: { type: "string" } },
      additionalProperties: false,
    };
    const fixture = synthesizeFixture(schema);
    expect(fixture).toEqual({ title: "fake-fixture" });
    assertSubset(schema, "tool");
    expect(new SchemaValidator().validate(schema, fixture)).toEqual([]);
  });

  it.each(["applied", "no-op"])("synthesizes a conditional answer for %s", (outcome) => {
    const schema = {
      type: "object",
      required: ["outcome"],
      properties: {
        outcome: { type: "string", enum: [outcome] },
        publication: {
          type: ["object", "null"],
          required: ["title"],
          properties: { title: { type: "string" } },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
      if: { properties: { outcome: { const: "applied" } } },
      then: {
        required: ["publication"],
        properties: { publication: { type: "object" } },
      },
    };
    const fixture = synthesizeFixture(schema);
    expect(fixture).toEqual(outcome === "applied"
      ? { outcome, publication: { title: "fake-fixture" } }
      : { outcome });
    assertSubset(schema, "tool");
    expect(new SchemaValidator().validate(schema, fixture)).toEqual([]);
  });

  it("uses the consequent's object schema when no base property is declared", () => {
    const schema = {
      type: "object",
      required: ["outcome"],
      properties: { outcome: { const: "applied" } },
      if: { properties: { outcome: { const: "applied" } } },
      then: {
        required: ["publication"],
        properties: {
          publication: {
            type: "object",
            required: ["count"],
            properties: { count: { type: "integer" } },
          },
        },
      },
    };
    const fixture = synthesizeFixture(schema);
    expect(fixture).toEqual({ outcome: "applied", publication: { count: 0 } });
    assertSubset(schema, "tool");
    expect(new SchemaValidator().validate(schema, fixture)).toEqual([]);
  });
});

describe("FakeCodingAgentRunner default responder", () => {
  it("throws by default when no per-entrypoint response is registered", async () => {
    const { FakeCodingAgentRunner } = await import("../src/skill/fake-runner.ts");
    const { parseSkillFile } = await import("../src/skill/skill-loader.ts");

    const askSkill = parseSkillFile(
      `---
name: ask
inputSchema: { type: object }
outputSchema: { type: object }
---

# ask
`,
      "ask",
      "/synthetic/ask/SKILL.md",
    );

    const runner = new FakeCodingAgentRunner("claude-code");
    await expect(
      runner.run({
        entrypoint: askSkill,
        supportSkills: [],
        renderedArguments: "",
        workingCopies: [],
      }),
    ).rejects.toThrowError(/no response registered for entrypoint 'ask'/);
  });

  it("synthesises a fenced-json response when synthesiseDefault: true is opted into", async () => {
    const { FakeCodingAgentRunner } = await import("../src/skill/fake-runner.ts");
    const { parseSkillFile } = await import("../src/skill/skill-loader.ts");
    const { extractTerminalJson } = await import("../src/skill/output-parse.ts");

    const askSkill = parseSkillFile(
      `---
name: ask
inputSchema:
  type: object
outputSchema:
  type: object
  required: [answer]
  properties:
    answer: { type: string }
---

# ask
`,
      "ask",
      "/synthetic/ask/SKILL.md",
    );

    const runner = new FakeCodingAgentRunner("claude-code", [], { synthesiseDefault: true });
    const result = await runner.run({
      entrypoint: askSkill,
      supportSkills: [],
      renderedArguments: "question: x",
      workingCopies: [],
    });

    const parsed = extractTerminalJson(result.responseText, "ask");
    expect(parsed).toEqual({ answer: "fake-fixture" });
  });

  it("explicit register() takes precedence over the synthesised default", async () => {
    const { FakeCodingAgentRunner } = await import("../src/skill/fake-runner.ts");
    const { parseSkillFile } = await import("../src/skill/skill-loader.ts");

    const askSkill = parseSkillFile(
      `---
name: ask
inputSchema: { type: object }
outputSchema:
  type: object
  required: [answer]
  properties:
    answer: { type: string }
---

# ask
`,
      "ask",
      "/synthetic/ask/SKILL.md",
    );

    const runner = new FakeCodingAgentRunner("claude-code", [], { synthesiseDefault: true });
    runner.register("ask", () => ({
      responseText: '```json\n{"answer":"explicit"}\n```',
    }));
    const result = await runner.run({
      entrypoint: askSkill,
      supportSkills: [],
      renderedArguments: "",
      workingCopies: [],
    });
    expect(result.responseText).toContain('"answer":"explicit"');
  });
});
