/** Git reads use fixed metadata and real objects, without ambient configuration or executable hooks. */
import { isAbsolute } from "node:path";

import type { RunProcess } from "./process.ts";

const CONFIG_ARGS = ["--no-replace-objects", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

export function gitArgs(root: string, gitDir: string | undefined, args: ReadonlyArray<string>): string[] {
  if (gitDir === undefined || !isAbsolute(gitDir)) throw new Error(`${root} needs an absolute recorded git metadata directory`);
  return [...CONFIG_ARGS, `--git-dir=${gitDir}`, `--work-tree=${root}`, ...args];
}

export function gitEnvironment(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
}

/** The standalone CLI owns its checkout; discover its metadata once, before taking any baseline reads. */
export async function gitDirectory(root: string, run: RunProcess): Promise<string> {
  const result = await run("git", [...CONFIG_ARGS, "rev-parse", "--absolute-git-dir"], { cwd: root, env: gitEnvironment() });
  if (result.code !== 0 || !isAbsolute(result.stdout.trim())) throw new Error(`git can't locate ${root}'s metadata: ${result.stderr.trim()}`);
  return result.stdout.trim();
}
