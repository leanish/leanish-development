import { readFileSync } from "node:fs";

import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { parseFloors } from "../src/floors.ts";

// The published schema of .github/dependency-floors.json (secure-it's skill embeds it) must describe what the gate's
// parser accepts: these cases keep the two from drifting apart.
const schema = JSON.parse(readFileSync(new URL("../dependency-floors.schema.json", import.meta.url), "utf8")) as object;
const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

const guava = {
  ecosystem: "Maven",
  package: "com.google.guava:guava",
  version: "33.7.2-jre",
  declaredIn: "build.gradle.kts",
  selector: [":checkstyle"],
  purpose: "security",
  advisories: ["GHSA-xxph-c9ww-hj94"],
  reason: "Checkstyle pulls an affected Guava",
  added: "2026-10-04",
};
const npm = { ...guava, ecosystem: "npm", package: "brace-expansion", version: "5.0.12", declaredIn: "package.json", selector: [["aws-cdk-lib", "brace-expansion"]] };
const compatibility = { ...guava, purpose: "compatibility", advisories: [] };
const without = (floor: Record<string, unknown>, key: string) => Object.fromEntries(Object.entries(floor).filter(([name]) => name !== key));

const parses = (file: unknown): boolean => {
  try {
    parseFloors(file);
    return true;
  } catch {
    return false;
  }
};

describe("dependency-floors.schema.json", () => {
  const structural: Array<[string, unknown]> = [
    ["a Maven security floor", { floors: [guava] }],
    ["an npm floor with a nested override path", { floors: [npm] }],
    ["an npm floor with a top-level key", { floors: [{ ...npm, selector: "brace-expansion" }] }],
    ["an npm floor mixing keys and key paths", { floors: [{ ...npm, selector: [["aws-cdk-lib", "brace-expansion"], "brace-expansion"] }] }],
    ["a selector string", { floors: [{ ...guava, selector: ":checkstyle" }] }],
    ["a selector with inner spaces", { floors: [{ ...guava, selector: [" :checkstyle"] }] }],
    ["a compatibility floor with no advisories", { floors: [compatibility] }],
    ["a compatibility floor with null advisories", { floors: [{ ...compatibility, advisories: null }] }],
    ["a compatibility floor without the field", { floors: [without(compatibility, "advisories")] }],
    ["no floors", { floors: [] }],
    ["not an object", []],
    ["another top-level key", { floors: [], extra: 1 }],
    ["an entry that isn't an object", { floors: ["guava"] }],
    ["an unknown field", { floors: [{ ...guava, name: "guava" }] }],
    ...["ecosystem", "package", "version", "declaredIn", "selector", "purpose", "reason", "added"].map(
      (key): [string, unknown] => [`no ${key}`, { floors: [without(guava, key)] }],
    ),
    ["an untrimmed package", { floors: [{ ...guava, package: " com.google.guava:guava" }] }],
    ["an empty reason", { floors: [{ ...guava, reason: "" }] }],
    ["another ecosystem", { floors: [{ ...guava, ecosystem: "pip" }] }],
    ["another purpose", { floors: [{ ...guava, purpose: "speed" }] }],
    ["a security floor without advisories", { floors: [{ ...guava, advisories: [] }] }],
    ["a security floor with null advisories", { floors: [{ ...guava, advisories: null }] }],
    ["a security floor without the field", { floors: [without(guava, "advisories")] }],
    ["a compatibility floor naming an advisory", { floors: [{ ...guava, purpose: "compatibility" }] }],
    ["an advisory that isn't an id", { floors: [{ ...guava, advisories: ["bad-id"] }] }],
    ["an empty selector", { floors: [{ ...guava, selector: [] }] }],
    ["a blank selector entry", { floors: [{ ...guava, selector: ["  "] }] }],
    ["a Maven selector with a key path", { floors: [{ ...guava, selector: [[":checkstyle"]] }] }],
    ["an npm selector with an empty key path", { floors: [{ ...npm, selector: [[]] }] }],
    ["a date in another format", { floors: [{ ...guava, added: "04/10/2026" }] }],
  ];

  const accepted = new Set([
    "a Maven security floor", "an npm floor with a nested override path", "an npm floor with a top-level key",
    "an npm floor mixing keys and key paths", "a selector string", "a selector with inner spaces",
    "a compatibility floor with no advisories", "a compatibility floor with null advisories",
    "a compatibility floor without the field", "no floors",
  ]);

  it.each(structural)("agrees with the gate's parser on %s", (name, file) => {
    expect(parses(file)).toBe(accepted.has(name));
    expect(validate(file)).toBe(accepted.has(name));
  });

  it("leaves two rules to the parser: a real calendar date and no duplicate claims", () => {
    for (const file of [{ floors: [{ ...guava, added: "2026-13-01" }] }, { floors: [guava, guava] }]) {
      expect(validate(file)).toBe(true);
      expect(parses(file)).toBe(false);
    }
  });
});
