// Copied from leanish/leanish-development-incubator core/runtime/test/unit/schema-subset.test.ts at 17883e3; see PROVENANCE.md.
// Local changes: imports this package's modules from `../src/` instead of `../../src/`.
import { describe, expect, it } from "vitest";

import { EntrypointSchemaError } from "../src/errors.ts";
import { assertSubset } from "../src/skill/schema-subset.ts";
import { SchemaValidator } from "../src/skill/validator.ts";

describe("assertSubset (schema subset)", () => {
  it("accepts the allowed keyword set", () => {
    expect(() =>
      assertSubset(
        {
          type: "object",
          description: "doc string allowed",
          properties: {
            outcome: { type: "string", enum: ["pr-opened", "no-op"] },
            count: { type: "integer", minimum: 0 },
            url: { type: "string", minLength: 1 },
          },
          required: ["outcome"],
          additionalProperties: false,
        },
        "ask",
      ),
    ).not.toThrow();
  });

  it("rejects combinators", () => {
    expect(() =>
      assertSubset({ type: "object", anyOf: [{ type: "object" }] }, "ask"),
    ).toThrowError(EntrypointSchemaError);
  });

  it("rejects $ref", () => {
    expect(() => assertSubset({ $ref: "#/defs/foo" }, "ask")).toThrowError(
      EntrypointSchemaError,
    );
  });

  it("rejects type: null", () => {
    expect(() => assertSubset({ type: "null" }, "ask")).toThrowError(
      EntrypointSchemaError,
    );
  });

  it("rejects pattern / format", () => {
    expect(() =>
      assertSubset({ type: "string", pattern: "^x$" }, "ask"),
    ).toThrowError(EntrypointSchemaError);
  });

  it("allows annotation keywords without validation effect", () => {
    expect(() =>
      assertSubset(
        {
          type: "object",
          title: "Outcome",
          examples: [{ outcome: "ok" }],
          properties: { outcome: { type: "string", description: "what happened" } },
        },
        "ask",
      ),
    ).not.toThrow();
  });
});

describe("narrow nullable answer schemas", () => {
  const condition = { properties: { outcome: { const: "applied" } } };
  const consequent = {
    required: ["publication"],
    properties: { publication: { type: "object" } },
  };

  it("allows the object/null union", () => {
    expect(() => assertSubset({
      type: ["object", "null"],
      properties: { title: { type: "string" } },
    }, "tool")).not.toThrow();
  });

  it.each([
    { type: ["string", "null"] },
    { type: ["object", "string"] },
    { type: ["object", "null", "string"] },
    { type: ["null", "object"] },
    { type: ["object"] },
    { type: [] },
  ])("rejects other type unions %#", (schema) => {
    expect(() => assertSubset(schema, "tool")).toThrowError(EntrypointSchemaError);
  });

  it("allows a discriminator to require one non-null object", () => {
    expect(() => assertSubset({ if: condition, then: consequent }, "tool")).not.toThrow();
  });

  it.each([
    { if: { properties: { outcome: { enum: ["applied"] } } }, then: consequent },
    { if: { properties: { outcome: { const: true } } }, then: consequent },
    { if: { properties: { outcome: { const: "applied" }, other: { const: "x" } } }, then: consequent },
    { if: { ...condition, required: ["outcome"] }, then: consequent },
    { if: condition },
    { then: consequent },
    { if: null, then: consequent },
    { if: condition, then: null },
    { if: condition, then: { required: ["publication"] } },
    { if: condition, then: { ...consequent, required: [] } },
    { if: condition, then: { ...consequent, required: ["publication", "other"] } },
    { if: condition, then: { ...consequent, required: ["other"] } },
    { if: condition, then: { ...consequent, additionalProperties: false } },
    { if: condition, then: { ...consequent, properties: { publication: { type: ["object", "null"] } } } },
    { if: condition, then: { ...consequent, properties: { publication: { type: "string" } } } },
    { if: condition, then: { ...consequent, properties: { publication: { type: "object" }, other: { type: "object" } } } },
    { if: condition, then: consequent, else: consequent },
  ])("rejects general or incomplete conditionals %#", (schema) => {
    expect(() => assertSubset(schema, "tool")).toThrowError(EntrypointSchemaError);
  });

  it.each([
    { type: ["object", "null"], properties: { invalid: { type: "null" } } },
    { type: ["object", "null"], additionalProperties: { type: ["string", "null"] } },
    {
      if: condition,
      then: {
        ...consequent,
        properties: { publication: { type: "object", properties: { invalid: { $ref: "#/defs/foo" } } } },
      },
    },
  ])("still checks nested schemas %#", (schema) => {
    expect(() => assertSubset(schema, "tool")).toThrowError(EntrypointSchemaError);
  });
});

describe("SchemaValidator with nullable answer schemas", () => {
  const publication = {
    type: ["object", "null"],
    required: ["title"],
    properties: { title: { type: "string" } },
    additionalProperties: false,
  };
  const answer = {
    type: "object",
    required: ["outcome"],
    properties: {
      outcome: { type: "string", enum: ["applied", "no-op"] },
      publication,
    },
    additionalProperties: false,
    if: { properties: { outcome: { const: "applied" } } },
    then: {
      required: ["publication"],
      properties: { publication: { type: "object" } },
    },
  };

  it.each([null, { title: "Published" }])("accepts a nullable object %#", (value) => {
    assertSubset(publication, "tool");
    expect(new SchemaValidator().validate(publication, value)).toEqual([]);
  });

  it.each([{}, { title: 1 }, { title: "Published", extra: true }, [], "text"])(
    "rejects invalid nullable object values %#",
    (value) => {
      expect(new SchemaValidator().validate(publication, value)).not.toEqual([]);
    },
  );

  it.each([
    { outcome: "applied", publication: { title: "Published" } },
    { outcome: "no-op", publication: null },
    { outcome: "no-op" },
  ])("accepts conditional answers %#", (value) => {
    assertSubset(answer, "tool");
    expect(new SchemaValidator().validate(answer, value)).toEqual([]);
  });

  it.each([
    { value: { outcome: "applied" }, keyword: "required", pointer: "/" },
    { value: { outcome: "applied", publication: null }, keyword: "type", pointer: "/publication" },
    { value: { outcome: "applied", publication: {} }, keyword: "required", pointer: "/publication" },
  ])("rejects invalid conditional answers %#", ({ value, keyword, pointer }) => {
    expect(new SchemaValidator().validate(answer, value)).toEqual(
      expect.arrayContaining([expect.objectContaining({ keyword, pointer })]),
    );
  });
});
