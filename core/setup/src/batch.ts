/** Adapted from the owner's weekly.mjs: review/run chains, a pool of eight, compact outcomes; no secret access. */
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { ToolConfig } from "@leanish/tool-runtime/config";
import type { ensureOsvScanner } from "@leanish/tool-runtime/osv-scanner";

import { commandEnvironment } from "./commands.ts";
import { readInstallation, type InstallationOptions } from "./configuration.ts";
import { readInstalledRelease, type InstalledRelease } from "./release.ts";
import { repositoryName } from "./tools.ts";

export interface BatchOptions extends InstallationOptions { readonly release: string; readonly repo?: string }
export interface Execution { readonly code: number; readonly report?: Readonly<Record<string, unknown>> }
type Invoke = (repo: string, action: "review" | "run") => Promise<Execution>;
const FAILURES = new Set(["error", "failed", "cannot-apply", "verification-failed", "incomplete", "partial-failure"]);

/** Inspect bounded structured results only. Raw child output, errors and notes are never forwarded to the agent. */
function compact(execution: Execution, repo: string) {
  const report = execution.report;
  let errors = execution.code !== 0 || report === undefined || report["status"] !== "ok" ? 1 : 0;
  let notes = 0;
  const prs = new Set<string>();
  let remaining = 10_000;
  const visit = (value: unknown, depth: number) => {
    if (depth > 20 || remaining-- <= 0) { errors++; return; }
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const entry of value) visit(entry, depth + 1); return; }
    const object = value as Record<string, unknown>;
    if (typeof object["outcome"] === "string" && FAILURES.has(object["outcome"])) errors++;
    for (const key of ["error", "problems", "incomplete", "errors"]) if (object[key] && (!Array.isArray(object[key]) || object[key].length > 0)) errors++;
    for (const key of ["notes", "waiting", "blocked", "leftOut"]) if (object[key] && (!Array.isArray(object[key]) || object[key].length > 0)) notes++;
    for (const key of ["pullRequest", "url"]) {
      const url = object[key];
      if (typeof url === "string" && url.startsWith(`https://github.com/${repo}/pull/`) && /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/.test(url)) prs.add(url);
    }
    for (const nested of Object.values(object)) visit(nested, depth + 1);
  };
  visit(report?.["result"], 0);
  if (report?.["error"]) errors++;
  const totals = report?.["totals"] as Record<string, unknown> | undefined;
  const cost = totals?.["estimatedApiCostUsd"];
  return { outcome: errors > 0 ? "error" : "completed", errors, notes, prs: [...prs], exitCode: execution.code,
    estimatedApiCostUsd: typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null };
}

/** One final report, parsed incrementally with a fixed line budget; prefer the tool over run.sh's fallback. */
export function invokeTool(release: InstalledRelease, config: string, tool: InstallationOptions["tool"], repo: string, action: "review" | "run"): Promise<Execution> {
  return new Promise((resolve) => {
    const env = commandEnvironment(process.env);
    if (process.env["XDG_STATE_HOME"] !== undefined) env["XDG_STATE_HOME"] = process.env["XDG_STATE_HOME"];
    const child = spawn("/bin/bash", [join(release.path, "core", "tool-runtime", "run.sh"), tool, action, repo, "--config", config], { env, stdio: ["ignore", "pipe", "pipe"] });
    let report: Record<string, unknown> | undefined;
    let overflow = false;
    for (const stream of [child.stdout, child.stderr]) {
      let pending = "";
      const line = (text: string) => {
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
        if (pending.length > 2_000_000) { pending = ""; overflow = true; child.kill("SIGTERM"); }
      });
      stream.on("end", () => line(pending));
    }
    child.on("error", () => resolve({ code: 1 }));
    child.on("close", (code) => resolve({ code: overflow ? 1 : code ?? 1, report }));
  });
}

export async function executeBatch(options: InstallationOptions, repos: ReadonlyArray<string>, invoke: Invoke, emit: (record: Readonly<Record<string, unknown>>) => void): Promise<number> {
  let next = 0;
  let failed = 0;
  let commands = 0;
  let outputFailure: unknown;
  const prs = new Set<string>();
  const worker = async () => {
    while (next < repos.length && outputFailure === undefined) {
      const repo = repos[next++]!;
      for (const action of ["review", "run"] as const) {
        if (outputFailure !== undefined) break;
        let execution: Execution;
        try { execution = await invoke(repo, action); } catch { execution = { code: 1 }; }
        const outcome = compact(execution, repo);
        commands++;
        if (outcome.errors > 0) failed++;
        for (const pr of outcome.prs) prs.add(pr);
        try { emit({ schemaVersion: 1, ...options, repo, action, ...outcome }); } catch (error) { outputFailure = error; }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, repos.length) }, worker));
  if (outputFailure !== undefined) throw new Error("Batch output failed; active commands drained, no further work scheduled");
  emit({ schemaVersion: 1, ...options, action: "summary", outcome: failed === 0 ? "completed" : "partial-failure", commands, failed, prs: [...prs] });
  return failed === 0 ? 0 : 1;
}

async function preflight(release: InstalledRelease, config: ToolConfig): Promise<void> {
  const module = await import(pathToFileURL(join(release.path, "core", "tool-runtime", "src", "osv-scanner.ts")).href) as { ensureOsvScanner: typeof ensureOsvScanner };
  await module.ensureOsvScanner(config.dirs.state, [config.dirs.cache, join(config.dirs.state, "workspaces"), tmpdir(), "/tmp"]);
}

export async function batch(
  options: BatchOptions, emit: (line: string) => void,
  machine = { release: readInstalledRelease, installation: readInstallation, preflight, invoke: invokeTool },
): Promise<number> {
  const output = (record: Readonly<Record<string, unknown>>) => emit(JSON.stringify(record));
  let installation: Awaited<ReturnType<typeof readInstallation>>;
  let release: InstalledRelease;
  let selected: ReadonlyArray<string>;
  let phase: "configuration" | "release" | "repository-selection" | "scanner" = "configuration";
  const failures = {
    configuration: "configuration: could not read or validate the installation",
    release: "release: could not verify the installed release",
    "repository-selection": "repository-selection: no valid opted-in repository selected",
    scanner: "scanner: could not initialize the pinned scanner",
  };
  try {
    installation = await machine.installation(options);
    phase = "release";
    release = await machine.release(options.release);
    phase = "repository-selection";
    const repos = installation.config.repos.map(({ repo }) => repo);
    const selectedRepo = options.repo === undefined ? undefined : repositoryName(options.repo, options.owner);
    selected = selectedRepo === undefined ? repos : repos.filter((repo) => repo.toLowerCase() === selectedRepo.toLowerCase());
    if (selected.length === 0) throw new Error("Selected repository has not opted in");
    phase = "scanner";
    await machine.preflight(release, installation.config);
  } catch {
    output({ schemaVersion: 1, tool: options.tool, owner: options.owner, action: "summary", outcome: "error", commands: 0, failed: 1, phase, reason: failures[phase] });
    return 1;
  }
  return executeBatch({ tool: options.tool, owner: options.owner }, selected, (repo, action) => machine.invoke(release, installation.path, options.tool, repo, action), output);
}
