import { describe, expect, it } from "vitest";

import { ClaudeStreamCollector } from "../src/skill/claude-code-stream.ts";

const feed = (events: ReadonlyArray<unknown>, raw: ReadonlyArray<string> = []) => {
  const collector = new ClaudeStreamCollector();
  for (const line of raw) collector.accept(line);
  for (const event of events) collector.accept(JSON.stringify(event));
  return collector;
};
const message = (id: string, usage: Record<string, unknown>) => ({ type: "assistant", message: { id, model: "m", usage } });
const result = (modelUsage: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ type: "result", subtype: "success", is_error: false, result: "done", modelUsage, ...extra });

describe("ClaudeStreamCollector", () => {
  it("reports a drop in a message's counters and lines that aren't events as gaps", () => {
    const usage = feed(
      [message("a", { input_tokens: 9, output_tokens: 5 }), message("a", { input_tokens: 9, output_tokens: 2 }), result({ m: { inputTokens: 9, outputTokens: 5 } })],
      ["not json", ""],
    ).usage();
    expect(usage.models[0]?.requests).toEqual([{ tokens: expect.objectContaining({ input: 9, output: 5 }), exact: true }]);
    expect(usage.gaps).toEqual(["message a: output, total decreased between events", "1 stdout lines weren't JSON events"]);
  });

  it("reports the terminal totals with a gap, never a clamped remainder, when the requests exceed them", () => {
    const usage = feed([message("a", { input_tokens: 20, output_tokens: 1 }), result({ m: { inputTokens: 10, outputTokens: 4 } }, { total_cost_usd: 0.5 })]).usage();
    expect(usage.measurement).toBe("partial");
    expect(usage.models[0]?.tokens).toMatchObject({ input: 10, output: 4 });
    expect(usage.providerCostUsd).toBe(0.5);
    expect(usage.gaps).toEqual(["m: the streamed requests exceed the terminal totals in input, total; the terminal totals are reported"]);
  });

  it("counts streamed models the terminal event doesn't list as partial", () => {
    const usage = feed([message("a", { input_tokens: 3, output_tokens: 1 }), result({})]).usage();
    expect(usage).toMatchObject({ measurement: "partial", tokens: { input: 3, output: 1, total: 4 } });
    expect(usage.gaps).toEqual(["m: streamed requests missing from the terminal totals"]);
  });

  it("notes 5-minute cache writes, which the prices don't assume", () => {
    const usage = feed([
      message("a", { input_tokens: 1, cache_creation_input_tokens: 40, cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 0 }, output_tokens: 1 }),
      result({ m: { inputTokens: 1, cacheCreationInputTokens: 40, outputTokens: 1 } }),
    ]).usage();
    expect(usage.gaps).toEqual(["40 cache-write tokens used the 5-minute cache; prices assume the 1-hour one"]);
  });

  it("has no quota reading without rate-limit events and no answer without a result", () => {
    const collector = feed([message("a", { input_tokens: 1, output_tokens: 1 })]);
    expect(collector.answer).toBeUndefined();
    expect(collector.usage().quota).toEqual({ status: "unavailable" });
  });

  it("takes a failed run's reason from `errors` when it has no result text", () => {
    const answer = feed([{ type: "result", subtype: "error_during_execution", is_error: true, errors: ["You've hit your limit", { code: "x" }] }]).answer;
    expect(answer).toEqual({ text: 'You\'ve hit your limit\n{"code":"x"}', isError: true, subtype: "error_during_execution" });
  });
});
