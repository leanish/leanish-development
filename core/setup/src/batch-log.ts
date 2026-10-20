/**
 * The person's full record of a batch, for finding why a command failed: every line each tool printed and how each
 * command ended. The scheduled agent never gets it or its path; it reads only the compact counts. Private to the user
 * (folder 0700, file 0600), which keeps it from other users, not from the user's own processes.
 */
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, writeSync } from "node:fs";
import { lstat, mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

export interface BatchLog {
  /** Appends one whole JSON line; after the first failure nothing more is written and `failed` stays true. */
  write(entry: Readonly<Record<string, unknown>>): void;
  readonly failed: boolean;
  close(): void;
}

/** Days of logs kept: older daily files are removed when a batch opens the log. */
export const BATCH_LOG_DAYS = 30;
const DAILY = /^batch-(\d{4})-(\d{2})-(\d{2})\.jsonl$/;

const localDate = (day: Date) => `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;

/** `<state>/logs/batch-YYYY-MM-DD.jsonl` by the machine's local date, as the deployment's weekly runner logs. */
export function batchLogPath(state: string, now: Date): string {
  return join(state, "logs", `batch-${localDate(now)}.jsonl`);
}

/** Removes this log's own daily files older than BATCH_LOG_DAYS; anything else in the folder is left alone. */
async function removeOldLogs(folder: string, now: Date): Promise<void> {
  const oldest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - BATCH_LOG_DAYS + 1);
  for (const name of await readdir(folder)) {
    const match = DAILY.exec(name);
    if (match === null) continue;
    if (new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) >= oldest) continue;
    const path = join(folder, name);
    if ((await lstat(path)).isFile()) await unlink(path);
  }
}

function privateToUser(entry: { readonly uid: number; readonly mode: number }): boolean {
  const uid = process.getuid?.();
  return (uid === undefined || entry.uid === uid) && (entry.mode & 0o077) === 0;
}

/** A log that can't be opened (a symlink or file in its place, a full disk) is a failed log, never a stopped batch. */
export async function openBatchLog(state: string, identity: Readonly<Record<string, unknown>>, now = new Date()): Promise<BatchLog> {
  const run = randomUUID();
  let fd: number | undefined;
  try {
    const folder = join(state, "logs");
    // A first batch can come before the tools create their state folder: create it private, as they do.
    await mkdir(state, { recursive: true, mode: 0o700 });
    try { await mkdir(folder, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    // Modes apply only when created: an existing folder or file must already be the user's and private.
    const entry = await lstat(folder);
    if (!entry.isDirectory() || !privateToUser(entry)) throw new Error(`${folder} must be a private directory of the user's`);
    // Retention never fails the log: a file it can't remove is just kept.
    await removeOldLogs(folder, now).catch(() => {});
    // O_NOFOLLOW: a symlink in the file's place fails here instead of redirecting the appends. O_NONBLOCK: a named
    // pipe there fails at once instead of blocking the batch until something reads it; a regular file is unaffected.
    fd = openSync(batchLogPath(state, now), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    const file = fstatSync(fd);
    if (!file.isFile() || !privateToUser(file)) throw new Error("the batch log must be a private regular file of the user's");
  } catch {
    if (fd !== undefined) closeSync(fd);
    fd = undefined;
  }
  let failed = fd === undefined;
  const log: BatchLog = {
    write(entry) {
      if (fd === undefined) return;
      try {
        // Written whole before returning: the eight workers share one event loop, so lines never interleave.
        const line = Buffer.from(`${JSON.stringify({ ts: new Date().toISOString(), run, ...identity, ...entry })}\n`);
        for (let written = 0; written < line.length;) written += writeSync(fd, line, written);
      } catch {
        failed = true;
        log.close();
      }
    },
    get failed() { return failed; },
    close() {
      if (fd === undefined) return;
      try { closeSync(fd); } catch { failed = true; }
      fd = undefined;
    },
  };
  return log;
}
