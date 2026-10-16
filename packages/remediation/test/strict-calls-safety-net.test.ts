import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runProcess } from "../../ci/src/process.ts";
import { LOCAL_GRADLE } from "./local-gradle-parser.ts";

// The normal visitor accounts for ordinary string literals. Empty visitor accounting deliberately exercises the
// fallback's independent string-content branch, so a future visitor gap cannot silently lose that protection.
describe.skipIf(LOCAL_GRADLE === undefined)("strict-call lexer safety nets", { timeout: 120_000 }, () => {
  let dir: string;
  let classpath: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "strict-safety-net-test-"));
    classpath = [dir, ...LOCAL_GRADLE!.jars.classpath].join(delimiter);
    const javac = process.env["JAVA_HOME"] === undefined ? "javac" : join(process.env["JAVA_HOME"], "bin", "javac");
    const compiled = await runProcess(javac, ["-cp", classpath, "-d", dir,
      fileURLToPath(new URL("../gradle/StrictCalls.java", import.meta.url)),
      fileURLToPath(new URL("./fixtures/StrictCallsSafetyNet.java", import.meta.url)),
    ]);
    expect(compiled.code, compiled.stderr).toBe(0);
  }, 120_000);
  afterAll(async () => { if (dir !== undefined) await rm(dir, { recursive: true, force: true }); });

  async function check(language: string, text: string) {
    const path = join(dir, `input.${language === "kotlin" ? "kts" : "groovy"}`);
    await writeFile(path, text);
    const java = process.env["JAVA_HOME"] === undefined ? "java" : join(process.env["JAVA_HOME"], "bin", "java");
    return runProcess(java, ["-cp", classpath, "StrictCallsSafetyNet", language, path]);
  }

  it("fingerprints a Kotlin file whose only strictly mention is an unaccounted string part", async () => {
    for (const text of ['val hint = "strictly"\n', 'val hint = "strictly"\n// changed\n']) {
      const result = await check("kotlin", text);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toBe(`file\t${createHash("sha256").update(text).digest("hex")}\n`);
    }
  });

  it("fails when Groovy's lexer reports an error, independently of AST conversion", async () => {
    const result = await check("groovy", "§\n");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("GroovySyntaxError: Unexpected character:");
  });
});
