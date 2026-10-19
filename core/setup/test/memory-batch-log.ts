import type { BatchLog } from "../src/batch-log.ts";

/** A batch log kept in memory, so no test writes into a real state directory. */
export function memoryLog(fail = false): BatchLog & { readonly entries: Readonly<Record<string, unknown>>[] } {
  const entries: Readonly<Record<string, unknown>>[] = [];
  return { entries, write: (entry) => { if (!fail) entries.push(entry); }, failed: fail, close: () => {} };
}
