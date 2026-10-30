import { describe, expect, it, vi } from "vitest";

import type { RunProcess } from "@leanish/gate/process";

import { Commands } from "../src/commands.ts";
import { exitCode } from "../src/contracts.ts";
import { doctor, type DoctorMachine } from "../src/doctor.ts";

function machine() {
  const files = new Set(["/usr/bin/security", "/usr/bin/lockf", "/home/.codex/auth.json"]);
  const bundles = new Map([["/Applications/ChatGPT.app", "com.openai.codex"], ["/Applications/Claude.app", "com.anthropic.claudefordesktop"]]);
  const outputs = new Map([
    ["node --version", "v24.0.0"], ["npm --version", "11.17.0"], ["git --version", "git version 2.42.0 (Apple Git-1)"],
    ["codex --version", "codex-cli 0.159.0"], ["claude --version", "2.1.312 (Claude Code)"],
    ["claude auth status --json", '{"loggedIn":true,"email":"private","token":"secret-sentinel"}'],
    ["java -version", 'openjdk version "25.0.1"'], ["javac -version", "javac 25.0.1"],
  ]);
  const failures = new Set<string>();
  const run = vi.fn<RunProcess>(async (command, args) => {
    const key = [command, ...args].join(" ");
    if (command === "/usr/bin/plutil") {
      expect(args.slice(0, 3)).toEqual(["-extract", "CFBundleIdentifier", "raw"]);
      const bundle = bundles.get(args[3]!.replace(/\/Contents\/Info\.plist$/, ""));
      return { code: failures.has(key) || bundle === undefined ? 1 : 0, stdout: bundle ?? "", stderr: "secret-sentinel" };
    }
    return { code: failures.has(key) ? 1 : 0, stdout: outputs.get(key) ?? "secret-sentinel", stderr: "secret-sentinel" };
  });
  const host: DoctorMachine = { commands: new Commands(run, { HOME: "/home" }), home: "/home", env: {}, platform: "darwin", arch: "arm64",
    exists: async (path) => files.has(path) || bundles.has(path),
    listDirectory: async (directory) => [...bundles.keys()].filter((path) => path.startsWith(directory + "/") && !path.slice(directory.length + 1).includes("/")).map((path) => path.slice(directory.length + 1)) };
  return { host, run, files, bundles, outputs, failures };
}

describe("doctor", () => {
  it("reports both usable agents as a choice, without exposing auth output", async () => {
    const { host, run } = machine();
    const results = await doctor({}, host);
    expect(exitCode(results)).toBe(2);
    expect(results.at(-1)).toMatchObject({ status: "needs-confirmation", data: { usable: ["codex", "claude-code"] } });
    expect(results.at(-1)?.data?.agents).toEqual([
      { agent: "codex", desktop: true, appPath: "/Applications/ChatGPT.app", cli: true, version: "0.159.0", login: true },
      { agent: "claude-code", desktop: true, appPath: "/Applications/Claude.app", cli: true, version: "2.1.312", login: true },
    ]);
    expect(JSON.stringify(results)).not.toMatch(/secret-sentinel|private/);
    expect(run.mock.calls.some(([command]) => command === "security")).toBe(false);
    expect(run.mock.calls.filter(([command]) => command === "codex").map(([, args]) => args[0])).toEqual(["--version", "sandbox", "login"]);
  });

  it("honors an explicit choice and accepts the exact requested JDK", async () => {
    const { host } = machine();
    const results = await doctor({ agent: "claude-code", java: 25 }, host);
    expect(exitCode(results)).toBe(0);
    expect(results.find((entry) => entry.step === "java")?.status).toBe("already-done");
    expect(results.at(-1)).toMatchObject({ data: { agent: "claude-code" } });
  });

  it("reports detected versions, paths, and platform in successful rows", async () => {
    const { host } = machine();
    const results = await doctor({ agent: "claude-code", java: 25 }, host);
    const data = Object.fromEntries(results.map((entry) => [entry.step, entry.data]));
    expect(data).toMatchObject({
      platform: { platform: "darwin", arch: "arm64" }, node: { version: "24.0.0" }, npm: { version: "11.17.0" }, git: { version: "2.42.0" },
      lockf: { path: "/usr/bin/lockf" }, keychain: { path: "/usr/bin/security" }, github: { hostname: "github.com", authenticated: true },
      "codex-cli": { version: "0.159.0" }, sandbox: { version: "0.159.0" },
      java: { version: "25.0.1", compilerVersion: "25.0.1", major: 25, compilerMajor: 25 },
      agent: { agent: "claude-code", version: "2.1.312", appPath: "/Applications/Claude.app" },
    });
    expect(results.filter((entry) => entry.status === "already-done").every((entry) => entry.data !== undefined)).toBe(true);
  });

  it("recognizes legacy JDK 8 version strings for both java and javac", async () => {
    const { host, outputs } = machine();
    outputs.set("java -version", 'java version "1.8.0_392"');
    outputs.set("javac -version", "javac 1.8.0_392");
    const results = await doctor({ agent: "codex", java: 8 }, host);
    expect(exitCode(results)).toBe(0);
    expect(results.find((entry) => entry.step === "java")).toMatchObject({ status: "already-done", data: {
      version: "1.8.0_392", compilerVersion: "1.8.0_392", major: 8, compilerMajor: 8,
    } });
    outputs.set("javac -version", "javac 1.7.0_80");
    expect((await doctor({ java: 8 }, host)).find((entry) => entry.step === "java")?.status).toBe("blocked");
  });

  it("checks JAVA_HOME's JDK instead of a different PATH JDK and reports the chosen executables", async () => {
    const { host, files, outputs, run } = machine();
    files.add("/jdk/bin/java");
    files.add("/jdk/bin/javac");
    outputs.set("/jdk/bin/java -version", 'openjdk version "21.0.8"');
    outputs.set("/jdk/bin/javac -version", "javac 21.0.8");
    const results = await doctor({ agent: "codex", java: 21 }, { ...host, env: { JAVA_HOME: "/jdk" } });
    expect(results.find((entry) => entry.step === "java")).toMatchObject({ status: "already-done", data: { java: "/jdk/bin/java", javac: "/jdk/bin/javac", source: "JAVA_HOME", major: 21 } });
    expect(run.mock.calls.some(([command]) => command === "java" || command === "javac")).toBe(false);
    expect((await doctor({ agent: "codex", java: 25 }, { ...host, env: { JAVA_HOME: "/jdk" } })).find((entry) => entry.step === "java")?.status).toBe("blocked");
  });

  it.each([undefined, "/missing-jdk"])("falls back to PATH when JAVA_HOME has no usable executable pair: %s", async (javaHome) => {
    const { host } = machine();
    const results = await doctor({ agent: "codex", java: 25 }, { ...host, env: javaHome === undefined ? {} : { JAVA_HOME: javaHome } });
    expect(results.find((entry) => entry.step === "java")).toMatchObject({ status: "already-done", data: { java: "java", javac: "javac", source: "PATH", major: 25 } });
  });

  it("does not return token-based gh authentication diagnostics", async () => {
    const { host, run } = machine();
    const auth = { GH_TOKEN: "secret-sentinel", GITHUB_TOKEN: "github-secret", GH_HOST: "github.com", GH_ENTERPRISE_TOKEN: "enterprise-secret" };
    const commands = new Commands(async (command, args, options) => {
      if (command === "gh") {
        expect(options?.env).toMatchObject(auth);
        return { code: 0, stdout: "secret-sentinel github-secret enterprise-secret", stderr: "secret-sentinel" };
      }
      expect(options?.env?.["GH_TOKEN"]).toBeUndefined();
      return run(command, args, options);
    }, auth);
    const results = await doctor({ agent: "codex" }, { ...host, commands });
    expect(results.find((entry) => entry.step === "github")?.status).toBe("already-done");
    expect(JSON.stringify(results)).not.toMatch(/secret-sentinel|github-secret|enterprise-secret/);
  });

  it.each(["codex", "claude-code"] as const)("selects %s when it is the only usable agent", async (agent) => {
    const { host, files, bundles } = machine();
    if (agent === "codex") bundles.delete("/Applications/Claude.app");
    else files.delete("/home/.codex/auth.json");
    const results = await doctor({}, host);
    expect(exitCode(results)).toBe(0);
    expect(results.at(-1)).toMatchObject({ data: { agent } });
  });

  it("accepts per-user app installs and custom CODEX_HOME without reading auth.json", async () => {
    const { host, files, bundles } = machine();
    bundles.delete("/Applications/ChatGPT.app");
    files.delete("/home/.codex/auth.json");
    bundles.set("/home/Applications/ChatGPT.app", "com.openai.codex");
    files.add("/custom/auth.json");
    expect(exitCode(await doctor({ agent: "codex" }, { ...host, env: { CODEX_HOME: "/custom" } }))).toBe(0);
  });

  it.each([
    ["codex", "/Applications/Work Assistant.app", "com.openai.codex"],
    ["claude-code", "/home/Applications/Renamed Claude.app", "com.anthropic.claudefordesktop"],
  ] as const)("finds renamed %s desktop apps by bundle identifier", async (agent, appPath, identifier) => {
    const { host, bundles } = machine();
    bundles.clear();
    bundles.set(appPath, identifier + "\n");
    const results = await doctor({ agent }, host);
    expect(exitCode(results)).toBe(0);
    expect(results.at(-1)?.data?.agents).toEqual(expect.arrayContaining([expect.objectContaining({ agent, desktop: true, appPath })]));
  });

  it("reports desktop absence even when both CLIs are logged in", async () => {
    const { host, bundles } = machine();
    bundles.clear();
    const results = await doctor({}, host);
    expect(results.at(-1)).toMatchObject({ status: "blocked", data: { usable: [], agents: [
      { agent: "codex", desktop: false, cli: true, login: true },
      { agent: "claude-code", desktop: false, cli: true, login: true },
    ] } });
  });

  it("ignores misleading filenames, unrelated bundle identifiers, and nested apps", async () => {
    const { host, bundles, run } = machine();
    bundles.clear();
    bundles.set("/Applications/Codex.app", "com.example.other");
    bundles.set("/Applications/Claude.app", "com.example.other");
    bundles.set("/Applications/Utilities/Nested.app", "com.openai.codex");
    bundles.set("/home/Applications/Utilities/Nested.app", "com.anthropic.claudefordesktop");
    bundles.set("/Applications/Backup.app.old", "com.openai.codex");
    expect((await doctor({}, host)).at(-1)).toMatchObject({ status: "blocked", data: { usable: [] } });
    expect(run.mock.calls.filter(([command]) => command === "/usr/bin/plutil")).toHaveLength(2);
  });

  it("does not accept an app whose plist probe fails", async () => {
    const { host, failures } = machine();
    failures.add("/usr/bin/plutil -extract CFBundleIdentifier raw /Applications/ChatGPT.app/Contents/Info.plist");
    const results = await doctor({ agent: "codex" }, host);
    expect(results.at(-1)?.status).toBe("blocked");
    expect(JSON.stringify(results)).not.toContain("secret-sentinel");
  });

  it("does not require Codex login for Claude, but always checks its sandbox", async () => {
    const { host, files, run } = machine();
    files.delete("/home/.codex/auth.json");
    expect(exitCode(await doctor({ agent: "claude-code" }, host))).toBe(0);
    expect(run.mock.calls.some(([command, args]) => command === "codex" && args[0] === "login")).toBe(false);
    expect(run.mock.calls.find(([command, args]) => command === "codex" && args[0] === "sandbox")?.[1]).toContain("permissions.setup-check.network.enabled=false");
  });

  it.each([["linux", "arm64"], ["darwin", "x64"]])("rejects %s/%s without executing programs", async (platform, arch) => {
    const { host, run } = machine();
    expect(exitCode(await doctor({}, { ...host, platform, arch }))).toBe(1);
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    ["node --version", "v23.9.0", "node"], ["npm --version", "11.16.0", "npm"], ["git --version", "git version 2.41.9", "git"],
    ["codex --version", "codex-cli 0.158.0", "codex-cli"], ["npm --version", "unparseable", "npm"],
    ["npm --version", "11.17.0-rc.1", "npm"],
  ])("blocks an old or unverifiable prerequisite: %s", async (command, output, step) => {
    const { host, outputs } = machine();
    outputs.set(command, output);
    expect((await doctor({ agent: "claude-code" }, host)).find((entry) => entry.step === step)?.status).toBe("blocked");
  });

  it("sandbox failure blocks Claude too, without an unsandboxed retry", async () => {
    const { host, run } = machine();
    const delegated = host.commands;
    const commands = new Commands(async (command, args) => args[0] === "sandbox" ? { code: 1, stdout: "", stderr: "secret-sentinel" } : delegated.probe(command, args));
    const results = await doctor({ agent: "claude-code" }, { ...host, commands });
    expect(results.find((entry) => entry.step === "sandbox")?.status).toBe("blocked");
    expect(run.mock.calls.some(([command]) => command === "/usr/bin/true")).toBe(false);
  });

  it.each(["/usr/bin/security", "/usr/bin/lockf"])("reports missing %s", async (file) => {
    const { host, files } = machine();
    files.delete(file);
    expect(exitCode(await doctor({ agent: "codex" }, host))).toBe(1);
  });

  it("does not choose an unavailable requested agent or treat a keyring-only login as usable", async () => {
    const { host, files } = machine();
    files.delete("/home/.codex/auth.json");
    expect((await doctor({ agent: "codex" }, host)).at(-1)?.status).toBe("blocked");
  });

  it.each(["not json", '{"loggedIn":false}', "null"])("fails closed on Claude authentication: %s", async (output) => {
    const { host, outputs } = machine();
    outputs.set("claude auth status --json", output);
    expect((await doctor({ agent: "claude-code" }, host)).at(-1)?.status).toBe("blocked");
  });

  it("requires the lowest verified Claude CLI version before checking its login", async () => {
    const { host, outputs, run } = machine();
    outputs.set("claude --version", "2.1.311 (Claude Code)");
    const results = await doctor({ agent: "claude-code" }, host);
    expect(results.at(-1)?.message).toContain("Claude requires CLI >=2.1.312");
    expect(results.at(-1)).toMatchObject({ status: "blocked", data: { agents: expect.arrayContaining([{ agent: "claude-code", desktop: true, appPath: "/Applications/Claude.app", cli: false, version: "2.1.311", login: false }]) } });
    expect(run.mock.calls.some(([command, args]) => command === "claude" && args[0] === "auth")).toBe(false);
  });

  it("rejects CLAUDE_CONFIG_DIR and a failed login or gh status", async () => {
    const { host, failures } = machine();
    expect((await doctor({ agent: "claude-code" }, { ...host, env: { CLAUDE_CONFIG_DIR: "/custom" } })).at(-1)?.status).toBe("blocked");
    failures.add("codex login status");
    failures.add("gh auth status --active --hostname github.com");
    const results = await doctor({ agent: "codex" }, host);
    expect(exitCode(results)).toBe(1);
    expect(results.find((entry) => entry.step === "github")?.status).toBe("blocked");
    expect(results.at(-1)?.status).toBe("blocked");
  });

  it("requires matching java and javac, and validates options before probing", async () => {
    const { host, outputs, run } = machine();
    await expect(doctor({ java: NaN }, host)).rejects.toThrow("JDK major");
    expect(run).not.toHaveBeenCalled();
    outputs.set("javac -version", "javac 21.0.1");
    expect((await doctor({ agent: "codex", java: 25 }, host)).find((entry) => entry.step === "java")?.status).toBe("blocked");
  });
});
