/** Adapted from the owner's weekly.mjs: review/run chains, a pool of eight, compact outcomes; no secret access. */
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { ToolConfig } from "@leanish/tool-runtime/config";
import type { ensureOsvScanner } from "@leanish/tool-runtime/osv-scanner";

import { openBatchLog, type BatchLog } from "./batch-log.ts";
import { commandEnvironment } from "./commands.ts";
import { readInstallation, type InstallationOptions } from "./configuration.ts";
import { requireFixturesForCandidate } from "./fixtures.ts";
import { readInstalledRelease, type InstalledRelease } from "./release.ts";
import { repositoryName } from "./tools.ts";

export interface BatchOptions extends InstallationOptions { readonly release: string; readonly repo?: string }
export interface Execution { readonly code: number; readonly report?: Readonly<Record<string, unknown>> }
type Invoke = (repo: string, action: "review" | "run", record: RecordLine) => Promise<Execution>;
const FAILURES = new Set(["error", "failed", "cannot-apply", "verification-failed", "incomplete", "partial-failure"]);
/**
 * Review outcomes a person should hear about, kept with their PR: closed after failing CI, an adaptation that changed
 * nothing, a PR the tool left alone (its body was rewritten, or a person took it over), and the waiting states
 * no-checks, waiting-required and held. Only these fixed names pass, never the tool's free-text detail. They aren't notes or errors.
 */
const ATTENTION = new Set(["closed", "no-checks", "waiting-required", "held", "adaptation-unchanged", "left-alone"]);
const ATTENTION_LIMIT = 100;
const PULL_REQUEST = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/;

/**
 * Coverage gaps (advisory sources a tool couldn't read) from the result's own `gaps`: bump-it lists them, secure-it
 * counts them. Only that top-level field counts, so a nested breakdown next to a total can't be added twice; only the
 * count passes.
 */
function coverageGaps(result: unknown): number {
  if (result === null || typeof result !== "object" || Array.isArray(result)) return 0;
  const gaps = (result as Record<string, unknown>)["gaps"];
  if (Array.isArray(gaps)) return gaps.length;
  return typeof gaps === "number" && Number.isSafeInteger(gaps) && gaps > 0 ? gaps : 0;
}

/** Inspect bounded structured results only. Raw child output, errors and notes are never forwarded to the agent. */
function compact(execution: Execution, repo: string) {
  const report = execution.report;
  let errors = execution.code !== 0 || report === undefined || report["status"] !== "ok" ? 1 : 0;
  let notes = 0;
  const prs = new Set<string>();
  const attention = new Map<string, string>();
  let attentionOmitted = 0;
  let remaining = 10_000;
  const visit = (value: unknown, depth: number) => {
    if (depth > 20 || remaining-- <= 0) { errors++; return; }
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const entry of value) visit(entry, depth + 1); return; }
    const object = value as Record<string, unknown>;
    if (typeof object["outcome"] === "string" && FAILURES.has(object["outcome"])) errors++;
    for (const key of ["error", "problems", "incomplete", "errors"]) if (object[key] && (!Array.isArray(object[key]) || object[key].length > 0)) errors++;
    for (const key of ["notes", "waiting", "blocked", "leftOut"]) if (object[key] && (!Array.isArray(object[key]) || object[key].length > 0)) notes++;
    // GitHub answers with the repository's canonical case, which a configured name may not share.
    const ownPullRequest = (url: unknown): url is string => typeof url === "string" && url.toLowerCase().startsWith(`https://github.com/${repo.toLowerCase()}/pull/`) && PULL_REQUEST.test(url);
    for (const key of ["pullRequest", "url"]) if (ownPullRequest(object[key])) prs.add(object[key]);
    const outcome = object["outcome"];
    if (typeof outcome === "string" && ATTENTION.has(outcome) && ownPullRequest(object["url"])) {
      if (attention.has(object["url"]) || attention.size < ATTENTION_LIMIT) attention.set(object["url"], outcome);
      else attentionOmitted++;
    }
    for (const nested of Object.values(object)) visit(nested, depth + 1);
  };
  visit(report?.["result"], 0);
  const gaps = coverageGaps(report?.["result"]);
  if (report?.["error"]) errors++;
  const totals = report?.["totals"] as Record<string, unknown> | undefined;
  const cost = totals?.["estimatedApiCostUsd"];
  return { outcome: errors > 0 ? "error" : "completed", errors, notes, gaps, prs: [...prs],
    attention: [...attention].map(([pr, outcome]) => ({ pr, outcome })), attentionOmitted, exitCode: execution.code,
    estimatedApiCostUsd: typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null };
}

/** Longest child line the person's log keeps; the rest is counted, not written. */
const LOGGED_LINE = 100_000;

/** One child output line for the person's batch log. */
export type RecordLine = (stream: "stdout" | "stderr", line: string) => void;

/**
 * One final report, parsed incrementally with a fixed line budget; prefer the tool over run.sh's fallback. Every
 * line also goes to `record` (the person's log), never to the agent.
 */
export function invokeTool(release: InstalledRelease, config: string, tool: InstallationOptions["tool"], repo: string, action: "review" | "run", record: RecordLine = () => {}): Promise<Execution> {
  return new Promise((resolve) => {
    const env = commandEnvironment(process.env);
    if (process.env["XDG_STATE_HOME"] !== undefined) env["XDG_STATE_HOME"] = process.env["XDG_STATE_HOME"];
    const child = spawn("/bin/bash", [join(release.path, "core", "tool-runtime", "run.sh"), tool, action, repo, "--config", config], { env, stdio: ["ignore", "pipe", "pipe"] });
    let report: Record<string, unknown> | undefined;
    let overflow = false;
    for (const [name, stream] of [["stdout", child.stdout], ["stderr", child.stderr]] as const) {
      let pending = "";
      const line = (text: string) => {
        if (text !== "") record(name, text.length > LOGGED_LINE ? `${text.slice(0, LOGGED_LINE)} [${text.length - LOGGED_LINE} more characters not logged]` : text);
        if (text.length > 2_000_000 || !text.startsWith("{")) return;
        try {
          const value = JSON.parse(text) as Record<string, unknown> | null;
          if (value?.["msg"] === "run finished" && value["tool"] === tool && value["repo"] === repo && !(report !== undefined && report["source"] !== "run.sh" && value["source"] === "run.sh")) report = value;
        } catch { /* Non-report output is intentionally discarded. */ }
      };
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        pending += chunk;
        let boundary: number;
        while ((boundary = pending.indexOf("\n")) !== -1) {
          line(pending.slice(0, boundary));
          pending = pending.slice(boundary + 1);
        }
        if (pending.length > 2_000_000) { pending = ""; overflow = true; record(name, "[line over 2,000,000 characters dropped; command stopped]"); child.kill("SIGTERM"); }
      });
      stream.on("end", () => line(pending));
    }
    // A launcher that can't start (EAGAIN, EMFILE) prints nothing: its reason goes to the person's log.
    child.on("error", (error) => { record("stderr", `[the launcher could not start: ${error.message}]`); resolve({ code: 1 }); });
    child.on("close", (code) => resolve({ code: overflow ? 1 : code ?? 1, report }));
  });
}

export async function executeBatch(options: InstallationOptions, repos: ReadonlyArray<string>, invoke: Invoke, emit: (record: Readonly<Record<string, unknown>>) => void, log?: BatchLog): Promise<number> {
  let next = 0;
  let failed = 0;
  let commands = 0;
  let gaps = 0;
  let outputFailure: unknown;
  const prs = new Set<string>();
  const attention = new Map<string, string>(); // by PR: the last outcome reported wins
  let attentionOmitted = 0;
  const worker = async () => {
    while (next < repos.length && outputFailure === undefined) {
      const repo = repos[next++]!;
      for (const action of ["review", "run"] as const) {
        if (outputFailure !== undefined) break;
        let execution: Execution;
        try { execution = await invoke(repo, action, (stream, line) => log?.write({ repo, action, stream, line })); } catch (error) {
          log?.write({ repo, action, event: "invoke-failed", message: error instanceof Error ? error.message : String(error) });
          execution = { code: 1 };
        }
        const outcome = compact(execution, repo);
        log?.write({ repo, action, event: "finished", ...outcome });
        commands++;
        if (outcome.errors > 0) failed++;
        gaps += outcome.gaps;
        for (const pr of outcome.prs) prs.add(pr);
        attentionOmitted += outcome.attentionOmitted;
        for (const { pr, outcome: state } of outcome.attention) {
          if (attention.has(pr) || attention.size < ATTENTION_LIMIT * 5) attention.set(pr, state);
          else attentionOmitted++;
        }
        try { emit({ schemaVersion: 1, ...options, repo, action, ...outcome }); } catch (error) { outputFailure = error; }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, repos.length) }, worker));
  if (outputFailure !== undefined) throw new Error("Batch output failed; active commands drained, no further work scheduled");
  const summary = { schemaVersion: 1, ...options, action: "summary", outcome: failed === 0 ? "completed" : "partial-failure", commands, failed, gaps, prs: [...prs],
    attention: [...attention].map(([pr, state]) => ({ pr, outcome: state })), attentionOmitted };
  log?.write({ event: "summary", ...summary });
  log?.close();
  // A fixed flag, never the log's path: the scheduled agent must not be pointed at text it shouldn't read.
  emit(log?.failed === true ? { ...summary, logFailed: true } : summary);
  return failed === 0 ? 0 : 1;
}

async function preflight(release: InstalledRelease, config: ToolConfig): Promise<void> {
  const module = await import(pathToFileURL(join(release.path, "core", "tool-runtime", "src", "osv-scanner.ts")).href) as { ensureOsvScanner: typeof ensureOsvScanner };
  await module.ensureOsvScanner(config.dirs.state, [config.dirs.cache, join(config.dirs.state, "workspaces"), tmpdir(), "/tmp"]);
}

export async function batch(
  options: BatchOptions, emit: (line: string) => void,
  machine = { release: readInstalledRelease, installation: readInstallation, preflight, invoke: invokeTool, log: openBatchLog },
): Promise<number> {
  const output = (record: Readonly<Record<string, unknown>>) => emit(JSON.stringify(record));
  let installation: Awaited<ReturnType<typeof readInstallation>>;
  let release: InstalledRelease;
  let selected: ReadonlyArray<string>;
  let phase: "configuration" | "release" | "repository-selection" | "candidate-scope" | "scanner" = "configuration";
  let log: BatchLog | undefined;
  const failures = {
    configuration: "configuration: could not read or validate the installation",
    release: "release: could not verify the installed release",
    "repository-selection": "repository-selection: no valid opted-in repository selected",
    "candidate-scope": "candidate-scope: a release candidate runs only on fixture repositories",
    scanner: "scanner: could not initialize the pinned scanner",
  };
  try {
    installation = await machine.installation(options);
    log = await machine.log(installation.config.dirs.state, { tool: options.tool, owner: options.owner });
    phase = "release";
    release = await machine.release(options.release);
    phase = "repository-selection";
    const repos = installation.config.repos.map(({ repo }) => repo);
    const selectedRepo = options.repo === undefined ? undefined : repositoryName(options.repo, options.owner);
    selected = selectedRepo === undefined ? repos : repos.filter((repo) => repo.toLowerCase() === selectedRepo.toLowerCase());
    if (selected.length === 0) throw new Error("Selected repository has not opted in");
    phase = "candidate-scope";
    requireFixturesForCandidate(release.tag, selected);
    phase = "scanner";
    await machine.preflight(release, installation.config);
  } catch (error) {
    log?.write({ event: "startup-failed", phase, message: error instanceof Error ? error.message : String(error) });
    log?.close();
    output({ schemaVersion: 1, tool: options.tool, owner: options.owner, action: "summary", outcome: "error", commands: 0, failed: 1, phase, reason: failures[phase],
      ...(log?.failed === true ? { logFailed: true } : {}) });
    return 1;
  }
  return executeBatch({ tool: options.tool, owner: options.owner }, selected, (repo, action, record) => machine.invoke(release, installation.path, options.tool, repo, action, record), output, log);
}
