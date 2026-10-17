import { randomUUID } from "node:crypto";
import { readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { fileEntry, lockConfiguration } from "./configuration.ts";
import { ownerName } from "./tools.ts";

/** Only real, canonical owner directories participate; malformed names never affect other installations. */
async function installationOwners(root: string): Promise<ReadonlyArray<string>> {
  const owners: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try { if (ownerName(entry.name) === entry.name) owners.push(entry.name); } catch { /* Not an owner directory. */ }
  }
  return owners.sort();
}

async function savedOffset(path: string): Promise<number | undefined> {
  const entry = await fileEntry(path);
  if (entry === undefined) return undefined;
  if (!entry.isFile() || entry.size > 1_000) throw new Error("Saved schedule offset must be a small regular schedule.json file");
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as { offsetHours?: unknown } | null;
    if (value === null || typeof value !== "object" || Object.keys(value).length !== 1 || !Number.isSafeInteger(value.offsetHours)
      || (value.offsetHours as number) < 0 || (value.offsetHours as number) > Number.MAX_SAFE_INTEGER - 24) throw new Error();
    return value.offsetHours as number;
  } catch { throw new Error("Invalid saved schedule offset; inspect schedule.json locally"); }
}

/** Reuse the owner's slot forever; only schedule may allocate, while schedule-check is read-only. */
export async function scheduleOffset(owner: string, home: string, mode: "reserve" | "existing"): Promise<number> {
  const root = join(home, ".config", "leanish", "installations");
  const selected = ownerName(owner);
  const path = join(root, selected, "schedule.json");
  const saved = await savedOffset(path);
  if (saved !== undefined) return saved;
  if (mode === "existing") throw new Error("No saved owner schedule offset; run schedule before checking app readback");

  // All owners share this PID lock so simultaneous allocations cannot choose the same free slot.
  const lock = join(root, ".schedule-lock");
  await lockConfiguration(lock);
  try {
    const current = await savedOffset(path);
    if (current !== undefined) return current;
    const used = new Set<number>();
    for (const other of await installationOwners(root)) {
      const offset = await savedOffset(join(root, other, "schedule.json"));
      if (offset !== undefined) used.add(offset);
    }
    let offsetHours = 0;
    while (used.has(offsetHours)) offsetHours++;
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ offsetHours }) + "\n", { flag: "wx", mode: 0o600 });
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
    return offsetHours;
  } finally { await rm(lock, { force: true }); }
}
