import { describe, expect, it, vi } from "vitest";

import type { RunProcess } from "@leanish/gate/process";

import { Commands, commandEnvironment } from "../src/commands.ts";

describe("setup subprocess boundary", () => {
  it("allowlists environment, passes literal arguments without a shell, and bounds duration", async () => {
    const env = { HOME: "/home", USER: "developer", LOGNAME: "developer", PATH: "/bin", GH_TOKEN: "secret", NODE_OPTIONS: "injection", GIT_CONFIG_COUNT: "1", npm_config_ignore_scripts: "false", JAVA_HOME: "/jdk" };
    expect(commandEnvironment(env)).toEqual({ HOME: "/home", USER: "developer", LOGNAME: "developer", PATH: "/bin", JAVA_HOME: "/jdk" });
    const run = vi.fn(async () => ({ code: 0, stdout: "ok\n", stderr: "" }));
    const commands = new Commands(run, env);
    expect(await commands.checked("git", ["show", "literal;$(command)"], "Failed", "/release")).toBe("ok");
    expect(run.mock.calls).toEqual([["git", ["show", "literal;$(command)"], { cwd: "/release", timeoutMs: 300_000, env: {
      HOME: "/home", USER: "developer", LOGNAME: "developer", PATH: "/bin", JAVA_HOME: "/jdk", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
    } }]]);
  });

  it("preserves USER and LOGNAME when probing Claude's Keychain-backed login", async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: '{"loggedIn":true}', stderr: "" }));
    const commands = new Commands(run, { USER: "developer", LOGNAME: "login-name", GH_TOKEN: "secret" });
    await commands.probe("claude", ["auth", "status", "--json"]);
    expect(run.mock.calls).toEqual([["claude", ["auth", "status", "--json"], {
      cwd: undefined, env: { USER: "developer", LOGNAME: "login-name" }, timeoutMs: 30_000,
    }]]);
  });

  it("forwards GitHub login environment only to gh probes", async () => {
    const github = { GH_TOKEN: "gh-secret", GITHUB_TOKEN: "github-secret", GH_HOST: "github.example.com", GH_ENTERPRISE_TOKEN: "enterprise-secret" };
    const env = { HOME: "/home", USER: "developer", ...github, NODE_OPTIONS: "injection" };
    const run = vi.fn<RunProcess>(async () => ({ code: 0, stdout: "ok", stderr: "" }));
    const commands = new Commands(run, env);
    await commands.probe("gh", ["auth", "status"]);
    expect(run.mock.calls[0]![2]?.env).toEqual({ HOME: "/home", USER: "developer", ...github });
    for (const command of ["claude", "codex", "git", "npm"]) await commands.probe(command, ["--version"]);
    await commands.checked("gh", ["api"], "Failed");
    await commands.checked("git", ["show"], "Failed");
    await commands.checked("npm", ["ci"], "Failed");
    for (const [, , options] of run.mock.calls.slice(1)) {
      for (const name of Object.keys(github)) expect(options?.env?.[name]).toBeUndefined();
      expect(options?.env?.["NODE_OPTIONS"]).toBeUndefined();
    }
  });

  it("never reflects child output or spawn errors in reported failures", async () => {
    for (const run of [async () => ({ code: 1, stdout: "secret", stderr: "secret" }), async () => { throw new Error("secret"); }]) {
      const commands = new Commands(run, {});
      await expect(commands.checked("gh", ["api"], "GitHub read failed")).rejects.toThrow(/^GitHub read failed$/);
      expect((await commands.probe("gh", ["auth", "status"])).code).not.toBe(0);
    }
  });
});
