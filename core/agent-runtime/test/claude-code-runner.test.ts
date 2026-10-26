// Copied from leanish/leanish-development core/runtime/test/unit/claude-code-runner.test.ts at c6282df; see PROVENANCE.md.
// Local changes: imports this package's modules from `../src/` instead of `../../src/`; stub binaries speak stream-json;
// write access, usage and failure reasons are covered.
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { ClaudeCodeRunner, claudeSettings, DENIED_TOOLS, RESTRICTED_TOOLS, restrictedClaudeSettings, scrubProxyCredentials } from "../src/skill/claude-code-runner.ts";
import { SkillLoader } from "../src/skill/skill-loader.ts";
import type { LoadedSkill } from "../src/skill/skill.ts";
import type { WorkingCopy } from "../src/types/working-copy.ts";
import type { SkillUsage } from "../src/usage/skill-usage.ts";

const ASK_FILE = `---
name: ask
description: Test
inputSchema: { type: object }
outputSchema: { type: object }
---

# ask
`;

/** Stage a real on-disk skill so `fs.cp` has something to copy. */
async function makeAskSkill(): Promise<LoadedSkill> {
  const dir = await mkdtemp(join(tmpdir(), "agent-runtime-runner-skill-"));
  await mkdir(join(dir, "ask"), { recursive: true });
  await writeFile(join(dir, "ask", "SKILL.md"), ASK_FILE);
  return new SkillLoader({ skillsDirs: [dir] }).loadEntrypoint("ask");
}

const ANSWER = '```json\n{"answer": "fake answer"}\n```';

const init = (model = "claude-x") => ({ type: "system", subtype: "init", model });
const message = (id: string, usage: Record<string, unknown>, model = "claude-x") => ({ type: "assistant", message: { id, model, usage, content: [] } });
const result = (text: string, extra: Record<string, unknown> = {}) => ({ type: "result", subtype: "success", is_error: false, result: text, ...extra });

/**
 * A stub `claude` that records its cwd, argv (one per line) and a few env vars into `<dir>/record`,
 * prints `events` as stream-json lines, writes `stderr` and exits with `exitCode`.
 */
async function makeStub(events: ReadonlyArray<unknown>, options: { exitCode?: number; stderr?: string; script?: string } = {}): Promise<{ bin: string; record: string }> {
  const dir = await mkdtemp(join(tmpdir(), "agent-runtime-fake-claude-"));
  const record = join(dir, "record");
  await writeFile(join(dir, "events.jsonl"), events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  const bin = join(dir, "claude");
  await writeFile(
    bin,
    `#!/bin/sh
{
  echo "CWD=$(pwd)"
  for arg in "$@"; do echo "ARG=$arg"; done
  echo "ENV BASE=[$BASE_VAR] OVERLAP=[$OVERLAP_VAR] CRED=[$CRED_VAR] GRADLE=[$GRADLE_USER_HOME] ZDOTDIR=[$ZDOTDIR] MEMORY=[$CLAUDE_CODE_DISABLE_AUTO_MEMORY] ASKPASS=[$GIT_ASKPASS]"
  [ -n "$ZDOTDIR" ] && [ -f "$ZDOTDIR/.zshenv" ] && echo "SHIM=present"
} > "${record}"
${options.script ?? ""}
cat "${join(dir, "events.jsonl")}"
${options.stderr !== undefined ? `echo "${options.stderr}" >&2` : ""}
exit ${options.exitCode ?? 0}
`,
  );
  await chmod(bin, 0o755);
  return { bin, record };
}

const args = (record: string) => record.split("\n").filter((line) => line.startsWith("ARG=")).map((line) => line.slice(4));
const settingsOf = (record: string) => JSON.parse(args(record)[args(record).indexOf("--settings") + 1]!) as Record<string, any>;

/** A working copy whose git metadata lives outside the tree, as the tools' workspace makes them. */
async function separateGitCopy(): Promise<WorkingCopy> {
  const root = await mkdtemp(join(tmpdir(), "claude-runner-wc-"));
  const path = join(root, "tree");
  const gitDir = join(root, "git");
  await mkdir(path);
  execFileSync("git", ["init", "-q", `--separate-git-dir=${gitDir}`, path]);
  return { projectId: "p", path, gitDir, branch: "main", headSha: "0".repeat(40) };
}

describe("ClaudeCodeRunner (against a stub binary)", () => {
  let askSkill: LoadedSkill;

  beforeAll(async () => {
    askSkill = await makeAskSkill();
  });

  const call = (extra: Partial<Parameters<ClaudeCodeRunner["run"]>[0]> = {}) => ({
    entrypoint: askSkill,
    supportSkills: [],
    renderedArguments: "question: What does X do?",
    workingCopies: [],
    ...extra,
  });

  it("stages skills, invokes the entrypoint by its plugin namespace and returns the result text", async () => {
    const { bin, record } = await makeStub([init(), result(ANSWER)]);
    const answer = await new ClaudeCodeRunner({ confinement: "sandbox", bin }).run(call());
    expect(answer.responseText).toContain('"answer": "fake answer"');
    const text = await readFile(record, "utf8");
    expect(args(text).slice(0, 4)).toEqual(["--print", "--output-format", "stream-json", "--verbose"]);
    expect(args(text).slice(6, 9)).toEqual(["--no-session-persistence", "--setting-sources", ""]);
    // The prompt is the last argument: the namespaced command, the rendered YAML on its own line, then the answer's
    // schema (Claude Code doesn't show the skill's frontmatter, where it lives).
    expect(text).toContain("ARG=/agent-runtime-staged:ask\nquestion: What does X do?\nThe skill's frontmatter (not shown to you) defines its answer");
    expect(text).toContain(JSON.stringify(askSkill.outputSchema, null, 2));
  });

  it("loads no MCP servers, using strict MCP configuration without a supplied config", async () => {
    const { bin, record } = await makeStub([result(ANSWER)]);
    await new ClaudeCodeRunner({ confinement: "sandbox", bin }).run(call());
    const argv = args(await readFile(record, "utf8"));
    expect(argv).toContain("--strict-mcp-config");
    expect(argv.some((arg) => arg === "--mcp-config" || arg.startsWith("--mcp-config="))).toBe(false);
  });

  it("mounts the first working copy as cwd and the rest via --add-dir", async () => {
    const wc1 = await mkdtemp(join(tmpdir(), "claude-runner-wc1-"));
    const wc2 = await mkdtemp(join(tmpdir(), "claude-runner-wc2-"));
    const { bin, record } = await makeStub([result(ANSWER)]);
    await new ClaudeCodeRunner({ confinement: "sandbox", bin }).run(call({
      workingCopies: [
        { projectId: "p1", path: wc1, branch: "main", headSha: "0".repeat(40) },
        { projectId: "p2", path: wc2, branch: "main", headSha: "0".repeat(40) },
      ],
    }));
    const text = await readFile(record, "utf8");
    // realpath canonicalisation may resolve symlinks on macOS — match the basename.
    expect(text).toMatch(new RegExp(`CWD=.*${wc1.replace(/^.*\//, "")}`));
    const argv = args(text);
    expect(argv[argv.indexOf("--add-dir") + 1]).toBe(wc2);
    // `--add-dir` takes any number of values, so the prompt comes after `--`, not as one more directory.
    expect(argv.at(-2)).toBe("--");
    // The stub records one line per argument line: the prompt's first line is its command.
    expect(argv.at(-1)).toBe("/agent-runtime-staged:ask");
  });

  it("runs without a working copy in an empty directory of its own, removed afterwards", async () => {
    const { bin, record } = await makeStub([result(ANSWER)]);
    await new ClaudeCodeRunner({ confinement: "sandbox", bin }).run(call());
    const cwd = /^CWD=(.*)$/m.exec(await readFile(record, "utf8"))![1]!;
    expect(cwd).toMatch(/claude-code-runner-empty-/);
    expect(existsSync(cwd)).toBe(false);
    // Removed when the run fails too.
    const failing = await makeStub([], { exitCode: 3, stderr: "boom" });
    await expect(new ClaudeCodeRunner({ confinement: "sandbox", bin: failing.bin }).run(call())).rejects.toThrow();
    const failedCwd = /^CWD=(.*)$/m.exec(await readFile(failing.record, "utf8"))![1]!;
    expect(failedCwd).toMatch(/claude-code-runner-empty-/);
    expect(existsSync(failedCwd)).toBe(false);
  });

  it("merges per-invocation env over the runner's configured base and isolates the commands' shell", async () => {
    const { bin, record } = await makeStub([result(ANSWER)]);
    await new ClaudeCodeRunner({ confinement: "sandbox", bin, env: { BASE_VAR: "from-runner", OVERLAP_VAR: "from-runner" } }).run(
      call({ env: { OVERLAP_VAR: "from-invocation", CRED_VAR: "tok" } }),
    );
    const text = await readFile(record, "utf8");
    expect(text).toContain("BASE=[from-runner] OVERLAP=[from-invocation] CRED=[tok]");
    expect(text).toMatch(/ZDOTDIR=\[[^\]]+zdotdir\] MEMORY=\[1\]/);
    expect(text).toContain("SHIM=present");
  });

  it("passes --effort through, mapping the suite-level `minimal` to the CLI's `low`", async () => {
    for (const [effort, expected] of [["high", "high"], ["minimal", "low"]] as const) {
      const { bin, record } = await makeStub([result(ANSWER)]);
      await new ClaudeCodeRunner({ confinement: "sandbox", bin }).run(call({ effort }));
      const argv = args(await readFile(record, "utf8"));
      expect(argv[argv.indexOf("--effort") + 1]).toBe(expected);
    }
  });

  it("grants write access inside the sandbox: edits in the working copy, git metadata and denied paths out of reach", async () => {
    const workingCopy = await separateGitCopy();
    const cache = await mkdtemp(join(tmpdir(), "claude-runner-cache-"));
    const deniedDir = await mkdtemp(join(tmpdir(), "claude-runner-denied-"));
    const deniedFile = join(deniedDir, "secret.txt");
    await writeFile(deniedFile, "x");
    const { bin, record } = await makeStub([result(ANSWER)]);
    await new ClaudeCodeRunner({ confinement: "sandbox", bin, buildCacheRoot: cache, readDenied: [deniedDir.replace(/$/, "-other"), deniedFile] }).run(
      call({ workingCopies: [workingCopy], access: "write", env: { GH_TOKEN: "ghs_read" }, secrets: [{ name: "GH_TOKEN", value: "ghs_read" }] }),
    );
    const text = await readFile(record, "utf8");
    const argv = args(text);
    expect(argv[argv.indexOf("--session-id") + 1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(argv[argv.indexOf("--permission-prompts") + 1]).toBe("none");
    const settings = settingsOf(text);
    expect(settings.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false });
    expect(settings.sandbox.filesystem.denyWrite).toEqual([workingCopy.gitDir, join(workingCopy.path, ".git")]);
    expect(settings.sandbox.filesystem.allowWrite).toEqual(expect.arrayContaining([cache, realpathSync("/tmp")]));
    expect(settings.sandbox.network).toEqual({ allowedDomains: ["*"], allowLocalBinding: true });
    expect(settings.sandbox.enableWeakerNetworkIsolation).toBe(true);
    expect(settings.permissions.allow).toEqual(["Bash"]);
    expect(settings.permissions.deny).toEqual([
      `Read(/${deniedDir}-other)`, `Read(/${deniedDir}-other/**)`, `Read(/${deniedFile})`, `Edit(/${workingCopy.gitDir}/**)`, `Edit(/${join(workingCopy.path, ".git")})`, ...DENIED_TOOLS,
    ]);
    expect(settings.permissions.deny).toEqual(expect.arrayContaining([
      "Artifact", "ArtifactComments", "ArtifactData", "ShareOnboardingGuide", "DesignSync", "PushNotification", "SendMessage",
      "RemoteTrigger", "CronCreate", "CronDelete", "ScheduleWakeup", "Workflow", "WebFetch", "WebSearch",
      "EnterWorktree", "ExitWorktree", "ListAgents", "Monitor", "Task", "Agent",
    ]));
    expect(settings.disableAllHooks).toBe(true);
    expect(settings.claudeMdExcludes).toContain("**/CLAUDE.md");
    expect(settings).toMatchObject({ includeCoAuthoredBy: false, attribution: { commit: "", pr: "" } });
    expect(text).toContain(`GRADLE=[${join(cache, "gradle")}]`);
    expect(text).toMatch(/ASKPASS=\[.+git-askpass\]/);
  });

  it("keeps read-only runs off the network and out of the working copies", () => {
    const settings = claudeSettings({ access: "read-only", workingCopies: ["/wc"], gitDirs: [], writableRoots: [], readDenied: [], home: "/home/u", sessionDir: "/home/u/.claude/projects/-wc/s" });
    expect(settings).toMatchObject({
      sandbox: { filesystem: { allowWrite: [], denyWrite: ["/wc"], denyRead: [] }, network: { allowedDomains: [] }, enableWeakerNetworkIsolation: false },
      permissions: { allow: ["Bash"], deny: ["Edit(//wc/.git)", ...DENIED_TOOLS] },
      claudeMdExcludes: ["**/CLAUDE.md", "**/CLAUDE.local.md", "/home/u/.claude/CLAUDE.md"],
    });
    expect(settings["disableAllHooks"]).toBe(true);
  });

  it("leaves the account's connectors, Claude Code's bundled skills and its authoring plugin out of every run", () => {
    for (const access of ["read-only", "write"] as const) {
      const settings = claudeSettings({ access, workingCopies: ["/wc"], gitDirs: [], writableRoots: [], readDenied: [], home: "/home/u", sessionDir: "/home/u/.claude/projects/-wc/s" });
      expect(settings).toMatchObject({ disableClaudeAiConnectors: true, disableBundledSkills: true, enabledPlugins: { "cc-plugin-plugin-authoring@builtin": false } });
    }
  });

  it("re-opens only the session's own output directory inside a denied ~/.claude, for Bash", () => {
    const claudeHome = "/home/u/.claude";
    const sessionDir = `${claudeHome}/projects/-wc-tree/0b2c`;
    const settings = claudeSettings({ access: "write", workingCopies: ["/wc/tree"], gitDirs: [], writableRoots: [], readDenied: [claudeHome, "/x"], home: "/home/u", sessionDir });
    expect(settings).toMatchObject({ sandbox: { filesystem: { denyRead: [claudeHome, "/x"], allowRead: [sessionDir] } } });
    // The file tools already can't leave the working copies; a ~/.claude rule would also hide the session's own outputs.
    expect((settings["permissions"] as { deny: string[] }).deny).toEqual(["Read(//x)", "Read(//x/**)", "Edit(//wc/tree/.git)", ...DENIED_TOOLS]);
  });

  it("refuses a write run without a working copy before spawning, reporting zero usage once", async () => {
    const stagingParentDir = await mkdtemp(join(tmpdir(), "claude-runner-staging-"));
    const { bin } = await makeStub([result(ANSWER)]);
    const usages: SkillUsage[] = [];
    await expect(new ClaudeCodeRunner({ confinement: "sandbox", bin, stagingParentDir }).run(call({ access: "write", onUsage: (usage) => usages.push(usage) })))
      .rejects.toThrowError(/needs at least one working copy/);
    expect(await readdir(stagingParentDir)).toEqual([]);
    expect(usages).toEqual([
      expect.objectContaining({ measurement: "complete", tokens: expect.objectContaining({ total: 0 }), quota: { status: "not-applicable", reason: "no provider call was made" } }),
    ]);
  });

  it("propagates non-zero exit codes with the stderr tail, keeping the usage streamed so far", async () => {
    const usages: SkillUsage[] = [];
    const { bin } = await makeStub([init(), message("m1", { input_tokens: 10, output_tokens: 2 })], { exitCode: 7, stderr: "boom" });
    await expect(new ClaudeCodeRunner({ confinement: "sandbox", bin }).run(call({ onUsage: (usage) => usages.push(usage) }))).rejects.toThrowError(/exited with code 7.*boom/);
    expect(usages[0]).toMatchObject({ measurement: "partial", model: "claude-x", tokens: { input: 10, output: 2, total: 12 } });
    expect(usages[0]?.gaps).toEqual([expect.stringMatching(/no terminal result event/)]);
  });

  it("fails on an error result or a missing result event", async () => {
    const failed = await makeStub([result("ran out of turns", { subtype: "error_max_turns", is_error: true })]);
    await expect(new ClaudeCodeRunner({ confinement: "sandbox", bin: failed.bin }).run(call())).rejects.toThrowError(/ended with error_max_turns: ran out of turns/);
    const silent = await makeStub([init()]);
    await expect(new ClaudeCodeRunner({ confinement: "sandbox", bin: silent.bin }).run(call())).rejects.toThrowError(/without a result event/);
  });

  it("reports tokens per request, the CLI's cost and the plan windows it saw", async () => {
    const usages: SkillUsage[] = [];
    const window = (five: number, seven: number) => ({
      type: "rate_limit_event",
      rate_limit_info: { unifiedWindows: { five_hour: { utilization: five, resetsAt: 1000 }, seven_day: { utilization: seven, resetsAt: 2000 } } },
    });
    const { bin } = await makeStub([
      init("claude-sonnet-x"),
      window(0.1, 0.5),
      message("m1", { input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, output_tokens: 1 }, "claude-sonnet-x"),
      message("m1", { input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, output_tokens: 4 }, "claude-sonnet-x"),
      message("m2", { input_tokens: 2, cache_read_input_tokens: 130, cache_creation_input_tokens: 0, output_tokens: 3 }, "claude-sonnet-x"),
      window(0.12, 0.51),
      result(ANSWER, {
        total_cost_usd: 0.0123,
        modelUsage: {
          "claude-sonnet-x": { inputTokens: 7, cacheReadInputTokens: 230, cacheCreationInputTokens: 20, outputTokens: 30, thinkingTokens: 5 },
          "claude-haiku-x": { inputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 10 },
        },
      }),
    ]);
    const answer = await new ClaudeCodeRunner({ confinement: "sandbox", bin }).run(call({ model: "claude-sonnet-x", onUsage: (usage) => usages.push(usage) }));
    expect(answer.model).toBeUndefined();
    const usage = usages[0]!;
    expect(usage).toMatchObject({ measurement: "complete", model: "claude-sonnet-x", providerCostUsd: 0.0123, gaps: [] });
    const sonnet = usage.models.find((model) => model.model === "claude-sonnet-x")!;
    // What the terminal totals add (here only output the events hadn't counted) goes to the largest request, now inexact.
    expect(sonnet.requests).toEqual([
      { tokens: { input: 125, cachedInput: 100, cacheWriteInput: 20, output: 4, reasoningOutput: 0, total: 129 }, exact: true },
      { tokens: { input: 132, cachedInput: 130, cacheWriteInput: 0, output: 26, reasoningOutput: 5, total: 158 }, exact: false },
    ]);
    expect(usage.models.find((model) => model.model === "claude-haiku-x")?.requests).toEqual([
      { tokens: { input: 50, cachedInput: 0, cacheWriteInput: 0, output: 10, reasoningOutput: 0, total: 60 }, exact: false },
    ]);
    expect(usage.tokens).toEqual({ input: 307, cachedInput: 230, cacheWriteInput: 20, output: 40, reasoningOutput: 5, total: 347 });
    expect(usage.quota).toMatchObject({ status: "observed", windows: [
      { limitId: "claude", window: "primary", beforePercent: 10, afterPercent: 12, changePercentPoints: 2 },
      { limitId: "claude", window: "secondary", beforePercent: 50, afterPercent: 51, changePercentPoints: 1 },
    ] });
  });

  it("fails with the reason the CLI reported on stdout when the process exits non-zero with nothing on stderr", async () => {
    const limited = await makeStub(
      [init(), result("", { subtype: "error_during_execution", is_error: true, errors: ["You've hit your limit · resets 5pm"] })],
      { exitCode: 1 },
    );
    await expect(new ClaudeCodeRunner({ confinement: "sandbox", bin: limited.bin }).run(call())).rejects.toThrowError(/exited with code 1.*the CLI reported: You've hit your limit · resets 5pm/s);
  });

  it("keeps the sandbox proxy's credentials out of the answer and of failures", async () => {
    const leaky = "Picked up JAVA_TOOL_OPTIONS: -Dhttps.proxyUser=srt.abc -Dhttps.proxyPassword=s3cret via http://srt.abc:s3cret@localhost:1";
    const ok = await makeStub([result(`${leaky}\n${ANSWER}`)]);
    const answer = await new ClaudeCodeRunner({ confinement: "sandbox", bin: ok.bin }).run(call());
    expect(answer.responseText).not.toContain("s3cret");
    expect(answer.responseText).toContain("proxyPassword=<redacted>");
    const failed = await makeStub([result(leaky, { subtype: "error_during_execution", is_error: true })], { exitCode: 1 });
    const error = await new ClaudeCodeRunner({ confinement: "sandbox", bin: failed.bin }).run(call()).catch((err: Error) => err);
    expect((error as Error).message).toContain("http://<redacted>@localhost:1");
    expect((error as Error).message).not.toContain("s3cret");
    expect(scrubProxyCredentials("proxyUser=srt.x proxyPassword=y")).toBe("proxyUser=<redacted> proxyPassword=<redacted>");
  });

  it("refuses a denied path with a glob character, which a permission rule would read as a pattern", () => {
    expect(() => new ClaudeCodeRunner({ confinement: "sandbox", readDenied: ["/work/repo/secrets[prod].json"] })).toThrowError(/'\/work\/repo\/secrets\[prod\]\.json' has a glob character/);
    expect(() => new ClaudeCodeRunner({ confinement: "sandbox", readDenied: ["/work/private"] })).not.toThrow();
  });

  it("refuses a relocated Claude config dir before spawning", async () => {
    const { bin, record } = await makeStub([result(ANSWER)]);
    await expect(new ClaudeCodeRunner({ confinement: "sandbox", bin, env: { CLAUDE_CONFIG_DIR: "/elsewhere" } }).run(call())).rejects.toThrowError(/CLAUDE_CONFIG_DIR \('\/elsewhere'\) isn't supported/);
    await expect(readFile(record, "utf8")).rejects.toThrowError(/ENOENT/);
  });

  it("scrubs a failure's reason before cutting it short, so a cut can't leave part of a credential", async () => {
    const reason = `${"p".repeat(10)} -Dhttps.proxyPassword=s3cretvalue ${"y".repeat(1985)}`;
    const { bin } = await makeStub([result(reason, { subtype: "error_during_execution", is_error: true })], { exitCode: 1 });
    const error = (await new ClaudeCodeRunner({ confinement: "sandbox", bin }).run(call()).catch((err: Error) => err)) as Error;
    expect(error.message).not.toMatch(/cretvalue/);
  });

  it("fails a run that succeeded when cleaning up fails, saying what was left behind", async () => {
    const stagingParentDir = await mkdtemp(join(tmpdir(), "claude-runner-staging-"));
    // The CLI makes its staged dir undeletable (the shell's ZDOTDIR lives in it).
    const { bin } = await makeStub([result(ANSWER)], { script: 'chmod 500 "$ZDOTDIR/.."' });
    try {
      await expect(new ClaudeCodeRunner({ confinement: "sandbox", bin, stagingParentDir }).run(call())).rejects.toThrowError(/the run ended, but cleaning up failed: the staged skills and shell/);
    } finally {
      for (const dir of await readdir(stagingParentDir)) await chmod(join(stagingParentDir, dir), 0o700);
    }
  });

  it("needs a confinement named, at runtime too", () => {
    expect(() => new ClaudeCodeRunner({} as never)).toThrow("confinement must be 'sandbox' or 'restricted', not 'undefined'");
    expect(() => new ClaudeCodeRunner({ confinement: "none" } as never)).toThrow("not 'none'");
  });

  it("runs restricted with only the read tools, no sandbox, and Bash, edits and the network denied", async () => {
    const { bin, record } = await makeStub([result(ANSWER)]);
    await new ClaudeCodeRunner({ confinement: "restricted", bin }).run(call());
    const text = await readFile(record, "utf8");
    const argv = args(text);
    expect(argv.slice(argv.indexOf("--restricted"), argv.indexOf("--restricted") + 3)).toEqual(["--restricted", "--tools", "Read,Glob,Grep,Skill"]);
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("default");
    expect(settingsOf(text)).toEqual(restrictedClaudeSettings({ readDenied: [], home: homedir() }));
    // A sandboxed run gets neither switch.
    const sandboxed = await makeStub([result(ANSWER)]);
    await new ClaudeCodeRunner({ confinement: "sandbox", bin: sandboxed.bin }).run(call());
    const sandboxedArgs = args(await readFile(sandboxed.record, "utf8"));
    expect(sandboxedArgs).not.toContain("--restricted");
    expect(sandboxedArgs).not.toContain("--tools");
  });

  it("pins a restricted run's settings: no sandbox, the denied paths and tools, and what every run gets", () => {
    expect(RESTRICTED_TOOLS).toEqual(["Read", "Glob", "Grep", "Skill"]);
    expect(restrictedClaudeSettings({ readDenied: ["/x"], home: "/home/u" })).toEqual({
      permissions: { deny: ["Read(//x)", "Read(//x/**)", "Bash", "Edit", "Write", "NotebookEdit", ...DENIED_TOOLS] },
      claudeMdExcludes: ["**/CLAUDE.md", "**/CLAUDE.local.md", "/home/u/.claude/CLAUDE.md"],
      includeCoAuthoredBy: false,
      attribution: { commit: "", pr: "" },
      autoMemoryEnabled: false,
      disableAllHooks: true,
      disableClaudeAiConnectors: true,
      disableBundledSkills: true,
      enabledPlugins: { "cc-plugin-plugin-authoring@builtin": false },
    });
  });

  it("refuses a write run when restricted, before staging anything or spawning", async () => {
    const stagingParentDir = await mkdtemp(join(tmpdir(), "claude-runner-staging-"));
    const wc = await separateGitCopy();
    const { bin, record } = await makeStub([result(ANSWER)]);
    const usages: SkillUsage[] = [];
    await expect(new ClaudeCodeRunner({ confinement: "restricted", bin, stagingParentDir }).run(call({ workingCopies: [wc], access: "write", onUsage: (usage) => usages.push(usage) })))
      .rejects.toThrow("access 'write' needs the 'sandbox' confinement");
    expect(await readdir(stagingParentDir)).toEqual([]);
    expect(existsSync(record)).toBe(false);
    expect(usages).toEqual([expect.objectContaining({ tokens: expect.objectContaining({ total: 0 }), quota: { status: "not-applicable", reason: "no provider call was made" } })]);
  });

  it("cleans up its staged dir and its empty working directory after a timeout", async () => {
    const stagingParentDir = await mkdtemp(join(tmpdir(), "claude-runner-staging-"));
    const { bin, record } = await makeStub([result(ANSWER)], { script: "sleep 5" });
    await expect(new ClaudeCodeRunner({ confinement: "sandbox", bin, stagingParentDir, timeoutMs: 200 }).run(call())).rejects.toThrowError(/did not return within 200ms/);
    expect(await readdir(stagingParentDir)).toEqual([]);
    const cwd = /^CWD=(.*)$/m.exec(await readFile(record, "utf8"))![1]!;
    expect(existsSync(cwd)).toBe(false);
  });
});
