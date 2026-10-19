import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { statSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { main, type SetupActions } from "../src/cli.ts";
import { result } from "../src/contracts.ts";
import { batch } from "../src/batch.ts";
import { parseToolConfig } from "@leanish/tool-runtime/config";

function actions(): SetupActions {
  return {
    doctor: vi.fn(async () => [result("doctor", "agent", "already-done", "Ready", { agent: "codex" })]),
    release: vi.fn(async () => result("release", "checkout", "changed", "Installed")),
    configure: vi.fn(async () => result("configure", "config", "changed", "Configured")),
    enroll: vi.fn(async () => result("enroll", "keychain", "needs-confirmation", "Use your terminal")),
    verifyTokens: vi.fn(async () => result("verify-tokens", "permissions", "blocked", "Unknown permissions")),
    gate: vi.fn(async () => [result("gate", "workflow", "changed", "PR ready")]),
    batch: vi.fn(async (_options, emit) => { emit('{"action":"summary"}'); return 0; }),
    schedule: vi.fn(async () => result("schedule", "task", "needs-confirmation", "Create the app task")),
    scheduleCheck: vi.fn(async () => result("schedule-check", "task", "already-done", "Matches")),
    fixtureCleanup: vi.fn(async () => [result("fixture-cleanup", "summary", "needs-confirmation", "Dry run")]),
    fixtureRepin: vi.fn(async () => [result("fixture-repin", "summary", "needs-confirmation", "Dry run")]),
  };
}

describe("setup command contract", () => {
  const releaseCommands = [
    { command: "gate", args: ["--repo", "acme/one"] },
    { command: "batch", args: ["bump-it", "--owner", "acme"] },
    { command: "schedule", args: ["bump-it", "--owner", "acme", "--agent", "codex"] },
    { command: "schedule-check", args: ["bump-it", "--owner", "acme", "--agent", "codex", "--task-file", "/tmp/observed.json"] },
    { command: "test-run", args: ["bump-it", "--owner", "acme", "--repo", "acme/one"] },
  ];

  it.each(releaseCommands.flatMap((entry) => ["v0.7.0-rc.1", "v0.7.0+build", "0.7.0", "v01.7.0", "v1.2", "../escape", "secret-sentinel"].map((tag) => ({ ...entry, tag }))))("rejects unstable or malformed release tags for $command: $tag", async ({ command, args, tag }) => {
    const handlers = actions();
    const emit = vi.fn();
    expect(await main([command, ...args, "--release", tag], emit, handlers)).toBe(64);
    expect(JSON.parse(emit.mock.calls[0]![0])).toMatchObject({ command, step: "arguments", status: "blocked", message: expect.stringContaining("--release must be a stable vX.Y.Z tag; prerelease/rc tags") });
    expect(JSON.stringify(emit.mock.calls)).not.toContain("secret-sentinel");
    for (const action of Object.values(handlers)) expect(action).not.toHaveBeenCalled();
  });

  it.each(releaseCommands)("accepts stable release tags for $command", async ({ command, args }) => {
    expect(await main([command, ...args, "--release", "v1.2.3"], () => {}, actions())).not.toBe(64);
  });

  it("dispatches doctor arguments and emits versioned JSONL only", async () => {
    const handlers = actions();
    const lines: string[] = [];
    expect(await main(["doctor", "--agent", "claude-code", "--java", "25"], (line) => lines.push(line), handlers)).toBe(0);
    expect(handlers.doctor).toHaveBeenCalledWith({ agent: "claude-code", java: 25 });
    expect(handlers.release).not.toHaveBeenCalled();
    expect(lines.map((line) => JSON.parse(line))).toEqual([{ schemaVersion: 1, command: "doctor", step: "agent", status: "already-done", message: "Ready", data: { agent: "codex" } }]);
  });

  it("dispatches release without options", async () => {
    const handlers = actions();
    const emit = vi.fn();
    expect(await main(["release"], emit, handlers)).toBe(0);
    expect(handlers.release).toHaveBeenCalledWith();
    expect(handlers.doctor).not.toHaveBeenCalled();
    expect(JSON.parse(emit.mock.calls[0]![0])).toMatchObject({ command: "release", status: "changed" });
  });

  it.each([[], ["install"], ["release", "--agent", "codex"], ["doctor", "extra"], ["doctor", "--agent", "other"],
    ["doctor", "--java", "7"], ["doctor", "--java", "25x"], ["doctor", "--java", "9007199254740992"], ["doctor", "--token", "secret-sentinel"]].map((argv) => ({ argv })))("rejects invalid arguments before side effects: $argv", async ({ argv }) => {
    const handlers = actions();
    const lines: string[] = [];
    expect(await main(argv, (line) => lines.push(line), handlers)).toBe(64);
    expect(handlers.doctor).not.toHaveBeenCalled();
    expect(handlers.release).not.toHaveBeenCalled();
    expect(JSON.parse(lines[0]!)).toMatchObject({ schemaVersion: 1, step: "arguments", status: "blocked" });
    expect(lines.join("")).not.toContain("secret-sentinel");
  });

  it.each([
    ["already-done", 0], ["changed", 0], ["needs-confirmation", 2], ["blocked", 1],
  ] as const)("maps %s to exit %i", async (status, code) => {
    expect(await main(["doctor"], () => {}, { ...actions(), doctor: async () => [result("doctor", "agent", status, "Check")] })).toBe(code);
  });

  it("dispatches fixture-cleanup as a dry run unless --apply is given", async () => {
    const handlers = actions();
    const configs = ["--bump-it-config", "/b.yaml", "--secure-it-config", "/s.yaml"];
    expect(await main(["fixture-cleanup", ...configs], () => {}, handlers)).toBe(2);
    expect(handlers.fixtureCleanup).toHaveBeenLastCalledWith({ bumpItConfig: "/b.yaml", secureItConfig: "/s.yaml", repo: undefined, apply: false }, expect.any(Function));
    await main(["fixture-cleanup", ...configs, "--repo", "acme/leanish-development_TEST_one", "--apply"], () => {}, handlers);
    expect(handlers.fixtureCleanup).toHaveBeenLastCalledWith({ bumpItConfig: "/b.yaml", secureItConfig: "/s.yaml", repo: "acme/leanish-development_TEST_one", apply: true }, expect.any(Function));
  });

  it("dispatches fixture-repin with its stable release", async () => {
    const handlers = actions();
    const configs = ["--bump-it-config", "/b.yaml", "--secure-it-config", "/s.yaml"];
    expect(await main(["fixture-repin", ...configs, "--release", "v0.7.0", "--apply"], () => {}, handlers)).toBe(2);
    expect(handlers.fixtureRepin).toHaveBeenLastCalledWith({ bumpItConfig: "/b.yaml", secureItConfig: "/s.yaml", repo: undefined, apply: true, release: "v0.7.0" }, expect.any(Function));
    expect(handlers.fixtureCleanup).not.toHaveBeenCalled();
  });

  it.each([
    ["fixture-repin", "--bump-it-config", "/b.yaml", "--secure-it-config", "/s.yaml"],
    ["fixture-repin", "--bump-it-config", "/b.yaml", "--secure-it-config", "/s.yaml", "--release", "v0.7.0-rc.1"],
    ["fixture-cleanup", "--bump-it-config", "/b.yaml", "--secure-it-config", "/s.yaml", "--release", "v0.7.0"],
  ].map((argv) => ({ argv })))("rejects invalid fixture-repin arguments: $argv", async ({ argv }) => {
    const handlers = actions();
    expect(await main(argv, () => {}, handlers)).toBe(64);
    expect(handlers.fixtureRepin).not.toHaveBeenCalled();
    expect(handlers.fixtureCleanup).not.toHaveBeenCalled();
  });

  it.each([
    ["fixture-cleanup"],
    ["fixture-cleanup", "--bump-it-config", "/b.yaml"],
    ["fixture-cleanup", "--bump-it-config", "/b.yaml", "--secure-it-config", "/s.yaml", "--repo", "widget"],
    ["fixture-cleanup", "--bump-it-config", "/b.yaml", "--secure-it-config", "/s.yaml", "--apply", "--apply"],
    ["fixture-cleanup", "--bump-it-config", "/b.yaml", "--secure-it-config", "/s.yaml", "extra"],
  ].map((argv) => ({ argv })))("rejects invalid fixture-cleanup arguments: $argv", async ({ argv }) => {
    const handlers = actions();
    expect(await main(argv, () => {}, handlers)).toBe(64);
    expect(handlers.fixtureCleanup).not.toHaveBeenCalled();
  });

  it("dispatches schedule/readback and maps test-run directly to the selected batch", async () => {
    const handlers = actions();
    const emit = vi.fn();
    const base = ["bump-it", "--owner", "acme", "--release", "v0.7.0"];
    expect(await main(["schedule", ...base, "--agent", "claude-code"], emit, handlers)).toBe(2);
    expect(handlers.schedule).toHaveBeenCalledWith({ tool: "bump-it", owner: "acme", release: "v0.7.0", agent: "claude-code" });
    expect(await main(["schedule-check", ...base, "--agent", "codex", "--task-file", "/tmp/readback.json"], emit, handlers)).toBe(0);
    expect(handlers.scheduleCheck).toHaveBeenCalledWith({ tool: "bump-it", owner: "acme", release: "v0.7.0", agent: "codex", taskFile: "/tmp/readback.json" });
    expect(await main(["test-run", ...base, "--repo", "acme/one"], emit, handlers)).toBe(0);
    expect(handlers.batch).toHaveBeenCalledExactlyOnceWith({ tool: "bump-it", owner: "acme", release: "v0.7.0", repo: "acme/one" }, emit);
  });

  it("test-run executes only one opted-in review/run chain through the batch implementation", async () => {
    const config = parseToolConfig("bump-it", "repos: [{repo: acme/one}, {repo: acme/two}]\nagent: {codingAgent: codex, model: sol, effort: medium}\ncommitIdentity: {name: Dev, email: dev@example.com}\n", "agent.yaml", "/home");
    const invoke = vi.fn(async () => ({ code: 0, report: { status: "ok", result: { outcome: "completed" } } }));
    const machine = { release: async () => ({ tag: "v0.7.0", sha: "a".repeat(40), path: "/release" }), installation: async () => ({ path: "/config", config }), preflight: async () => {}, invoke };
    const handlers = { ...actions(), batch: (options: Parameters<typeof batch>[0], emit: (line: string) => void) => batch(options, emit, machine) };
    const argv = ["test-run", "bump-it", "--owner", "acme", "--release", "v0.7.0", "--repo"];
    expect(await main([...argv, "acme/one"], () => {}, handlers)).toBe(0);
    expect(invoke.mock.calls.map((args) => args.slice(2))).toEqual([["bump-it", "acme/one", "review"], ["bump-it", "acme/one", "run"]]);
    invoke.mockClear();
    expect(await main([...argv, "acme/unselected"], () => {}, handlers)).toBe(1);
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([
    ["schedule", "bump-it", "--owner", "acme", "--release", "v0.7.0"],
    ["schedule-check", "bump-it", "--owner", "acme", "--release", "v0.7.0", "--agent", "codex"],
    ["schedule", "bump-it", "--owner", "acme", "--release", "v0.7.0", "--agent", "other"],
    ["schedule", "bump-it", "--owner", "acme", "--owner", "other", "--release", "v0.7.0", "--agent", "codex"],
    ["test-run", "bump-it", "--owner", "acme", "--release", "v0.7.0"],
    ["test-run", "bump-it", "--owner", "acme", "--release", "v0.7.0", "--repo", "other/one"],
    ["test-run", "bump-it", "--owner", "acme", "--release", "v0.7.0", "--repo", "acme/one", "--repo", "acme/two"],
    ["test-run", "bump-it", "--owner", "acme", "--release", "v0.7.0", "--repo", "acme/one", "--dry-run"],
  ].map((argv) => ({ argv })))("rejects incomplete or unsafe part 3 input: $argv", async ({ argv }) => {
    const handlers = actions();
    const emit = vi.fn();
    expect(await main(argv, emit, handlers)).toBe(64);
    expect(JSON.parse(emit.mock.calls[0]![0])).toMatchObject({ command: argv[0], status: "blocked" });
    for (const action of Object.values(handlers)) expect(action).not.toHaveBeenCalled();
  });

  it.each([
    [["--time", "7:05"], "--time must be HH:MM"], [["--time", "24:00"], "--time must be HH:MM"], [["--time", "10:60"], "--time must be HH:MM"],
    [["--day", "wednesday"], "--day must be one of sun, mon, tue, wed, thu, fri, sat"], [["--day", "3"], "--day must be one of"],
  ] as const)("explains a refused schedule choice %j", async (choice, message) => {
    const handlers = actions();
    const emit = vi.fn();
    expect(await main(["schedule", "bump-it", "--owner", "acme", "--release", "v0.7.0", "--agent", "codex", ...choice], emit, handlers)).toBe(64);
    expect(JSON.parse(emit.mock.calls[0]![0])).toMatchObject({ command: "schedule", step: "arguments", status: "blocked", message: expect.stringContaining(message) });
    expect(handlers.schedule).not.toHaveBeenCalled();
  });

  it("passes the chosen time and case-insensitive weekday to schedule and schedule-check", async () => {
    const handlers = actions();
    const base = ["bump-it", "--owner", "acme", "--release", "v0.7.0", "--agent", "codex", "--time", "06:30", "--day", "MON"];
    await main(["schedule", ...base], () => {}, handlers);
    expect(handlers.schedule).toHaveBeenCalledWith({ tool: "bump-it", owner: "acme", release: "v0.7.0", agent: "codex", time: { hour: 6, minute: 30 }, weekday: 1 });
    await main(["schedule-check", ...base, "--task-file", "/tmp/readback.json"], () => {}, handlers);
    expect(handlers.scheduleCheck).toHaveBeenCalledWith({ tool: "bump-it", owner: "acme", release: "v0.7.0", agent: "codex", time: { hour: 6, minute: 30 }, weekday: 1, taskFile: "/tmp/readback.json" });
  });

  it.each([
    ["gate", "--repo", "acme/one", "--release", "v0.7.0", "--release", "v0.8.0"],
    ["enroll", "bump-it", "--owner", "acme", "--owner", "other", "--login", "dev"],
    ["enroll", "bump-it", "--owner", "acme", "--login=dev", "--login=dev"],
    ["doctor", "--agent=codex", "--agent=codex"],
    ["configure", "bump-it", "--owner", "acme", "--repo", "acme/one", "--name", "Dev", "--name", "Other"],
    ["batch", "bump-it", "--owner", "acme", "--release", "v0.7.0", "--repo", "acme/one", "--repo", "acme/two"],
    ["gate", "--repo", "acme/one", "--release", "v0.7.0", "--confirm-settings", "--confirm-settings"],
    ["schedule", "bump-it", "--owner", "acme", "--release", "v0.7.0", "--agent", "codex", "--time", "06:30", "--time", "06:30"],
    ["schedule-check", "bump-it", "--owner", "acme", "--release", "v0.7.0", "--agent", "codex", "--day", "mon", "--day", "tue", "--task-file", "/tmp/x.json"],
  ].map((argv) => ({ argv })))("rejects repeated single-valued flags and reports the command: $argv", async ({ argv }) => {
    const handlers = actions();
    const emit = vi.fn();
    expect(await main(argv, emit, handlers)).toBe(64);
    expect(JSON.parse(emit.mock.calls[0]![0])).toMatchObject({ command: argv[0], step: "arguments" });
    for (const action of Object.values(handlers)) expect(action).not.toHaveBeenCalled();
  });

  it("streams gate results once, preserves a PR on settings failure, and exits nonzero", async () => {
    const workflow = result("gate", "workflow", "changed", "PR ready", { pullRequest: "https://github.com/acme/one/pull/1" });
    const blocked = result("gate", "actions-allowlist", "blocked", "Could not apply setting", { httpStatus: 500 });
    const emit = vi.fn();
    const handlers = { ...actions(), gate: async (_options: unknown, publish: (entry: typeof workflow) => void) => {
      publish(workflow);
      expect(emit).toHaveBeenCalledOnce();
      publish(blocked);
      return [workflow, blocked];
    } };
    expect(await main(["gate", "--repo", "acme/one", "--release", "v0.7.0"], emit, handlers)).toBe(1);
    expect(emit.mock.calls.map(([line]) => JSON.parse(line))).toEqual([workflow, blocked]);
  });

  it("a blocker wins over a pending choice, and failures are structured", async () => {
    expect(await main(["doctor"], () => {}, { ...actions(), doctor: async () => [result("doctor", "node", "blocked", "Missing"), result("doctor", "agent", "needs-confirmation", "Choose")] })).toBe(1);
    const emit = vi.fn();
    expect(await main(["release"], emit, { ...actions(), release: async () => { throw new Error("Verification failed"); } })).toBe(1);
    expect(JSON.parse(emit.mock.calls[0]![0])).toMatchObject({ command: "release", status: "blocked", message: "Verification failed" });
  });

  it("the executable produces parseable JSON on usage failures and no stderr", () => {
    const execution = spawnSync(process.execPath, [fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "unknown"], { encoding: "utf8" });
    expect(execution.status).toBe(64);
    expect(execution.stderr).toBe("");
    expect(JSON.parse(execution.stdout)).toMatchObject({ schemaVersion: 1, status: "blocked" });
  });

  it("ships an executable batch launcher", () => {
    expect(statSync(new URL("../run.sh", import.meta.url)).mode & 0o111).toBe(0o111);
  });

  it("dispatches part 2 commands with explicit repository and settings scope", async () => {
    const handlers = actions();
    const emit = vi.fn();
    expect(await main(["configure", "bump-it", "--owner", "Acme", "--repo", "acme/one", "--repo", "acme/two", "--agent", "codex", "--name", "Dev", "--email", "dev@example.com"], emit, handlers)).toBe(0);
    expect(handlers.configure).toHaveBeenCalledWith(expect.objectContaining({ owner: "acme", repos: ["acme/one", "acme/two"], agent: "codex" }));
    expect(await main(["enroll", "secure-it", "--owner", "acme", "--login", "Dev"], emit, handlers)).toBe(2);
    expect(handlers.enroll).toHaveBeenCalledWith({ tool: "secure-it", owner: "acme", login: "dev" });
    expect(await main(["verify-tokens", "secure-it", "--owner", "acme"], emit, handlers)).toBe(1);
    expect(await main(["gate", "--repo", "acme/one", "--release", "v0.7.0", "--confirm-settings"], emit, handlers)).toBe(0);
    expect(handlers.gate).toHaveBeenCalledWith({ repo: "acme/one", release: "v0.7.0", java: undefined, confirmSettings: true }, expect.any(Function));
    expect(await main(["batch", "bump-it", "--owner", "acme", "--release", "v0.7.0", "--repo", "acme/one"], emit, handlers)).toBe(0);
    expect(handlers.batch).toHaveBeenCalledWith({ tool: "bump-it", owner: "acme", release: "v0.7.0", repo: "acme/one" }, emit);
  });

  it.each([
    ["configure", "../tool", "--owner", "acme", "--repo", "acme/one"], ["configure", "bump-it", "--owner", "../home", "--repo", "acme/one"],
    ["configure", "secure-it", "--owner", "acme", "--repo", "other/one"], ["gate", "--repo", "acme/one"],
    ["enroll", "bump-it", "--owner", "acme", "--login", "x;command"], ["batch", "bump-it", "--owner", "acme", "--release", "v0.7.0", "--token", "secret-sentinel"],
  ].map((argv) => ({ argv })))("rejects unsafe part 2 input before dispatch: $argv", async ({ argv }) => {
    const handlers = actions();
    const emit = vi.fn();
    expect(await main(argv, emit, handlers)).toBe(64);
    for (const action of Object.values(handlers)) expect(action).not.toHaveBeenCalled();
    expect(JSON.stringify(emit.mock.calls)).not.toContain("secret-sentinel");
  });
});
