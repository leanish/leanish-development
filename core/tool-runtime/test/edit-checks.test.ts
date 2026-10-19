import { describe, expect, it } from "vitest";

import { GATE_WORKFLOW, isDependencyFile, isMechanical, writtenPins } from "../src/edit-checks.ts";

describe("isMechanical", () => {
  it("takes the base's side for the dependency files a move touches, workflows aside, matching the catalog by whole folder", () => {
    for (const path of ["package-lock.json", "web/package.json", "npm-shrinkwrap.json", "gradle.lockfile", "app/buildscript-gradle.lockfile", "build.gradle", "app/build.gradle.kts", "gradle/libs.versions.toml", "app/gradle/libs.versions.toml", ".github/dependency-floors.json"]) {
      expect(isMechanical(path), path).toBe(true);
    }
    for (const path of ["xgradle/libs.versions.toml", "app/xgradle/libs.versions.toml", ".github/workflows/ci.yml", "action.yml", "README.md"]) {
      expect(isMechanical(path), path).toBe(false);
    }
    expect(isDependencyFile(".github/workflows/ci.yml", true)).toBe(true);
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
      .replace(`      - uses: acme/setup@${OLD}   # v4.0.0`, `      - uses: acme/setup@${NEW}   # v5.0.0`)
      .replace(`      - uses: "acme/setup/sub@${OLD}" # v4.0.0`, `      - uses: "acme/setup/sub@${NEW}" # v5.0.0`));
    expect(writtenPins(written, "ci.yml", [pin])).toBe(written);
  });

  it("writes a CRLF file's pins, keeping its line endings", () => {
    const text = `jobs:\r\n  j:\r\n    steps:\r\n      - uses: acme/setup@${OLD} # v4.0.0\r\n      - run: echo\r\n`;
    expect(writtenPins(text, "ci.yml", [pin])).toBe(text.replace(`acme/setup@${OLD} # v4.0.0`, `acme/setup@${NEW} # v5.0.0`));
  });

  it("adds no comment where there was none to match, and writes the gate's own caller", () => {
    const gate = `jobs:\n  gate:\n    uses: ${GATE_WORKFLOW.name}/${GATE_WORKFLOW.path}@${OLD} # v0.6.1\n`;
    expect(writtenPins(gate, GATE_WORKFLOW.path, [{ name: GATE_WORKFLOW.name, from: "v0.6.1", to: "v0.7.0", commitSha: NEW }]))
      .toBe(`jobs:\n  gate:\n    uses: ${GATE_WORKFLOW.name}/${GATE_WORKFLOW.path}@${NEW} # v0.7.0\n`);
  });

  it.each([
    ["an alias", `x: &a acme/setup@${OLD}\njobs:\n  j:\n    steps:\n      - uses: *a # v4.0.0\n`, "aliased"],
    ["a comment naming more than the version", `jobs:\n  j:\n    steps:\n      - uses: acme/setup@${OLD} # v4.0.0 pinned by hand\n`, "can't be rewritten in place"],
    ["invalid YAML", "jobs: [\n", "isn't valid YAML"],
  ])("refuses %s rather than guessing", (_name, text, message) => {
    expect(() => writtenPins(text, "ci.yml", [pin])).toThrow(message);
  });
});
