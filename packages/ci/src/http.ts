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

/** Timing and notice sources replaced by deterministic tests; production uses timers, the clock, Math.random and stderr. */
export interface RetryTiming {
  readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly random: () => number;
  readonly now: () => number;
  readonly notice: (message: string) => void;
}

const RETRIES = 2;
const BACKOFF_MS = 500;
const TRANSIENT_CODES = new Set(["UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "ECONNRESET", "ETIMEDOUT"]);
// GitHub's primary limits reset hourly, so one wait never needs more than an hour (plus clock skew).
const RATE_LIMIT_RETRIES = 2;
const RATE_LIMIT_MAX_WAIT_MS = 61 * 60_000;
const SECONDARY_LIMIT_WAIT_MS = 60_000;
const TIMING: RetryTiming = {
  sleep: (milliseconds, signal) => sleep(milliseconds, undefined, { signal }),
  random: Math.random,
  now: Date.now,
  notice: (message) => process.stderr.write(`${message}\n`),
};

/**
 * GET/HEAD reads retry transient connection failures twice, including body resets,
 * with exponential backoff and jitter. No overall timeout is added: fetch timeouts
 * and caller signals control duration. Successful reads are buffered so retries
 * finish before consumers parse them. A rate-limited read (see `rateLimitWait`)
 * waits as asked and retries twice; other HTTP failures, aborts and other methods
 * are never retried. Errors name the request and cause.
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
  let attempt = 0;
  let rateLimited = 0;
  for (;;) {
    signal?.throwIfAborted();
    try {
      const response = await fetch(url, init);
      if (!response.ok) {
        const wait = rateLimitWait(response, timing.now(), rateLimited);
        if (wait === undefined || wait > RATE_LIMIT_MAX_WAIT_MS || rateLimited === RATE_LIMIT_RETRIES) return response;
        rateLimited++;
        // Undici keeps the connection until the body is read, so release it before a long wait.
        await response.text().catch(() => undefined);
        // A long pass can spend a token's hourly quota; waiting for the reset beats failing the run.
        timing.notice(`${url}: rate limited (HTTP ${response.status}), retrying in ${Math.ceil(wait / 1000)}s`);
        await timing.sleep(wait, signal);
        continue;
      }
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
      attempt++;
    }
  }
}

/**
 * How long a 403/429 response asks to wait, following GitHub's rules: `retry-after`
 * seconds when given, else until `x-ratelimit-reset` when no requests remain, else a
 * minute for a 429, doubling for each earlier wait. Undefined for a 403 without those
 * headers: a permission failure.
 */
export function rateLimitWait(response: Awaited<ReturnType<Fetch>>, nowMs: number, earlierWaits: number): number | undefined {
  if (response.status !== 403 && response.status !== 429) return undefined;
  const retryAfter = response.headers.get("retry-after")?.trim();
  if (retryAfter !== undefined && /^\d+$/.test(retryAfter)) return Number(retryAfter) * 1000;
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  if (response.headers.get("x-ratelimit-remaining") === "0" && Number.isInteger(reset) && reset > 0) {
    // One extra second covers the reset landing just after the clock reading.
    return Math.max(0, reset * 1000 - nowMs) + 1000;
  }
  return response.status === 429 ? SECONDARY_LIMIT_WAIT_MS * 2 ** earlierWaits : undefined;
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
