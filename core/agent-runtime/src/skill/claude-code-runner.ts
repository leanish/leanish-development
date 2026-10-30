// Copied from leanish/leanish-development core/runtime/src/skill/claude-code-runner.ts at c6282df; see PROVENANCE.md.
// Local changes: write access in Claude Code's sandbox, usage and failure reasons from its stream-json events, and
// refusals that never echo CLAUDE_CONFIG_DIR's value.
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, rmdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";

import { deliverSkillUsage, type SkillUsage, ZERO_TOKENS } from "../usage/skill-usage.ts";
import { ClaudeStreamCollector } from "./claude-code-stream.ts";
import { githubToolsEnv } from "./codex-command-env.ts";
import { assertAbsolute, assertOutsideDenied } from "./codex-permissions.ts";
import { shellIsolationEnv, writeMountGitDirs } from "./codex-runner.ts";
import { spawnCapture } from "./spawn-capture.ts";
import { stageSkills } from "./stage-skills.ts";
import type {
  CodingAgentRunner,
  SkillInvocation,
  SkillInvocationResult,
} from "./runner.ts";
import { resolveWorkingCopyMount } from "./wc-mount.ts";

/**
 * Coding-agent runner that drives the `claude` (Claude Code) CLI via
 * subprocess. Per ADR-0002, skills are staged into a temp directory and
 * mounted via `--plugin-dir`; the prompt invokes the entrypoint by its plugin
 * namespace (`/agent-runtime-staged:<name>`) followed by the rendered YAML.
 *
 * Isolation mirrors the Codex runner's profile (`codex-permissions.ts`) with
 * Claude Code's own mechanisms, all passed inline (`--settings <json>`), with
 * no user, project or local settings loaded (`--setting-sources ""`), no
 * CLAUDE.md and no auto memory:
 *   - Bash runs in the sandbox, which must be available (`failIfUnavailable`),
 *     with no unsandboxed fallback and no approval prompts (allowed whole, as
 *     Codex's commands are); `readDenied` is denied to it and, as
 *     `Read(...)` rules (exact for files, recursive for directories), to the
 *     file tools too;
 *   - `write`: the file tools may edit only inside the working copies
 *     (`acceptEdits`; every other prompt is denied, `--permission-prompts
 *     none`), Bash may also write the temp dirs and `writableRoots`, and each
 *     working copy's git metadata (outside the working tree) is denied to both;
 *     network: any host, through the sandbox's proxy;
 *     macOS's certificate trust service stays reachable from the sandbox
 *     (`enableWeakerNetworkIsolation`): without it Go tools such as `gh` can't
 *     verify TLS and Node floods its output with trust-settings errors;
 *   - `read-only`: no network, the working copies are denied to Bash's writes
 *     and edits need a prompt that never comes (Bash keeps the sandbox's own
 *     temp dir).
 * That is the `sandbox` confinement. A host without Claude Code's sandbox (a Lambda function) runs `restricted`
 * instead: `--restricted` with only the read tools (`--tools Read,Glob,Grep,Skill`), Bash, edits and the network
 * denied, so nothing runs commands and nothing needs the sandbox; `write` is refused before anything is staged.
 * No hooks run (`disableAllHooks`), whether from settings or from a skill, except those an administrator's managed
 * policy enforces, which no inline setting can turn off.
 * The sandbox's proxy announces itself in `HTTPS_PROXY` with credentials the
 * JVM doesn't read from there, so the commands' zsh gets a `.zshenv` (in the
 * staged `ZDOTDIR` that also keeps the user's startup files away) turning it
 * into proxy system properties.
 *
 * Usage comes from the stream-json events, read as they arrive
 * (`claude-code-stream.ts`), so it survives a failure or timeout: tokens per
 * request, the CLI's own list-price cost estimate (`providerCostUsd`) and the
 * account's plan windows when the CLI reports them.
 */
/** How a run is confined; see the class comment. Each host names its own: neither is a safe default for the other. */
export type ClaudeConfinement = "sandbox" | "restricted";

export interface ClaudeCodeRunnerOptions {
  /** `sandbox` where Claude Code's sandbox is available (write runs need it), `restricted` where it isn't. */
  readonly confinement: ClaudeConfinement;
  /** Override the `claude` binary path. Defaults to `"claude"` (PATH lookup). */
  readonly bin?: string;
  /** Per-invocation timeout in ms. Defaults to 14 minutes (under Lambda's 15-min cap). */
  readonly timeoutMs?: number;
  /** Optional override for staging-temp parent (testing hook). */
  readonly stagingParentDir?: string;
  /** Extra env vars merged onto the subprocess. */
  readonly env?: Readonly<Record<string, string>>;
  /** stdout / stderr capture cap, in bytes. Defaults to 8 MiB. */
  readonly captureCapBytes?: number;
  /** Extra directories a `write` invocation may write to, besides its working copies and the temp dirs. */
  readonly writableRoots?: ReadonlyArray<string>;
  /** Build-tool cache: `GRADLE_USER_HOME` and `npm_config_cache` point inside it, and a `write` run may write to it. */
  readonly buildCacheRoot?: string;
  /** Absolute paths the agent may not read, through Bash or the file tools. */
  readonly readDenied?: ReadonlyArray<string>;
}

const DEFAULT_TIMEOUT_MS = 14 * 60 * 1000;
const DEFAULT_CAPTURE_CAP_BYTES = 8 * 1024 * 1024;
const PLUGIN_NAME = "agent-runtime-staged";

export class ClaudeCodeRunner implements CodingAgentRunner {
  readonly codingAgent = "claude-code";

  readonly #bin: string;
  readonly #timeoutMs: number;
  readonly #stagingParentDir: string | undefined;
  readonly #env: Readonly<Record<string, string>>;
  readonly #captureCapBytes: number;
  readonly #writableRoots: ReadonlyArray<string>;
  readonly #cacheEnv: Readonly<Record<string, string>>;
  readonly #readDenied: ReadonlyArray<string>;
  readonly #confinement: ClaudeConfinement;

  constructor(options: ClaudeCodeRunnerOptions) {
    // Checked at runtime too: a caller in plain JavaScript gets no type error, and a missing policy must not mean one.
    if (options.confinement !== "sandbox" && options.confinement !== "restricted") {
      throw new Error(`ClaudeCodeRunner: confinement must be 'sandbox' or 'restricted', not '${String(options.confinement)}'`);
    }
    this.#confinement = options.confinement;
    this.#bin = options.bin ?? "claude";
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#stagingParentDir = options.stagingParentDir;
    this.#env = options.env ?? {};
    this.#captureCapBytes = options.captureCapBytes ?? DEFAULT_CAPTURE_CAP_BYTES;
    const cacheRoot = options.buildCacheRoot;
    this.#writableRoots = [...(options.writableRoots ?? []), ...(cacheRoot !== undefined ? [cacheRoot] : [])];
    assertAbsolute(this.#writableRoots, "writableRoots/buildCacheRoot");
    this.#cacheEnv =
      cacheRoot === undefined ? {} : { GRADLE_USER_HOME: join(cacheRoot, "gradle"), npm_config_cache: join(cacheRoot, "npm") };
    this.#readDenied = options.readDenied ?? [];
    assertAbsolute(this.#readDenied, "readDenied");
    assertLiteral(this.#readDenied, "readDenied");
    assertOutsideDenied(this.#writableRoots, this.#readDenied, "writable root");
  }

  async run(invocation: SkillInvocation): Promise<SkillInvocationResult> {
    const startedAt = performance.now();
    const collector = new ClaudeStreamCollector();
    let spawned = false;
    try {
      return await this.#run(invocation, collector, () => {
        spawned = true;
      });
    } finally {
      deliverSkillUsage(invocation.onUsage, claudeCodeUsage(invocation, Math.round(performance.now() - startedAt), spawned, collector));
    }
  }

  async #run(invocation: SkillInvocation, collector: ClaudeStreamCollector, onSpawn: () => void): Promise<SkillInvocationResult> {
    // The session's saved outputs and the login are found, opened and removed under ~/.claude; a relocated config dir
    // would move them where none of that reaches. The refusal names where the variable came from, never its value: a
    // caller may have mapped a credential to it, and this error is reported before any redaction.
    const configDirSource = (
      [["the process environment", process.env], ["the runner's env option", this.#env], ["the invocation's env", invocation.env ?? {}]] as const
    ).find(([, env]) => nonEmpty(env["CLAUDE_CONFIG_DIR"]) !== undefined)?.[0];
    if (configDirSource !== undefined) {
      throw new Error(`ClaudeCodeRunner: CLAUDE_CONFIG_DIR (set in ${configDirSource}) isn't supported; unset it so the CLI uses ~/.claude`);
    }
    const access = invocation.access ?? "read-only";
    if (access === "write" && this.#confinement === "restricted") {
      throw new Error(
        // Never advise a lesser access here: a caller acting on the text would record a write that never happened.
        "ClaudeCodeRunner: access 'write' needs the 'sandbox' confinement, which only a host with Claude Code's sandbox has; this runner is 'restricted' and grants no tool that edits or runs commands, so give write runs to a runner that can write here",
      );
    }
    const workingCopies = invocation.workingCopies.map((wc) => wc.path);
    assertOutsideDenied(workingCopies, this.#readDenied, "working copy");
    const gitDirs = access === "write" ? await writeMountGitDirs(invocation.workingCopies) : [];
    assertLiteral(gitDirs, "a working copy's git metadata");
    if (access === "write") {
      for (const root of this.#writableRoots) await mkdir(root, { recursive: true, mode: 0o700 });
    }
    const staged = await stageSkills({
      entrypoint: invocation.entrypoint,
      supportSkills: invocation.supportSkills,
      pluginName: PLUGIN_NAME,
      ...(this.#stagingParentDir !== undefined ? { parentDir: this.#stagingParentDir } : {}),
    });
    // The file tools may read cwd, so with no working copy they get an empty directory of their own instead of
    // wherever the tool was started.
    const emptyCwd = invocation.workingCopies.length === 0
      ? await mkdtemp(join(tmpdir(), "claude-code-runner-empty-")).catch(async (err: unknown) => {
        await staged.cleanup().catch(() => undefined);
        throw err;
      })
      : undefined;
    const mount = emptyCwd !== undefined ? { cwd: emptyCwd, addDirs: [] } : resolveWorkingCopyMount(invocation.workingCopies);
    const sessionId = randomUUID();
    const sessionDir = join(homedir(), ".claude", "projects", (await realpath(mount.cwd).catch(() => mount.cwd)).replace(/[^A-Za-z0-9]/g, "-"), sessionId);
    let failed = false;
    try {
      const shell = await shellIsolationEnv(staged.dir);
      await writeFile(join(shell["ZDOTDIR"]!, ".zshenv"), PROXY_SHIM);
      const githubEnv = nonEmpty({ ...this.#env, ...invocation.env }["GH_TOKEN"]) !== undefined ? await githubToolsEnv(staged.dir) : {};
      const settings = this.#confinement === "restricted"
        ? restrictedClaudeSettings({ readDenied: this.#readDenied, home: homedir() })
        : claudeSettings({
          access,
          workingCopies,
          gitDirs,
          writableRoots: access === "write" ? [...this.#writableRoots, ...(await tempDirs())] : [],
          readDenied: this.#readDenied,
          home: homedir(),
          sessionDir,
        });
      const args: string[] = [
        "--print",
        "--output-format",
        "stream-json",
        "--verbose",
        "--session-id",
        sessionId,
        "--no-session-persistence",
        ...(this.#confinement === "restricted" ? ["--restricted", "--tools", RESTRICTED_TOOLS.join(",")] : []),
        "--setting-sources",
        "",
        "--strict-mcp-config",
        "--permission-mode",
        access === "write" ? "acceptEdits" : "default",
        "--permission-prompts",
        "none",
        "--plugin-dir",
        staged.dir,
        "--settings",
        JSON.stringify(settings),
      ];
      for (const dir of mount.addDirs) {
        args.push("--add-dir", dir);
      }
      if (invocation.model !== undefined) {
        args.push("--model", invocation.model);
      }
      if (invocation.effort !== undefined) {
        args.push("--effort", mapEffortForClaudeCli(invocation.effort));
      }
      // `--add-dir` takes any number of values: without `--`, the prompt after the last one would be read as a directory.
      args.push("--", slashCommandPrompt(invocation));

      onSpawn();
      let stderrTail: string | undefined;
      try {
        ({ stderrTail } = await spawnCapture({
          bin: this.#bin,
          args,
          cwd: mount.cwd,
          // Per-invocation env (target-project credentials) wins over the runner's configured base; the cache
          // routing, shell isolation and the CLI's own switches go last, so nothing may shadow them.
          env: {
            ...this.#env,
            ...invocation.env,
            ...this.#cacheEnv,
            ...shell,
            ...githubEnv,
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
            DISABLE_AUTOUPDATER: "1",
            // The global env override takes precedence over modelSettings in CLI 2.1.312.
            CLAUDE_CODE_AUTO_COMPACT_WINDOW: undefined,
            BASH_DEFAULT_TIMEOUT_MS: String(Math.floor(this.#timeoutMs * 12 / 14)),
            BASH_MAX_TIMEOUT_MS: String(Math.floor(this.#timeoutMs * 12 / 14)),
            CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
          },
          timeoutMs: this.#timeoutMs,
          captureCapBytes: this.#captureCapBytes,
          label: "ClaudeCodeRunner",
          scrubAmbientCredentials: true,
          onStdoutLine: (line) => collector.accept(line),
          ...(invocation.secrets !== undefined ? { secrets: invocation.secrets } : {}),
        }));
      } catch (err) {
        // The CLI reports why a run failed (a plan limit, an execution error) in its result event on stdout, which a
        // failed process's message (its stderr tail) doesn't carry.
        // Scrubbed before it's cut short: a cut could split a credential the scrub would no longer recognise.
        const reason = scrubProxyCredentials(collector.answer?.text ?? "");
        const detail = reason === "" ? "" : `; the CLI reported: ${reason.slice(-2000)}`;
        throw new Error(`${scrubProxyCredentials((err as Error).message)}${detail}`);
      }
      const answer = collector.answer;
      if (answer === undefined) throw new Error("ClaudeCodeRunner: the CLI ended without a result event");
      if (answer.isError) {
        throw new Error(`ClaudeCodeRunner: the run ended with ${answer.subtype}: ${scrubProxyCredentials(answer.text).slice(-2000)}`);
      }
      const model = collector.model;
      return {
        responseText: scrubProxyCredentials(answer.text),
        ...(stderrTail !== undefined ? { stderrTail: scrubProxyCredentials(stderrTail) } : {}),
        ...(model !== undefined && model !== invocation.model ? { model } : {}),
      };
    } catch (err) {
      failed = true;
      throw err;
    } finally {
      // Each step runs whatever the others do. A step that fails fails a run that had succeeded, saying what was left
      // behind; it never replaces the run's own failure.
      const leftBehind: string[] = [];
      // The session's saved outputs (written despite --no-session-persistence) mustn't outlive it.
      await rm(sessionDir, { recursive: true, force: true }).catch((err: Error) => leftBehind.push(`the session's saved outputs (${err.message})`));
      // The working copy's project dir, once no session is left in it; another session may still be using it.
      await rmdir(dirname(sessionDir)).catch(() => undefined);
      await staged.cleanup().catch((err: Error) => leftBehind.push(`the staged skills and shell (${err.message})`));
      if (emptyCwd !== undefined) await rm(emptyCwd, { recursive: true, force: true }).catch((err: Error) => leftBehind.push(`the empty working directory (${err.message})`));
      if (leftBehind.length > 0 && !failed) throw new Error(`ClaudeCodeRunner: the run ended, but cleaning up failed: ${leftBehind.join("; ")}`);
    }
  }
}

export interface ClaudeSettingsRequest {
  readonly access: "read-only" | "write";
  readonly workingCopies: ReadonlyArray<string>;
  readonly gitDirs: ReadonlyArray<string>;
  /** Bash's writable roots besides the working copies (write runs only). */
  readonly writableRoots: ReadonlyArray<string>;
  readonly readDenied: ReadonlyArray<string>;
  readonly home: string;
  /**
   * Where Claude Code keeps this session's long command outputs (`~/.claude/projects/<cwd slug>/<session id>`): it shows
   * the model their path, so Bash may read that one directory even when `~/.claude` is denied.
   */
  readonly sessionDir: string;
}

/**
 * Claude Code tools the agent never gets. Codex's runs have none of them, and an unanswered prompt shouldn't be the
 * only thing standing in their way: publishing, messaging, scheduling and web access reach past the working copies;
 * worktrees move the session out of its working copy (and its saved outputs out of the session dir); other sessions
 * and background monitors are outside the call; sub-agents may pick their own model and effort.
 */
export const DENIED_TOOLS = [
  "Artifact", "ArtifactComments", "ArtifactData", "ShareOnboardingGuide", "DesignSync", "PushNotification", "SendMessage",
  "RemoteTrigger", "CronCreate", "CronDelete", "ScheduleWakeup", "Workflow", "WebFetch", "WebSearch",
  "EnterWorktree", "ExitWorktree", "ListAgents", "Monitor", "Task", "Agent", "PublishPlugin",
] as const;

/** The inline settings of a `sandbox` run; see the class comment. Exported for tests. */
export function claudeSettings(request: ClaudeSettingsRequest): Record<string, unknown> {
  const write = request.access === "write";
  // The file tools can't read outside the working copies anyway (that needs a prompt, and none is answered); an explicit
  // `~/.claude` rule would also stop them from reading the session's saved outputs, so it's left to that default.
  const claudeHome = join(request.home, ".claude");
  const opensSession = request.readDenied.includes(claudeHome);
  const gitEntries = request.workingCopies.map((path) => join(path, ".git"));
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: true,
      filesystem: {
        allowWrite: write ? [...request.writableRoots] : [],
        denyWrite: write ? [...request.gitDirs, ...gitEntries] : [...request.workingCopies],
        denyRead: [...request.readDenied],
        ...(opensSession ? { allowRead: [request.sessionDir] } : {}),
      },
      network: write ? { allowedDomains: ["*"], allowLocalBinding: true } : { allowedDomains: [] },
      // Lets sandboxed commands reach macOS's trust service, which `gh` (Go) and Node need to verify TLS. It is a possible
      // exfiltration path, and only write runs, which already reach any host, get it.
      enableWeakerNetworkIsolation: write,
    },
    permissions: {
      // Every command runs in the sandbox (no unsandboxed fallback), as Codex runs every command in its own: without
      // this, Claude Code still asks about commands it can't analyse statically (`echo "$?"`), and nobody answers.
      allow: ["Bash"],
      deny: [
        ...request.readDenied.filter((path) => path !== claudeHome).flatMap(readRules),
        ...request.gitDirs.map((dir) => `Edit(/${dir}/**)`),
        ...gitEntries.map((path) => `Edit(/${path})`),
        ...DENIED_TOOLS,
      ],
    },
    ...commonSettings(request.home),
  };
}

/** The read tools a `restricted` run keeps (`--tools`); `--restricted` already drops the ones that run code. */
export const RESTRICTED_TOOLS = ["Read", "Glob", "Grep", "Skill"] as const;

/** The inline settings of a `restricted` run: no sandbox, so nothing that writes or runs commands. Exported for tests. */
export function restrictedClaudeSettings(request: { readonly readDenied: ReadonlyArray<string>; readonly home: string }): Record<string, unknown> {
  return {
    permissions: {
      deny: [...request.readDenied.flatMap(readRules), "Bash", "Edit", "Write", "NotebookEdit", ...DENIED_TOOLS],
    },
    ...commonSettings(request.home),
  };
}

/** What every run gets, whatever confines it. */
function commonSettings(home: string): Record<string, unknown> {
  return {
    modelSettings: {
      "claude-haiku-5-5": { autoCompactWindow: 100000 },
    },
    // The skill tells the agent to read the repository's own instructions; nothing else is injected.
    claudeMdExcludes: ["**/CLAUDE.md", "**/CLAUDE.local.md", join(home, ".claude", "CLAUDE.md")],
    // The tools publish the agent's PR text and commit message as written: no Claude Code attribution in them.
    includeCoAuthoredBy: false,
    attribution: { commit: "", pr: "" },
    autoMemoryEnabled: false,
    // Nothing runs besides the agent's own tool calls: no hooks from settings or from a skill (managed policy aside).
    disableAllHooks: true,
    // Nor anything the claude.ai account connects.
    disableClaudeAiConnectors: true,
    // Claude Code's own skills (`/loop`, `/schedule`) read files or call services while they start, outside the
    // sandbox's and the file tools' limits. The switch keeps a few built-ins, handled below.
    disableBundledSkills: true,
    // With these flags, `plugin-authoring` is the one kept built-in the model can invoke (`/doctor` and `/design`
    // refuse model invocation), so its plugin goes; a Skill deny rule would leave it listed.
    enabledPlugins: { "cc-plugin-plugin-authoring@builtin": false },
  };
}

/**
 * Claude Code reads its permission rules as glob patterns, so a path with a glob character (`secrets[prod].json`)
 * would deny something other than itself. Such paths are refused rather than escaped: an escape the matcher didn't
 * honour would fail open.
 */
function assertLiteral(paths: ReadonlyArray<string>, what: string): void {
  const glob = paths.find((path) => /[*?[\]{}!\\]/.test(path));
  if (glob !== undefined) throw new Error(`ClaudeCodeRunner: ${what} '${glob}' has a glob character, which Claude Code's permission rules would read as a pattern`);
}

/** `Read` rules for one denied path: exact for a file, recursive for a directory, both when it doesn't exist (yet). */
function readRules(path: string): string[] {
  let directory: boolean | undefined;
  try {
    directory = statSync(path).isDirectory();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (directory === undefined) return [`Read(/${path})`, `Read(/${path}/**)`];
  return directory ? [`Read(/${path}/**)`] : [`Read(/${path})`];
}

/** The temp dirs Codex's write profile also opens: the user's temp dir (the JVM's `java.io.tmpdir` on macOS) and /tmp. */
async function tempDirs(): Promise<string[]> {
  const dirs = await Promise.all([tmpdir(), "/tmp"].map((dir) => realpath(dir).catch(() => dir)));
  return [...new Set(dirs)];
}

function slashCommandPrompt(invocation: SkillInvocation): string {
  const command = `/${PLUGIN_NAME}:${invocation.entrypoint.name}`;
  const parts = [command, ...(invocation.renderedArguments.length === 0 ? [] : [invocation.renderedArguments])];
  const schema = invocation.entrypoint.outputSchema;
  // Claude Code drops a skill's frontmatter when it loads it, and the answer's schema lives there; Codex reads the
  // whole SKILL.md, so the agent gets the same contract here.
  if (schema !== undefined) {
    parts.push(`The skill's frontmatter (not shown to you) defines its answer: end your final message with one \`\`\`json block valid against this JSON Schema.\n\`\`\`json\n${JSON.stringify(schema, null, 2)}\n\`\`\``);
  }
  return parts.join("\n");
}

/**
 * The commands' zsh startup (in the staged `ZDOTDIR`): the sandbox routes network through an authenticating proxy
 * it announces as `HTTPS_PROXY=http://user:pass@host:port`; the JVM ignores that variable, so it gets the same proxy
 * as system properties (Basic auth allowed for tunnels).
 */
const PROXY_SHIM = `if [[ -n "\${HTTPS_PROXY:-}" ]]; then
  _p=\${HTTPS_PROXY#*://}; _p=\${_p%%/*}
  _cred=; [[ $_p == *@* ]] && { _cred=\${_p%@*}; _p=\${_p##*@}; }
  _h=\${_p%:*}; _port=\${_p##*:}
  _o="-Djdk.http.auth.tunneling.disabledSchemes= -Djdk.http.auth.proxying.disabledSchemes= -Dhttp.nonProxyHosts=localhost|127.0.0.1"
  for _s in http https; do
    _o="$_o -D$_s.proxyHost=$_h -D$_s.proxyPort=$_port"
    [[ -n $_cred ]] && _o="$_o -D$_s.proxyUser=\${_cred%%:*} -D$_s.proxyPassword=\${_cred#*:}"
  done
  export JAVA_TOOL_OPTIONS="\${JAVA_TOOL_OPTIONS:-} $_o"
  unset _p _cred _h _port _o _s
fi
`;

/** The sandbox proxy's per-command credentials, wherever they show up (JVM banners, URLs). */
export function scrubProxyCredentials(text: string): string {
  return text
    .replace(/(proxy(?:User|Password)=)[^\s"\\]+/g, "$1<redacted>")
    // Splitting at the first colon after the user's first character matches what `[^…]+:[^…]+` did, without the two
    // parts trading characters (polynomial backtracking on a run of colons).
    .replace(/(\/\/)[^\s/@"\\][^\s/@"\\:]*:[^\s/@"\\]+@/g, "$1<redacted>@");
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

function claudeCodeUsage(invocation: SkillInvocation, durationMs: number, spawned: boolean, collector: ClaudeStreamCollector): SkillUsage {
  const base = {
    codingAgent: "claude-code",
    ...(invocation.model !== undefined ? { requestedModel: invocation.model } : {}),
    durationMs,
    synthetic: false,
  };
  if (!spawned) {
    return {
      ...base,
      models: [],
      measurement: "complete",
      tokens: ZERO_TOKENS,
      quota: { status: "not-applicable", reason: "no provider call was made" },
      gaps: [],
    };
  }
  const usage = collector.usage();
  const model = collector.model;
  return {
    ...base,
    ...(model !== undefined ? { model } : {}),
    measurement: usage.measurement,
    ...(usage.tokens !== undefined ? { tokens: usage.tokens } : {}),
    models: usage.models,
    ...(usage.providerCostUsd !== undefined ? { providerCostUsd: usage.providerCostUsd } : {}),
    quota: usage.quota,
    gaps: usage.gaps,
  };
}

/**
 * Map the suite's `Effort` vocabulary onto Claude Code's CLI surface.
 *
 *   - Claude CLI: `--effort <low|medium|high|xhigh|max>` (validated by `claude --help`).
 *   - Suite: `minimal | low | medium | high | xhigh`.
 *
 * `minimal` collapses to `low` because the CLI rejects `minimal`; every
 * other value passes through verbatim. The suite has no `max` — operators
 * who want `max` would need to widen the suite-level `Effort` type first.
 *
 * Exported so tests can assert the mapping and downstream tooling can
 * compose against the same table without re-deriving it.
 */
export function mapEffortForClaudeCli(effort: string): string {
  return effort === "minimal" ? "low" : effort;
}
