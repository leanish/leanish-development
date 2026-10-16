import type { StrictCallParser } from "../src/strict-calls.ts";

/** A stand-in for the Gradle-compiler parser in tools' tests: each file's lines that mention `strictly`, as calls. */
export const textStrictCalls: StrictCallParser = async (files) =>
  new Map(files.map((file) => [file.path, file.text.split("\n").filter((line) => line.includes("strictly")).map((line) => `call\t${line.trim()}`)]));
