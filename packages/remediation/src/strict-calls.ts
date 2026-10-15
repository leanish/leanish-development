/**
 * Reads what Gradle build scripts say about strict versions with the compilers the build's own Gradle distribution
 * ships (`gradle/StrictCalls.java`): parsed, never run, so no string or comment form can hide a `strictly(...)` the way
 * it could from a hand-written lexer.
 */
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runProcess, type RunProcess } from "../../ci/src/process.ts";
import type { Tree } from "../../ci/src/tree.ts";

/** Each file's findings (`<kind> TAB <text>` lines, in order); `tree` is the one whose Gradle wrapper names the distribution. */
export type StrictCallParser = (files: ReadonlyArray<{ readonly path: string; readonly text: string }>, tree: Tree) => Promise<ReadonlyMap<string, ReadonlyArray<string>>>;

const PROGRAM = join(dirname(fileURLToPath(import.meta.url)), "..", "gradle", "StrictCalls.java");
const WRAPPER_PROPERTIES = "gradle/wrapper/gradle-wrapper.properties";
/** The jars the parsers need; their versions follow the distribution's. */
const JARS = [/^groovy-\d/, /^kotlin-compiler-embeddable-/, /^kotlin-stdlib-\d/, /^kotlin-script-runtime-/, /^kotlin-reflect-/, /^kotlinx-coroutines-core-jvm-/, /^annotations-/, /^kotlin-daemon-embeddable-/];
const TIMEOUT_MS = 120_000;

/**
 * A parser over the distributions under `gradleHome` (the tools' `GRADLE_USER_HOME`, where their Gradle inventory
 * downloaded the build's wrapper distribution). Java runs outside the sandbox with only `PATH`, `JAVA_HOME` and `HOME`,
 * in a fresh directory holding only copies of the files: it parses text and runs none of it.
 */
export function gradleStrictCalls(gradleHome: string, run: RunProcess = runProcess): StrictCallParser {
  return async (files, tree) => {
    if (files.length === 0) return new Map();
    const lib = await distributionLib(gradleHome, tree);
    const classpath = (await readdir(lib)).filter((name) => name.endsWith(".jar") && JARS.some((jar) => jar.test(name))).map((name) => join(lib, name));
    if (classpath.length < JARS.length) throw new Error(`${lib} lacks the Groovy or Kotlin compiler jars the strict-pin check parses with`);
    const dir = await mkdtemp(join(tmpdir(), "strict-calls-"));
    try {
      // The suffix picks the parser: `.gradle.kts` for Kotlin, anything else Groovy.
      const copies = await Promise.all(files.map(async (file, index) => {
        const copy = join(dir, `${index}${file.path.endsWith(".kts") ? ".gradle.kts" : ".gradle"}`);
        await writeFile(copy, file.text);
        return copy;
      }));
      const env = Object.fromEntries(["PATH", "JAVA_HOME", "HOME"].flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]!]])));
      const java = process.env["JAVA_HOME"] === undefined ? "java" : join(process.env["JAVA_HOME"], "bin", "java");
      const result = await run(java, ["-cp", classpath.join(":"), PROGRAM, ...copies], { cwd: dir, env, timeoutMs: TIMEOUT_MS });
      // The source launcher warns on stderr even when it succeeds: only the exit code says whether it parsed.
      if (result.code !== 0) throw new Error(`the build files couldn't be parsed: ${result.stderr.trim().split("\n").filter((line) => !line.includes("warning")).slice(-3).join(" ")}`);
      const found = new Map<string, string[]>(files.map((file) => [file.path, []]));
      for (const line of result.stdout.split("\n")) {
        if (line === "") continue;
        const tab = line.indexOf("\t");
        const index = copies.indexOf(line.slice(0, tab));
        if (index < 0) throw new Error(`the strict-pin parser named an unknown file: ${line.slice(0, tab)}`);
        found.get(files[index]!.path)!.push(line.slice(tab + 1));
      }
      return found;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

/** `<gradleHome>/wrapper/dists/gradle-<version>-<type>/<hash>/gradle-<version>/lib` for `tree`'s wrapper. */
async function distributionLib(gradleHome: string, tree: Tree): Promise<string> {
  const properties = await tree.read(WRAPPER_PROPERTIES);
  const url = /^distributionUrl\s*[=:]\s*(\S+)/m.exec(properties ?? "")?.[1]?.replace(/\\:/g, ":");
  const match = url === undefined ? null : /gradle-([^/]+)-(bin|all)\.zip$/.exec(url);
  if (match === null) throw new Error(`no Gradle wrapper names the distribution whose compilers parse the build files (${WRAPPER_PROPERTIES})`);
  const [, version, type] = match;
  const dists = join(gradleHome, "wrapper", "dists", `gradle-${version}-${type}`);
  const hashes = await readdir(dists).catch(() => [] as string[]);
  for (const hash of hashes) {
    const lib = join(dists, hash, `gradle-${version}`, "lib");
    if ((await readdir(lib).catch(() => [] as string[])).length > 0) return lib;
  }
  throw new Error(`Gradle ${version}'s distribution isn't in ${dists}, so its compilers can't parse the build files`);
}

/** The tools' `GRADLE_USER_HOME`: their build cache's `gradle` folder (as `runSandboxed` sets it), else `~/.gradle`. */
export function gradleHome(buildCacheRoot: string | undefined): string {
  return buildCacheRoot === undefined ? join(homedir(), ".gradle") : join(buildCacheRoot, "gradle");
}
