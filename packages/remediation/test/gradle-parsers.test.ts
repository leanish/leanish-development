import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runProcess } from "../../ci/src/process.ts";
import { gradleParserJars, PARSER_JARS, protectedDir, saveDistribution, type ParserHome } from "../src/gradle-parsers.ts";

const VERSION = "9.1.0";
const URL = `https://services.gradle.org/distributions/gradle-${VERSION}-bin.zip`;
const JARS = ["groovy-4.0.jar", "kotlin-compiler-embeddable-2.0.jar", "kotlin-stdlib-2.0.jar", "kotlin-script-runtime-2.0.jar",
  "kotlin-reflect-2.0.jar", "kotlinx-coroutines-core-jvm-1.0.jar", "annotations-24.0.jar", "kotlin-daemon-embeddable-2.0.jar"];
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "gradle-parsers-test-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function fixture(names = JARS) {
  const source = join(root, "source");
  const lib = join(source, `gradle-${VERSION}`, "lib");
  await mkdir(lib, { recursive: true });
  for (const name of names) await writeFile(join(lib, name), `fake jar ${name}`);
  const zip = join(root, "distribution.zip");
  const zipped = await runProcess("zip", ["-q", zip, ...names.map((name) => `gradle-${VERSION}/lib/${name}`)], { cwd: source });
  expect(zipped.code, zipped.stderr).toBe(0);
  const bytes = await readFile(zip);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, options) => {
    expect(options?.redirect).toBe("manual");
    const url = String(input);
    if (url === `${URL}.sha256`) return new Response(`${sha256}\n`);
    if (url === URL) return new Response(null, { status: 301, headers: { location: "https://downloads.gradle.org/first" } });
    if (url === "https://downloads.gradle.org/first") return new Response(null, { status: 307, headers: { location: "/distribution.zip" } });
    if (url === "https://downloads.gradle.org/distribution.zip") return new Response(new Uint8Array(bytes));
    throw new Error(`unexpected fetch ${url}`);
  });
  // Tests use fake fetch and explicit writable roots; production also excludes all temp directories.
  const home: ParserHome = { stateDir: join(root, "state"), sandboxWritable: [source], fetch };
  return { home, fetch, sha256 };
}

describe("protected Gradle parser jars", () => {
  it("installs exactly one jar per family through HTTPS 301/307 redirects and reuses a checked warm installation", async () => {
    const { home, fetch, sha256 } = await fixture();
    const installed = await gradleParserJars(home, VERSION);
    expect(installed.classpath.map((path) => path.slice(path.lastIndexOf("/") + 1))).toEqual(JARS);
    expect(installed.classpath).toHaveLength(PARSER_JARS.length);
    await installed.verify();
    const dir = join(home.stateDir, "tools", "gradle-parsers", VERSION);
    expect(await readdir(dir)).toEqual(expect.arrayContaining(["lib", "manifest.json"]));
    expect(JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")))
      .toMatchObject({ version: VERSION, distributionSha256: sha256, jars: JARS.map((name) => ({ name, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) })) });
    expect(await readdir(dirname(dir))).toEqual([VERSION]);
    fetch.mockClear();
    const noUnzip = vi.fn(async () => { throw new Error("must reuse the installation"); });
    const reused = await gradleParserJars(home, VERSION, noUnzip);
    expect(reused.classpath).toEqual(installed.classpath);
    expect(fetch).not.toHaveBeenCalled();
    expect(noUnzip).not.toHaveBeenCalled();
  });

  it("refuses a distribution whose published checksum doesn't match and removes staging", async () => {
    const { home, fetch } = await fixture();
    fetch.mockImplementationOnce(async () => new Response("0".repeat(64)));
    await expect(gradleParserJars(home, VERSION)).rejects.toThrow("doesn't match its published sha256");
    expect(await readdir(protectedDir(home, "gradle-parsers"))).toEqual([]);
  });

  it("refuses a non-HTTPS hop before requesting it", async () => {
    const { home, fetch } = await fixture();
    const original = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (input, options) => String(input) === "https://downloads.gradle.org/first"
      ? new Response(null, { status: 307, headers: { location: "http://downloads.gradle.org/untrusted.zip" } })
      : original(input, options));
    await expect(gradleParserJars(home, VERSION)).rejects.toThrow("only fetched over HTTPS");
    expect(fetch.mock.calls.some(([url]) => String(url).startsWith("http:"))).toBe(false);
  });

  it.each([
    ["missing", JARS.slice(1), "0 jars matching"],
    ["duplicate", [...JARS, "groovy-4.1.jar"], "2 jars matching"],
  ] as const)("refuses a %s jar family", async (_kind, names, message) => {
    const { home } = await fixture([...names]);
    await expect(gradleParserJars(home, VERSION)).rejects.toThrow(message);
    expect(await readdir(protectedDir(home, "gradle-parsers"))).toEqual([]);
  });

  it("rechecks installed jars before each use and on warm lookup", async () => {
    const { home } = await fixture();
    const installed = await gradleParserJars(home, VERSION);
    await writeFile(installed.classpath[0]!, "replaced jar");
    await expect(installed.verify()).rejects.toThrow("isn't the parser jar that was installed");
    await expect(gradleParserJars(home, VERSION)).rejects.toThrow("isn't the parser jar that was installed");
  });

  it("reports a truncated JSON manifest with the remove-and-reinstall hint", async () => {
    const { home, fetch } = await fixture();
    await gradleParserJars(home, VERSION);
    const dir = join(protectedDir(home, "gradle-parsers"), VERSION);
    await writeFile(join(dir, "manifest.json"), '{"version":');
    fetch.mockClear();
    await expect(gradleParserJars(home, VERSION)).rejects.toThrow(`remove ${dir} to reinstall it`);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["version", "distributionSha256", "jars"])("refuses a damaged manifest's %s", async (key) => {
    const { home, fetch } = await fixture();
    await gradleParserJars(home, VERSION);
    const path = join(protectedDir(home, "gradle-parsers"), VERSION, "manifest.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    manifest[key] = "invalid";
    await writeFile(path, JSON.stringify(manifest));
    fetch.mockClear();
    await expect(gradleParserJars(home, VERSION)).rejects.toThrow("isn't a parser installation's manifest");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a symlinked jar even with identical bytes", async () => {
    const { home } = await fixture();
    const installed = await gradleParserJars(home, VERSION);
    const path = installed.classpath[0]!;
    const elsewhere = join(root, "same.jar");
    await copyFile(path, elsewhere);
    await rm(path);
    await symlink(elsewhere, path);
    await expect(installed.verify()).rejects.toThrow("isn't the parser jar that was installed");
  });

  it("refuses state inside any sandbox-writable root, including a symlinked ancestor", async () => {
    const { home, fetch } = await fixture();
    await expect(gradleParserJars({ ...home, sandboxWritable: [root] }, VERSION)).rejects.toThrow("which sandboxed commands can write");
    const alias = join(root, "alias");
    await mkdir(join(root, "writable"));
    await symlink(join(root, "writable"), alias);
    expect(() => protectedDir({ ...home, stateDir: join(alias, "state"), sandboxWritable: [join(root, "writable")] }, "strict-calls"))
      .toThrow("which sandboxed commands can write");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a version directory that is itself a sandbox-writable root", async () => {
    const { home, fetch } = await fixture();
    const writable = join(home.stateDir, "tools", "gradle-parsers", VERSION);
    await expect(gradleParserJars({ ...home, sandboxWritable: [writable] }, VERSION)).rejects.toThrow("which sandboxed commands can write");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["../x", "9..1", "9.1\n"])("refuses bad version %s before any download or filesystem use", async (version) => {
    const { home, fetch } = await fixture();
    await expect(gradleParserJars(home, version)).rejects.toThrow("isn't a Gradle version");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("bounded distribution streaming", () => {
  it("accepts a stream exactly at the byte limit", async () => {
    const path = join(root, "bounded.zip");
    await saveDistribution(new Response("12345678"), path, URL, 8);
    expect(await readFile(path, "utf8")).toBe("12345678");
  });

  it.each([undefined, "1"])("refuses past the streamed limit with Content-Length=%s and cancels the source", async (length) => {
    let pulls = 0;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { pulls++; controller.enqueue(new Uint8Array([1, 2, 3, 4])); },
      cancel,
    });
    const response = new Response(body, { headers: length === undefined ? {} : { "content-length": length } });
    const path = join(root, "bounded.zip");
    await expect(saveDistribution(response, path, URL, 8)).rejects.toThrow(`${URL} exceeds the distribution download limit of 8 bytes`);
    expect((await readFile(path)).length).toBeLessThanOrEqual(8);
    expect(cancel).toHaveBeenCalledOnce();
    expect(pulls).toBeLessThan(10);
  });
});
