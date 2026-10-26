// Copied from leanish/leanish-development core/runtime/src/runtime/run-report.ts at c6282df; see PROVENANCE.md.
// Local changes: only the fields every host shares; the host names the run with `identified` (the tools' `tool` and
// `repo`, the incubator's `agent`) and adds its own fields with `extra` (the incubator's dispatch counts), also on a
// signal; the command's `result` comes with its end.
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
    return serialized;
  }
}

/** A host field may neither replace a shared one nor, as an extra, its identity: the spread would silently win. */
function assertHostFields(kind: "identity" | "extra", fields: Readonly<Record<string, unknown>>, identity: Readonly<Record<string, string>>): void {
  // `toJSON` would replace the whole line when it's serialized.
  const clashing = Object.keys(fields).filter((field) => SHARED_FIELDS.has(field) || field === "toJSON" || Object.hasOwn(identity, field));
  if (clashing.length > 0) throw new Error(`run report ${kind} fields may not replace '${clashing.join("', '")}'`);
}

/** Writes `line` and resolves once it's handed to the OS, so an exit right after can't drop it. */
export function writeFinalLine(stream: NodeJS.WritableStream, line: string): Promise<void> {
  return new Promise((done) => {
    stream.write(line, () => done());
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
 * stops listening.
 */
export function reportOnTerminationSignals(report: RunReport, stream: NodeJS.WritableStream, extra?: () => RunExtra): () => void {
  let handling = false;
  const listener = (signal: NodeJS.Signals): void => {
    if (handling) return;
    handling = true;
    let raised = false;
    const raise = (): void => {
      if (raised) return;
      raised = true;
      stop();
      process.kill(process.pid, signal);
    };
    const end = { status: "interrupted", exitCode: 128 + (constants.signals[signal] ?? 0), signal, error: `stopped by ${signal}` } as const;
    let line: string | undefined;
    try {
      line = report.finish({ ...end, ...(extra !== undefined ? { extra: extra() } : {}) });
    } catch (err) {
      // A throw here would leave the run without its final line and the process dying of the throw, not the signal.
      line = report.finish({ ...end, error: `${end.error}; the host's fields were left out: ${(err as Error).message}` });
    }
    if (line === undefined) {
      raise();
      return;
    }
    const fallback = setTimeout(raise, SIGNAL_FLUSH_MS);
    stream.write(line, () => {
      clearTimeout(fallback);
      raise();
    });
  };
  const stop = (): void => {
    for (const signal of REPORTED_SIGNALS) process.removeListener(signal, listener);
  };
  for (const signal of REPORTED_SIGNALS) process.on(signal, listener);
  return stop;
}
