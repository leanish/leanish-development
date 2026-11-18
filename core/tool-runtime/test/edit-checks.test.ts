import { describe, expect, it } from "vitest";

import { tree } from "@leanish/gate/test/required-fixture";

import { actionsOutsidePlan, GATE_WORKFLOW, isDependencyFile, isMechanical, pinsLanded, policyFence, writtenPins } from "../src/edit-checks.ts";

describe("isMechanical", () => {
  it("takes the base's side for the dependency files a move touches, workflows aside, matching the catalog by whole folder", () => {
    for (const path of ["package-lock.json", "web/package.json", "npm-shrinkwrap.json", "gradle.lockfile", "app/buildscript-gradle.lockfile", "build.gradle", "app/build.gradle.kts", "gradle/libs.versions.toml", "app/gradle/libs.versions.toml", ".github/dependency-floors.json"]) {
      expect(isMechanical(path), path).toBe(true);
    }
    for (const path of ["xgradle/libs.versions.toml", "app/xgradle/libs.versions.toml", ".github/workflows/ci.yml", "action.yml", "README.md"]) {
      expect(isMechanical(path), path).toBe(false);
    }
    expect(isDependencyFile(".github/workflows/ci.yml", true)).toBe(true);
    // The exceptions file too, its cleanup recomputed over the new base; never the gate's config.
    expect(isMechanical(".github/supply-chain-exceptions.json")).toBe(true);
    expect(isMechanical(".github/supply-chain.json")).toBe(false);
  });
});

describe("writtenPins", () => {
  const OLD = "a".repeat(40);
  const NEW = "1".repeat(40);
  const pin = { name: "Acme/Setup", from: "v4.0.0", to: "v5.0.0", commitSha: NEW };

  it("moves only the planned version's uses, keeping every other byte", () => {
    const text = [
      "# A stale comment naming acme/setup@" + OLD + " # v4.0.0 stays.",
      "on: push",
      "jobs:",
      "  build:",
      "    steps:",
      `      - uses: acme/setup@${OLD}   # v4.0.0`,
      `      - uses: "acme/setup/sub@${OLD}" # v4.0.0`,
      `      - uses: acme/setup@${"b".repeat(40)} # v3.2.0`,
      "      - run: |",
      `          echo uses: acme/setup@${OLD} # v4.0.0`,
      `      - uses: other/action@${OLD} # v4.0.0\r`,
      "",
    ].join("\n");
    const written = writtenPins(text, "ci.yml", [pin]);
    expect(written).toBe(text
      .replace(`      - uses: acme/setup@${OLD}   # v4.0.0`, `      - uses: acme/setup@${NEW}   # v5.0.0`));
    expect(writtenPins(written, "ci.yml", [pin])).toBe(written);
  });

  it("writes a CRLF file's pins, keeping its line endings", () => {
    const text = `jobs:\r\n  j:\r\n    steps:\r\n      - uses: acme/setup@${OLD} # v4.0.0\r\n      - run: echo\r\n`;
    expect(writtenPins(text, "ci.yml", [pin])).toBe(text.replace(`acme/setup@${OLD} # v4.0.0`, `acme/setup@${NEW} # v5.0.0`));
  });

  it("adds no comment where there was none to match, and writes the gate's own caller", () => {
    const name = `${GATE_WORKFLOW.name}/${GATE_WORKFLOW.path}`;
    const gate = `jobs:\n  gate:\n    uses: ${name}@${OLD} # v0.6.1\n`;
    expect(writtenPins(gate, GATE_WORKFLOW.path, [{ name, from: "v0.6.1", to: "v0.7.0", commitSha: NEW }]))
      .toBe(`jobs:\n  gate:\n    uses: ${name}@${NEW} # v0.7.0\n`);
  });

  it("writes and verifies a subpath pin independently of siblings in the same file", async () => {
    const file = ".github/workflows/ci.yml";
    const text = `jobs:\n  j:\n    steps:\n      - uses: Acme/setup/Deploy@${OLD} # v4.0.0\n      - uses: acme/setup/deploy@${OLD} # v4.0.0\n`;
    const move = { ...pin, name: "acme/setup/Deploy", locations: [file] };
    const written = writtenPins(text, file, [move]);
    expect(written).toBe(text.replace(`Deploy@${OLD} # v4.0.0`, `Deploy@${NEW} # v5.0.0`));
    const base = tree({ [file]: text }, "base");
    const head = tree({ [file]: written }, "head");
    expect(await pinsLanded([move], head)).toEqual([]);
    expect(await policyFence([file], [move], base, head)).toEqual([]);
    const both = tree({ [file]: written.replace(`deploy@${OLD} # v4.0.0`, `deploy@${NEW} # v5.0.0`) }, "both");
    expect(await policyFence([file], [move], base, both)).toHaveLength(1);
    expect(await actionsOutsidePlan([move], base, both)).toEqual([
      expect.stringContaining("acme/setup/deploy@"),
      expect.stringContaining("acme/setup/deploy@"),
    ]);
  });

  it.each([
    ["an alias", `x: &a acme/setup@${OLD}\njobs:\n  j:\n    steps:\n      - uses: *a # v4.0.0\n`, "aliased"],
    ["a comment naming more than the version", `jobs:\n  j:\n    steps:\n      - uses: acme/setup@${OLD} # v4.0.0 pinned by hand\n`, "can't be rewritten in place"],
    ["invalid YAML", "jobs: [\n", "isn't valid YAML"],
  ])("refuses %s rather than guessing", (_name, text, message) => {
    expect(() => writtenPins(text, "ci.yml", [pin])).toThrow(message);
  });
});
