import { observeQuota, type QuotaUsage, type RateLimitSnapshot } from "../usage/quota.ts";
import { type ModelUsage, type RequestUsage, sumTokens, type TokenUsage, UNATTRIBUTED_MODEL } from "../usage/skill-usage.ts";

// A single-turn invocation may receive these informational events even after its result. Everything else must
// belong to the foreground turn and arrive before it. Unknown events fail closed when completion is checked.
const INFORMATIONAL_EVENTS = new Set(["rate_limit_event", "auth_status", "prompt_suggestion"]);
const INFORMATIONAL_SYSTEM_EVENTS = new Set(["informational", "turn_duration", "session_metadata"]);
const FOREGROUND_EVENTS = new Set(["assistant", "user", "stream_event", "tool_progress", "tool_use_summary"]);
const FOREGROUND_SYSTEM_EVENTS = new Set([
  "init", "compact_boundary", "api_retry", "hook_started", "hook_progress", "hook_response",
  "stop_hook_summary", "local_command_output", "instruction_size_warning", "task_summary",
]);

/**
 * Reads Claude Code's `--print --output-format stream-json --verbose` events, line by line as
 * they arrive: the final answer and the run's usage.
 *
 * Usage follows the tools' convention (`input` includes cache reads and writes, `cachedInput` is the
 * reads, `cacheWriteInput` the writes). Each assistant message is one model request; its events repeat
 * the message's usage with counters that only grow, so a request keeps the field-wise maximum (a
 * counter that drops is a gap). Output counts in those events stop short of the final ones, so the
 * terminal per-model totals are the reference: what they hold beyond the requests is added inexactly
 * (see `withRemainder`); requests that exceed them are a gap, never clamped. Without the terminal
 * event the usage is a lower bound and the cost unknown.
 */
export class ClaudeStreamCollector {
  readonly #requests = new Map<string, { readonly model: string; tokens: TokenUsage }>();
  readonly #gaps: string[] = [];
  readonly #rateLimits: RateLimitSnapshot[] = [];
  #mainModel: string | undefined;
  #result: TerminalResult | undefined;
  #unreadable = 0;
  #protocolFailure: string | undefined;

  accept(line: string): void {
    if (line.trim() === "") return;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      this.#unreadable += 1;
      this.#protocolFailure ??= "stdout contained a non-JSON event";
      return;
    }
    if (!isObject(event)) {
      this.#protocolFailure ??= "stdout contained a non-object event";
      return;
    }
    this.#checkProtocol(event);
    switch (event["type"]) {
      case "system":
        if (event["subtype"] === "init" && typeof event["model"] === "string") this.#mainModel ??= event["model"];
        return;
      case "assistant":
        this.#acceptMessage(event["message"]);
        return;
      case "rate_limit_event":
        this.#acceptRateLimit(event["rate_limit_info"]);
        return;
      case "result":
        this.#result = terminalResult(event);
        return;
    }
  }

  /** Check after EOF, never while streaming: a later event can invalidate an earlier, valid result. */
  assertComplete(): void {
    if (this.#protocolFailure !== undefined) throw new Error(`ClaudeCodeRunner: protocol failure: ${this.#protocolFailure}`);
    if (this.#result === undefined) throw new Error("ClaudeCodeRunner: the CLI ended without a result event");
  }

  /** The CLI's native payload, not JSON extracted from assistant prose. runSkill validates its schema locally. */
  get structuredOutput(): unknown {
    return this.#result?.structuredOutput;
  }

  /** Kept in the existing usage gaps even when cleanup accompanies another invocation failure. */
  recordCleanupFailure(detail: string): void {
    this.#gaps.push(`cleanup failed: ${detail}`);
  }

  #checkProtocol(event: Record<string, unknown>): void {
    const type = event["type"];
    if (type === "result") {
      if (this.#result !== undefined) this.#protocolFailure ??= "received a second result event";
      if ((event["queued_turn_count"] !== undefined && event["queued_turn_count"] !== 0)
        || event["deferred_tool_use"] !== undefined || event["interrupted_by_shutdown"] === true) {
        this.#protocolFailure ??= "result left a pending, deferred or interrupted turn";
      }
      return;
    }
    if (typeof type === "string" && INFORMATIONAL_EVENTS.has(type)) return;
    if (type === "system") {
      const subtype = event["subtype"];
      if (typeof subtype === "string" && INFORMATIONAL_SYSTEM_EVENTS.has(subtype)) return;
      if (subtype === "status" && (this.#result === undefined || event["status"] === null)) return;
      if (subtype === "background_tasks_changed" && Array.isArray(event["tasks"]) && event["tasks"].length === 0) return;
      if (this.#result === undefined && typeof subtype === "string" && FOREGROUND_SYSTEM_EVENTS.has(subtype)) return;
      const name = typeof subtype === "string" ? subtype : "<non-string subtype>";
      this.#protocolFailure ??= this.#result === undefined ? `unexpected system event: ${name}` : `late system event: ${name}`;
      return;
    }
    if (this.#result === undefined && typeof type === "string" && FOREGROUND_EVENTS.has(type)) return;
    const name = typeof type === "string" ? type : "<non-string type>";
    this.#protocolFailure ??= this.#result === undefined ? `unexpected event: ${name}` : `late event: ${name}`;
  }

  /** Last terminal text for diagnostics; completion still needs assertComplete and a successful subtype. */
  get answer(): { readonly text: string; readonly isError: boolean; readonly subtype: string } | undefined {
    const result = this.#result;
    if (result === undefined) return undefined;
    return { text: result.text, isError: result.isError, subtype: result.subtype };
  }

  /** The model the session ran on, as the CLI reported it. */
  get model(): string | undefined {
    return this.#mainModel ?? [...this.#requests.values()][0]?.model;
  }

  usage(): ClaudeStreamUsage {
    const gaps = [...this.#gaps];
    if (this.#unreadable > 0) gaps.push(`${this.#unreadable} stdout lines weren't JSON events`);
    const streamed = new Map<string, RequestUsage[]>();
    for (const request of this.#requests.values()) {
      const list = streamed.get(request.model) ?? [];
      list.push({ tokens: request.tokens, exact: true });
      streamed.set(request.model, list);
    }
    const result = this.#result;
    const quota = this.#quota();
    if (result === undefined) {
      gaps.push("no terminal result event: the tokens are a lower bound and the cost is unknown");
      const models = [...streamed].map(([model, requests]) => modelUsage(model, requests));
      return { measurement: "partial", models, ...withTokens(models), quota, gaps };
    }
    let measurement: "complete" | "partial" = "complete";
    const models: ModelUsage[] = [];
    for (const [model, totals] of result.models) {
      const requests = streamed.get(model) ?? [];
      streamed.delete(model);
      const remainder = subtract(totals, sumTokens(requests.map((request) => request.tokens)));
      const negative = Object.entries(remainder).filter(([, value]) => value < 0).map(([field]) => field);
      if (negative.length > 0) {
        measurement = "partial";
        gaps.push(`${model}: the streamed requests exceed the terminal totals in ${negative.join(", ")}; the terminal totals are reported`);
        models.push({ model, tokens: totals, requests });
        continue;
      }
      models.push(modelUsage(model, withRemainder(requests, remainder)));
    }
    for (const [model, requests] of streamed) {
      measurement = "partial";
      gaps.push(`${model}: streamed requests missing from the terminal totals`);
      models.push(modelUsage(model, requests));
    }
    const fiveMinuteWrites = this.#fiveMinuteWrites;
    if (fiveMinuteWrites > 0) gaps.push(`${fiveMinuteWrites} cache-write tokens used the 5-minute cache; prices assume the 1-hour one`);
    return {
      measurement,
      models,
      ...withTokens(models),
      ...(result.costUsd !== undefined ? { providerCostUsd: result.costUsd } : {}),
      quota,
      gaps,
    };
  }

  #fiveMinuteWrites = 0;

  #acceptMessage(message: unknown): void {
    if (!isObject(message) || typeof message["id"] !== "string" || !isObject(message["usage"])) return;
    const model = typeof message["model"] === "string" ? message["model"] : UNATTRIBUTED_MODEL;
    const usage = message["usage"];
    const tokens = messageTokens(usage);
    const previous = this.#requests.get(message["id"]);
    if (previous === undefined) {
      this.#requests.set(message["id"], { model, tokens });
      const creation = usage["cache_creation"];
      if (isObject(creation)) this.#fiveMinuteWrites += count(creation["ephemeral_5m_input_tokens"]);
      return;
    }
    const dropped = (Object.keys(tokens) as Array<keyof TokenUsage>).filter((field) => tokens[field] < previous.tokens[field]);
    if (dropped.length > 0) this.#gaps.push(`message ${message["id"]}: ${dropped.join(", ")} decreased between events`);
    previous.tokens = maxTokens(previous.tokens, tokens);
  }

  #acceptRateLimit(info: unknown): void {
    if (!isObject(info) || !isObject(info["unifiedWindows"])) return;
    const windows = info["unifiedWindows"];
    const readings = [
      reading(windows["five_hour"], "primary", 300),
      reading(windows["seven_day"], "secondary", 10_080),
    ].filter((entry) => entry !== undefined);
    if (readings.length > 0) this.#rateLimits.push({ limitId: "claude", windows: readings });
  }

  #quota(): QuotaUsage {
    const first = this.#rateLimits[0];
    const last = this.#rateLimits[this.#rateLimits.length - 1];
    if (first === undefined || last === undefined) return { status: "unavailable" };
    return { status: "observed", approximate: true, windows: observeQuota([first], [last]) };
  }
}

export interface ClaudeStreamUsage {
  readonly measurement: "complete" | "partial";
  readonly tokens?: TokenUsage;
  readonly models: ReadonlyArray<ModelUsage>;
  /** The CLI's own cost estimate at list prices (`total_cost_usd`), when the terminal event arrived. */
  readonly providerCostUsd?: number;
  readonly quota: QuotaUsage;
  readonly gaps: ReadonlyArray<string>;
}

interface TerminalResult {
  readonly text: string;
  readonly structuredOutput: unknown;
  readonly isError: boolean;
  readonly subtype: string;
  readonly costUsd: number | undefined;
  readonly models: ReadonlyMap<string, TokenUsage>;
}

function terminalResult(event: Record<string, unknown>): TerminalResult {
  const models = new Map<string, TokenUsage>();
  const modelUsage = event["modelUsage"];
  if (isObject(modelUsage)) {
    for (const [model, value] of Object.entries(modelUsage)) {
      if (!isObject(value)) continue;
      const uncached = count(value["inputTokens"]);
      const read = count(value["cacheReadInputTokens"]);
      const write = count(value["cacheCreationInputTokens"]);
      const output = count(value["outputTokens"]);
      models.set(model, tokenUsage(uncached, read, write, output, Math.min(count(value["thinkingTokens"]), output)));
    }
  }
  const cost = event["total_cost_usd"];
  // A run that fails inside the CLI (a plan limit, an execution error) reports why in `errors`, often with no `result`.
  const errors = Array.isArray(event["errors"]) ? event["errors"].map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry))) : [];
  const result = typeof event["result"] === "string" ? event["result"] : "";
  return {
    text: result !== "" ? result : errors.join("\n"),
    structuredOutput: event["structured_output"],
    isError: event["is_error"] !== false,
    subtype: typeof event["subtype"] === "string" ? event["subtype"] : "unknown",
    costUsd: typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : undefined,
    models,
  };
}

function messageTokens(usage: Record<string, unknown>): TokenUsage {
  return tokenUsage(
    count(usage["input_tokens"]),
    count(usage["cache_read_input_tokens"]),
    count(usage["cache_creation_input_tokens"]),
    count(usage["output_tokens"]),
    0,
  );
}

function tokenUsage(uncached: number, read: number, write: number, output: number, reasoning: number): TokenUsage {
  const input = uncached + read + write;
  return { input, cachedInput: read, cacheWriteInput: write, output, reasoningOutput: reasoning, total: input + output };
}

function subtract(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    input: left.input - right.input,
    cachedInput: left.cachedInput - right.cachedInput,
    cacheWriteInput: left.cacheWriteInput - right.cacheWriteInput,
    output: left.output - right.output,
    reasoningOutput: left.reasoningOutput - right.reasoningOutput,
    total: left.total - right.total,
  };
}

function maxTokens(left: TokenUsage, right: TokenUsage): TokenUsage {
  const input = Math.max(left.input, right.input);
  const output = Math.max(left.output, right.output);
  return {
    input,
    cachedInput: Math.max(left.cachedInput, right.cachedInput),
    cacheWriteInput: Math.max(left.cacheWriteInput, right.cacheWriteInput),
    output,
    reasoningOutput: Math.max(left.reasoningOutput, right.reasoningOutput),
    total: input + output,
  };
}

/**
 * Adds what the terminal totals hold beyond the streamed requests. It can't be split safely: part of it is output the
 * events stopped counting before a message ended, which belongs to a streamed request whose input decides its price
 * tier, and part may be requests never streamed (sub-agents', background ones). So it's folded into the largest
 * streamed request, marked inexact: a price over the long-context threshold then becomes unknown instead of the
 * ordinary tier's. With no streamed request it's one inexact request of its own.
 */
function withRemainder(requests: ReadonlyArray<RequestUsage>, remainder: TokenUsage): RequestUsage[] {
  if (remainder.total === 0) return [...requests];
  const largest = requests.reduce<number>((best, request, i) => (best < 0 || request.tokens.input > requests[best]!.tokens.input ? i : best), -1);
  if (largest < 0) return [{ tokens: remainder, exact: false }];
  return requests.map((request, i) => (i === largest ? { tokens: sumTokens([request.tokens, remainder]), exact: false } : request));
}

function modelUsage(model: string, requests: ReadonlyArray<RequestUsage>): ModelUsage {
  return { model, tokens: sumTokens(requests.map((request) => request.tokens)), requests };
}

function withTokens(models: ReadonlyArray<ModelUsage>): { readonly tokens?: TokenUsage } {
  return models.length === 0 ? {} : { tokens: sumTokens(models.map((model) => model.tokens)) };
}

function reading(value: unknown, window: "primary" | "secondary", windowMinutes: number) {
  if (!isObject(value) || typeof value["utilization"] !== "number") return undefined;
  const resetsAt = value["resetsAt"];
  return {
    window,
    usedPercent: Math.round(value["utilization"] * 100),
    windowMinutes,
    ...(typeof resetsAt === "number" ? { resetsAt } : {}),
  };
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
