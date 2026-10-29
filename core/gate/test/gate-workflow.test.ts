/** The reusable gate's event handling: PRs are compared when they change; scheduled runs scan the default branch only. */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { REPORT_SCHEMA_VERSION } from "../src/report.ts";

interface GateStep {
  readonly id?: string;
  readonly name?: string;
  readonly if?: string;
  readonly run?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly with?: Readonly<Record<string, string>>;
  readonly "continue-on-error"?: boolean;
}

interface GateWorkflow {
  readonly on: { readonly workflow_call: { readonly inputs: Readonly<Record<string, unknown>> } };
  readonly jobs: Readonly<Record<string, { readonly permissions?: unknown; readonly needs?: ReadonlyArray<string>; readonly if?: string; readonly steps: ReadonlyArray<GateStep> }>>;
}

const workflow = parse(readFileSync(new URL("../../../.github/workflows/supply-chain.yml", import.meta.url), "utf8")) as GateWorkflow;
const mode = workflow.jobs["plan"]!.steps.find((step) => step.id === "mode")!.run!;

function plan(event: string, ref: string): { status: number | null; outputs: string } {
  const dir = mkdtempSync(join(tmpdir(), "gate-plan-"));
  try {
    const output = join(dir, "output");
    const command = spawnSync("/bin/bash", ["-e", "-c", mode], {
      env: { EVENT: event, REF: ref, DEFAULT_REF: "refs/heads/main", GITHUB_OUTPUT: output },
      encoding: "utf8",
    });
    expect(command.error).toBeUndefined();
    let outputs = "";
    try {
      outputs = readFileSync(output, "utf8");
    } catch {
      // No outputs: the step failed before writing them.
    }
    return { status: command.status, outputs };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the gate's plan", () => {
  it("compares a pull request's base and head", () => {
    expect(plan("pull_request", "refs/pull/7/merge")).toEqual({ status: 0, outputs: 'mode=compare\nsides=["base","head"]\n' });
  });

  it.each(["push", "schedule", "workflow_dispatch"])("scans the default branch on %s", (event) => {
    expect(plan(event, "refs/heads/main")).toEqual({ status: 0, outputs: 'mode=scan\nsides=["head"]\n' });
  });

  it.each(["push", "schedule", "workflow_dispatch"])("refuses another branch on %s", (event) => {
    expect(plan(event, "refs/heads/feature")).toEqual({ status: 1, outputs: "" });
  });

  it("refuses events it doesn't handle", () => {
    expect(plan("issue_comment", "refs/heads/main").status).toBe(1);
  });
});

describe("the gate's jobs", () => {
  it("never rescan open PRs, so none writes statuses", () => {
    expect(Object.keys(workflow.jobs)).toEqual(["plan", "inventory", "supply-chain", "cooldown"]);
    expect(Object.keys(workflow.on.workflow_call.inputs)).toEqual(["java-version", "java-distribution", "node-version"]);
    for (const job of Object.values(workflow.jobs)) expect(JSON.stringify(job.permissions ?? {})).not.toContain("statuses");
  });
});

describe("the reusable workflow's fail-closed guards", () => {
  const comparison = workflow.jobs["supply-chain"]!;
  const cooldown = workflow.jobs["cooldown"]!;
  const inventoryGuard = comparison.steps[0]!;
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

  it("runs the required jobs even when their prerequisites fail", () => {
    expect(comparison.needs).toEqual(["plan", "inventory"]);
    expect(comparison.if).toBe("always() && needs.plan.result == 'success'");
    expect(cooldown.needs).toEqual(["plan", "supply-chain"]);
    expect(cooldown.if).toBe("always() && github.event_name == 'pull_request'");
    expect(inventoryGuard.name).toBe("Require the inventories");
    expect(inventoryGuard.env).toEqual({ INVENTORY: "${{ needs.inventory.result }}" });
    expect(comparisonGuard.name).toBe("Require a passing comparison");
    expect(comparisonGuard.env).toEqual({ PLAN: "${{ needs.plan.result }}", COMPARISON: "${{ needs.supply-chain.result }}" });
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

  it.each(["failure", "cancelled", "skipped", ""])("fails the comparison when inventory is %s", (inventory) => {
    expect(run(inventoryGuard, { INVENTORY: inventory }).status).toBe(1);
  });

  it("accepts successful inventories", () => {
    expect(run(inventoryGuard, { INVENTORY: "success" }).status).toBe(0);
  });

  it.each([
    ["success", "failure"], ["success", "cancelled"], ["success", "skipped"], ["success", ""],
    ["failure", "success"], ["cancelled", "success"], ["skipped", "success"], ["", "success"],
  ])("fails cooldown when plan is %s and comparison is %s", (plan, comparison) => {
    expect(run(comparisonGuard, { PLAN: plan, COMPARISON: comparison }).status).toBe(1);
  });

  it("accepts a passing plan and comparison", () => {
    expect(run(comparisonGuard, { PLAN: "success", COMPARISON: "success" }).status).toBe(0);
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
