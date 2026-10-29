// New in this repository.
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { claudeCodeRunnerOptions, codexRunnerOptions, type IsolationPolicy, isolationPolicy, type IsolationSettings } from "../src/isolation.ts";
import { KeychainStore } from "../src/secret-store.ts";
import { ClaudeCodeRunner } from "../src/skill/claude-code-runner.ts";
import { CodexRunner } from "../src/skill/codex-runner.ts";

const SETTINGS: IsolationSettings = {
  commitIdentity: { name: "secure-it", email: "secure-it@example.com" },
  readDeny: ["/Users/dev/private-data"],
  commandPath: ["/opt/tool/guard"],
  releaseAgeDays: 7,
  releaseAgeExclude: [],
  buildCacheRoot: "/Users/dev/.cache/leanish/secure-it",
};
const HOME = "/Users/dev";

describe("isolationPolicy", () => {
  it("denies the sensitive home paths that exist and the configured ones, and gives the agent the configured identity", () => {
    const existing = new Set([`${HOME}/.ssh`, `${HOME}/.gitconfig`, `${HOME}/Library/Keychains`]);
    const options = isolationPolicy(SETTINGS, { home: HOME, env: { PATH: "/usr/bin:/bin" }, exists: (path) => existing.has(path) });
    expect(options.readDenied).toEqual([
      `${HOME}/.ssh`,
      `${HOME}/.gitconfig`,
      `${HOME}/Library/Keychains`,
      "/Users/dev/private-data",
      `${HOME}/.codex/auth.json`,
    ]);
    expect(options.loginHome).toBe(`${HOME}/.codex`);
    expect(options.buildCacheRoot).toBe(SETTINGS.buildCacheRoot);
    expect(options.env).toEqual({
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.excludesFile",
      GIT_CONFIG_VALUE_0: "/dev/null",
      npm_config_userconfig: "/dev/null",
      npm_config_ignore_scripts: "true",
      npm_config_min_release_age: "7",
      PATH: "/opt/tool/guard:/usr/bin:/bin",
      GIT_AUTHOR_NAME: "secure-it",
      GIT_AUTHOR_EMAIL: "secure-it@example.com",
      GIT_COMMITTER_NAME: "secure-it",
      GIT_COMMITTER_EMAIL: "secure-it@example.com",
    });
  });

  it("sets no git identity when none is given, leaving the rest of the env alone", () => {
    const machine = { home: HOME, env: { PATH: "/usr/bin:/bin" }, exists: () => false };
    const named = isolationPolicy(SETTINGS, machine);
    const anonymous = isolationPolicy({ ...SETTINGS, commitIdentity: undefined }, machine);
    const identityFree = Object.entries(named.env ?? {}).filter(([name]) => !/^GIT_(AUTHOR|COMMITTER)_/.test(name));
    expect(identityFree).toHaveLength(Object.keys(named.env ?? {}).length - 4);
    expect(anonymous.env).toEqual(Object.fromEntries(identityFree));
    expect(anonymous.readDenied).toEqual(named.readDenied);
  });

  it("reuses $CODEX_HOME's login and the repository's release age, its trusted scopes exempt", () => {
    const options = isolationPolicy({ ...SETTINGS, releaseAgeDays: 3, releaseAgeExclude: ["@leanish/*", "@acme/*"], commandPath: [] }, { home: HOME, env: { CODEX_HOME: "/opt/codex" }, exists: () => false });
    expect(options.loginHome).toBe("/opt/codex");
    expect(options.readDenied).toContain("/opt/codex/auth.json");
    expect(options.env?.["npm_config_min_release_age"]).toBe("3");
    expect(options.env?.["npm_config_min_release_age_exclude"]).toBe("@leanish/*,@acme/*");
    expect(options.env?.["PATH"]).toBeUndefined();
  });

  it("denies the resolved login file when CODEX_HOME is relative", () => {
    const options = isolationPolicy(SETTINGS, {
      home: HOME,
      env: { CODEX_HOME: "custom-codex-home" },
      exists: () => false,
    });

    expect(options.loginHome).toBe(resolve("custom-codex-home"));
    expect(options.readDenied).toContain(resolve("custom-codex-home", "auth.json"));
  });

  it("denies a custom login symlink and its canonical target without reading either", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "codex-isolation-"));
    try {
      const loginHome = join(fixtureRoot, "custom-codex-home");
      const targetAuth = join(fixtureRoot, "auth-fixture.json");
      await mkdir(loginHome);
      await writeFile(targetAuth, "test fixture only");
      await symlink(targetAuth, join(loginHome, "auth.json"));
      const canonicalAuth = await realpath(targetAuth);

      const options = isolationPolicy(SETTINGS, {
        home: HOME,
        env: { CODEX_HOME: loginHome },
      });

      expect(options.loginHome).toBe(loginHome);
      expect(options.readDenied).toContain(join(loginHome, "auth.json"));
      expect(options.readDenied).toContain(canonicalAuth);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("refuses relative paths, a negative or fractional release age, and an exclusion npm would split", () => {
    const machine = { home: HOME, env: {}, exists: () => false };
    expect(() => isolationPolicy({ ...SETTINGS, readDeny: ["private"] }, machine)).toThrow("must be absolute; got 'private'");
    expect(() => isolationPolicy({ ...SETTINGS, commandPath: ["guard"] }, machine)).toThrow("got 'guard'");
    expect(() => isolationPolicy({ ...SETTINGS, releaseAgeDays: -1 }, machine)).toThrow("non-negative integer");
    expect(() => isolationPolicy({ ...SETTINGS, releaseAgeDays: 1.5 }, machine)).toThrow("non-negative integer");
    expect(() => isolationPolicy({ ...SETTINGS, releaseAgeExclude: ["@a/*,@b/*"] }, machine)).toThrow("no comma");
  });
});

describe("runner adapters", () => {
  const machine = { home: HOME, env: { PATH: "/usr/bin:/bin" }, exists: (path: string) => path === `${HOME}/.ssh` };
  // What `codexIsolation` returned for SETTINGS on this machine before the policy became agent-neutral.
  const ENV = {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.excludesFile",
    GIT_CONFIG_VALUE_0: "/dev/null",
    npm_config_userconfig: "/dev/null",
    npm_config_ignore_scripts: "true",
    npm_config_min_release_age: "7",
    PATH: "/opt/tool/guard:/usr/bin:/bin",
    GIT_AUTHOR_NAME: "secure-it",
    GIT_AUTHOR_EMAIL: "secure-it@example.com",
    GIT_COMMITTER_NAME: "secure-it",
    GIT_COMMITTER_EMAIL: "secure-it@example.com",
  };
  const READ_DENIED = [`${HOME}/.ssh`, "/Users/dev/private-data", `${HOME}/.codex/auth.json`];
  const LAMBDA: IsolationPolicy = { buildCacheRoot: "/tmp/agent-runtime-cache", readDenied: [], env: {} };

  it("gives Codex the options codexIsolation gave it", () => {
    expect(codexRunnerOptions(isolationPolicy(SETTINGS, machine))).toStrictEqual({
      loginHome: `${HOME}/.codex`,
      buildCacheRoot: SETTINGS.buildCacheRoot,
      readDenied: READ_DENIED,
      env: ENV,
    });
  });

  it("gives Claude Code the options the tools' field-by-field conversion gave it, without the Codex login", () => {
    expect(claudeCodeRunnerOptions(isolationPolicy(SETTINGS, machine), "sandbox")).toStrictEqual({
      confinement: "sandbox",
      env: ENV,
      readDenied: READ_DENIED,
      buildCacheRoot: SETTINGS.buildCacheRoot,
    });
  });

  it("keeps the runners' tuning, which can't replace the policy", () => {
    const policy = isolationPolicy(SETTINGS, machine);
    // A plain-JavaScript caller could pass policy fields as tuning; the policy wins.
    const codexTuning = { bin: "/opt/codex", timeoutMs: 1_000, readDenied: [], env: { PATH: "/evil" } } as unknown as Parameters<typeof codexRunnerOptions>[1];
    const codex = codexRunnerOptions(policy, codexTuning);
    expect(codex).toMatchObject({ bin: "/opt/codex", timeoutMs: 1_000, readDenied: READ_DENIED, env: ENV });
    const claudeTuning = { bin: "/opt/claude", captureCapBytes: 10, confinement: "sandbox", buildCacheRoot: "/elsewhere" } as unknown as Parameters<typeof claudeCodeRunnerOptions>[2];
    const claude = claudeCodeRunnerOptions(policy, "restricted", claudeTuning);
    expect(claude).toMatchObject({ bin: "/opt/claude", captureCapBytes: 10, confinement: "restricted", buildCacheRoot: SETTINGS.buildCacheRoot });
    // Nor link a login the policy doesn't name: its auth.json wouldn't be denied.
    const login = { loginHome: "/home/someone/.codex" } as unknown as Parameters<typeof codexRunnerOptions>[1];
    expect(codexRunnerOptions(LAMBDA, login)).not.toHaveProperty("loginHome");
    expect(codexRunnerOptions(policy, login).loginHome).toBe(policy.loginHome);
  });

  it("denies the login a hand-made policy links, even when the policy doesn't", () => {
    const linked = codexRunnerOptions({ ...LAMBDA, loginHome: "/synthetic/codex-home" });
    expect(linked).toMatchObject({ loginHome: "/synthetic/codex-home", readDenied: ["/synthetic/codex-home/auth.json"] });
    // A policy that already denies it lists it once.
    expect(codexRunnerOptions({ ...LAMBDA, loginHome: "/synthetic/codex-home", readDenied: ["/synthetic/codex-home/auth.json"] }).readDenied)
      .toEqual(["/synthetic/codex-home/auth.json"]);
  });

  it("accepts a Lambda function's hand-made policy, with no settings, home or login", () => {
    expect(codexRunnerOptions(LAMBDA)).toStrictEqual({ buildCacheRoot: "/tmp/agent-runtime-cache", readDenied: [], env: {} });
    expect(claudeCodeRunnerOptions(LAMBDA, "restricted")).toStrictEqual({ confinement: "restricted", env: {}, readDenied: [], buildCacheRoot: "/tmp/agent-runtime-cache" });
    expect(() => new CodexRunner(codexRunnerOptions(LAMBDA))).not.toThrow();
    expect(() => new ClaudeCodeRunner(claudeCodeRunnerOptions(LAMBDA, "restricted"))).not.toThrow();
  });

  it("refuses a policy with relative paths, a missing cache or non-string env values, in either adapter", () => {
    const invalid: ReadonlyArray<readonly [unknown, string]> = [
      [{ ...LAMBDA, readDenied: ["private"] }, "readDenied entries must be absolute paths; got 'private'"],
      [{ ...LAMBDA, readDenied: "/private" }, "readDenied must be an array"],
      [{ ...LAMBDA, readDenied: ["/private", undefined] }, "readDenied entries must be absolute paths; got 'undefined'"],
      // A hole in the array, as a plain-JavaScript caller might leave.
      [{ ...LAMBDA, readDenied: ["/private", , "/other"] }, "readDenied entries must be absolute paths; got 'undefined'"],
      [{ readDenied: [], env: {} }, "buildCacheRoot must be an absolute path; got 'undefined'"],
      [{ ...LAMBDA, buildCacheRoot: "cache" }, "buildCacheRoot must be an absolute path; got 'cache'"],
      [{ ...LAMBDA, loginHome: ".codex" }, "loginHome must be an absolute path when given; got '.codex'"],
      [{ ...LAMBDA, env: { npm_config_min_release_age: 7 } }, "env values must be strings; npm_config_min_release_age isn't"],
      [{ ...LAMBDA, env: undefined }, "env must be an object of strings"],
      [undefined, "the isolation policy must be an object"],
    ];
    for (const [policy, message] of invalid) {
      expect(() => codexRunnerOptions(policy as IsolationPolicy)).toThrow(`codexRunnerOptions: ${message}`);
      expect(() => claudeCodeRunnerOptions(policy as IsolationPolicy, "restricted")).toThrow(`claudeCodeRunnerOptions: ${message}`);
    }
  });
});

describe("KeychainStore", () => {
  it("reads a generic password by service name, without its trailing newline", async () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const store = new KeychainStore(async (args) => {
      calls.push(args);
      return { code: 0, stdout: "s3cret\n" };
    });
    expect(await store.get("secure-it-github")).toBe("s3cret");
    expect(calls).toEqual([["find-generic-password", "-s", "secure-it-github", "-w"]]);
  });

  it("fails on a missing or empty item, never echoing what security printed", async () => {
    const missing = new KeychainStore(async () => ({ code: 44, stdout: "leaked?" }));
    await expect(missing.get("secure-it-github")).rejects.toThrow("no Keychain item for service 'secure-it-github' (security exited 44)");
    await expect(missing.get("secure-it-github")).rejects.not.toThrow("leaked");
    const empty = new KeychainStore(async () => ({ code: 0, stdout: "\n" }));
    await expect(empty.get("secure-it-github")).rejects.toThrow("is empty");
  });

  it("refuses a service name that isn't a plain identifier", async () => {
    const store = new KeychainStore(async () => ({ code: 0, stdout: "x" }));
    await expect(store.get("-s other")).rejects.toThrow("Keychain service names are");
  });
});
