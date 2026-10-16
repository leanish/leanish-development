import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RunProcess } from "../../ci/src/process.ts";
import type { Tree } from "../../ci/src/tree.ts";
import { protectedDir, type ParserHome, type ParserJars } from "../src/gradle-parsers.ts";
import { gradleStrictCalls } from "../src/strict-calls.ts";
import { noParserFetch } from "./local-gradle-parser.ts";

let state: string;
beforeEach(async () => { state = await mkdtemp(join(tmpdir(), "strict-calls-test-")); });
afterEach(async () => { await rm(state, { recursive: true, force: true }); });
const tree = (properties = "distributionUrl=https\\://untrusted.example/gradle-9.1.0-all.zip"): Tree => ({
  id: "test", read: async () => properties, list: async () => [],
});
const files = [{ path: "sub/build.gradle", text: "\uFEFFstrictly('1.0')" }, { path: "build.gradle.kts", text: 'strictly("1.0")' }];
const home = (): ParserHome => ({ stateDir: state, sandboxWritable: [join(state, "writable")], fetch: noParserFetch });

function compilers() {
  const verify = vi.fn(async () => {});
  const jars: ParserJars = { classpath: ["/protected/groovy.jar", "/protected/kotlin.jar"], verify };
  return { jars, verify, install: vi.fn(async () => jars) };
}

describe("gradleStrictCalls", () => {
  it("uses only the wrapper's version and injected classpath, with inputs under protected state and verification immediately before Java", async () => {
    const events: string[] = [];
    let copies: ReadonlyArray<string> = [];
    const { jars, verify, install } = compilers();
    const run: RunProcess = async (command, args, options) => {
      events.push("run");
      expect(command).toMatch(/java$/);
      expect(args.slice(0, 2)).toEqual(["-cp", jars.classpath.join(":")]);
      expect(options?.timeoutMs).toBe(120_000);
      expect(Object.keys(options!.env!)).toEqual(expect.arrayContaining(["PATH", "HOME"]));
      expect(Object.keys(options!.env!).every((key) => ["PATH", "HOME", "JAVA_HOME"].includes(key))).toBe(true);
      for (const path of copies) expect(dirname(path)).toBe(options!.cwd);
      expect(dirname(options!.cwd!)).toBe(protectedDir(home(), "strict-calls"));
      expect(options!.cwd).not.toBe(tmpdir());
      expect(copies[1]).toMatch(/\.gradle\.kts$/);
      return { code: 0, stdout: `${copies[0]}\tcall\tstrictly('1.0')\n${copies[1]}\terror\tbad ${copies[1]}\n`, stderr: "warning: benign" };
    };
    // Capture filenames when verify runs, after all input writes but before the launch.
    verify.mockImplementation(async () => {
      const parent = protectedDir(home(), "strict-calls");
      const runs = await readdir(parent);
      const dir = join(parent, runs[0]!);
      copies = (await readdir(dir)).map((name) => join(dir, name));
      expect(await readFile(copies[0]!, "utf8")).toBe("strictly('1.0')");
      events.push("verify");
    });
    const findings = await gradleStrictCalls(home(), run, install)(files, tree("  distributionUrl=https\\://ignored.example/\\\r\n  gradle-9.1.0-all.zip\r\n"));
    expect(install).toHaveBeenCalledWith(home(), "9.1.0");
    expect(events).toEqual(["verify", "run"]);
    expect(findings).toEqual(new Map([[files[0]!.path, ["call\tstrictly('1.0')"]], [files[1]!.path, ["error\tbad build.gradle.kts"]]]));
    expect(await readdir(protectedDir(home(), "strict-calls"))).toEqual([]);
  });

  it.each(["verify", "launch", "exit", "timeout", "unknown-file"])("removes input copies after a %s failure", async (failure) => {
    const { verify, install } = compilers();
    if (failure === "verify") verify.mockRejectedValue(new Error("jar changed"));
    const run = vi.fn<RunProcess>(async () => {
      if (failure === "launch") throw new Error("spawn java ENOENT");
      return { code: failure === "exit" ? 1 : failure === "timeout" ? 128 : 0, stdout: failure === "unknown-file" ? "unknown\tcall\tx\n" : "", stderr: "parser failed" };
    });
    const reason = { verify: "jar changed", launch: "Java isn't available", exit: "couldn't be parsed", timeout: "was stopped, past its 120s limit", "unknown-file": "unknown file" }[failure]!;
    await expect(gradleStrictCalls(home(), run, install)(files, tree())).rejects.toThrow(reason);
    if (failure === "verify") expect(run).not.toHaveBeenCalled();
    expect(await readdir(protectedDir(home(), "strict-calls"))).toEqual([]);
  });

  it("refuses writable input state before launching Java", async () => {
    const { install } = compilers();
    const run = vi.fn<RunProcess>();
    await expect(gradleStrictCalls({ ...home(), sandboxWritable: [state] }, run, install)(files, tree())).rejects.toThrow("which sandboxed commands can write");
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    "https://example.com/custom-gradle.zip",
    "https://example.com/gradle-9.1.0-bin.zip?download=1",
  ])("refuses a wrapper URL without the required distribution filename suffix: %s", async (url) => {
    const { install } = compilers();
    const run = vi.fn<RunProcess>();
    await expect(gradleStrictCalls(home(), run, install)(files, tree(`distributionUrl=${url}`))).rejects.toThrow("no Gradle wrapper names the distribution");
    expect(install).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("doesn't install compilers without inputs or a readable wrapper version", async () => {
    const { install } = compilers();
    const parse = gradleStrictCalls(home(), undefined, install);
    expect(await parse([], tree())).toEqual(new Map());
    await expect(parse(files, tree(""))).rejects.toThrow("no Gradle wrapper names");
    expect(install).not.toHaveBeenCalled();
  });
});
