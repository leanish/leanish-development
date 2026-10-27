// New in this repository; the signal cases are adapted from leanish/leanish-development
// core/runtime/test/unit/run-local-cli.test.ts at c6282df (see PROVENANCE.md).
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RunReport, type RunFinished, startRunReport, writeFinalLine } from "../src/report/run-report.ts";
import { unreportedSkillUsage, toSkillUsageRecord } from "../src/usage/skill-usage-record.ts";

const SIGNALLED = fileURLToPath(new URL("./fixtures/report-on-signal.ts", import.meta.url));

/** Runs the fixture until it's ready, sends `signal`, and returns how it died and its final lines. */
async function killed(signal: NodeJS.Signals, mode: "idle" | "in-flight" | "extra" | "bad-extra" | "unserializable-extra"): Promise<{ signal: NodeJS.Signals | null; finals: RunFinished[] }> {
  const child = spawn(process.execPath, [SIGNALLED, mode], { stdio: ["ignore", "ignore", "pipe"] });
  let log = "";
  const ready = new Promise<void>((done) =>
    child.stderr.on("data", (chunk: Buffer) => {
      log += chunk.toString("utf8");
      if (log.includes("ready\n")) done();
    }),
  );
  const exited = new Promise<NodeJS.Signals | null>((done) => child.on("exit", (_code, died) => done(died)));
  await ready;
  child.kill(signal);
  const died = await exited;
  const finals = log.split("\n").filter((line) => line.includes('"run finished"')).map((line) => JSON.parse(line) as RunFinished);
  return { signal: died, finals };
}

const STARTED = fileURLToPath(new URL("./fixtures/start-run-report-on-signal.ts", import.meta.url));

/** Runs startRunReport's fixture until it's ready, sends SIGTERM, and returns how it died and what it wrote. */
async function killedStarted(mode: "plain" | "throwing-extra" | "throwing-before", marker: string): Promise<{ signal: NodeJS.Signals | null; lines: Record<string, unknown>[] }> {
  const child = spawn(process.execPath, [STARTED, mode], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, TEST_REPORT_MARKER: marker } });
  let log = "";
  const ready = new Promise<void>((done) =>
    child.stderr.on("data", (chunk: Buffer) => {
      log += chunk.toString("utf8");
      if (log.includes("ready\n")) done();
    }),
  );
  const exited = new Promise<NodeJS.Signals | null>((done) => child.on("exit", (_code, died) => done(died)));
  await ready;
  expect(existsSync(marker)).toBe(false);
  child.kill("SIGTERM");
  const died = await exited;
  return { signal: died, lines: log.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as Record<string, unknown>) };
}

const FAILING = fileURLToPath(new URL("./fixtures/final-line-on-failing-stream.ts", import.meta.url));

/** Runs the failing stream's fixture to its exit (`signal`: sends it a SIGTERM once it's ready), with what it printed. */
async function onFailingStream(
  mode: "end" | "no-close" | "write-final-line" | "signal",
  marker: string,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [FAILING, mode], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TEST_REPORT_MARKER: marker } });
  let stdout = "";
  let stderr = "";
  let killed = false;
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
    if (mode === "signal" && !killed && stdout.includes("ready\n")) {
      killed = true;
      child.kill("SIGTERM");
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  // 'close', not 'exit': once both pipes are read to their end.
  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((done) => child.on("close", (exitCode, died) => done([exitCode, died])));
  return { code, signal, stdout, stderr };
}

/** A real stream whose writes fail with EPIPE and whose destroy takes 20 ms, so its 'error' comes after setImmediate. */
function failingWritable(emitClose = true): Writable {
  return new Writable({
    emitClose,
    write: (_chunk, _encoding, callback) => callback(Object.assign(new Error("write EPIPE"), { code: "EPIPE" })),
    destroy: (err, callback) => {
      setTimeout(() => callback(err), 20);
    },
  });
}

/** Resolves once `stream` emitted 'error' and every listener of that turn ran. */
const errorEmitted = (stream: Writable) => new Promise<void>((done) => stream.once("error", () => setImmediate(done)));

/** A stream that keeps each write's callback until `flush`, as a slow pipe would; `failing` flushes with an error. */
class HeldStream extends EventEmitter {
  readonly writes: string[] = [];
  readonly #pending: Array<() => void> = [];
  readonly #failing: boolean;

  constructor(failing = false) {
    super();
    this.#failing = failing;
  }

  write(text: string, done?: (err?: Error | null) => void): boolean {
    this.writes.push(text);
    this.#pending.push(() => done?.(this.#failing ? new Error("EPIPE") : null));
    return true;
  }

  flush(): void {
    for (const done of this.#pending.splice(0)) done();
  }

  get stream(): NodeJS.WritableStream {
    return this as unknown as NodeJS.WritableStream;
  }
}

/** Lets pending callbacks and promise reactions run. */
const settle = () => new Promise<void>((done) => setImmediate(done));

type SignalListener = (signal: NodeJS.Signals) => void;

/** Runs `start`, and returns what it returned with a function that fakes a signal to the listener it added. */
function withFakeSignals<T>(start: () => T): { started: T; fakeSignal: (signal: NodeJS.Signals) => void } {
  const before = new Map(SIGNALS.map((signal) => [signal, process.listeners(signal)]));
  const started = start();
  const added = new Map(SIGNALS.map((signal) => [signal, process.listeners(signal).filter((listener) => !before.get(signal)!.includes(listener)) as SignalListener[]]));
  return {
    started,
    // As a delivered signal would, without delivering one (no other listener runs), and only while it still listens.
    fakeSignal: (signal) => {
      const listener = added.get(signal as (typeof SIGNALS)[number])?.[0];
      if (listener === undefined || !process.listeners(signal).includes(listener)) throw new Error(`the report doesn't listen for ${signal}`);
      listener(signal);
    },
  };
}

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const listenerCounts = () => SIGNALS.map((signal) => process.listenerCount(signal));

const CLOCK = () => "2026-10-07T05:00:00.000Z";

function parse(line: string | undefined): RunFinished {
  if (line === undefined) throw new Error("no line");
  expect(line.endsWith("\n")).toBe(true);
  return JSON.parse(line) as RunFinished;
}

describe("RunReport", () => {
  it("ends a command with one line: tool, repo, status, result and its skill runs", () => {
    const report = new RunReport(CLOCK);
    report.identified({ tool: "secure-it", repo: "acme/widget" });
    report.usageRecorder.started?.({ invocationId: "i-1", entrypoint: "secure-it" });
    report.usageRecorder.record(
      toSkillUsageRecord(unreportedSkillUsage("codex", 12, "sol"), { invocationId: "i-1", entrypoint: "secure-it", outcome: "succeeded" }, { usd: null, complete: false, byModel: [], gaps: [] }),
    );
    const line = parse(report.finish({ status: "ok", exitCode: 0, result: { pullRequest: "https://github.com/acme/widget/pull/7" } }));
    expect(line).toMatchObject({
      ts: "2026-10-07T05:00:00.000Z",
      level: "info",
      msg: "run finished",
      tool: "secure-it",
      repo: "acme/widget",
      status: "ok",
      exitCode: 0,
      result: { pullRequest: "https://github.com/acme/widget/pull/7" },
    });
    expect(line.skills.map((skill) => skill.invocationId)).toEqual(["i-1"]);
    expect(line).not.toHaveProperty("dispatches");
  });

  it("writes the line once, and an error before the tool was identified has neither tool nor repo", () => {
    const report = new RunReport(CLOCK);
    const line = parse(report.finish({ status: "error", exitCode: 64, error: "usage: secure-it run <owner/repo>" }));
    expect(line).toMatchObject({ level: "error", status: "error", exitCode: 64, error: "usage: secure-it run <owner/repo>" });
    expect(line).not.toHaveProperty("tool");
    expect(line).not.toHaveProperty("result");
    expect(report.finish({ status: "ok", exitCode: 0 })).toBeUndefined();
  });

  it("keeps the tools' line byte for byte, field order included", () => {
    const now = vi.spyOn(performance, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(1_234.4);
    try {
      const report = new RunReport(CLOCK);
      report.identified({ tool: "secure-it", repo: "acme/widget" });
      const line = report.finish({ status: "interrupted", exitCode: 143, error: "stopped by SIGTERM", signal: "SIGTERM", result: { pullRequest: "https://github.com/acme/widget/pull/7" } });
      const zero = '{"input":0,"cachedInput":0,"cacheWriteInput":0,"output":0,"reasoningOutput":0,"total":0}';
      expect(line).toBe(
        '{"ts":"2026-10-07T05:00:00.000Z","level":"error","msg":"run finished","tool":"secure-it","repo":"acme/widget",' +
          '"status":"interrupted","exitCode":143,"error":"stopped by SIGTERM","signal":"SIGTERM","durationMs":234,' +
          '"result":{"pullRequest":"https://github.com/acme/widget/pull/7"},"skills":[],' +
          `"totals":{"skillRuns":0,"skillRunsInProgress":0,"tokens":${zero},"tokensLowerBound":${zero},` +
          '"estimatedApiCostUsd":0,"estimatedApiCostUsdLowerBound":0,"pricingBases":[],"gaps":[]}}\n',
      );
    } finally {
      now.mockRestore();
    }
  });

  it("puts a host's identity after msg and its extras after result, in the order given", () => {
    const report = new RunReport(CLOCK);
    report.identified({ agent: "atc" });
    const line = parse(report.finish({ status: "ok", exitCode: 0, extra: { dispatches: { attempted: 2, completed: 1, failed: 1 }, selfPublishesDropped: 0 } }));
    expect(Object.keys(line)).toEqual(["ts", "level", "msg", "agent", "status", "exitCode", "durationMs", "dispatches", "selfPublishesDropped", "skills", "totals"]);
    expect(line).toMatchObject({ agent: "atc", dispatches: { attempted: 2, completed: 1, failed: 1 }, selfPublishesDropped: 0 });
  });

  it("adds to the identity on a later call, keeping each field's place", () => {
    const report = new RunReport(CLOCK);
    report.identified({ tool: "secure-it", repo: "acme/widget" });
    report.identified({ tool: "bump-it", command: "run" });
    const line = parse(report.finish({ status: "ok", exitCode: 0 }));
    expect(Object.keys(line).slice(3, 6)).toEqual(["tool", "repo", "command"]);
    expect(line).toMatchObject({ tool: "bump-it", repo: "acme/widget", command: "run" });
  });

  it.each(["ts", "level", "msg", "status", "exitCode", "error", "signal", "durationMs", "result", "skills", "totals"])(
    "refuses a host field named %s, as identity or extra",
    (field) => {
      const report = new RunReport(CLOCK);
      expect(() => report.identified({ [field]: "x" })).toThrow(`may not replace '${field}'`);
      expect(() => report.finish({ status: "ok", exitCode: 0, extra: { [field]: "x" } })).toThrow(`may not replace '${field}'`);
    },
  );

  it("refuses an extra that would replace the identity, and stays unfinished", () => {
    const report = new RunReport(CLOCK);
    report.identified({ agent: "atc" });
    expect(() => report.finish({ status: "ok", exitCode: 0, extra: { agent: "other" } })).toThrow("extra fields may not replace 'agent'");
    expect(parse(report.finish({ status: "ok", exitCode: 0 }))).toMatchObject({ agent: "atc" });
  });

  it("refuses a toJSON field, which would replace the whole line when it's written", () => {
    const report = new RunReport(CLOCK);
    expect(() => report.identified({ toJSON: "x" })).toThrow("may not replace 'toJSON'");
    expect(() => report.finish({ status: "error", exitCode: 1, extra: { toJSON: () => ({ status: "ok" }) } })).toThrow("may not replace 'toJSON'");
  });

  it("stays unfinished when its extras can't be serialized, so it can still finish without them", () => {
    const report = new RunReport(CLOCK);
    expect(() => report.finish({ status: "ok", exitCode: 0, extra: { count: 1n } })).toThrow(TypeError);
    expect(parse(report.finish({ status: "ok", exitCode: 0 }))).toMatchObject({ status: "ok" });
  });
});

// The source's "writes the line before dying of SIGTERM" and "interrupted mid-skill" cases, on a bare command.
describe("reportOnTerminationSignals", () => {
  it("writes the line before dying of SIGTERM, with the signal's exit code and complete (empty) totals", async () => {
    const { signal, finals } = await killed("SIGTERM", "idle");
    expect(signal).toBe("SIGTERM");
    expect(finals).toHaveLength(1);
    expect(finals[0]).toMatchObject({
      status: "interrupted",
      exitCode: 143,
      signal: "SIGTERM",
      error: "stopped by SIGTERM",
      tool: "secure-it",
      repo: "acme/widget",
      totals: { skillRuns: 0, skillRunsInProgress: 0, tokens: { total: 0 }, estimatedApiCostUsd: 0, gaps: [] },
    });
  }, 20_000);

  it("adds the host's extras as they stand when the signal arrives", async () => {
    const { signal, finals } = await killed("SIGTERM", "extra");
    expect(signal).toBe("SIGTERM");
    expect(finals).toHaveLength(1);
    expect(finals[0]).toMatchObject({ status: "interrupted", tool: "secure-it", dispatches: 1 });
    expect(Object.keys(finals[0]!).indexOf("dispatches")).toBe(Object.keys(finals[0]!).indexOf("skills") - 1);
  }, 20_000);

  it.each(["bad-extra", "unserializable-extra"] as const)("still writes the final line, without the host's fields, when they're invalid on a signal (%s)", async (mode) => {
    const { signal, finals } = await killed("SIGTERM", mode);
    expect(signal).toBe("SIGTERM");
    expect(finals).toHaveLength(1);
    expect(finals[0]).toMatchObject({ status: "interrupted", error: expect.stringContaining("the host's fields were left out: ") });
  }, 20_000);

  it("reports a skill run still in flight as unknown usage, with only lower bounds", async () => {
    const { signal, finals } = await killed("SIGINT", "in-flight");
    expect(signal).toBe("SIGINT");
    expect(finals).toEqual([
      expect.objectContaining({
        status: "interrupted",
        exitCode: 130,
        totals: expect.objectContaining({
          skillRuns: 0,
          skillRunsInProgress: 1,
          tokens: null,
          estimatedApiCostUsd: null,
          tokensLowerBound: expect.objectContaining({ total: 0 }),
          gaps: ["1 skill run(s) were still in progress, so their usage is unknown"],
        }),
      }),
    ]);
  }, 20_000);
});

describe("startRunReport", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const lines = (text: string | undefined) => (text ?? "").trimEnd().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);

  it("ends with the host's lines and the final line in one write, resolving once it's flushed, extras as they stand then", async () => {
    const held = new HeldStream();
    let dispatches = 0;
    const seen: RunFinished[] = [];
    const report = startRunReport({
      stream: held.stream,
      env: {},
      extra: () => ({ dispatches }),
      beforeFinalLine: (final) => {
        seen.push(final);
        return [JSON.stringify({ msg: "GitHub API requests", ts: final.ts, repo: final["repo"] })];
      },
    });
    report.identified({ tool: "secure-it", repo: "acme/widget" });
    dispatches = 2;
    let resolved = false;
    const ending = report.end({ status: "ok", exitCode: 0, result: { pullRequest: "https://github.com/acme/widget/pull/7" } }).then(() => {
      resolved = true;
    });
    await settle();
    expect(resolved).toBe(false);
    expect(held.writes).toHaveLength(1);
    const [before, final] = lines(held.writes[0]);
    expect(final).toMatchObject({ msg: "run finished", tool: "secure-it", status: "ok", exitCode: 0, dispatches: 2, result: { pullRequest: "https://github.com/acme/widget/pull/7" } });
    expect(before).toEqual({ msg: "GitHub API requests", ts: final!["ts"], repo: "acme/widget" });
    expect(seen).toEqual([final]);
    held.flush();
    await ending;
    expect(resolved).toBe(true);
  });

  it("ends an error the same way", async () => {
    const held = new HeldStream();
    const report = startRunReport({ stream: held.stream, env: {} });
    const ending = report.end({ status: "error", exitCode: 64, error: "usage: secure-it run <owner/repo>" });
    held.flush();
    await ending;
    expect(lines(held.writes[0])).toEqual([expect.objectContaining({ level: "error", status: "error", exitCode: 64, error: "usage: secure-it run <owner/repo>" })]);
  });

  it("writes one line when ended twice; the second end resolves once that line is flushed", async () => {
    const held = new HeldStream();
    const report = startRunReport({ stream: held.stream, env: {} });
    const first = report.end({ status: "ok", exitCode: 0 });
    let secondResolved = false;
    const second = report.end({ status: "error", exitCode: 1, error: "late" }).then(() => {
      secondResolved = true;
    });
    await settle();
    expect(secondResolved).toBe(false);
    held.flush();
    await Promise.all([first, second]);
    expect(held.writes).toHaveLength(1);
    expect(lines(held.writes[0])).toEqual([expect.objectContaining({ status: "ok" })]);
    await report.end({ status: "ok", exitCode: 0 });
    expect(held.writes).toHaveLength(1);
  });

  it("writes one line when a signal comes first and the end races it, and raises the signal once it's flushed", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const baseline = listenerCounts();
    const held = new HeldStream();
    const { started: report, fakeSignal } = withFakeSignals(() =>
      startRunReport({ stream: held.stream, env: {}, beforeFinalLine: (final) => [`{"before":"${final.status}"}`] }),
    );
    fakeSignal("SIGTERM");
    const ending = report.end({ status: "ok", exitCode: 0 });
    await settle();
    expect(kill).not.toHaveBeenCalled();
    held.flush();
    await ending;
    await settle();
    expect(held.writes).toHaveLength(1);
    expect(lines(held.writes[0])).toEqual([
      { before: "interrupted" },
      expect.objectContaining({ status: "interrupted", exitCode: 143, signal: "SIGTERM", error: "stopped by SIGTERM" }),
    ]);
    expect(kill.mock.calls).toEqual([[process.pid, "SIGTERM"]]);
    expect(listenerCounts()).toEqual(baseline);
  });

  it("writes one line when a signal races the end, and raises the signal once that line is flushed", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const baseline = listenerCounts();
    const held = new HeldStream();
    const { started: report, fakeSignal } = withFakeSignals(() => startRunReport({ stream: held.stream, env: {} }));
    const ending = report.end({ status: "ok", exitCode: 0 });
    fakeSignal("SIGINT");
    fakeSignal("SIGINT");
    await settle();
    expect(kill).not.toHaveBeenCalled();
    held.flush();
    await ending;
    await settle();
    expect(held.writes).toHaveLength(1);
    expect(lines(held.writes[0])).toEqual([expect.objectContaining({ status: "ok", exitCode: 0 })]);
    expect(kill.mock.calls).toEqual([[process.pid, "SIGINT"]]);
    expect(listenerCounts()).toEqual(baseline);
  });

  it("still writes the line when the host's extras throw, noting why they're missing", async () => {
    const held = new HeldStream();
    const report = startRunReport({
      stream: held.stream,
      env: {},
      extra: () => {
        throw new Error("no counts");
      },
      beforeFinalLine: (final) => [`{"before":"${final.error}"}`],
    });
    const ending = report.end({ status: "error", exitCode: 1, error: "compare failed" });
    held.flush();
    await ending;
    const error = "compare failed; the host's fields were left out: no counts";
    expect(lines(held.writes[0])).toEqual([{ before: error }, expect.objectContaining({ status: "error", error })]);
  });

  it("still writes the line when the lines before it throw, noting why they're missing, in error's own place", async () => {
    const held = new HeldStream();
    const report = startRunReport({
      stream: held.stream,
      env: {},
      extra: () => ({ dispatches: 1 }),
      beforeFinalLine: () => {
        throw new Error("no summary");
      },
    });
    report.identified({ agent: "atc" });
    const ending = report.end({ status: "ok", exitCode: 0 });
    held.flush();
    await ending;
    const [final, ...rest] = lines(held.writes[0]);
    expect(rest).toEqual([]);
    expect(final).toMatchObject({ status: "ok", dispatches: 1, error: "the lines before this one were left out: no summary" });
    expect(Object.keys(final!)).toEqual(["ts", "level", "msg", "agent", "status", "exitCode", "error", "durationMs", "dispatches", "skills", "totals"]);
  });

  it("writes the line as it was even when the lines before it change their record and throw", async () => {
    const held = new HeldStream();
    const report = startRunReport({
      stream: held.stream,
      env: {},
      beforeFinalLine: (final) => {
        Object.assign(final, { result: { count: 1n }, status: "error" });
        throw new Error("no summary");
      },
    });
    const ending = report.end({ status: "ok", exitCode: 0, result: { prs: 1 } });
    held.flush();
    await ending;
    expect(lines(held.writes[0])).toEqual([expect.objectContaining({ status: "ok", result: { prs: 1 }, error: "the lines before this one were left out: no summary" })]);
  });

  it("still writes the line and raises the signal when the host's callbacks throw on a signal", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const held = new HeldStream();
    const { fakeSignal } = withFakeSignals(() =>
      startRunReport({
        stream: held.stream,
        env: {},
        extra: () => {
          throw new Error("no counts");
        },
        beforeFinalLine: () => {
          throw new Error("no summary");
        },
      }),
    );
    fakeSignal("SIGHUP");
    held.flush();
    await settle();
    expect(lines(held.writes[0])).toEqual([
      expect.objectContaining({
        status: "interrupted",
        exitCode: 129,
        error: "stopped by SIGHUP; the host's fields were left out: no counts; the lines before this one were left out: no summary",
      }),
    ]);
    expect(kill.mock.calls).toEqual([[process.pid, "SIGHUP"]]);
  });

  it("writes an after-final-line marker only once the line is flushed, and not when the write fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "run-report-marker-"));
    const marker = join(dir, "marker");
    const env: NodeJS.ProcessEnv = { TEST_REPORT_MARKER: marker };
    const held = new HeldStream();
    const report = startRunReport({ stream: held.stream, env, marker: { env: "TEST_REPORT_MARKER", when: "after-final-line" } });
    expect(env).toEqual({});
    const ending = report.end({ status: "ok", exitCode: 0 });
    await settle();
    expect(held.writes).toHaveLength(1);
    expect(existsSync(marker)).toBe(false);
    held.flush();
    await ending;
    expect(readFileSync(marker, "utf8")).toBe("reported\n");

    const unflushed = join(dir, "unflushed");
    const failing = new HeldStream(true);
    const failed = startRunReport({ stream: failing.stream, env: { TEST_REPORT_MARKER: unflushed }, marker: { env: "TEST_REPORT_MARKER", when: "after-final-line" } });
    const failedEnding = failed.end({ status: "ok", exitCode: 0 });
    failing.flush();
    await failedEnding;
    expect(failing.writes).toHaveLength(1);
    expect(existsSync(unflushed)).toBe(false);
  });

  it("writes a start marker as reporting starts, and says so on the stream when it can't", async () => {
    const dir = mkdtempSync(join(tmpdir(), "run-report-marker-"));
    const marker = join(dir, "marker");
    const held = new HeldStream();
    const report = startRunReport({ stream: held.stream, env: { TEST_REPORT_MARKER: marker }, marker: { env: "TEST_REPORT_MARKER", when: "start" } });
    expect(readFileSync(marker, "utf8")).toBe("reported\n");
    expect(held.writes).toEqual([]);
    const ending = report.end({ status: "ok", exitCode: 0 });
    held.flush();
    await ending;

    const missing = join(dir, "no-such-dir", "marker");
    const unmarked = new HeldStream();
    const unmarkedReport = startRunReport({ stream: unmarked.stream, env: { TEST_REPORT_MARKER: missing }, marker: { env: "TEST_REPORT_MARKER", when: "start" } });
    expect(unmarked.writes).toEqual([expect.stringContaining(`run report: can't write TEST_REPORT_MARKER=${missing} (`)]);
    const unmarkedEnding = unmarkedReport.end({ status: "ok", exitCode: 0 });
    unmarked.flush();
    await unmarkedEnding;
    expect(lines(unmarked.writes[1])).toEqual([expect.objectContaining({ msg: "run finished" })]);
  });

  it("removes the marker's variable from process.env as it starts, before any child process can inherit it", async () => {
    const marker = join(mkdtempSync(join(tmpdir(), "run-report-marker-")), "marker");
    vi.stubEnv("TEST_REPORT_MARKER", marker);
    const held = new HeldStream();
    const report = startRunReport({ stream: held.stream, marker: { env: "TEST_REPORT_MARKER", when: "start" } });
    expect(process.env["TEST_REPORT_MARKER"]).toBeUndefined();
    const child = spawnSync(process.execPath, ["-e", "process.stdout.write(process.env.TEST_REPORT_MARKER ?? 'unset')"], { encoding: "utf8" });
    expect(child.stdout).toBe("unset");
    expect(readFileSync(marker, "utf8")).toBe("reported\n");
    const ending = report.end({ status: "ok", exitCode: 0 });
    held.flush();
    await ending;
  });

  it("removes its signal listeners on completion, a failed write included, so sequential reports don't leak them", async () => {
    const baseline = listenerCounts();
    for (const failing of [false, true, false]) {
      const held = new HeldStream(failing);
      const report = startRunReport({ stream: held.stream, env: {} });
      expect(listenerCounts()).toEqual(baseline.map((count) => count + 1));
      const ending = report.end({ status: "ok", exitCode: 0 });
      held.flush();
      await ending;
      expect(listenerCounts()).toEqual(baseline);
    }
    // A stream that throws instead of calling back still lets the end settle, so the command returns its exit code.
    const throwing = Object.assign(new EventEmitter(), { write: () => { throw new Error("stream destroyed"); } }) as unknown as NodeJS.WritableStream;
    await expect(startRunReport({ stream: throwing, env: {} }).end({ status: "ok", exitCode: 0 })).resolves.toBeUndefined();
    expect(listenerCounts()).toEqual(baseline);
  });

  it("still writes the line when the result can't be serialized, leaving it out and noting why", async () => {
    const held = new HeldStream();
    const report = startRunReport({ stream: held.stream, env: {}, extra: () => ({ dispatches: 1 }) });
    const ending = report.end({ status: "ok", exitCode: 0, result: { count: 10n } });
    held.flush();
    await ending;
    const [line] = lines(held.writes[0]);
    expect(line).toMatchObject({ status: "ok", exitCode: 0, error: expect.stringContaining("the host's fields and the result were left out") });
    expect(line).not.toHaveProperty("result");
    expect(held.writes).toHaveLength(1);
  });

  // A real process and a real signal: the line, then the marker, then death by the signal.
  it.each([
    ["plain", { dispatches: 1 }],
    ["throwing-extra", { error: "stopped by SIGTERM; the host's fields were left out: no counts" }],
  ] as const)("on a real SIGTERM writes one line after the host's, then the marker, and dies of it (%s)", async (mode, fields) => {
    const marker = join(mkdtempSync(join(tmpdir(), "run-report-marker-")), "marker");
    const { signal, lines: written } = await killedStarted(mode, marker);
    expect(signal).toBe("SIGTERM");
    expect(written).toEqual([
      { msg: "before the final line", status: "interrupted" },
      expect.objectContaining({ msg: "run finished", agent: "atc", status: "interrupted", exitCode: 143, signal: "SIGTERM", ...fields }),
    ]);
    expect(readFileSync(marker, "utf8")).toBe("reported\n");
  }, 20_000);

  it("on a real SIGTERM still writes the line, without the lines before it, when they throw", async () => {
    const marker = join(mkdtempSync(join(tmpdir(), "run-report-marker-")), "marker");
    const { signal, lines: written } = await killedStarted("throwing-before", marker);
    expect(signal).toBe("SIGTERM");
    expect(written).toEqual([
      expect.objectContaining({ msg: "run finished", status: "interrupted", dispatches: 1, error: "stopped by SIGTERM; the lines before this one were left out: no summary" }),
    ]);
    expect(readFileSync(marker, "utf8")).toBe("reported\n");
  }, 20_000);

  // A real stream calls a failed write back, then emits 'error' once destroyed; unheard, that 'error' would end the
  // process with exit code 1, whatever the run's own.
  it.each(["end", "no-close", "write-final-line"] as const)(
    "on a stream whose write fails, settles and the process exits with its own code, its later 'error' heard (%s)",
    async (mode) => {
      const marker = join(mkdtempSync(join(tmpdir(), "run-report-marker-")), "marker");
      const { code, signal, stdout, stderr } = await onFailingStream(mode, marker);
      expect({ code, signal }, stderr).toEqual({ code: 0, signal: null });
      // Settled before the stream finished destroying itself, so before its 'error'.
      expect(stdout).toBe("settled\ndestroyed\n");
      expect(existsSync(marker)).toBe(false);
    },
    20_000,
  );

  it("on a real SIGTERM with a failing stream, still dies of the signal, without the marker", async () => {
    const marker = join(mkdtempSync(join(tmpdir(), "run-report-marker-")), "marker");
    const { code, signal, stderr } = await onFailingStream("signal", marker);
    expect({ code, signal }, stderr).toEqual({ code: null, signal: "SIGTERM" });
    expect(existsSync(marker)).toBe(false);
  }, 20_000);

  it.each([
    ["startRunReport's end", (stream: Writable) => startRunReport({ stream, env: {} }).end({ status: "ok", exitCode: 0 })],
    ["writeFinalLine", (stream: Writable) => writeFinalLine(stream, "{}\n")],
  ] as const)("listens to the stream only while a write needs it, keeping the host's listener (%s)", async (_path, write) => {
    const host = (): void => undefined;
    const written = new Writable({ write: (_chunk, _encoding, callback) => callback() });
    written.on("error", host);
    await write(written);
    expect(written.listeners("error")).toEqual([host]);
    expect(written.listenerCount("close")).toBe(0);

    for (const emitClose of [true, false]) {
      const heard: Error[] = [];
      const hostHearing = (err: Error): void => {
        heard.push(err);
      };
      const failing = failingWritable(emitClose);
      failing.on("error", hostHearing);
      const emitted = errorEmitted(failing);
      await write(failing);
      // Settled on the write's callback; still listening for the 'error' to come.
      expect(failing.listenerCount("error")).toBe(3);
      await emitted;
      expect(failing.listeners("error")).toEqual([hostHearing]);
      expect(failing.listenerCount("close")).toBe(0);
      expect(heard.map((err) => err.message)).toEqual(["write EPIPE"]);
    }
  });

  it("on a signal, listens to a failing stream until its 'error', after raising the signal", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const baseline = listenerCounts();
    const failing = failingWritable();
    const emitted = errorEmitted(failing);
    const { fakeSignal } = withFakeSignals(() => startRunReport({ stream: failing, env: {} }));
    fakeSignal("SIGTERM");
    await settle();
    expect(kill.mock.calls).toEqual([[process.pid, "SIGTERM"]]);
    expect(failing.listenerCount("error")).toBe(2);
    await emitted;
    expect(failing.listenerCount("error")).toBe(0);
    expect(failing.listenerCount("close")).toBe(0);
    expect(listenerCounts()).toEqual(baseline);
  });
});
