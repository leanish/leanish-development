/**
 * The Groovy and Kotlin compiler jars the strict-pin parser runs (`gradle/StrictCalls.java`). Java runs them outside
 * the sandbox, so they never come from a folder sandboxed commands can write (the tools' Gradle cache is one): the tool
 * downloads Gradle's official distribution itself, checks it against the checksum Gradle publishes next to it (its
 * HTTPS is the root of trust, as for the Gradle wrapper), and keeps only the jars it needs in its state directory, each
 * re-checked against the recorded sha256 right before every run.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { runProcess, type RunProcess } from "../../ci/src/process.ts";
import { canonical, isInside } from "./osv-scanner.ts";

const DISTRIBUTIONS = "https://services.gradle.org/distributions";
/** The jars the parsers need, exactly one of each; their versions follow the distribution's. */
export const PARSER_JARS: ReadonlyArray<RegExp> = [
  /^groovy-\d[^/]*\.jar$/,
  /^kotlin-compiler-embeddable-[^/]+\.jar$/,
  /^kotlin-stdlib-\d[^/]*\.jar$/,
  /^kotlin-script-runtime-[^/]+\.jar$/,
  /^kotlin-reflect-[^/]+\.jar$/,
  /^kotlinx-coroutines-core-jvm-[^/]+\.jar$/,
  /^annotations-[^/]+\.jar$/,
  /^kotlin-daemon-embeddable-[^/]+\.jar$/,
];
/** A released or pre-release Gradle version, by whole segments: it becomes a URL and a folder name. */
const VERSION = /^\d{1,4}(\.\d{1,4}){1,2}(-(rc|milestone)-\d{1,4})?$/;
/** services.gradle.org redirects to downloads.gradle.org and GitHub's release assets. */
const MAX_REDIRECTS = 5;

export interface ParserJars {
  /** The jars, in `PARSER_JARS` order. */
  readonly classpath: ReadonlyArray<string>;
  /** Fails unless every jar is still the regular file, with the sha256, that was installed. */
  verify(): Promise<void>;
}

/** Where the parser's jars and input copies live, and what it must stay out of. */
export interface ParserHome {
  /** The tool's state directory, which sandboxed commands can't write outside its workspaces. */
  readonly stateDir: string;
  /** Every directory sandboxed commands may write. */
  readonly sandboxWritable: ReadonlyArray<string>;
  readonly fetch: typeof globalThis.fetch;
}

interface Manifest {
  readonly version: string;
  readonly distributionSha256: string;
  readonly jars: ReadonlyArray<{ readonly name: string; readonly sha256: string }>;
}

/** `name` under the tool's state directory, refused when any sandbox-writable directory holds it. */
export function protectedDir(home: ParserHome, name: string): string {
  // Canonical from here on: a symlink somewhere writable that points here could be retargeted between check and use.
  const dir = canonical(join(home.stateDir, "tools", name));
  const writable = home.sandboxWritable.find((root) => isInside(dir, root));
  if (writable !== undefined) throw new Error(`${dir} is inside ${writable}, which sandboxed commands can write`);
  return dir;
}

/** Gradle `version`'s parser jars, installed first when they aren't there yet. */
export async function gradleParserJars(home: ParserHome, version: string, run: RunProcess = runProcess): Promise<ParserJars> {
  if (!VERSION.test(version) || version.trim() !== version) throw new Error(`"${version}" isn't a Gradle version the strict-pin parser can install`);
  const root = protectedDir(home, "gradle-parsers");
  const dir = protectedDir(home, join("gradle-parsers", version));
  const existing = await readManifest(dir);
  if (existing !== undefined) return checked(dir, existing);
  await mkdir(root, { recursive: true });
  const staging = await mkdtemp(join(root, `.${version}-`));
  try {
    const manifest = await install(home, version, staging, run);
    try {
      await rename(staging, dir);
    } catch (err) {
      // Another run installed it meanwhile: its copy, checked like any other, is the one used.
      if (!["EEXIST", "ENOTEMPTY"].includes((err as NodeJS.ErrnoException).code ?? "")) throw err;
      const theirs = await readManifest(dir);
      if (theirs === undefined) throw err;
      return checked(dir, theirs);
    }
    return checked(dir, manifest);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function install(home: ParserHome, version: string, staging: string, run: RunProcess): Promise<Manifest> {
  const url = `${DISTRIBUTIONS}/gradle-${version}-bin.zip`;
  const expected = (await (await httpsGet(home.fetch, `${url}.sha256`)).text()).trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error(`${url}.sha256 isn't a sha256`);
  const zip = join(staging, "distribution.zip");
  const response = await httpsGet(home.fetch, url);
  await saveDistribution(response, zip, url);
  const actual = await sha256Of(zip);
  if (actual !== expected) throw new Error(`${url} doesn't match its published sha256`);
  const listed = await run("unzip", ["-Z1", zip]);
  if (listed.code !== 0) throw new Error(`listing ${url} failed: ${listed.stderr.trim()}`);
  const prefix = `gradle-${version}/lib/`;
  const names = listed.stdout.split("\n").filter((entry) => entry.startsWith(prefix)).map((entry) => entry.slice(prefix.length));
  const picked = PARSER_JARS.map((jar) => {
    const matches = names.filter((name) => jar.test(name));
    if (matches.length !== 1) throw new Error(`Gradle ${version}'s lib has ${matches.length} jars matching ${jar}, not one`);
    return matches[0]!;
  });
  const lib = join(staging, "lib");
  await mkdir(lib);
  const extracted = await run("unzip", ["-q", "-j", zip, ...picked.map((name) => `${prefix}${name}`), "-d", lib]);
  if (extracted.code !== 0) throw new Error(`extracting Gradle ${version}'s parser jars failed: ${extracted.stderr.trim()}`);
  await rm(zip);
  const manifest: Manifest = {
    version,
    distributionSha256: actual,
    jars: await Promise.all(picked.map(async (name) => ({ name, sha256: await regularFileSha256(join(lib, name)) }))),
  };
  await writeFile(join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  return manifest;
}

/** Streams a distribution to disk with a byte cap, regardless of the server's Content-Length. */
export async function saveDistribution(response: Response, path: string, url: string, maxBytes = 512 * 1024 * 1024): Promise<void> {
  if (response.body === null) throw new Error(`${url} has no body`);
  await pipeline(
    Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
    async function* (source) {
      let bytes = 0;
      for await (const chunk of source) {
        bytes += chunk.length;
        if (bytes > maxBytes) throw new Error(`${url} exceeds the distribution download limit of ${maxBytes} bytes`);
        yield chunk;
      }
    },
    createWriteStream(path, { flags: "wx" }),
  );
}

/** The parsed manifest of an installation, undefined when there's none; a damaged one fails. */
async function readManifest(dir: string): Promise<Manifest | undefined> {
  let text: string;
  try {
    text = await readFile(join(dir, "manifest.json"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  const invalid = `${dir}/manifest.json isn't a parser installation's manifest; remove ${dir} to reinstall it`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (err) {
    throw new Error(invalid, { cause: err });
  }
  const manifest = typeof parsed === "object" && parsed !== null ? parsed as Partial<Manifest> : undefined;
  const jars = manifest?.jars;
  const valid = manifest?.version === basename(dir) && typeof manifest.distributionSha256 === "string" && /^[a-f0-9]{64}$/.test(manifest.distributionSha256)
    && Array.isArray(jars) && jars.length === PARSER_JARS.length
    && jars.every((jar, index) => typeof jar?.name === "string" && PARSER_JARS[index]!.test(jar.name) && typeof jar.sha256 === "string" && /^[a-f0-9]{64}$/.test(jar.sha256));
  if (!valid) throw new Error(invalid);
  return parsed as Manifest;
}

async function checked(dir: string, manifest: Manifest): Promise<ParserJars> {
  const classpath = manifest.jars.map((jar) => join(dir, "lib", jar.name));
  const jars: ParserJars = {
    classpath,
    async verify() {
      for (const [index, jar] of manifest.jars.entries()) {
        const path = classpath[index]!;
        if (canonical(path) !== path || (await regularFileSha256(path)) !== jar.sha256) {
          throw new Error(`${path} isn't the parser jar that was installed; remove ${dir} to reinstall it`);
        }
      }
    },
  };
  await jars.verify();
  return jars;
}

/** GET over HTTPS only, every redirect included. */
async function httpsGet(fetch: typeof globalThis.fetch, url: string): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!current.startsWith("https://")) throw new Error(`refusing ${current}: the parser's distribution is only fetched over HTTPS`);
    const response = await fetch(current, { redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location === null) throw new Error(`${current} redirects without a location`);
      current = new URL(location, current).toString();
      continue;
    }
    if (!response.ok) throw new Error(`${current} failed with HTTP ${response.status}`);
    return response;
  }
  throw new Error(`${url} redirects more than ${MAX_REDIRECTS} times`);
}

async function regularFileSha256(path: string): Promise<string> {
  const stat = await lstat(path);
  if (!stat.isFile()) throw new Error(`${path} isn't a regular file`);
  return sha256Of(path);
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}
