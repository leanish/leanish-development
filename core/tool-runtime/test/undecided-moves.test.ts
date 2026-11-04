import { describe, expect, it } from "vitest";

import { assertNoUndecidedMoves, byPackage } from "../src/undecided-moves.ts";

describe("byPackage", () => {
  it("keeps each package's distinct causes once, in the order first seen", () => {
    const causes = byPackage([
      ["npm|a", "publisher identity"],
      ["npm|b", "direct-peer set"],
      ["npm|a", "direct-peer set"],
      ["npm|a", "publisher identity"],
    ]);
    expect([...causes]).toEqual([["npm|a", ["publisher identity", "direct-peer set"]], ["npm|b", ["direct-peer set"]]]);
  });
});

describe("assertNoUndecidedMoves", () => {
  const undecided = byPackage([["npm|a", "publisher identity"], ["npm|a", "direct-peer set"], ["Gradle Wrapper|gradle/gradle", "publisher identity"]]);

  it("lets a PR go on when its recorded plan moves nothing undecided, or records none", () => {
    expect(() => assertNoUndecidedMoves([{ ecosystem: "npm", name: "b" }, { ecosystem: "Maven", name: "a" }], undecided)).not.toThrow();
    expect(() => assertNoUndecidedMoves(undefined, undecided)).not.toThrow();
  });

  it("keeps the PR, naming each undecided package once with all its causes, in the order of its moves", () => {
    const recorded = [
      { ecosystem: "Gradle Wrapper", name: "gradle/gradle" },
      { ecosystem: "npm", name: "b" },
      { ecosystem: "npm", name: "a" },
      { ecosystem: "npm", name: "a" },
    ];
    expect(() => assertNoUndecidedMoves(recorded, undecided)).toThrow(new Error(
      "Gradle Wrapper gradle/gradle's publisher identity can't be decided; keeping the PR; npm a's publisher identity and direct-peer set can't be decided; keeping the PR",
    ));
  });
});
