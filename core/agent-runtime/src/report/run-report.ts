// Copied from leanish/leanish-development core/runtime/src/runtime/run-report.ts at c6282df; see PROVENANCE.md.
// Local changes: only the fields every host shares; the host names the run with `identified` (the tools' `tool` and
// `repo`, the incubator's `agent`) and adds its own fields with `extra` (the incubator's dispatch counts), also on a
// signal; the command's `result` comes with its end; `startRunReport` owns a command's whole report (signals, the
// wrapper's marker, lines before the final one) instead of each host wiring it; a failed write's later 'error' is heard
// and dropped, so the process keeps its exit code.
import { writeFileSync } from "node:fs";
import { constants } from "node:os";
import { performance } from "node:perf_hooks";

import type { SkillUsageRecord, SkillUsageRecorder } from "../usage/skill-usage-record.ts";
import { totalSkillUsage, type UsageTotals } from "../usage/usage-totals.ts";

/**
 * What one command did, for the single `run finished` JSON line it always
 * ends with on stderr — whatever the log level, and on every exit path: a bad
 * argument, a failed startup, a failure, success, or a SIGINT / SIGTERM /
 * SIGHUP (then written before the process dies by that signal). Only SIGKILL
 * (or a crash of Node itself) ends a run without it.
 *
 * `status` describes the command, not the host's business outcome: a run that
 * found nothing to do, or left a PR for a human, still completed (`ok`); what
 * it did goes in `result`.
 *
 * The host's own fields sit among these, in this order: its identity (`identified`)
 * after `msg`, its extras (`RunEnd.extra`) after `result`.
 */
export interface RunFinished {
  readonly ts: string;
  readonly level: "info" | "error";
  readonly msg: "run finished";
  readonly status: RunStatus;
  readonly exitCode: number;
  readonly error?: string;
  readonly signal?: string;
  /** Wall time of the whole command on a monotonic clock. */
  readonly durationMs: number;
  /** What the command did (the PR it opened, the findings it fixed…), as the host reports it. */
  readonly result?: Readonly<Record<string, unknown>>;
  /** One record per finished skill run (`runSkill` call that reached its runner), in completion order. */
  readonly skills: ReadonlyArray<SkillUsageRecord>;
  readonly totals: UsageTotals;
  /** The host's identity and extra fields. */
  readonly [field: string]: unknown;
}

export type RunStatus = "ok" | "error" | "interrupted";

/** Host fields added to the line; never one of the shared fields of `RunFinished`. */
export type RunExtra = Readonly<Record<string, unknown>>;

export interface RunEnd {
  readonly status: RunStatus;
  readonly exitCode: number;
  readonly error?: string;
  readonly signal?: NodeJS.Signals;
  readonly result?: Readonly<Record<string, unknown>>;
  /** The host's own fields, such as the incubator's dispatch counts. */
  readonly extra?: RunExtra;
}

/** The fields `RunReport` writes itself, which a host's identity or extras may not replace. */
const SHARED_FIELDS: ReadonlySet<string> = new Set([
  "ts",
  "level",
  "msg",
  "status",
  "exitCode",
  "error",
  "signal",
  "durationMs",
  "result",
  "skills",
  "totals",
]);

/** The final record and the line it is written as (its JSON and a newline). */
export interface FinalLine {
  readonly record: RunFinished;
  readonly line: string;
}

/** Accumulates one command's facts; scoped to that command. */
export class RunReport {
  readonly #startedAt = performance.now();
  readonly #clock: () => string;
  readonly #skills: SkillUsageRecord[] = [];
  /** Skill runs that reached their runner and have no record yet. */
  readonly #inFlight = new Set<string>();
  #identity: Readonly<Record<string, string>> = {};
  #finished = false;

  constructor(clock: () => string = () => new Date().toISOString()) {
    this.#clock = clock;
  }

  /**
   * Names the run once its arguments are read (the tools: `tool` and `repo`; the incubator: `agent`). A later call
   * adds to or replaces earlier fields. Throws on a shared field's name.
   */
  identified(fields: Readonly<Record<string, string>>): void {
    assertHostFields("identity", fields, {});
    this.#identity = { ...this.#identity, ...fields };
  }

  /** For `SkillContext.usageRecorder`. */
  readonly usageRecorder: SkillUsageRecorder = {
    started: (run) => {
      this.#inFlight.add(run.invocationId);
    },
    record: (record) => {
      this.#inFlight.delete(record.invocationId);
      this.#skills.push(record);
    },
  };

  /**
   * The final line, once: later calls (a signal racing the normal end) get undefined. Throws, without finishing, when
   * `end.extra` names a shared or identity field or can't be serialized, so a caller can still finish without it.
   */
  finish(end: RunEnd): string | undefined {
    return this.finishRecord(end)?.line;
  }

  /** As `finish`, with the record the line serializes, for a host that writes lines derived from it. */
  finishRecord(end: RunEnd): FinalLine | undefined {
    if (this.#finished) return undefined;
    const extra = end.extra ?? {};
    assertHostFields("extra", extra, this.#identity);
    const totals = totalSkillUsage(this.#skills, this.#inFlight.size);
    const line: RunFinished = {
      ts: this.#clock(),
      level: end.status === "ok" ? "info" : "error",
      msg: "run finished",
      ...this.#identity,
      status: end.status,
      exitCode: end.exitCode,
      ...(end.error !== undefined ? { error: end.error } : {}),
      ...(end.signal !== undefined ? { signal: end.signal } : {}),
      durationMs: Math.round(performance.now() - this.#startedAt),
      ...(end.result !== undefined ? { result: end.result } : {}),
      ...extra,
      skills: [...this.#skills],
      totals,
    };
    const serialized = `${JSON.stringify(line)}\n`;
    this.#finished = true;
    return { record: line, line: serialized };
  }
}

/** A host field may neither replace a shared one nor, as an extra, its identity: the spread would silently win. */
function assertHostFields(kind: "identity" | "extra", fields: Readonly<Record<string, unknown>>, identity: Readonly<Record<string, string>>): void {
  // `toJSON` would replace the whole line when it's serialized.
  const clashing = Object.keys(fields).filter((field) => SHARED_FIELDS.has(field) || field === "toJSON" || Object.hasOwn(identity, field));
  if (clashing.length > 0) throw new Error(`run report ${kind} fields may not replace '${clashing.join("', '")}'`);
}

/**
 * Writes `line` and resolves once it's handed to the OS, so an exit right after can't drop it. A failed write resolves
 * too, with nothing more written: the stream's 'error' that follows is swallowed rather than ending the process, so the
 * host's exit code stands.
 */
export async function writeFinalLine(stream: NodeJS.WritableStream, line: string): Promise<void> {
  await flushed(stream, line);
}

/**
 * Writes `text`; resolves once it's handed to the OS, to whether that worked. A stream that throws instead of calling
 * back with its error also resolves to false: the run's end must still settle, with its exit code.
 *
 * A Node stream whose write fails calls back with the error, then emits 'error' once it's destroyed, which can take
 * longer than a turn of the event loop (an asynchronous `_destroy`). With no listener that kills the process, its exit
 * code lost, so this listens before writing: after a success it stops at once; after a failure it stays until the
 * stream's 'error' or 'close'. Only its own listeners are removed, the host's stay. The end doesn't wait for either
 * event: a stream may never emit 'close' (`emitClose: false`).
 */
function flushed(stream: NodeJS.WritableStream, text: string): Promise<boolean> {
  return new Promise((done) => {
    // Settles a write the stream ended before calling back, if any; nothing more comes after either event.
    const streamEnded = (): void => {
      done(false);
      stopListening();
    };
    const stopListening = (): void => {
      stream.removeListener("error", streamEnded);
      stream.removeListener("close", streamEnded);
    };
    stream.on("error", streamEnded);
    stream.on("close", streamEnded);
    try {
      stream.write(text, (err) => {
        const written = err === undefined || err === null;
        done(written);
        if (written) stopListening();
      });
    } catch {
      done(false);
    }
  });
}

const REPORTED_SIGNALS: ReadonlyArray<NodeJS.Signals> = ["SIGINT", "SIGTERM", "SIGHUP"];
/** How long a final line may take to flush before the signal is raised anyway. */
const SIGNAL_FLUSH_MS = 2_000;

/**
 * While a command runs, a SIGINT / SIGTERM / SIGHUP first writes its final
 * line (`interrupted`, exit code 128 + the signal's number), then is raised
 * again with this listener gone, so the process ends by the signal as it
 * would have without it (a running coding agent's own signal forwarding, in
 * `spawnCapture`, still kills its process group). `extra` gives the host's
 * own fields as they stand when the signal arrives (the incubator's dispatch
 * counts), as `RunEnd.extra` does on a normal end. Returns the function that
 * stops listening. `startRunReport` does this, and the normal end, for a
 * command that owns its process.
 */
export function reportOnTerminationSignals(report: RunReport, stream: NodeJS.WritableStream, extra?: () => RunExtra): () => void {
  return raisingAfter(async (signal) => {
    const text = finalText(report, interrupted(signal), extra);
    if (text !== undefined) await writeFinalLine(stream, text);
  });
}

/** Where a wrapper's marker file is named, and when this process writes it to say it reports the run itself. */
export interface RunReportMarker {
  /** The environment variable naming the file; read and removed from the environment as reporting starts. */
  readonly env: string;
  /**
   * `start`: as soon as reporting is in place (the wrapper's own line is then never needed). `after-final-line`: once
   * the final line is flushed; best effort, so a failed write leaves the wrapper to write its own line too, a duplicate
   * rather than none.
   */
  readonly when: "start" | "after-final-line";
}

export interface RunReportOptions {
  /** Where the final line (and the lines `beforeFinalLine` gives) goes. */
  readonly stream: NodeJS.WritableStream;
  readonly marker?: RunReportMarker;
  /** The environment `marker.env` is read from and removed from; `process.env` unless a test gives its own. */
  readonly env?: NodeJS.ProcessEnv;
  /** The host's own fields (`RunEnd.extra`), evaluated when the run completes: at its end or on a signal. */
  readonly extra?: () => RunExtra;
  /** Lines (without their newline) written right before the final line, in the same write, from its record. */
  readonly beforeFinalLine?: (final: RunFinished) => ReadonlyArray<string>;
}

/** One command's report, from `startRunReport`. */
export interface StartedRunReport {
  /** As `RunReport.identified`. */
  identified(fields: Readonly<Record<string, string>>): void;
  /** For `SkillContext.usageRecorder`. */
  readonly usageRecorder: SkillUsageRecorder;
  /**
   * Writes the final line and resolves once it's flushed. Idempotent: a later call, or one racing a signal, writes
   * nothing more and resolves once the one line is flushed. Stops the signal handling.
   */
  end(end: Omit<RunEnd, "extra">): Promise<void>;
}

/**
 * Starts the report of a command that owns its process: one final line on `stream`, on its end or on a SIGINT /
 * SIGTERM / SIGHUP (then raised again once the line is out, as `reportOnTerminationSignals` does), through the same
 * path. `extra` or `beforeFinalLine` throwing can't keep that line from being written nor the signal from being raised:
 * what they would have added is left out, and the line's `error` says why. The marker's variable is removed from the
 * environment before this returns, so nothing the command starts inherits it. A host that runs several reports in one
 * process (a Lambda function's invocations) composes `RunReport` and `writeFinalLine` instead, with no signal handlers.
 */
export function startRunReport(options: RunReportOptions): StartedRunReport {
  const marker = takeMarker(options.marker, options.env ?? process.env);
  const report = new RunReport();
  let closing: Promise<void> | undefined;
  const close = (end: Omit<RunEnd, "extra">): Promise<void> => {
    closing ??= new Promise<void>((done) => {
      const text = finalText(report, end, options.extra, options.beforeFinalLine);
      if (text === undefined) {
        done();
        return;
      }
      done(flushed(options.stream, text).then((written) => {
        // Synchronous: on a signal, the process dies right after this.
        if (written && marker?.when === "after-final-line") writeMarker(marker.path);
      }));
    });
    return closing;
  };
  const stop = raisingAfter((signal) => close(interrupted(signal)));
  if (marker?.when === "start") {
    try {
      writeFileSync(marker.path, "reported\n");
    } catch (err) {
      // The wrapper will then write a final line of its own too; say why there are two.
      options.stream.write(`run report: can't write ${marker.env}=${marker.path} (${messageOf(err)}); the wrapper may report this run as well\n`);
    }
  }
  return {
    identified: (fields) => report.identified(fields),
    usageRecorder: report.usageRecorder,
    end: async (end) => {
      try {
        await close(end);
      } finally {
        stop();
      }
    },
  };
}

interface TakenMarker {
  readonly env: string;
  readonly path: string;
  readonly when: RunReportMarker["when"];
}

/** Reads the marker's file from `env` and removes the variable, so no child process inherits it. */
function takeMarker(marker: RunReportMarker | undefined, env: NodeJS.ProcessEnv): TakenMarker | undefined {
  if (marker === undefined) return undefined;
  const path = env[marker.env];
  delete env[marker.env];
  if (path === undefined || path === "") return undefined;
  return { env: marker.env, path, when: marker.when };
}

function writeMarker(path: string): void {
  try {
    writeFileSync(path, "reported\n");
  } catch {
    // The wrapper reports as well: a duplicate line rather than none.
  }
}

/** A signal's end: `interrupted`, with 128 + its number as the exit code. */
function interrupted(signal: NodeJS.Signals): Omit<RunEnd, "extra"> {
  return { status: "interrupted", exitCode: 128 + (constants.signals[signal] ?? 0), signal, error: `stopped by ${signal}` };
}

/**
 * The text that ends the run: `beforeFinalLine`'s lines, then the final line; undefined once the report finished. What
 * throws is left out, noted in the line's `error`: a throw here would leave the run without its final line (and, on a
 * signal, the process dying of the throw, not the signal).
 */
function finalText(
  report: RunReport,
  end: Omit<RunEnd, "extra">,
  extra?: () => RunExtra,
  beforeFinalLine?: (final: RunFinished) => ReadonlyArray<string>,
): string | undefined {
  let final: FinalLine | undefined;
  try {
    final = report.finishRecord({ ...end, ...(extra !== undefined ? { extra: extra() } : {}) });
  } catch (err) {
    try {
      final = report.finishRecord({ ...end, error: noted(end.error, `the host's fields were left out: ${messageOf(err)}`) });
    } catch {
      // The result itself can't be written (a value JSON can't serialize, say): the line goes without it too.
      const { result: _unwritable, ...rest } = end;
      final = report.finishRecord({ ...rest, error: noted(end.error, `the host's fields and the result were left out: ${messageOf(err)}`) });
    }
  }
  if (final === undefined || beforeFinalLine === undefined) return final?.line;
  // From the serialized line, never the record itself: whatever the callback does to its copy, the line stays as it was.
  const snapshot = (): RunFinished => JSON.parse(final.line) as RunFinished;
  try {
    return [...beforeFinalLine(snapshot()).map((line) => `${line}\n`), final.line].join("");
  } catch (err) {
    const record = snapshot();
    return `${JSON.stringify(withError(record, noted(record.error, `the lines before this one were left out: ${messageOf(err)}`)))}\n`;
  }
}

function noted(error: string | undefined, note: string): string {
  return error === undefined ? note : `${error}; ${note}`;
}

/** `record` with `error` replaced, in its place right after `exitCode`. */
function withError(record: RunFinished, error: string): RunFinished {
  const fields = Object.entries(record).filter(([field]) => field !== "error");
  fields.splice(fields.findIndex(([field]) => field === "exitCode") + 1, 0, ["error", error]);
  return Object.fromEntries(fields) as unknown as RunFinished;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Listens for SIGINT / SIGTERM / SIGHUP: the first runs `onSignal`, then (once it settles, or after SIGNAL_FLUSH_MS)
 * is raised again with these listeners gone, so the process ends by it. Returns the function that stops listening.
 */
function raisingAfter(onSignal: (signal: NodeJS.Signals) => Promise<void>): () => void {
  let handling = false;
  const listener = (signal: NodeJS.Signals): void => {
    if (handling) return;
    handling = true;
    let raised = false;
    const raise = (): void => {
      if (raised) return;
      raised = true;
      clearTimeout(fallback);
      stop();
      process.kill(process.pid, signal);
    };
    const fallback = setTimeout(raise, SIGNAL_FLUSH_MS);
    let settled: Promise<void>;
    try {
      settled = onSignal(signal);
    } catch {
      settled = Promise.resolve();
    }
    settled.then(raise, raise);
  };
  const stop = (): void => {
    for (const signal of REPORTED_SIGNALS) process.removeListener(signal, listener);
  };
  for (const signal of REPORTED_SIGNALS) process.on(signal, listener);
  return stop;
}
