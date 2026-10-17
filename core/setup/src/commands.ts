import { runProcess, type ProcessResult, type RunProcess } from "@leanish/gate/process";

/** Keep ambient credentials and executable/config injection out of child environments. */
export function commandEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = ["HOME", "USER", "LOGNAME", "PATH", "TMPDIR", "LANG", "LC_ALL", "JAVA_HOME", "CODEX_HOME", "GH_CONFIG_DIR"];
  return Object.fromEntries(allowed.flatMap((key) => env[key] === undefined ? [] : [[key, env[key]]]));
}

export class Commands {
  readonly #run: RunProcess;
  readonly #env: NodeJS.ProcessEnv;
  readonly #ghProbeEnv: NodeJS.ProcessEnv;

  constructor(run: RunProcess = runProcess, env: NodeJS.ProcessEnv = process.env) {
    this.#run = run;
    this.#env = commandEnvironment(env);
    const ghNames = ["GH_TOKEN", "GITHUB_TOKEN", "GH_HOST", "GH_ENTERPRISE_TOKEN"];
    this.#ghProbeEnv = { ...this.#env, ...Object.fromEntries(ghNames.flatMap((key) => env[key] === undefined ? [] : [[key, env[key]]])) };
  }

  /** A failed probe is data, including when a binary is missing. Never expose its diagnostic output. */
  async probe(command: string, args: ReadonlyArray<string>, cwd?: string): Promise<ProcessResult> {
    try {
      return await this.#run(command, args, { cwd, env: command === "gh" ? this.#ghProbeEnv : this.#env, timeoutMs: 30_000 });
    } catch {
      return { code: 1, stdout: "", stderr: "" };
    }
  }

  async checked(command: string, args: ReadonlyArray<string>, message: string, cwd?: string): Promise<string> {
    const env = command === "git"
      ? { ...this.#env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" }
      : this.#env;
    let execution: ProcessResult;
    try {
      execution = await this.#run(command, args, { cwd, env, timeoutMs: 300_000 });
    } catch {
      throw new Error(message);
    }
    if (execution.code !== 0) throw new Error(message);
    return execution.stdout.trim();
  }
}
