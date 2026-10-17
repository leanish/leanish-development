import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { main, type SetupActions } from "../src/cli.ts";
import { result } from "../src/contracts.ts";

function actions(): SetupActions {
  return {
    doctor: vi.fn(async () => [result("doctor", "agent", "already-done", "Ready", { agent: "codex" })]),
    release: vi.fn(async () => result("release", "checkout", "changed", "Installed")),
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
});
