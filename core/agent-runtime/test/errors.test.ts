// New in this repository.
import { describe, expect, it } from "vitest";

import { EntrypointInvocationError, EntrypointSchemaError, RuntimeError } from "../src/errors.ts";

describe("errors", () => {
  it("keeps one RuntimeError base that a host's own errors extend", () => {
    class HostError extends RuntimeError {}
    const error = new HostError("boom");
    expect(error).toBeInstanceOf(RuntimeError);
    expect(error.name).toBe("HostError");
  });

  it("carries the entrypoint errors' details as own fields", () => {
    const schema = new EntrypointSchemaError("ask", "missing 'inputSchema' in frontmatter");
    expect(schema).toBeInstanceOf(RuntimeError);
    expect({ ...schema }).toMatchObject({ entrypoint: "ask" });
    expect(schema.message).toBe("Entry-point skill 'ask' schema invalid: missing 'inputSchema' in frontmatter");

    const invocation = new EntrypointInvocationError("json-parse-fail", "ask", "bad JSON", [{ pointer: "/", keyword: "type", message: "m" }], { stdoutTail: "out" });
    expect({ ...invocation }).toMatchObject({ reason: "json-parse-fail", entrypoint: "ask", schemaErrors: [{ pointer: "/", keyword: "type", message: "m" }] });
    invocation.attachStderrTail("err");
    expect(invocation.captured).toEqual({ stdoutTail: "out", stderrTail: "err" });
  });
});
