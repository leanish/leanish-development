// Adapted from leanish/leanish-development core/runtime/test/unit/run-skill-usage.test.ts and
// run-skill-invocation.test.ts at c6282df (see PROVENANCE.md): the same cases, against `SkillContext`/`SkillCall`
// instead of a runtime built from an agent descriptor.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { beforeAll, describe, expect, it } from "vitest";

import { ConsoleLogger } from "../src/logger/console-logger.ts";
import { withCorrelation } from "../src/logger/correlation.ts";
import { FakeCodingAgentRunner } from "../src/skill/fake-runner.ts";
import { type Credentials, runSkill, type SkillCall, type SkillContext } from "../src/skill/run-skill.ts";
import type { CodingAgentRunner, SkillInvocation, SkillInvocationResult } from "../src/skill/runner.ts";
import { SkillLoader } from "../src/skill/skill-loader.ts";
import { SchemaValidator } from "../src/skill/validator.ts";
import type { WorkingCopy } from "../src/types/working-copy.ts";
import { parseModelPrices } from "../src/usage/model-prices.ts";
import type { SkillRunStart, SkillUsageRecord, SkillUsageRecorder } from "../src/usage/skill-usage-record.ts";
import { deliverSkillUsage, type SkillUsage } from "../src/usage/skill-usage.ts";

const SKILL_FILE = `---
name: probe
inputSchema:
  type: object
  properties:
    package: { type: string }
outputSchema:
  type: object
  required: [ok]
  properties:
    ok: { type: boolean }
---

# probe
`;

const VALID = "```json\n{\"ok\": true}\n```";
const INVALID = "```json\n{\"nope\": 1}\n```";

/** Synthetic prices: 2 USD per million input tokens, 10 per million output. */
const PRICES = parseModelPrices(
  {
    "model-a": {
      inputPerMTok: 2,
      cachedInputPerMTok: 0.5,
      cacheWritePerMTok: 2.5,
      outputPerMTok: 10,
      basis: "standard, short context",
      source: "test fixture",
      asOf: "2026-01-01",
    },
  },
  "test",
);

const TOKENS = { input: 1_000_000, cachedInput: 0, cacheWriteInput: 0, output: 100_000, reasoningOutput: 0, total: 1_100_000 };
const MEASURED: SkillUsage = {
  codingAgent: "codex",
  requestedModel: "model-a",
  model: "model-a",
  durationMs: 5,
  synthetic: false,
  measurement: "complete",
  tokens: TOKENS,
  models: [{ model: "model-a", tokens: TOKENS, requests: [{ tokens: TOKENS, exact: true }] }],
  quota: { status: "unavailable" },
  gaps: [],
};

/** A runner that answers `responseText` (or throws `error`), reports `usage` unless told not to, and keeps what it got. */
class ScriptedRunner implements CodingAgentRunner {
  readonly codingAgent = "codex";
  readonly invocations: SkillInvocation[] = [];
  readonly #script: { readonly responseText?: string; readonly error?: Error; readonly usage?: SkillUsage | "never"; readonly model?: string };

  constructor(script: { readonly responseText?: string; readonly error?: Error; readonly usage?: SkillUsage | "never"; readonly model?: string }) {
    this.#script = script;
  }

  async run(invocation: SkillInvocation): Promise<SkillInvocationResult> {
    this.invocations.push(invocation);
    try {
      if (this.#script.error !== undefined) throw this.#script.error;
      return { responseText: this.#script.responseText ?? VALID, ...(this.#script.model !== undefined ? { model: this.#script.model } : {}) };
    } finally {
      if (this.#script.usage !== "never") deliverSkillUsage(invocation.onUsage, this.#script.usage ?? MEASURED);
    }
  }
}

let skillsDir: string;

beforeAll(async () => {
  skillsDir = await mkdtemp(join(tmpdir(), "run-skill-"));
  await mkdir(join(skillsDir, "probe"), { recursive: true });
  await writeFile(join(skillsDir, "probe", "SKILL.md"), SKILL_FILE);
});

function contextWith(
  runner: CodingAgentRunner,
  options: { readonly logLevel?: "info" | "error"; readonly recorder?: SkillUsageRecorder; readonly prices?: boolean } = {},
): { readonly ctx: SkillContext; readonly records: SkillUsageRecord[]; readonly starts: SkillRunStart[]; readonly log: () => string } {
  const records: SkillUsageRecord[] = [];
  const starts: SkillRunStart[] = [];
  const stream = new PassThrough();
  let log = "";
  stream.on("data", (chunk: Buffer) => {
    log += chunk.toString("utf8");
  });
  const ctx: SkillContext = {
    entrypoints: ["probe"],
    supportSkills: [],
    skillLoader: new SkillLoader({ skillsDirs: [skillsDir] }),
    runnerFor: () => runner,
    validator: new SchemaValidator(),
    logger: new ConsoleLogger({ minLevel: options.logLevel ?? "info", stream }),
    usageRecorder: options.recorder ?? { started: (run) => starts.push(run), record: (record) => records.push(record) },
    ...(options.prices === true ? { modelPrices: PRICES } : {}),
  };
  return { ctx, records, starts, log: () => log };
}

const CALL: SkillCall<object> = { entrypoint: "probe", input: {}, workingCopies: [], codingAgent: "codex", model: "model-a", access: "read-only" };
const WORKING_COPY: WorkingCopy = { projectId: "acme/widget", path: "/tmp/acme-widget", branch: "main", headSha: "a".repeat(40) };

describe("runSkill", () => {
  it("hands the runner the call's access, model, effort and credential env, and returns the validated answer", async () => {
    const runner = new ScriptedRunner({});
    const { ctx } = contextWith(runner);
    const secrets = [{ name: "GH_TOKEN", value: "read-token" }];
    const answer = await runSkill(ctx, {
      ...CALL,
      input: { package: "vite" },
      workingCopies: [WORKING_COPY],
      effort: "high",
      access: "write",
      credentials: { env: { GH_TOKEN: "read-token" }, secrets },
    });
    expect(answer).toEqual({ ok: true });
    expect(runner.invocations[0]).toMatchObject({
      access: "write",
      model: "model-a",
      effort: "high",
      env: { GH_TOKEN: "read-token" },
      secrets,
      workingCopies: [WORKING_COPY],
    });
    expect(runner.invocations[0]?.renderedArguments).toContain("package: vite");
  });

  it("refuses an entrypoint the tool doesn't declare, a write run without a working copy, and input that fails the schema, before any runner starts", async () => {
    const runner = new ScriptedRunner({});
    const { ctx } = contextWith(runner);
    await expect(runSkill(ctx, { ...CALL, entrypoint: "undeclared" })).rejects.toMatchObject({ reason: "entrypoint-not-declared" });
    await expect(runSkill(ctx, { ...CALL, access: "write" })).rejects.toMatchObject({ reason: "write-without-working-copy" });
    await expect(runSkill(ctx, { ...CALL, input: { package: 7 } })).rejects.toMatchObject({ reason: "input-validation-fail" });
    expect(runner.invocations).toEqual([]);
  });

  it("logs the concrete model a runner resolved from a family name", async () => {
    const { ctx, log } = contextWith(new ScriptedRunner({ model: "gpt-6.1-sol" }));
    await runSkill(ctx, { ...CALL, model: "sol" });
    expect(log()).toContain('"msg":"runSkill model resolved"');
    expect(log()).toContain('"model":"gpt-6.1-sol"');
  });
});

describe("runSkill usage", () => {
  it("records and logs one usage record per call, with the API-price estimate and the call's correlation", async () => {
    const { ctx, records, starts, log } = contextWith(new ScriptedRunner({}), { prices: true });
    await withCorrelation({ requestId: "req-1", stage: "run" }, () => runSkill(ctx, CALL));
    await runSkill(ctx, CALL);

    expect(records).toHaveLength(2);
    // Each call is announced before its record, under the same id.
    expect(starts).toEqual(records.map((record) => ({ invocationId: record.invocationId, entrypoint: "probe" })));
    expect(records[0]).toMatchObject({
      entrypoint: "probe",
      requestId: "req-1",
      stage: "run",
      outcome: "succeeded",
      codingAgent: "codex",
      model: "model-a",
      measurement: "complete",
      models: [{ model: "model-a", requests: 1 }],
      // 1M input × 2 + 0.1M output × 10
      apiCost: { usd: 3, complete: true },
    });
    expect(records[0]?.invocationId).not.toBe(records[1]?.invocationId);
    expect(log()).toContain('"msg":"runSkill usage"');
  });

  it("feeds the recorder whatever the log level", async () => {
    const { ctx, records, log } = contextWith(new ScriptedRunner({}), { logLevel: "error" });
    await runSkill(ctx, CALL);
    expect(records).toHaveLength(1);
    expect(log()).not.toContain("runSkill usage");
    expect(records[0]?.apiCost).toMatchObject({ usd: null });
  });

  it("records the usage of a runner that failed, and of an answer then rejected", async () => {
    const failed = contextWith(new ScriptedRunner({ error: new Error("cli broke") }));
    await expect(runSkill(failed.ctx, CALL)).rejects.toThrowError(/cli broke/);
    expect(failed.records.map((record) => record.outcome)).toEqual(["runner-failed"]);
    expect(failed.records[0]?.tokens?.input).toBe(1_000_000);

    const rejected = contextWith(new ScriptedRunner({ responseText: INVALID }));
    await expect(runSkill(rejected.ctx, CALL)).rejects.toThrowError(/failed outputSchema validation/);
    expect(rejected.records.map((record) => record.outcome)).toEqual(["output-rejected"]);

    const unparsable = contextWith(new ScriptedRunner({ responseText: "no json here" }));
    await expect(runSkill(unparsable.ctx, CALL)).rejects.toThrow();
    expect(unparsable.records.map((record) => record.outcome)).toEqual(["output-rejected"]);
  });

  it("turns a runner that never reports usage into an explicit gap", async () => {
    const { ctx, records } = contextWith(new ScriptedRunner({ usage: "never" }));
    await runSkill(ctx, CALL);
    expect(records[0]).toMatchObject({
      codingAgent: "codex",
      requestedModel: "model-a",
      measurement: "partial",
      gaps: ["the codex runner reported no usage; the duration is runSkill's own measurement"],
      apiCost: { usd: null, complete: false },
    });
    expect(records[0]?.tokens).toBeUndefined();
  });

  it("keeps a throwing recorder from changing the result, logging it instead", async () => {
    const throwing: SkillUsageRecorder = {
      started: () => {
        throw new Error("disk full");
      },
      record: () => {
        throw new Error("disk full");
      },
    };
    const { ctx, log } = contextWith(new ScriptedRunner({}), { recorder: throwing });
    await expect(runSkill(ctx, CALL)).resolves.toEqual({ ok: true });
    expect(log()).toContain('"msg":"runSkill usage recorder failed"');
    expect(log()).toContain("disk full");

    const failing = contextWith(new ScriptedRunner({ error: new Error("cli broke") }), { recorder: throwing });
    await expect(runSkill(failing.ctx, CALL)).rejects.toThrowError(/cli broke/);
  });

  it("records a fake runner's call as synthetic, costing nothing", async () => {
    const runner = new FakeCodingAgentRunner("codex");
    runner.register("probe", () => ({ responseText: VALID }));
    const { ctx, records } = contextWith(runner);
    await runSkill(ctx, CALL);
    expect(records[0]).toMatchObject({
      synthetic: true,
      measurement: "complete",
      tokens: { total: 0 },
      quota: { status: "not-applicable", reason: "synthetic run" },
      apiCost: { usd: 0, complete: true },
    });
  });

  it("records nothing for a call rejected before it reached the runner", async () => {
    const { ctx, records, starts } = contextWith(new ScriptedRunner({}));
    await expect(runSkill(ctx, { ...CALL, entrypoint: "undeclared" })).rejects.toThrow();
    expect(records).toEqual([]);
    expect(starts).toEqual([]);
  });
});

describe("runSkill lazy credentials", () => {
  const CREDENTIALS: Credentials = { env: { GH_TOKEN: "read-token" }, secrets: [{ name: "GH_TOKEN", value: "read-token" }] };

  /** A resolver that answers `answer` and counts its calls. */
  function resolver(answer: () => Promise<Credentials | undefined>): { readonly resolve: () => Promise<Credentials | undefined>; readonly calls: () => number } {
    let calls = 0;
    return {
      resolve: () => {
        calls += 1;
        return answer();
      },
      calls: () => calls,
    };
  }

  it("resolves them right before the runner: while the resolver is pending nothing is started", async () => {
    const runner = new ScriptedRunner({});
    const { ctx, records, starts } = contextWith(runner);
    const { promise: called, resolve: notifyCalled } = Promise.withResolvers<void>();
    const { promise: pending, resolve: answer } = Promise.withResolvers<Credentials>();
    const result = runSkill(ctx, {
      ...CALL,
      credentials: () => {
        notifyCalled();
        return pending;
      },
    });

    await called;
    await new Promise((resolve) => setImmediate(resolve));
    expect(starts).toEqual([]);
    expect(runner.invocations).toEqual([]);

    answer(CREDENTIALS);
    await expect(result).resolves.toEqual({ ok: true });
    expect(starts).toHaveLength(1);
    expect(records).toHaveLength(1);
    expect(runner.invocations[0]).toMatchObject({ env: CREDENTIALS.env, secrets: CREDENTIALS.secrets });
  });

  it("isn't called for a call rejected before the runner, nor when the runner can't be found", async () => {
    const lazy = resolver(async () => CREDENTIALS);
    const { ctx, records, starts } = contextWith(new ScriptedRunner({}));
    const withMissingEntrypoint: SkillContext = { ...ctx, entrypoints: ["probe", "missing"] };
    const withMissingSupportSkill: SkillContext = { ...ctx, supportSkills: ["missing"] };
    const withoutRunner: SkillContext = {
      ...ctx,
      runnerFor: () => {
        throw new Error("no runner for codex");
      },
    };
    const call = { ...CALL, credentials: lazy.resolve };

    await expect(runSkill(ctx, { ...call, entrypoint: "undeclared" })).rejects.toMatchObject({ reason: "entrypoint-not-declared" });
    await expect(runSkill(withMissingEntrypoint, { ...call, entrypoint: "missing" })).rejects.toThrowError(/skill 'missing' not found/);
    await expect(runSkill(withMissingSupportSkill, call)).rejects.toThrowError(/skill 'missing' not found/);
    await expect(runSkill(ctx, { ...call, input: { package: 7 } })).rejects.toMatchObject({ reason: "input-validation-fail" });
    await expect(runSkill(ctx, { ...call, access: "write" })).rejects.toMatchObject({ reason: "write-without-working-copy" });
    await expect(runSkill(withoutRunner, call)).rejects.toThrowError("no runner for codex");
    expect(lazy.calls()).toBe(0);
    expect(starts).toEqual([]);
    expect(records).toEqual([]);
  });

  it("fails the call with the resolver's own error, thrown or rejected, before anything starts", async () => {
    const thrown = new Error("vault sealed");
    const rejected = new TypeError("vault unreachable");
    const runner = new ScriptedRunner({});
    const { ctx, records, starts } = contextWith(runner);

    await expect(runSkill(ctx, {
      ...CALL,
      credentials: () => {
        throw thrown;
      },
    })).rejects.toBe(thrown);
    await expect(runSkill(ctx, { ...CALL, credentials: () => Promise.reject(rejected) })).rejects.toBe(rejected);
    expect(starts).toEqual([]);
    expect(records).toEqual([]);
    expect(runner.invocations).toEqual([]);
  });

  it("logs a resolver's failure once, by the error's class and never its message", async () => {
    const { ctx, log } = contextWith(new ScriptedRunner({}));
    const leaky = new TypeError("token ghp_not-a-real-secret was revoked");
    await expect(runSkill(ctx, { ...CALL, credentials: () => Promise.reject(leaky) })).rejects.toBe(leaky);

    const failures = log().split("\n").filter((line) => line.includes('"reason":"credentials-unresolved"'));
    expect(failures).toHaveLength(1);
    expect(JSON.parse(failures[0]!)).toMatchObject({ level: "error", msg: "runSkill failed", entrypoint: "probe", error: "TypeError" });
    expect(log()).not.toContain("ghp_not-a-real-secret");
  });

  it("rethrows the resolver's error even when logging it throws", async () => {
    const runner = new ScriptedRunner({});
    const { ctx, starts, records } = contextWith(runner);
    const down = (): never => {
      throw new Error("logger down");
    };
    const brokenLogger: SkillContext["logger"] = { debug: down, info: down, warn: down, error: down, with: () => brokenLogger };
    const failing: SkillContext = { ...ctx, logger: brokenLogger };
    const rejected = new Error("vault unreachable");
    await expect(runSkill(failing, { ...CALL, credentials: () => Promise.reject(rejected) })).rejects.toBe(rejected);
    expect([starts, records, runner.invocations]).toEqual([[], [], []]);
  });

  it("runs without credentials, and starts only then, when an untyped resolver answers null", async () => {
    const runner = new ScriptedRunner({});
    const { ctx, starts, records } = contextWith(runner);
    const untyped = (async () => null) as unknown as () => Promise<Credentials | undefined>;
    await expect(runSkill(ctx, { ...CALL, credentials: untyped })).resolves.toEqual({ ok: true });
    expect(runner.invocations[0]).not.toHaveProperty("env");
    expect(runner.invocations[0]).not.toHaveProperty("secrets");
    expect([starts.length, records.map((record) => record.outcome)]).toEqual([1, ["succeeded"]]);
  });

  it("hands the runner exactly what the same credentials given as an object would", async () => {
    const eager = new ScriptedRunner({});
    const lazy = new ScriptedRunner({});
    await runSkill(contextWith(eager).ctx, { ...CALL, credentials: CREDENTIALS });
    await runSkill(contextWith(lazy).ctx, { ...CALL, credentials: async () => CREDENTIALS });
    const { onUsage: _eagerOnUsage, ...fromObject } = eager.invocations[0]!;
    const { onUsage: _lazyOnUsage, ...fromResolver } = lazy.invocations[0]!;
    expect(fromResolver).toStrictEqual(fromObject);
    expect(fromResolver).toMatchObject({ env: CREDENTIALS.env, secrets: CREDENTIALS.secrets });
  });

  it("runs without credentials when the resolver has none", async () => {
    const runner = new ScriptedRunner({});
    const { ctx } = contextWith(runner);
    await expect(runSkill(ctx, { ...CALL, credentials: async () => undefined })).resolves.toEqual({ ok: true });
    expect(runner.invocations[0]).not.toHaveProperty("env");
    expect(runner.invocations[0]).not.toHaveProperty("secrets");
  });

  it("calls each call's resolver once, every call anew", async () => {
    const runner = new ScriptedRunner({});
    const { ctx } = contextWith(runner);
    const first = resolver(async () => CREDENTIALS);
    const second = resolver(async () => ({ env: { GH_TOKEN: "other-token" }, secrets: [{ name: "GH_TOKEN", value: "other-token" }] }));

    await runSkill(ctx, { ...CALL, credentials: first.resolve });
    await runSkill(ctx, { ...CALL, credentials: second.resolve });
    expect([first.calls(), second.calls()]).toEqual([1, 1]);
    expect(runner.invocations.map((invocation) => invocation.env)).toEqual([{ GH_TOKEN: "read-token" }, { GH_TOKEN: "other-token" }]);

    await runSkill(ctx, { ...CALL, credentials: first.resolve });
    expect(first.calls()).toBe(2);
  });
});
