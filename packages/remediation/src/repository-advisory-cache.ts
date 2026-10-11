import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { isObject } from "../../ci/src/json.ts";
import type { RepositoryAdvisoryCache } from "../../ci/src/repository-advisories.ts";

const TTL_MS = 60 * 60 * 1_000;

/** Local tools only: share a complete repository response across snapshots and processes for one hour. */
export class FileRepositoryAdvisoryCache implements RepositoryAdvisoryCache {
  readonly #dir: string;
  readonly #scope: string;
  readonly #now: () => number;

  constructor(cacheDir: string, token: string | undefined, now: () => number = Date.now) {
    this.#dir = join(cacheDir, "repository-advisories-v1");
    // Private repository responses must not satisfy a read made with a different credential.
    this.#scope = createHash("sha256").update(token ?? "").digest("hex");
    this.#now = now;
  }

  async read(repo: string): Promise<ReadonlyArray<unknown> | undefined> {
    try {
      const entry: unknown = JSON.parse(await readFile(this.#path(repo), "utf8"));
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
