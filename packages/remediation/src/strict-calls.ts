/**
 * Reads what Gradle build scripts say about strict versions with the compilers the build's own Gradle distribution
 * ships (`gradle/StrictCalls.java`): parsed, never run, so no string or comment form can hide a `strictly(...)` the way
 * it could from a hand-written lexer.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runProcess, type RunProcess } from "../../ci/src/process.ts";
import type { Tree } from "../../ci/src/tree.ts";
import { gradleParserJars, protectedDir, type ParserHome } from "./gradle-parsers.ts";
import { wrapperProperties } from "./wrapper-properties.ts";

/**
 * Each file's findings (`<kind> TAB <text>` lines, in order; `error TAB <reason>` for a file that doesn't parse);
 * `tree` is the one whose Gradle wrapper names the distribution.
 */
export type StrictCallParser = (files: ReadonlyArray<{ readonly path: string; readonly text: string }>, tree: Tree) => Promise<ReadonlyMap<string, ReadonlyArray<string>>>;

const PROGRAM = join(dirname(fileURLToPath(import.meta.url)), "..", "gradle", "StrictCalls.java");
const WRAPPER_PROPERTIES = "gradle/wrapper/gradle-wrapper.properties";
const TIMEOUT_MS = 120_000;

/**
 * Parses with protected compiler jars and input copies under the tool's state directory. Java runs outside the
 * sandbox with only `PATH`, `JAVA_HOME` and `HOME`: it parses text and runs none of it.
 */
export function gradleStrictCalls(home: ParserHome, run: RunProcess = runProcess, jars = gradleParserJars): StrictCallParser {
  return async (files, tree) => {
    if (files.length === 0) return new Map();
    const properties = wrapperProperties(await tree.read(WRAPPER_PROPERTIES) ?? "");
    // The wrapper supplies only a version; parser downloads always use the official distribution URL.
    const match = /\/gradle-([^/]+)-(?:bin|all)\.zip$/.exec(properties.get("distributionUrl") ?? "");
    if (match === null) throw new Error(`no Gradle wrapper names the distribution whose compilers parse the build files (${WRAPPER_PROPERTIES})`);
    const compiler = await jars(home, match[1]!);
    const parent = protectedDir(home, "strict-calls");
    await mkdir(parent, { recursive: true });
    const dir = await mkdtemp(join(parent, "run-"));
    try {
      // The copy suffix picks Kotlin for `.kt` and `.kts`, Groovy otherwise.
      const copies = await Promise.all(files.map(async (file, index) => {
        const copy = join(dir, `${index}${/\.kts?$/.test(file.path) ? ".gradle.kts" : ".gradle"}`);
        // A byte-order mark the Groovy parser rejects carries no code.
        await writeFile(copy, file.text.replace(/^\uFEFF/, ""));
        return copy;
      }));
      const env = Object.fromEntries(["PATH", "JAVA_HOME", "HOME"].flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]!]])));
      const java = process.env["JAVA_HOME"] === undefined ? "java" : join(process.env["JAVA_HOME"], "bin", "java");
      await compiler.verify();
      const result = await run(java, ["-cp", compiler.classpath.join(":"), PROGRAM, ...copies], { cwd: dir, env, timeoutMs: TIMEOUT_MS }).catch((err: Error) => {
        throw new Error(`Java isn't available to parse the build files (${err.message})`);
      });
      // The source launcher warns on stderr even when it succeeds: only the exit code says whether it parsed.
      // `runProcess` reports a signal as 128: the timeout's SIGKILL, or a stop from outside.
      if (result.code === 128) throw new Error(`parsing the build files was stopped, past its ${TIMEOUT_MS / 1000}s limit or from outside`);
      if (result.code !== 0) throw new Error(`the build files couldn't be parsed: ${result.stderr.trim().split("\n").filter((line) => !line.includes("warning")).slice(-3).join(" ")}`);
      const found = new Map<string, string[]>(files.map((file) => [file.path, []]));
      for (const line of result.stdout.split("\n")) {
        if (line === "") continue;
        const tab = line.indexOf("\t");
        const index = copies.indexOf(line.slice(0, tab));
        if (index < 0) throw new Error(`the strict-pin parser named an unknown file: ${line.slice(0, tab)}`);
        // A parse error may name the temporary copy; the edit's own path is what the reader knows.
        found.get(files[index]!.path)!.push(line.slice(tab + 1).replaceAll(copies[index]!, files[index]!.path));
      }
      return found;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}
