import { randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { parseDocument } from "yaml";

import { CODING_AGENTS, parseToolConfig, type CodingAgent, type ToolConfig } from "@leanish/tool-runtime/config";

import { result, type SetupResult } from "./contracts.ts";
import { descriptor, ownerName, repositoryName, toolName, type Tool } from "./tools.ts";

export interface InstallationOptions {
  readonly tool: Tool;
  readonly owner: string;
}
export interface ConfigureOptions extends InstallationOptions {
  readonly repos: ReadonlyArray<string>;
  readonly agent?: CodingAgent;
  readonly model?: string;
  readonly effort?: string;
  readonly name?: string;
  readonly email?: string;
}

export function configPath(options: InstallationOptions, home = homedir()): string {
  return join(home, ".config", "leanish", "installations", ownerName(options.owner), toolName(options.tool), "agent.yaml");
}

export async function fileEntry(path: string) {
  try { return await lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Do not let a restored or repository-controlled symlink redirect configuration writes. */
async function ensureDirectory(path: string, home: string): Promise<void> {
  if (path !== home) await ensureDirectory(dirname(path), home);
  const entry = await fileEntry(path);
  if (entry !== undefined) {
    if (!entry.isDirectory()) throw new Error("Installation directories must not be symlinks or files");
    return;
  }
  try { await mkdir(path, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !(await fileEntry(path))?.isDirectory()) throw error;
  }
}

export function validateConfig(options: InstallationOptions, text: string, path: string, home: string): ToolConfig {
  try {
    const config = parseToolConfig(options.tool, text, path, home);
    for (const { repo } of config.repos) repositoryName(repo, options.owner);
    for (const name of Object.values(config.secrets)) if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error();
    return config;
  } catch {
    // YAML diagnostics can echo user-entered values. Never return them to a conversational agent.
    throw new Error("Installation config is invalid; inspect it locally against docs/tool-configuration.md");
  }
}

export async function readInstallation(options: InstallationOptions, home = homedir()): Promise<{ path: string; config: ToolConfig }> {
  const path = configPath(options, home);
  for (let parent = dirname(path); parent !== home; parent = dirname(parent)) {
    if (!(await fileEntry(parent))?.isDirectory()) throw new Error("Installation parents must be real directories");
  }
  const entry = await fileEntry(path);
  if (!entry?.isFile()) throw new Error("Installation config must exist as a regular file");
  return { path, config: validateConfig(options, await readFile(path, "utf8"), path, home) };
}

/** Publish a complete PID lock atomically, so interruption cannot leave an empty live-looking lock. */
export async function lockConfiguration(lock: string): Promise<void> {
  const temporary = `${lock}.${randomUUID()}.tmp`;
  try {
    try { await writeFile(temporary, `${process.pid}\n`, { mode: 0o600, flag: "wx" }); }
    catch (error) { throw new Error(`Could not create installation configuration lock (${(error as NodeJS.ErrnoException).code ?? "unknown filesystem error"})`); }
    for (let attempt = 0; attempt < 2; attempt++) {
      try { await link(temporary, lock); return; } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw new Error(`Could not create installation configuration lock (${code ?? "unknown filesystem error"})`);
        const entry = await fileEntry(lock);
        const pid = entry?.isFile() ? Number(await readFile(lock, "utf8")) : NaN;
        let stale = false;
        if (Number.isSafeInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); } catch (probe) { stale = (probe as NodeJS.ErrnoException).code === "ESRCH"; }
        }
        const current = await fileEntry(lock);
        if (!stale || current?.ino !== entry?.ino || attempt > 0) throw new Error("Installation configuration is locked; inspect before retrying");
        await rm(lock);
      }
    }
  } finally { await rm(temporary, { force: true }); }
}

/** Reconcile opt-ins only. Existing identity, agent, branches, paths, limits and secret overrides stay the person's. */
export async function configure(options: ConfigureOptions, home = homedir()): Promise<SetupResult> {
  const path = configPath(options, home);
  const owner = ownerName(options.owner);
  if (options.repos.length === 0) throw new Error("Select at least one repository");
  for (const repo of options.repos) repositoryName(repo, owner);
  if (options.agent !== undefined && !CODING_AGENTS.includes(options.agent)) throw new Error("Invalid coding agent");
  const entry = await fileEntry(path);
  if (entry !== undefined && !entry.isFile()) throw new Error("Installation config must be a regular file");
  if (entry === undefined && (options.agent === undefined || !options.name?.trim() || !options.email?.trim())) {
    return result("configure", "choices", "needs-confirmation", "A new installation needs --agent, --name and --email", { path });
  }
  const contribution = await descriptor(options.tool);
  const text = entry === undefined ? contribution.template.replaceAll("{{owner}}", owner) : await readFile(path, "utf8");
  const existing = entry === undefined ? undefined : validateConfig(options, text, path, home);
  const doc = parseDocument(text);
  if (existing === undefined) {
    const agent = options.agent!;
    doc.set("agent", { codingAgent: agent, model: options.model ?? contribution.descriptor.agentDefaults[agent].model, effort: options.effort ?? contribution.descriptor.agentDefaults[agent].effort });
    doc.set("commitIdentity", { name: options.name, email: options.email });
  }
  const repos = [...(existing?.repos ?? [])];
  for (const repo of options.repos) if (!repos.some((entry) => entry.repo.toLowerCase() === repo.toLowerCase())) repos.push({ repo, branch: undefined });
  const added = repos.length !== (existing?.repos.length ?? 0);
  // Append to the validated YAML sequence, preserving every existing per-repo key and comment.
  if (added) for (const { repo } of repos.slice(existing?.repos.length ?? 0)) doc.addIn(["repos"], { repo });
  const updated = doc.toString();
  validateConfig(options, updated, path, home);
  await ensureDirectory(dirname(path), home);
  const lock = join(dirname(path), ".setup-lock");
  await lockConfiguration(lock);
  try {
    // Refuse a lost update instead of overwriting another editor's choices.
    const current = await fileEntry(path);
    if ((current === undefined) !== (entry === undefined) || (current !== undefined && (!current.isFile() || await readFile(path, "utf8") !== text))) throw new Error("Installation config changed during reconciliation; retry");
    if (added) {
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, updated, { mode: 0o600, flag: "wx" });
        await rename(temporary, path);
      } finally { await rm(temporary, { force: true }); }
    }
    await chmod(path, 0o600);
    return result("configure", "config", added || ((entry?.mode ?? 0) & 0o777) !== 0o600 ? "changed" : "already-done", "Reconciled explicit repository opt-ins; existing choices preserved", { path, repos: repos.map(({ repo }) => repo) });
  } finally { await rm(lock, { recursive: true, force: true }); }
}
