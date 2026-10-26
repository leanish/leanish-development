/**
 * The command around one run of a tool: `<tool> run|review <owner/repo>
 * [--config <file>]`. It reads the config (the repository must be listed),
 * the two tokens from the config's resolved per-tool Keychain services
 * (defaults or explicit overrides; the write one for the tool's own
 * GitHub calls, clone and push; the read-only one, the only credential the
 * agent's commands get), syncs the working copy, wires the isolated coding
 * agent, hands everything to the tool's `run` or `review`, and always ends with
 * a GitHub request summary and the `run finished` line on stderr,
 * interruptions included.
 */
import { writeFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";
import { isDeepStrictEqual, parseArgs } from "node:util";

import { createGitHubClient } from "@leanish/agent-runtime/github/github-client";
import { codexIsolation } from "@leanish/agent-runtime/isolation";
import type { CodexRunnerOptions } from "@leanish/agent-runtime/skill/codex-runner";
import { ConsoleLogger } from "@leanish/agent-runtime/logger/console-logger";
import { reportOnTerminationSignals, RunReport, writeFinalLine } from "@leanish/agent-runtime/report/run-report";
import { ClaudeCodeRunner } from "@leanish/agent-runtime/skill/claude-code-runner";
import { CodexRunner } from "@leanish/agent-runtime/skill/codex-runner";
import { runSkill } from "@leanish/agent-runtime/skill/run-skill";
import type { CodingAgentRunner } from "@leanish/agent-runtime/skill/runner";
import { SkillLoader } from "@leanish/agent-runtime/skill/skill-loader";
import { SchemaValidator } from "@leanish/agent-runtime/skill/validator";
import { KeychainStore, type SecretStore } from "@leanish/agent-runtime/secret-store";
import type { GitHubClient } from "@leanish/agent-runtime/types/clients";
import type { Logger } from "@leanish/agent-runtime/types/logger";
import type { WorkingCopy } from "@leanish/agent-runtime/types/working-copy";
import { parseModelPrices } from "@leanish/agent-runtime/usage/model-prices";
import { gitCloneAuth } from "@leanish/agent-runtime/working-copy/git-clone-auth";
import { LocalGitWorkspace } from "@leanish/agent-runtime/working-copy/local-git-workspace";
import type { Workspace } from "@leanish/agent-runtime/working-copy/workspace";
import { readSettings } from "@leanish/gate/gate";
import { workingTree } from "@leanish/gate/tree";

import { type CodingAgent, defaultConfigPath, parseToolConfig, repoOf, type ToolConfig, type ToolRepo } from "./config.ts";
import { DEFAULT_MODEL_PRICES } from "./model-prices.ts";
import type { ToolName } from "./own-pr.ts";
import { GitHubRequests } from "./github-requests.ts";
import { changedSince, fileState, type FileState, git } from "./git-copies.ts";
import { runProcess } from "@leanish/gate/process";
import { safePath } from "./local-files.ts";

const GUARD_DIR = fileURLToPath(new URL("../../agent-runtime/guard", import.meta.url));

/** What a tool's `run` or `review` gets. */
export interface ToolRunContext {
  /** Command-scoped fetch: counts the tool's own GitHub API attempts, including gate reads and retries. */
  readonly fetch: typeof globalThis.fetch;
  readonly config: ToolConfig;
  readonly repo: ToolRepo;
  /** The branch the tool works against: the configured one, else the repository's default branch. */
  readonly base: string;
  readonly github: GitHubClient;
  readonly workspace: Workspace;
  readonly workingCopy: WorkingCopy;
  readonly logger: Logger;
  readonly now: Date;
  /** The repository's release age, from its `.github/supply-chain.json`. */
  readonly releaseAgeDays: number;
  /** npm patterns exempt from it: the repository's own scopes (`@scope/*`), whose young versions resolve anyway. */
  readonly releaseAgeExclude: ReadonlyArray<string>;
  /** The agent's read-only token: for the gate's own GitHub reads (advisories, actions), never for writes. */
  readonly readToken: string;
  /** How the agent is isolated; `runSandboxed` runs repository code the same way. */
  readonly isolation: CodexRunnerOptions;
  /** Runs a skill with write access and the read-only token; restoredFiles declares dependency restores to its guard only. */
  readonly agent: <TInput, TOutput>(call: { readonly entrypoint: string; readonly input: TInput; readonly restoredFiles?: ReadonlyArray<FileState> }) => Promise<TOutput>;
}

export interface ToolHandlers {
  readonly tool: ToolName;
  /** Where the tool's skills live, its entrypoints, and the support skills staged with each. */
  readonly skills: { readonly dirs: ReadonlyArray<string>; readonly entrypoints: ReadonlyArray<string>; readonly support: ReadonlyArray<string> };
  run(context: ToolRunContext): Promise<Readonly<Record<string, unknown>>>;
  review(context: ToolRunContext): Promise<Readonly<Record<string, unknown>>>;
}

/** The machine a command runs on; each defaults to the real one, tests replace them. */
export interface Machine {
  readonly assertAgentWorkspace: typeof assertAgentWorkspace;
  readonly secrets: SecretStore;
  readonly fetch: typeof globalThis.fetch;
  readonly stderr: NodeJS.WritableStream;
  readonly now: () => Date;
  readonly readText: (path: string) => Promise<string>;
  /** Creates a directory and its missing parents, private to the user; leaves an existing one as it is. */
  readonly ensureDir: (path: string) => Promise<void>;
  readonly workspace: (root: string, token: string, config: ToolConfig) => Workspace;
  readonly runner: (codingAgent: CodingAgent, isolation: CodexRunnerOptions) => CodingAgentRunner;
  /** run.sh's marker file (`TOOL_REPORT_MARKER`): written once the final line is out, so run.sh doesn't write one too. */
  readonly reportMarker: string | undefined;
}

export const USAGE = (tool: ToolName) => `usage: ${tool} run|review <owner/repo> [--config <agent.yaml>]`;

/** Runs the command `argv` describes; resolves to its exit code once the final line is written. */
export async function runToolCommand(handlers: ToolHandlers, argv: ReadonlyArray<string>, machine: Partial<Machine> = {}): Promise<number> {
  const m: Machine = { ...defaultMachine(), ...machine };
  const report = new RunReport();
  const requests = new GitHubRequests();
  const fetch = requests.wrap(m.fetch);
  let command: string | undefined;
  // The final line goes through this stream, on the normal path and on a signal's: it tells run.sh once the line is out.
  const finalLines = acknowledging(m.stderr, m.reportMarker, requests, () => ({ tool: handlers.tool, command }));
  let stopReporting: () => void = () => undefined;
  const finish = async (exitCode: number, status: "ok" | "error", extra: { error?: string; result?: Readonly<Record<string, unknown>> } = {}) => {
    stopReporting();
    const line = report.finish({ status, exitCode, ...extra });
    if (line !== undefined) await writeFinalLine(finalLines, line);
    return exitCode;
  };
  try {
    stopReporting = reportOnTerminationSignals(report, finalLines);
  } catch (err) {
    return finish(70, "error", { error: `couldn't start reporting: ${(err as Error).message}` });
  }

  let repoName: string;
  let configPath: string;
  try {
    const { values, positionals } = parseArgs({ args: [...argv], options: { config: { type: "string" } }, allowPositionals: true, strict: true });
    if (positionals.length !== 2 || (positionals[0] !== "run" && positionals[0] !== "review")) throw new Error(USAGE(handlers.tool));
    [command, repoName] = positionals as [string, string];
    configPath = values.config ?? defaultConfigPath(handlers.tool);
  } catch (err) {
    return finish(64, "error", { error: (err as Error).message });
  }

  report.identified({ tool: handlers.tool, repo: repoName });
  const logger = new ConsoleLogger({ minLevel: "info", stream: m.stderr }).with({ tool: handlers.tool, repo: repoName, command });
  try {
    const config = parseToolConfig(handlers.tool, await m.readText(configPath), configPath);
    const repo = repoOf(config, repoName);
    const write = await m.secrets.get(config.secrets.write);
    const read = await m.secrets.get(config.secrets.read);
    if (write === read) throw new Error(`${config.secrets.write} and ${config.secrets.read} hold the same token: the agent would get the write one`);
    // The sandbox may write inside the cache but can't create it or its parents. The agent's runner creates its roots
    // before a call, but sandboxed commands (inventories, npm, Gradle) can run first: on a fresh installation's
    // missing `dirs.cache` they failed with EPERM.
    await m.ensureDir(config.dirs.cache);
    // The tools' fine-grained token has no Checks permission, so CI is read from Actions jobs and commit statuses.
    const github = createGitHubClient({ env: { GITHUB_TOKEN: write }, fetch, headChecks: "actions-jobs" });
    const base = repo.branch ?? (await defaultBranch(repo.repo, write, fetch));
    const workspace = m.workspace(join(config.dirs.state, "workspaces"), write, config);
    const synced = await workspace.sync([{ id: repo.repo, source: { url: `https://github.com/${repo.repo}.git`, branch: base } }]);
    const workingCopy = synced.workingCopies[0]!;
    const { config: repoConfig } = await readSettings(workingTree(workingCopy.path));
    const releaseAgeExclude = repoConfig.ownPackages.npmScopes.map((scope) => `${scope}/*`);
    const isolation = codexIsolation({
      commitIdentity: config.commitIdentity,
      readDeny: config.readDeny,
      commandPath: [GUARD_DIR],
      releaseAgeDays: repoConfig.releaseAgeDays,
      releaseAgeExclude,
      buildCacheRoot: config.dirs.cache,
    });
    const runner = m.runner(config.agent.codingAgent, isolation);
    const prices = config.modelPrices === undefined
      ? DEFAULT_MODEL_PRICES
      : parseModelPrices(JSON.parse(await m.readText(config.modelPrices)), config.modelPrices);
    const skillContext = {
      entrypoints: handlers.skills.entrypoints,
      supportSkills: handlers.skills.support,
      skillLoader: new SkillLoader({ skillsDirs: handlers.skills.dirs }),
      runnerFor: (codingAgent: string) => {
        if (codingAgent !== runner.codingAgent) throw new Error(`no ${codingAgent} runner`);
        return runner;
      },
      validator: new SchemaValidator(),
      logger,
      usageRecorder: report.usageRecorder,
      modelPrices: prices,
    };
    const context: ToolRunContext = {
      fetch,
      config,
      repo,
      base,
      github,
      workspace,
      workingCopy,
      logger,
      now: m.now(),
      releaseAgeDays: repoConfig.releaseAgeDays,
      releaseAgeExclude,
      readToken: read,
      isolation,
      agent: async (call) => {
        await m.assertAgentWorkspace(workingCopy, call.input, call.restoredFiles);
        return runSkill(skillContext, {
          entrypoint: call.entrypoint,
          input: call.input,
          workingCopies: [workingCopy],
          codingAgent: config.agent.codingAgent,
          model: config.agent.model,
          effort: config.agent.effort,
          access: "write",
          credentials: { env: { GH_TOKEN: read }, secrets: [{ name: "GH_TOKEN", value: read }] },
        });
      },
    };
    const result = command === "run" ? await handlers.run(context) : await handlers.review(context);
    return finish(0, "ok", { result });
  } catch (err) {
    const message = (err as Error).message;
    logger.error(`${handlers.tool} ${command} failed`, { error: message });
    return finish(1, "error", { error: message });
  }
}

/**
 * `out`, which writes run.sh's marker right after a `run finished` line went
 * through. Writing it is best effort: if it fails, run.sh writes its own line
 * as well, a duplicate rather than none.
 */
function acknowledging(out: NodeJS.WritableStream, marker: string | undefined, requests: GitHubRequests, identity: () => { tool: ToolName; command: string | undefined }): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      const final = JSON.parse(chunk.toString("utf8")) as { ts: string; repo?: string };
      const summary = JSON.stringify({ ts: final.ts, level: "info", msg: "GitHub API requests", ...identity(), repo: final.repo, ...requests.summary() });
      // This stream also handles signals: flush the summary and final line together, exactly once.
      out.write(`${summary}\n${chunk.toString("utf8")}`, (err) => {
        if ((err === undefined || err === null) && marker !== undefined && marker !== "" && chunk.toString("utf8").includes('"msg":"run finished"')) {
          try {
            // Synchronous: on a signal, the process dies right after this callback.
            writeFileSync(marker, "reported\n");
          } catch {
            // run.sh reports instead (see above).
          }
        }
        callback(err ?? null);
      });
    },
  });
}

/** The repository's default branch, read with the tool's token. */
async function defaultBranch(repo: string, token: string, fetch: typeof globalThis.fetch): Promise<string> {
  const response = await fetch(`https://api.github.com/repos/${repo}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`reading ${repo}'s default branch failed (HTTP ${response.status})`);
  const branch = ((await response.json()) as { default_branch?: unknown }).default_branch;
  if (typeof branch !== "string" || branch === "") throw new Error(`GitHub named no default branch for ${repo}`);
  return branch;
}

export async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
}

function defaultMachine(): Machine {
  return {
    assertAgentWorkspace,
    secrets: new KeychainStore(),
    fetch: globalThis.fetch,
    stderr: process.stderr,
    now: () => new Date(),
    readText: (path) => readFile(path, "utf8"),
    ensureDir: ensurePrivateDir,
    reportMarker: process.env["TOOL_REPORT_MARKER"],
    workspace: (root, token, config) => new LocalGitWorkspace({ workspaceRoot: root, gitAuth: gitCloneAuth(token), commitIdentity: config.commitIdentity }),
    // Both runners get the same isolation: denied paths, the agent's env and its build cache.
    runner: (codingAgent, isolation) =>
      codingAgent === "codex"
        ? new CodexRunner(isolation)
        : new ClaudeCodeRunner({ confinement: "sandbox", env: isolation.env ?? {}, readDenied: isolation.readDenied ?? [], ...(isolation.buildCacheRoot !== undefined ? { buildCacheRoot: isolation.buildCacheRoot } : {}) }),
  };
}

/** Refuse unexplained staged, unstaged or untracked edits before handing the workspace to an agent. */
export async function assertAgentWorkspace(workingCopy: WorkingCopy, value: unknown, restoredFiles: ReadonlyArray<FileState> = []): Promise<void> {
  const input = value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
  const paths = (key: string): string[] => {
    const entries = input[key];
    if (entries === undefined) return [];
    if (!Array.isArray(entries) || !entries.every(safePath)) throw new Error(`agent input ${key} must contain repository-relative file paths`);
    return entries;
  };
  for (const expected of restoredFiles) {
    if (!safePath(expected.path)) throw new Error("restoredFiles must contain repository-relative file paths");
    if (!isDeepStrictEqual(await fileState(workingCopy, expected.path), expected)) throw new Error(`agent workspace changed after tool restore: ${expected.path}`);
  }
  const resolving = input["mode"] === "resolve";
  const allowed = new Set([...paths("toolWritten"), ...restoredFiles.map((file) => file.path), ...(resolving ? paths("conflicted") : [])]);
  if (resolving) for (const path of await cleanMergePaths(workingCopy)) allowed.add(path);
  const staged = await git(workingCopy, ["diff", "--cached", "--name-only", "-z", "--no-renames", "HEAD", "--"], runProcess);
  if (staged.code !== 0) throw new Error(`checking the agent workspace index failed: ${staged.stderr.trim()}`);
  const changed = new Set([...await changedSince(workingCopy, "HEAD"), ...staged.stdout.split("\0").filter(Boolean)]);
  const unexpected = [...changed].filter((path) => !allowed.has(path)).sort();
  if (unexpected.length > 0) throw new Error(`agent workspace has undeclared changes against HEAD: ${unexpected.join(", ")}`);
}

/** Only untouched, non-conflicted entries from Git's own automatic merge result may pass without a declaration. */
async function cleanMergePaths(workingCopy: WorkingCopy): Promise<string[]> {
  const merging = await git(workingCopy, ["rev-parse", "--quiet", "--verify", "MERGE_HEAD"], runProcess);
  if (merging.code === 1) return [];
  if (merging.code !== 0) throw new Error(`reading the agent workspace merge failed: ${merging.stderr.trim()}`);
  const automatic = await git(workingCopy, ["rev-parse", "--quiet", "--verify", "AUTO_MERGE^{tree}"], runProcess);
  if (automatic.code !== 0) throw new Error("the agent workspace merge has no AUTO_MERGE tree to check");
  const tree = automatic.stdout.trim();
  const names = async (args: string[]): Promise<string[]> => {
    const result = await git(workingCopy, ["diff", "--name-only", "-z", "--no-renames", ...args, "--"], runProcess);
    if (result.code !== 0) throw new Error(`checking the agent workspace merge failed: ${result.stderr.trim()}`);
    return result.stdout.split("\0").filter(Boolean);
  };
  const brought = await names(["HEAD", tree]);
  // Check both index and files: a staged edit hidden by restoring its worktree must still be refused.
  const different = new Set([...await names(["--cached", tree]), ...await names([tree]), ...await names(["--diff-filter=U"])]);
  return brought.filter((path) => !different.has(path));
}
