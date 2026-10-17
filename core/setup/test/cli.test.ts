import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { statSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { main, type SetupActions } from "../src/cli.ts";
import { result } from "../src/contracts.ts";

function actions(): SetupActions {
  return {
    doctor: vi.fn(async () => [result("doctor", "agent", "already-done", "Ready", { agent: "codex" })]),
    release: vi.fn(async () => result("release", "checkout", "changed", "Installed")),
    configure: vi.fn(async () => result("configure", "config", "changed", "Configured")),
    enroll: vi.fn(async () => result("enroll", "keychain", "needs-confirmation", "Use your terminal")),
    verifyTokens: vi.fn(async () => result("verify-tokens", "permissions", "blocked", "Unknown permissions")),
    gate: vi.fn(async () => [result("gate", "workflow", "changed", "PR ready")]),
    batch: vi.fn(async (_options, emit) => { emit('{"action":"summary"}'); return 0; }),
  };
}

describe("setup command contract", () => {
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

  it.each([
    ["gate", "--repo", "acme/one", "--release", "v0.7.0", "--release", "v0.8.0"],
    ["enroll", "bump-it", "--owner", "acme", "--owner", "other", "--login", "dev"],
    ["enroll", "bump-it", "--owner", "acme", "--login=dev", "--login=dev"],
    ["doctor", "--agent=codex", "--agent=codex"],
    ["configure", "bump-it", "--owner", "acme", "--repo", "acme/one", "--name", "Dev", "--name", "Other"],
    ["batch", "bump-it", "--owner", "acme", "--release", "v0.7.0", "--repo", "acme/one", "--repo", "acme/two"],
    ["gate", "--repo", "acme/one", "--release", "v0.7.0", "--confirm-settings", "--confirm-settings"],
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
