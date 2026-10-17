#!/usr/bin/env node
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import { CODING_AGENTS, type CodingAgent } from "@leanish/tool-runtime/config";

import { result, exitCode, type SetupResult } from "./contracts.ts";
import { doctor, type DoctorOptions } from "./doctor.ts";
import { installRelease } from "./release.ts";

const USAGE = "usage: node core/setup/src/cli.ts doctor [--agent codex|claude-code] [--java <major>] | release";

export interface SetupActions {
  readonly doctor: (options: DoctorOptions) => Promise<ReadonlyArray<SetupResult>>;
  readonly release: () => Promise<SetupResult>;
}

/** Dependency injection keeps command dispatch tests away from the person's machine and GitHub. */
export async function main(
  argv: ReadonlyArray<string>, emit: (line: string) => void = (line) => process.stdout.write(line + "\n"),
  actions: SetupActions = { doctor, release: installRelease },
): Promise<number> {
  const [command, ...args] = argv;
  let options: DoctorOptions = {};
  try {
    if (command !== "doctor" && command !== "release") throw new Error();
    const { values } = parseArgs({ args, options: command === "doctor" ? { agent: { type: "string" }, java: { type: "string" } } : {}, strict: true });
    if (values.agent !== undefined && !CODING_AGENTS.includes(values.agent as CodingAgent)) throw new Error();
    if (values.java !== undefined && (!/^\d+$/.test(values.java as string) || !Number.isSafeInteger(Number(values.java)) || Number(values.java) < 8)) throw new Error();
    options = { ...(values.agent === undefined ? {} : { agent: values.agent as CodingAgent }), ...(values.java === undefined ? {} : { java: Number(values.java) }) };
  } catch {
    emit(JSON.stringify(result(command === "release" ? "release" : "doctor", "arguments", "blocked", USAGE)));
    return 64;
  }
  let results: ReadonlyArray<SetupResult>;
  try {
    results = command === "doctor" ? await actions.doctor(options) : [await actions.release()];
  } catch (error) {
    results = [result(command, command, "blocked", (error as Error).message)];
  }
  for (const entry of results) emit(JSON.stringify(entry));
  return exitCode(results);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
