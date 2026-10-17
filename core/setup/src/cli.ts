#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import { setupArguments, USAGE, type SetupCommand } from "./arguments.ts";
import { batch, type BatchOptions } from "./batch.ts";
import { configure, type ConfigureOptions, type InstallationOptions } from "./configuration.ts";
import { result, exitCode, SETUP_COMMANDS, type SetupResult } from "./contracts.ts";
import { doctor, type DoctorOptions } from "./doctor.ts";
import { enrollment, verifyTokens } from "./enrollment.ts";
import { adoptGate, type GateOptions } from "./gate.ts";
import { installRelease } from "./release.ts";

export interface SetupActions {
  readonly doctor: (options: DoctorOptions) => Promise<ReadonlyArray<SetupResult>>;
  readonly release: () => Promise<SetupResult>;
  readonly configure: (options: ConfigureOptions) => Promise<SetupResult>;
  readonly enroll: (options: InstallationOptions & { readonly login: string }) => Promise<SetupResult>;
  readonly verifyTokens: (options: InstallationOptions) => Promise<SetupResult>;
  readonly gate: (options: GateOptions, emit: (entry: SetupResult) => void) => Promise<ReadonlyArray<SetupResult>>;
  readonly batch: (options: BatchOptions, emit: (line: string) => void) => Promise<number>;
}

/** Dependency injection keeps command dispatch tests away from the person's machine and GitHub. */
export async function main(
  argv: ReadonlyArray<string>, emit: (line: string) => void = (line) => process.stdout.write(line + "\n"),
  actions: SetupActions = { doctor, release: installRelease, configure, enroll: enrollment, verifyTokens, gate: (options, emit) => adoptGate(options, undefined, emit), batch },
): Promise<number> {
  let parsed: SetupCommand;
  try {
    parsed = setupArguments(argv);
  } catch {
    const command = SETUP_COMMANDS.find((command) => command === argv[0]) ?? "setup";
    emit(JSON.stringify(result(command, "arguments", "blocked", USAGE)));
    return 64;
  }
  let results: ReadonlyArray<SetupResult>;
  const emitted = new Set<SetupResult>();
  const publish = (entry: SetupResult) => { emit(JSON.stringify(entry)); emitted.add(entry); };
  try {
    switch (parsed.command) {
      case "doctor": results = await actions.doctor(parsed.options); break;
      case "release": results = [await actions.release()]; break;
      case "configure": results = [await actions.configure(parsed.options)]; break;
      case "enroll": results = [await actions.enroll(parsed.options)]; break;
      case "verify-tokens": results = [await actions.verifyTokens(parsed.options)]; break;
      case "gate": results = await actions.gate(parsed.options, publish); break;
      case "batch": return await actions.batch(parsed.options, emit);
    }
  } catch (error) {
    results = [result(parsed.command, parsed.command, "blocked", (error as Error).message)];
  }
  for (const entry of results) if (!emitted.has(entry)) publish(entry);
  return exitCode(results);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
