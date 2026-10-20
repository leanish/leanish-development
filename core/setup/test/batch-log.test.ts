import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { batchLogPath, openBatchLog } from "../src/batch-log.ts";
import { executeBatch } from "../src/batch.ts";

// Lets one test make the next append fail, as a full disk would.
const failing = vi.hoisted(() => ({ next: false }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, writeSync: (...args: Parameters<typeof actual.writeSync>) => {
    if (failing.next) { failing.next = false; throw Object.assign(new Error("no space left"), { code: "ENOSPC" }); }
    return actual.writeSync(...args);
  } };
});

let state: string;
const now = new Date(2026, 9, 19, 12);
const lines = async () => (await readFile(batchLogPath(state, now), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
beforeEach(async () => { state = await mkdtemp(join(tmpdir(), "setup-batch-log-")); });
afterEach(async () => { failing.next = false; await rm(state, { recursive: true, force: true }); });

describe("the person's batch log", () => {
  it("appends whole JSON lines with one run id to a private file by local date", async () => {
    const log = await openBatchLog(state, { tool: "bump-it", owner: "acme" }, now);
    log.write({ repo: "acme/one", action: "run", stream: "stderr", line: "npm ERR! 502" });
    log.write({ event: "summary" });
    log.close();
    expect(log.failed).toBe(false);
    expect(batchLogPath(state, now)).toBe(join(state, "logs", "batch-2026-10-19.jsonl"));
    expect((await stat(join(state, "logs"))).mode & 0o777).toBe(0o700);
    expect((await stat(batchLogPath(state, now))).mode & 0o777).toBe(0o600);
    const [first, second] = await lines();
    expect(first).toMatchObject({ tool: "bump-it", owner: "acme", repo: "acme/one", action: "run", stream: "stderr", line: "npm ERR! 502" });
    expect(second).toMatchObject({ event: "summary" });
    expect(first!["run"]).toEqual(second!["run"]);
    const again = await openBatchLog(state, { tool: "bump-it", owner: "acme" }, now);
    again.write({ event: "summary" });
    again.close();
    const all = await lines();
    expect(all).toHaveLength(3);
    expect(all[2]!["run"]).not.toEqual(first!["run"]);
  });

  it("fails without writing through a symlink in the file's or the folder's place", async () => {
    await mkdir(join(state, "logs"), { mode: 0o700 });
    await writeFile(join(state, "target"), "");
    await symlink(join(state, "target"), batchLogPath(state, now));
    const linkedFile = await openBatchLog(state, {}, now);
    linkedFile.write({ event: "summary" });
    expect(linkedFile.failed).toBe(true);
    expect(await readFile(join(state, "target"), "utf8")).toBe("");
    await rm(join(state, "logs"), { recursive: true });
    await mkdir(join(state, "elsewhere"));
    await symlink(join(state, "elsewhere"), join(state, "logs"));
    const linkedFolder = await openBatchLog(state, {}, now);
    linkedFolder.write({ event: "summary" });
    expect(linkedFolder.failed).toBe(true);
    expect(await readdir(join(state, "elsewhere"))).toEqual([]);
  });

  it.each([["folder", 0o755, 0o600], ["file", 0o700, 0o644]])("refuses an existing %s others can read, without writing to it", async (_name, folderMode, fileMode) => {
    await mkdir(join(state, "logs"), { mode: 0o700 });
    await chmod(join(state, "logs"), folderMode);
    await writeFile(batchLogPath(state, now), "", { mode: 0o600 });
    await chmod(batchLogPath(state, now), fileMode);
    const log = await openBatchLog(state, {}, now);
    log.write({ event: "summary" });
    expect(log.failed).toBe(true);
    expect(await readFile(batchLogPath(state, now), "utf8")).toBe("");
  });

  it("fails at once, without blocking, on a named pipe in the file's place", async () => {
    await mkdir(join(state, "logs"), { mode: 0o700 });
    expect(spawnSync("mkfifo", [batchLogPath(state, now)]).status).toBe(0);
    const log = await openBatchLog(state, {}, now);
    expect(log.failed).toBe(true);
  });

  it("creates a missing state folder private, as a first batch can come before the tools create it", async () => {
    const log = await openBatchLog(join(state, "missing"), {}, now);
    log.write({ event: "summary" });
    log.close();
    expect(log.failed).toBe(false);
    expect((await stat(join(state, "missing"))).mode & 0o777).toBe(0o700);
  });

  it("keeps 30 days of its own daily files and nothing else is touched", async () => {
    await mkdir(join(state, "logs"), { mode: 0o700 });
    const names = ["batch-2026-09-19.jsonl", "batch-2026-09-20.jsonl", "batch-2026-10-18.jsonl", "batch-notes.txt", "other-2020-01-01.jsonl"];
    for (const name of names) await writeFile(join(state, "logs", name), "");
    await mkdir(join(state, "logs", "batch-2020-01-01.jsonl"));
    (await openBatchLog(state, {}, now)).close();
    expect((await readdir(join(state, "logs"))).sort()).toEqual(["batch-2020-01-01.jsonl", "batch-2026-09-20.jsonl", "batch-2026-10-18.jsonl", "batch-2026-10-19.jsonl", "batch-notes.txt", "other-2020-01-01.jsonl"]);
  });

  it("stops at the first failed append and reports it, while the batch still completes and reports logFailed", async () => {
    const log = await openBatchLog(state, {}, now);
    const records: Readonly<Record<string, unknown>>[] = [];
    let calls = 0;
    expect(await executeBatch({ tool: "bump-it", owner: "acme" }, ["acme/one"], async (_repo, action, record) => {
      calls++;
      record("stdout", `${action} line`);
      if (action === "run") failing.next = true;
      record("stdout", "lost");
      return { code: 0, report: { msg: "run finished", status: "ok", result: { outcome: "completed" } } };
    }, (record) => records.push(record), log)).toBe(0);
    expect(calls).toBe(2);
    expect(log.failed).toBe(true);
    expect(records.at(-1)).toMatchObject({ action: "summary", outcome: "completed", logFailed: true });
    expect(JSON.stringify(records)).not.toContain(state);
    const written = await lines();
    expect(written.map((entry) => entry["line"] ?? entry["event"])).toEqual(["review line", "lost", "finished", "run line"]);
  });
});
