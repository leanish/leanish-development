import { describe, expect, it } from "vitest";

import { validPermissions } from "../src/tools.ts";

const contents = { name: "contents", label: "Contents", write: "write", read: "read" };

describe("tool descriptor permissions", () => {
  it("accepts a table of named, labelled entries with a level per role", () => {
    expect(validPermissions([contents, { name: "pull_requests", label: "Pull requests", write: "write", read: "none" }])).toBe(true);
  });

  it.each([
    ["not an array", contents],
    ["empty", []],
    ["a duplicate name", [contents, contents]],
    ["an unknown level", [{ ...contents, read: "admin" }]],
    ["a missing role", [{ name: "contents", label: "Contents", write: "write" }]],
    ["an empty label", [{ ...contents, label: "" }]],
    ["a name outside snake case", [{ ...contents, name: "Contents" }]],
    ["a name the token form uses itself", [{ ...contents, name: "description" }]],
    ["a non-object entry", ["contents"]],
  ])("rejects %s", (_case, permissions) => {
    expect(validPermissions(permissions)).toBe(false);
  });
});
