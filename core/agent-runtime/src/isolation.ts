// Derived from leanish/leanish-development core/runtime/src/runtime/run-local-cli.ts (`localCodexOptions`,
// `SENSITIVE_HOME_PATHS`) at c6282df; see PROVENANCE.md.
// Local changes: every input is explicit (the host's config) instead of `AGENT_RUNTIME_*` variables; the agent's
// commands get the given commit identity, if any, instead of reading the developer's global git identity; the release
// age is the repository's, not a fixed 7, with its own npm scopes excluded from it; the resolved login source and its
// canonical path (when present) stay unreadable; the result is an agent-neutral policy that each runner gets through
// its own adapter (`codexRunnerOptions`, `claudeCodeRunnerOptions`), and the login home is absolute.
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import type { ClaudeCodeRunnerOptions, ClaudeConfinement } from "./skill/claude-code-runner.ts";
import type { CodexRunnerOptions } from "./skill/codex-runner.ts";

/**
 * Places under the home that commonly hold credentials or private config:
 * keys, cloud, registry and git credentials, the Codex and Claude logins,
 * shell startup files (which often export tokens) and their history.
 */
export const SENSITIVE_HOME_PATHS: ReadonlyArray<string> = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".codex",
  ".claude",
  ".claude.json",
  ".config",
  ".netrc",
  ".npmrc",
  ".gitconfig",
  ".git-credentials",
  ".docker",
  ".kube",
  ".gradle",
  ".m2",
  ".zshrc",
  ".zshenv",
  ".zprofile",
  ".zsh_history",
  ".bashrc",
  ".bash_profile",
  ".bash_history",
  ".profile",
  "Library/Keychains",
];

export interface GitIdentity {
  readonly name: string;
  readonly email: string;
}

export interface IsolationSettings {
  /**
   * Who the host's commits are by; the agent's commands get the same identity. Absent: none is set, so the host's own
   * `GIT_AUTHOR_*`/`GIT_COMMITTER_*` variables pass through when it has them; otherwise (the home's git config is
   * replaced) git guesses one from the user and host names, or refuses to commit.
   */
  readonly commitIdentity?: GitIdentity | undefined;
  /** Absolute paths the agent's commands may not read, on top of sensitive home paths and the Codex login source. */
  readonly readDeny: ReadonlyArray<string>;
  /** Absolute directories put first on the PATH of the agent's commands (the guards), and only theirs. */
  readonly commandPath: ReadonlyArray<string>;
  /** The repository's release age, given to npm as `min-release-age`. */
  readonly releaseAgeDays: number;
  /** npm package patterns exempt from it (the repository's own scopes, `@scope/*`), given to npm as `min-release-age-exclude`. */
  readonly releaseAgeExclude: ReadonlyArray<string>;
  /** Where the build tools' caches go instead of `~/.gradle` and the like. */
  readonly buildCacheRoot: string;
}

/**
 * How a coding agent's commands are isolated, whichever agent runs them: what they may not read, the env they get on
 * top of the scrubbed one, and where the build tools' caches go. Each runner gets it through its adapter
 * (`codexRunnerOptions`, `claudeCodeRunnerOptions`), which checks it, so a host may also build one by hand: a Lambda
 * function's is `{ buildCacheRoot, readDenied: [], env: {} }`, with no settings, home or login behind it.
 */
export interface IsolationPolicy {
  /** Absolute paths the agent's commands (and Claude Code's file tools) may not read. */
  readonly readDenied: ReadonlyArray<string>;
  /** Env given to the agent's commands, over the scrubbed process env. */
  readonly env: Readonly<Record<string, string>>;
  /** Absolute directory the build tools' caches go to (`GRADLE_USER_HOME`, `npm_config_cache`); a write run may write it. */
  readonly buildCacheRoot: string;
  /**
   * Absolute Codex home whose file-backed login the run reuses. Only the Codex adapter uses it; absent, no login is
   * linked (an API key, or a host with none).
   */
  readonly loginHome?: string;
}

/** `CodexRunner`'s options other than the policy's: its binary, timeouts, staging and the like. */
export type CodexRunnerTuning = Omit<CodexRunnerOptions, keyof IsolationPolicy>;

/** `ClaudeCodeRunner`'s options other than the policy's and the confinement: its binary, timeouts, staging and the like. */
export type ClaudeCodeRunnerTuning = Omit<ClaudeCodeRunnerOptions, "confinement" | keyof IsolationPolicy>;

/** What `isolationPolicy` reads from the machine; each defaults to the real one. */
export interface Machine {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly exists: (path: string) => boolean;
  readonly realpath: (path: string) => string;
}

/**
 * The policy a tool's agent runs with, on the developer's machine:
 *   - Codex reuses the developer's file-backed `codex login` (`$CODEX_HOME`,
 *     else `~/.codex`, made absolute) — the CLI reads it, sandboxed commands
 *     can't;
 *   - deny sandboxed commands the resolved login `auth.json` path (and its
 *     canonical path when present), the sensitive home paths above that exist,
 *     and `readDeny`: anything they read reaches the model provider, and a write
 *     run has the network. Codex shows the denied paths to the model, so their
 *     names (never their contents) are visible to it; the rest of the home
 *     stays readable, and so do toolchains and working copies under it;
 *   - replace the home's git and npm config (denied above, and able to hold
 *     credentials) with env, and leave out the system's git config (its
 *     credential helper, such as Homebrew's `osxkeychain`, would ask the
 *     Keychain; the agent can name a helper itself with `-c`, so the denied
 *     `Library/Keychains` is what keeps those credentials out): the commit identity when given, npm's
 *     `ignore-scripts`, the repository's `min-release-age` and its own
 *     packages' `min-release-age-exclude` (npm 11.17 or later reads it);
 *   - put `commandPath` (the guards) first on the PATH of the agent's
 *     commands — only theirs: the tool's own clone and push keep the real
 *     tools;
 *   - give the agent a dedicated build-tool cache instead of `~/.gradle`,
 *     whose init scripts every later build would run.
 */
export function isolationPolicy(settings: IsolationSettings, machine: Partial<Machine> = {}): IsolationPolicy {
  const { env = process.env, home = homedir(), exists = existsSync, realpath = realpathSync } = machine;
  const relative = [...settings.commandPath, ...settings.readDeny, settings.buildCacheRoot].filter((path) => !isAbsolute(path));
  if (relative.length > 0) throw new Error(`isolation paths must be absolute; got '${relative.join("', '")}'`);
  if (!Number.isInteger(settings.releaseAgeDays) || settings.releaseAgeDays < 0) {
    throw new Error(`releaseAgeDays must be a non-negative integer; got ${settings.releaseAgeDays}`);
  }
  // npm splits the variable on commas.
  const exclude = settings.releaseAgeExclude.find((pattern) => pattern.trim() === "" || pattern.includes(","));
  if (exclude !== undefined) throw new Error(`releaseAgeExclude patterns must be non-empty and have no comma; got '${exclude}'`);
  // Absolute, as the adapters require; CodexRunner resolved it the same way.
  const loginHome = resolve(nonEmpty(env["CODEX_HOME"]) ?? join(home, ".codex"));
  const readDenied = [
    ...SENSITIVE_HOME_PATHS.map((path) => join(home, path)).filter(exists),
    ...settings.readDeny,
    ...loginDenials(loginHome, exists, realpath),
  ];
  const path = nonEmpty(env["PATH"]);
  const commandPath = settings.commandPath.join(":");
  const identity = settings.commitIdentity;
  return {
    loginHome,
    buildCacheRoot: settings.buildCacheRoot,
    readDenied: [...new Set(readDenied)],
    env: {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      // git's default excludes file lives under ~/.config too.
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.excludesFile",
      GIT_CONFIG_VALUE_0: "/dev/null",
      npm_config_userconfig: "/dev/null",
      npm_config_ignore_scripts: "true",
      npm_config_min_release_age: String(settings.releaseAgeDays),
      ...(settings.releaseAgeExclude.length > 0 ? { npm_config_min_release_age_exclude: settings.releaseAgeExclude.join(",") } : {}),
      ...(commandPath !== "" ? { PATH: path !== undefined ? `${commandPath}:${path}` : commandPath } : {}),
      ...(identity !== undefined
        ? { GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email, GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email }
        : {}),
    },
  };
}

/** The login file of `loginHome`, and its canonical path when it exists: never readable by the agent's commands. */
function loginDenials(loginHome: string, exists: (path: string) => boolean, realpath: (path: string) => string): string[] {
  const loginPath = join(loginHome, "auth.json");
  return [loginPath, ...(exists(loginPath) ? [realpath(loginPath)] : [])];
}

/**
 * `CodexRunner`'s options for `policy`, with the `tuning` that isn't isolation. A login the policy links stays
 * unreadable to the agent's commands even when a hand-made policy doesn't deny it (`isolationPolicy`'s already does).
 */
export function codexRunnerOptions(policy: IsolationPolicy, tuning: CodexRunnerTuning = {}): CodexRunnerOptions {
  assertValidPolicy(policy, "codexRunnerOptions");
  // The policy alone decides the login, even against a plain-JavaScript `tuning` that names one.
  const { loginHome: _ignored, ...rest } = tuning as CodexRunnerTuning & { readonly loginHome?: unknown };
  const login = policy.loginHome === undefined ? [] : loginDenials(policy.loginHome, existsSync, realpathSync);
  return {
    ...rest,
    ...(policy.loginHome !== undefined ? { loginHome: policy.loginHome } : {}),
    buildCacheRoot: policy.buildCacheRoot,
    readDenied: [...new Set([...policy.readDenied, ...login])],
    env: { ...policy.env },
  };
}

/**
 * `ClaudeCodeRunner`'s options for `policy` under `confinement`, with the `tuning` that isn't isolation. The login
 * home isn't used: Claude Code reads its own login. A `restricted` run gets the build cache's env too, but runs no
 * commands; write runs still need `sandbox`, which the runner checks.
 */
export function claudeCodeRunnerOptions(policy: IsolationPolicy, confinement: ClaudeConfinement, tuning: ClaudeCodeRunnerTuning = {}): ClaudeCodeRunnerOptions {
  assertValidPolicy(policy, "claudeCodeRunnerOptions");
  return {
    ...tuning,
    confinement,
    env: { ...policy.env },
    readDenied: [...policy.readDenied],
    buildCacheRoot: policy.buildCacheRoot,
  };
}

/** A host may build a policy by hand (or in plain JavaScript), so each adapter checks it before a runner gets it. */
function assertValidPolicy(policy: IsolationPolicy, adapter: string): void {
  if (typeof policy !== "object" || policy === null) throw new Error(`${adapter}: the isolation policy must be an object`);
  const { readDenied, env, buildCacheRoot, loginHome } = policy;
  if (!Array.isArray(readDenied)) throw new Error(`${adapter}: readDenied must be an array of absolute paths`);
  // By index, so an `undefined` entry (or a hole) is caught too.
  const relative = readDenied.findIndex((path: unknown) => typeof path !== "string" || !isAbsolute(path));
  if (relative !== -1) throw new Error(`${adapter}: readDenied entries must be absolute paths; got '${String(readDenied[relative])}'`);
  if (typeof buildCacheRoot !== "string" || !isAbsolute(buildCacheRoot)) {
    throw new Error(`${adapter}: buildCacheRoot must be an absolute path; got '${String(buildCacheRoot)}'`);
  }
  if (loginHome !== undefined && (typeof loginHome !== "string" || !isAbsolute(loginHome))) {
    throw new Error(`${adapter}: loginHome must be an absolute path when given; got '${String(loginHome)}'`);
  }
  if (typeof env !== "object" || env === null || Array.isArray(env)) throw new Error(`${adapter}: env must be an object of strings`);
  const nonString = Object.entries(env).find(([, value]: [string, unknown]) => typeof value !== "string");
  if (nonString !== undefined) throw new Error(`${adapter}: env values must be strings; ${nonString[0]} isn't`);
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}
