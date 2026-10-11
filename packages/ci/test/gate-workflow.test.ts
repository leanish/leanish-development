/** The reusable gate's event handling: PRs are compared when they change; scheduled runs scan the default branch only. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface GateWorkflow {
  readonly on: { readonly workflow_call: { readonly inputs: Readonly<Record<string, unknown>> } };
  readonly jobs: Readonly<Record<string, { readonly permissions?: unknown; readonly steps: ReadonlyArray<{ readonly id?: string; readonly run?: string }> }>>;
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
