import { setTimeout as sleep } from "node:timers/promises";

/** The slice of `fetch` the gate uses, so tests can fake every registry and API. */
export type Fetch = (
  url: string,
  init?: { method?: string; body?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

/** Timing sources replaced by deterministic tests; production uses timers and Math.random. */
export interface RetryTiming {
  readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly random: () => number;
}

const RETRIES = 2;
const BACKOFF_MS = 500;
const TRANSIENT_CODES = new Set(["UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "ECONNRESET", "ETIMEDOUT"]);
const TIMING: RetryTiming = { sleep: (milliseconds, signal) => sleep(milliseconds, undefined, { signal }), random: Math.random };

/**
 * GET/HEAD reads retry transient connection failures twice, including body resets,
 * with exponential backoff and jitter. No overall timeout is added: fetch timeouts
 * and caller signals control duration. Successful reads are buffered so retries
 * finish before consumers parse them. HTTP failures, aborts and other methods are
 * never retried. Errors name the request and cause.
 */
export function namingFailures(fetch: Fetch, timing: RetryTiming = TIMING): Fetch {
  return async (url, init) => {
    try {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method !== "GET" && method !== "HEAD") return await fetch(url, init);
      return await retryRead(fetch, url, init, timing);
    } catch (err) {
      throw new Error(`${init?.method ?? "GET"} ${url} failed: ${reasonOf(err)}`, { cause: err });
    }
  };
}

async function retryRead(fetch: Fetch, url: string, init: Parameters<Fetch>[1], timing: RetryTiming): Promise<Awaited<ReturnType<Fetch>>> {
  const signal = init?.signal;
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      const response = await fetch(url, init);
      if (!response.ok) return response;
      const text = await response.text();
      signal?.throwIfAborted();
      return {
        ok: response.ok,
        status: response.status,
        headers: response.headers,
        text: async () => text,
        json: async () => JSON.parse(text) as unknown,
      };
    } catch (err) {
      if (signal?.aborted || attempt === RETRIES || !isTransient(err)) throw err;
      await timing.sleep(BACKOFF_MS * 2 ** attempt * (0.5 + timing.random()), signal);
    }
  }
}

/**
 * Why GitHub refused a read, for its error message: which rate limit ran out and
 * until when, from GitHub's headers; empty when the status isn't a refusal. Reads
 * fail rather than wait, so a slow pass never hides a spent quota.
 */
export function githubRefusal(response: Awaited<ReturnType<Fetch>>, hasToken: boolean): string {
  if (response.status !== 403 && response.status !== 429) return "";
  const setToken = hasToken ? "" : "; set GITHUB_TOKEN";
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  if (response.headers.get("x-ratelimit-remaining") === "0" && Number.isInteger(reset) && reset > 0) {
    const resource = response.headers.get("x-ratelimit-resource") ?? "core";
    return ` (GitHub rate limit: the ${hasToken ? "token's" : "anonymous"} "${resource}" quota is used up until ${new Date(reset * 1000).toISOString()}${setToken})`;
  }
  const retryAfter = response.headers.get("retry-after")?.trim();
  if (retryAfter !== undefined && /^\d+$/.test(retryAfter)) return ` (GitHub secondary rate limit: retry after ${retryAfter}s)`;
  if (response.status === 429) return ` (GitHub rate limit${setToken})`;
  return hasToken ? " (the token can't read it?)" : " (rate limited? set GITHUB_TOKEN)";
}

/** Walk causes without looping; explicit cancellation always takes priority over a nested socket error. */
function isTransient(error: unknown): boolean {
  const seen = new Set<unknown>();
  let transient = false;
  for (let current = error; current !== null && typeof current === "object" && !seen.has(current);) {
    seen.add(current);
    const entry = current as { name?: unknown; code?: unknown; cause?: unknown };
    if (entry.name === "AbortError" || entry.name === "TimeoutError") return false;
    if (typeof entry.code === "string" && TRANSIENT_CODES.has(entry.code)) transient = true;
    current = entry.cause;
  }
  return transient;
}

/** The cause's code and message (some causes carry only one of them), else the error's own message. */
function reasonOf(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause;
  if (!(cause instanceof Error)) return err.message;
  const code = (cause as Error & { code?: unknown }).code;
  const parts = [typeof code === "string" ? code : "", cause.message].filter((part) => part !== "");
  return parts.length === 0 ? cause.name : parts.join(" ");
}

/** Keeps input order; after a failure stops scheduling, drains active work, then throws the first failure. */
export async function mapLimited<T, R>(items: ReadonlyArray<T>, limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("mapLimited needs a positive integer limit");
  const results = new Array<R>(items.length);
  let next = 0;
  let failure: { readonly error: unknown } | undefined;
  const worker = async (): Promise<void> => {
    while (failure === undefined && next < items.length) {
      const index = next++;
      try {
        results[index] = await work(items[index]!);
      } catch (err) {
        failure ??= { error: err };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure !== undefined) throw failure.error;
  return results;
}
