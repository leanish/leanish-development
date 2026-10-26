import { describe, expect, it } from "vitest";

import { literal } from "../src/pr-text.ts";

describe("literal", () => {
  it("renders text as a code span, so links, mentions and Markdown stay text", () => {
    expect(literal("see https://evil.example/x and @someone **now** [x](y)")).toBe("`see https://evil.example/x and @someone **now** [x](y)`");
  });

  it("fences past the text's longest backtick run, padding an end that is a backtick", () => {
    expect(literal("a `b` c")).toBe("``a `b` c``");
    expect(literal("``x``")).toBe("``` ``x`` ```");
    expect(literal("`")).toBe("`` ` ``");
  });

  it("breaks a comment opening, plan and state markers included", () => {
    expect(literal("x <!-- leanish:state {} --> y")).toBe("`x < !-- leanish:state {} --> y`");
    expect(literal("<!--<!--")).toBe("`< !--< !--`");
  });

  it("escapes pipes only in a table cell, and collapses whitespace", () => {
    expect(literal("a|b", { table: true })).toBe("`a\\|b`");
    expect(literal("a|b")).toBe("`a|b`");
    expect(literal(" a\n\tb  ")).toBe("`a b`");
  });

  it("leaves empty text empty", () => {
    expect(literal("")).toBe("");
    expect(literal(" \n ")).toBe("");
  });
});
