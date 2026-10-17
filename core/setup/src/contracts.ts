/** One JSON object per stdout line; never include subprocess output or credentials. */
export interface SetupResult {
  readonly schemaVersion: 1;
  readonly command: "doctor" | "release";
  readonly step: string;
  readonly status: "changed" | "already-done" | "blocked" | "needs-confirmation";
  readonly message: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

/** The skill's agent submits this to its app's scheduling tool; scripts do not create tasks. */
export interface ScheduleSpec {
  readonly name: string;
  readonly prompt: string;
  readonly folder: string;
  readonly cadence: {
    readonly hour: number;
    readonly minute: number;
    readonly timeZone: string;
  } & ({ readonly frequency: "daily" } | { readonly frequency: "weekly"; readonly day: 1 | 2 | 3 | 4 | 5 | 6 | 7 });
}

export function result(
  command: SetupResult["command"], step: string, status: SetupResult["status"], message: string,
  data?: SetupResult["data"],
): SetupResult {
  return { schemaVersion: 1, command, step, status, message, ...(data === undefined ? {} : { data }) };
}

export function exitCode(results: ReadonlyArray<SetupResult>): number {
  if (results.some((entry) => entry.status === "blocked")) return 1;
  return results.some((entry) => entry.status === "needs-confirmation") ? 2 : 0;
}
