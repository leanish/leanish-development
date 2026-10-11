import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync } from "node:fs";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { isObject } from "../../ci/src/json.ts";
import type { RepositoryAdvisoryCache } from "../../ci/src/repository-advisories.ts";
import { canonical, isInside } from "./osv-scanner.ts";

const TTL_MS = 60 * 60 * 1_000;

/**
 * Local tools only: share a complete repository response across snapshots and processes for one hour.
 * Keep it under `dirs.state`, never a sandbox-writable dir: an agent or build that could rewrite an
 * entry (say, to `[]`) would hide repository-only advisories from the final verification.
 */
export class FileRepositoryAdvisoryCache implements RepositoryAdvisoryCache {
  readonly #dir: string;
  readonly #scope: string;
  readonly #now: () => number;

  constructor(stateDir: string, sandboxWritable: ReadonlyArray<string>, token: string | undefined, now: () => number = Date.now) {
    // The canonical path, as for OSV-Scanner: a symlink the sandbox can retarget must not decide where entries live.
    this.#dir = canonical(join(stateDir, "repository-advisories-v1"));
    const writable = sandboxWritable.find((root) => isInside(this.#dir, root));
    if (writable !== undefined) throw new Error(`the repository-advisory cache would live in ${writable}, which sandboxed commands can write`);
    // canonical() keeps a dangling link's own name (the leaf or any ancestor); its target could be created later
    // somewhere writable, redirecting the cache.
    const link = danglingLink(this.#dir);
    if (link !== undefined) throw new Error(`the repository-advisory cache path goes through the dangling symlink ${link}`);
    // Private repository responses must not satisfy a read made with a different credential.
    this.#scope = createHash("sha256").update(token ?? "").digest("hex");
    this.#now = now;
  }

  async read(repo: string): Promise<ReadonlyArray<unknown> | undefined> {
    try {
      // O_NOFOLLOW: an entry linked to a file elsewhere is a miss, never trusted data.
      const file = await open(this.#path(repo), constants.O_RDONLY | constants.O_NOFOLLOW);
      let text: string;
      try {
        text = await file.readFile("utf8");
      } finally {
        await file.close();
      }
      const entry: unknown = JSON.parse(text);
      if (!isObject(entry) || entry["repo"] !== repo.toLowerCase() || typeof entry["fetchedAt"] !== "number" || !Array.isArray(entry["advisories"])) return undefined;
      const age = this.#now() - entry["fetchedAt"];
      if (!Number.isFinite(age) || age < 0 || age >= TTL_MS) return undefined;
      return entry["advisories"];
    } catch {
      return undefined;
    }
  }

  async write(repo: string, advisories: ReadonlyArray<unknown>): Promise<void> {
    const path = this.#path(repo);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await mkdir(this.#dir, { recursive: true });
      await writeFile(temporary, JSON.stringify({ repo: repo.toLowerCase(), fetchedAt: this.#now(), advisories }), { flag: "wx", mode: 0o600 });
      // Unique siblings + rename expose only whole entries, even when several processes miss together.
      await rename(temporary, path);
    } catch {
      // The cache is best effort; API failures still propagate from the caller.
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  #path(repo: string): string {
    const key = createHash("sha256").update(`${this.#scope}:${repo.toLowerCase()}`).digest("hex");
    return join(this.#dir, `${key}.json`);
  }
}

/** The first unresolved component of `path` that is a symlink (a dangling one, since canonical() resolves the rest). */
function danglingLink(path: string): string | undefined {
  for (let current = path; ; current = dirname(current)) {
    try {
      return lstatSync(current).isSymbolicLink() ? current : undefined;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      if (dirname(current) === current) return undefined;
    }
  }
}
