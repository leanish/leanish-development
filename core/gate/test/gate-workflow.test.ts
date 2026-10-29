/** The reusable gate's event handling: PRs are compared when they change; scheduled runs scan the default branch only. */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { REPORT_SCHEMA_VERSION } from "../src/report.ts";

interface GateStep {
  readonly uses?: string;
  readonly "working-directory"?: string;
  readonly id?: string;
  readonly name?: string;
  readonly if?: string;
  readonly run?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly with?: Readonly<Record<string, string | number | boolean>>;
  readonly "continue-on-error"?: boolean;
}

interface GateWorkflow {
  readonly on: { readonly workflow_call: {
    readonly inputs: Readonly<Record<string, unknown>>;
    readonly outputs: Readonly<Record<string, { readonly value: string }>>;
  } };
  readonly jobs: Readonly<Record<string, GateJob>>;
}

interface GateJob {
  readonly permissions?: unknown;
  readonly needs?: string | ReadonlyArray<string>;
  readonly if?: string;
  readonly strategy?: unknown;
  readonly uses?: string;
  readonly outputs?: Readonly<Record<string, string>>;
  readonly steps: ReadonlyArray<GateStep>;
}

const workflow = parse(readFileSync(new URL("../../../.github/workflows/supply-chain.yml", import.meta.url), "utf8")) as GateWorkflow;
const ci = parse(readFileSync(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8")) as GateWorkflow;

for (const job of ["inventory", "supply-chain"]) {
  describe(`${job}'s event validation`, () => {
    const validator = workflow.jobs[job]!.steps[0]!;

    function validate(event: string, ref: string): number | null {
      const command = spawnSync("/bin/bash", ["-e", "-c", validator.run!], {
        env: { EVENT: event, REF: ref, DEFAULT_REF: "refs/heads/main" }, encoding: "utf8",
      });
      expect(command.error).toBeUndefined();
      return command.status;
    }

    it("validates the caller's event and ref before any other step", () => {
      expect(validator.name).toBe("Validate the event and ref");
      expect(validator.env).toEqual({
        EVENT: "${{ github.event_name }}", REF: "${{ github.ref }}",
        DEFAULT_REF: "refs/heads/${{ github.event.repository.default_branch }}",
      });
      expect(validator.if).toBeUndefined();
      expect(validator["continue-on-error"]).toBeUndefined();
      expect(validator).toEqual(workflow.jobs["inventory"]!.steps[0]);
    });

    it("accepts a pull request's merge ref", () => {
      expect(validate("pull_request", "refs/pull/7/merge")).toBe(0);
    });

    it.each(["push", "schedule", "workflow_dispatch"])("accepts a default-branch %s", (event) => {
      expect(validate(event, "refs/heads/main")).toBe(0);
    });

    it.each(["push", "schedule", "workflow_dispatch"])("refuses another branch or a tag on %s", (event) => {
      expect(validate(event, "refs/heads/feature")).toBe(1);
      expect(validate(event, "refs/tags/main")).toBe(1);
    });

    it.each(["issue_comment", "pull_request_target", "merge_group", ""])("refuses unsupported event '%s'", (event) => {
      expect(validate(event, "refs/heads/main")).toBe(1);
    });
  });
}

describe("the gate's jobs", () => {
  it("never rescan open PRs, so none writes statuses", () => {
    expect(Object.keys(workflow.jobs)).toEqual(["inventory", "supply-chain", "cooldown"]);
    expect(Object.keys(workflow.on.workflow_call.inputs)).toEqual(["java-version", "java-distribution", "node-version"]);
    for (const job of Object.values(workflow.jobs)) expect(JSON.stringify(job.permissions ?? {})).not.toContain("statuses");
  });

  it("preserves the comparison and cooldown outputs for callers", () => {
    const outputs = workflow.on.workflow_call.outputs;
    expect(Object.keys(outputs)).toEqual(["comparison-passed", "cooldown-held"]);
    expect(outputs["comparison-passed"]!.value).toBe("${{ jobs.supply-chain.outputs.passed }}");
    expect(outputs["cooldown-held"]!.value).toBe("${{ jobs.cooldown.outputs.held }}");
    expect(workflow.jobs["supply-chain"]!.outputs).toEqual({ passed: "${{ steps.passed.outputs.passed }}" });
    expect(workflow.jobs["cooldown"]!.outputs).toEqual({ held: "${{ steps.evaluate.outputs.held }}" });
  });
});

describe("the reusable workflow's fail-closed guards", () => {
  const comparison = workflow.jobs["supply-chain"]!;
  const cooldown = workflow.jobs["cooldown"]!;
  const inventoryGuard = comparison.steps[1]!;
  const comparisonGuard = cooldown.steps[0]!;
  const evaluate = cooldown.steps.find((step) => step.id === "evaluate")!;
  const hold = cooldown.steps.find((step) => step.name === "Hold the young versions")!;

  function run(step: GateStep, env: Record<string, string>, cwd?: string) {
    const result = spawnSync("/bin/bash", ["-e", "-o", "pipefail", "-c", step.run!], {
      cwd, env: { ...process.env, ...env }, encoding: "utf8",
    });
    expect(result.error).toBeUndefined();
    return result;
  }

  it("runs the required verdict and PR cooldown after every dependency outcome", () => {
    expect(comparison.needs).toBe("inventory");
    expect(comparison.if).toBe("always()");
    expect(cooldown.needs).toBe("supply-chain");
    expect(cooldown.if).toBe("always() && github.event_name == 'pull_request'");
    expect(inventoryGuard.name).toBe("Require the inventories");
    expect(inventoryGuard.env).toEqual({ INVENTORY: "${{ needs.inventory.result }}" });
    expect(comparisonGuard.name).toBe("Require a passing comparison");
    expect(comparisonGuard.env).toEqual({ COMPARISON: "${{ needs.supply-chain.result }}" });
    expect(evaluate.name).toBe("Evaluate the cooldown");
    expect(evaluate.env).toEqual({ HEAD_SHA: "${{ github.sha }}" });
    for (const step of [inventoryGuard, comparisonGuard, evaluate]) {
      expect(step.if).toBeUndefined();
      expect(step["continue-on-error"]).toBeUndefined();
    }
    const download = cooldown.steps.find((step) => step.with?.["name"] === "supply-chain-report")!;
    expect(download.with?.["path"]).toBe("${{ runner.temp }}/report");
    expect(download.if).toBeUndefined();
    expect(download["continue-on-error"]).toBeUndefined();
    expect(cooldown.steps.indexOf(download)).toBeLessThan(cooldown.steps.indexOf(evaluate));
  });

  it.each(["failure", "cancelled", "skipped", "unknown", ""])("fails the comparison when inventory is %s", (inventory) => {
    expect(run(inventoryGuard, { INVENTORY: inventory }).status).toBe(1);
  });

  it("accepts successful inventories", () => {
    expect(run(inventoryGuard, { INVENTORY: "success" }).status).toBe(0);
  });

  it.each(["failure", "cancelled", "skipped", "unknown", ""])("fails cooldown when comparison is '%s'", (comparison) => {
    expect(run(comparisonGuard, { COMPARISON: comparison }).status).toBe(1);
  });

  it("accepts a passing comparison", () => {
    expect(run(comparisonGuard, { COMPARISON: "success" }).status).toBe(0);
  });

  it.each(["missing", "another head", "failed", "passing"])("evaluates the actual cooldown command with a %s report", (kind) => {
    const dir = mkdtempSync(join(process.cwd(), ".gate-guard-"));
    try {
      symlinkSync(fileURLToPath(new URL("../../../", import.meta.url)), join(dir, "tool"));
      mkdirSync(join(dir, "report"));
      const head = "a".repeat(40);
      if (kind !== "missing") writeFileSync(join(dir, "report/supply-chain.json"), JSON.stringify({
        schemaVersion: REPORT_SCHEMA_VERSION, mode: "compare", completed: true,
        headSha: kind === "another head" ? "b".repeat(40) : head,
        verdict: kind === "failed" ? "fail" : "pass", cooldown: { evaluated: true, releaseAgeDays: 7, held: [] },
      }));
      const output = join(dir, "output");
      const result = run(evaluate, { HEAD_SHA: head, RUNNER_TEMP: dir, GITHUB_OUTPUT: output }, dir);
      expect(result.status, result.stderr).toBe(kind === "passing" ? 0 : 2);
      if (kind === "passing") expect(readFileSync(output, "utf8")).toBe("held=false\nuntil=\n");
      else expect(existsSync(output)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails the hold step only after an evaluation says versions are held", () => {
    expect(hold.if).toBe("steps.evaluate.outputs.held == 'true'");
    expect(hold["continue-on-error"]).toBeUndefined();
    expect(cooldown.steps.indexOf(hold)).toBeGreaterThan(cooldown.steps.indexOf(evaluate));
    expect(run(hold, { UNTIL: "2026-10-13T00:00:00Z" }).status).toBe(1);
  });
});

describe("the inventory job's sequential checkouts", () => {
  const inventory = workflow.jobs["inventory"]!;
  const steps = inventory.steps;
  const baseCheckout = steps.find((step) => step.name === "Check out the PR merge commit for base")!;
  const headCheckout = steps.find((step) => step.name === "Check out the repository")!;
  const moveBase = steps.find((step) => step.name === "Move to the base the PR builds on")!;
  const base = steps.find((step) => step.name === "Inventory the base Gradle builds")!;
  const head = steps.find((step) => step.name === "Inventory the head Gradle builds")!;
  const upload = steps.find((step) => step.with?.["name"] === "gradle-inventories")!;

  it("uses separate checkouts of the same merge commit, with base at its first parent", () => {
    expect(inventory.needs).toBeUndefined();
    expect(inventory.if).toBeUndefined();
    expect(inventory.strategy).toBeUndefined();
    for (const checkout of [baseCheckout, headCheckout]) {
      expect(checkout.uses).toMatch(/^actions\/checkout@/);
      expect(checkout.with?.["ref"]).toBe("${{ github.sha }}");
      expect(checkout.with?.["fetch-depth"]).toBe(2);
      expect(checkout.with?.["persist-credentials"]).toBe(false);
    }
    expect(baseCheckout.with?.["path"]).toBe("base");
    expect(headCheckout.with?.["path"]).toBe("repo");
    expect(headCheckout.if).toBeUndefined();
    expect(moveBase["working-directory"]).toBe("base");
    expect(moveBase.run).toBe("git checkout --quiet --detach HEAD^1");
    for (const step of [baseCheckout, moveBase, base]) expect(step.if).toBe("github.event_name == 'pull_request'");
    expect(steps.indexOf(baseCheckout)).toBeLessThan(steps.indexOf(moveBase));
    expect(steps.indexOf(moveBase)).toBeLessThan(steps.indexOf(base));
  });

  it("inventories base before head and skips head after a base failure", () => {
    expect(base.run).toBe('node tool/core/gate/src/cli.ts gradle-inventory --repo base --out "$RUNNER_TEMP/gradle-base.json"');
    expect(head.run).toBe('node tool/core/gate/src/cli.ts gradle-inventory --repo repo --out "$RUNNER_TEMP/gradle-head.json"');
    expect(steps.indexOf(headCheckout)).toBeLessThan(steps.indexOf(base));
    expect(steps.indexOf(base)).toBeLessThan(steps.indexOf(head));
    expect(head.if).toBeUndefined();
    for (const step of [base, head]) expect(step["continue-on-error"]).toBeUndefined();
  });

  it("uploads both inventory files together, allowing either or both to be absent", () => {
    expect(steps.indexOf(head)).toBeLessThan(steps.indexOf(upload));
    expect(upload.with?.["path"]).toBe("${{ runner.temp }}/gradle-base.json\n${{ runner.temp }}/gradle-head.json\n");
    expect(upload.with?.["if-no-files-found"]).toBe("ignore");
    const download = workflow.jobs["supply-chain"]!.steps.find((step) => step.uses?.startsWith("actions/download-artifact@"))!;
    expect(download.with).toEqual({ pattern: "gradle-*", path: "${{ runner.temp }}/inventories", "merge-multiple": true });
  });

  it("selects comparison only for pull requests after event validation", () => {
    const compare = workflow.jobs["supply-chain"]!.steps.find((step) => step.name === "Gate dependency changes and findings")!;
    expect(compare.env?.["MODE"]).toBe("${{ github.event_name == 'pull_request' && 'compare' || 'scan' }}");
  });
});

describe("this repository's CI", () => {
  it("uses the local reusable gate without a bridge", () => {
    expect(Object.keys(ci.jobs)).toEqual(["gate", "check"]);
    expect(ci.jobs["gate"]!.uses).toBe("./.github/workflows/supply-chain.yml");
  });

  it("runs tests after a passing comparison even when cooldown failed, unless cancelled", () => {
    expect(ci.jobs["check"]!.needs).toBe("gate");
    expect(ci.jobs["check"]!.if).toBe("${{ !cancelled() && needs.gate.outputs.comparison-passed == 'true' && (github.event_name == 'pull_request' || github.event_name == 'push') }}");
  });
});
