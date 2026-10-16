/** Test-only compiler injection: no download and no trust placed in this writable cache by production code. */
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { RunProcess } from "../../ci/src/process.ts";
import { PARSER_JARS, type ParserHome, type ParserJars } from "../src/gradle-parsers.ts";
import { gradleStrictCalls } from "../src/strict-calls.ts";

export const LOCAL_GRADLE = (() => {
  const dists = join(homedir(), ".gradle", "wrapper", "dists");
  try {
    for (const name of readdirSync(dists)) {
      const version = /^gradle-([89]\.[\d.]+)-bin$/.exec(name)?.[1];
      if (version === undefined) continue;
      for (const hash of readdirSync(join(dists, name))) {
        const lib = join(dists, name, hash, `gradle-${version}`, "lib");
        let names: string[];
        try { names = readdirSync(lib); } catch { continue; }
        const matches = PARSER_JARS.map((family) => names.filter((jar) => family.test(jar)));
        if (matches.some((jars) => jars.length !== 1)) continue;
        const jars: ParserJars = { classpath: matches.map(([jar]) => join(lib, jar!)), verify: async () => {} };
        return { version, jars };
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return undefined;
})();

export const LOCAL_WRAPPER = {
  "gradle/wrapper/gradle-wrapper.properties": `distributionUrl=https\\://services.gradle.org/distributions/gradle-${LOCAL_GRADLE?.version}-bin.zip\n`,
};

export const noParserFetch: typeof globalThis.fetch = async () => { throw new Error("parser tests must not fetch"); };

export function localGradleParser(stateDir: string, run?: RunProcess) {
  const home: ParserHome = { stateDir, sandboxWritable: [], fetch: noParserFetch };
  return gradleStrictCalls(home, run, async (_home, version) => {
    if (LOCAL_GRADLE === undefined || version !== LOCAL_GRADLE.version) throw new Error(`no local Gradle ${version} compiler jars`);
    return LOCAL_GRADLE.jars;
  });
}
