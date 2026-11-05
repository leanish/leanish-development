import type { SecurityFix } from "@leanish/gate/candidates";
import { describe, expect, it } from "vitest";

import { assessmentOf, youngOf } from "../src/issue-assessment.ts";
import type { ObservedFinding } from "../src/issue-model.ts";
import { type ChangePlan, type SecurityUnit, selectWork } from "../src/plan.ts";

describe("youngOf", () => {
  const unit = (induced: Array<{ name: string; version: string }>): SecurityUnit => ({ kind: "routine", topic: "security", work: [{
    ecosystem: "Maven", name: "g:parent", from: "1.0", locations: [":runtimeClasspath"], targets: [], unfixable: [], malicious: false, severity: "HIGH",
    to: { version: "1.1", line: "1", aged: true, major: false, blockers: [] }, problem: undefined, induced,
  }] });
  const plan = { moves: [] } as unknown as ChangePlan;
  const now = new Date("2026-11-03T00:00:00Z");
  const dates: Record<string, string | undefined> = { "g:young": "2026-11-05T00:00:00.000Z", "g:aged": "2026-10-30T00:00:00.000Z", "g:undated": undefined };

  it("counts what a parent probe resolved as young while it's younger than the wait or undated, unless trusted", async () => {
    const young = await youngOf(unit([{ name: "g:young", version: "2" }, { name: "g:aged", version: "2" }, { name: "g:undated", version: "2" }, { name: "t:trusted", version: "2" }]), plan, {
      now, trusted: (pkg) => pkg.name.startsWith("t:"), eligibleAt: async (pkg) => dates[pkg.name],
    });
    expect(young).toEqual([
      { ecosystem: "Maven", name: "g:young", version: "2", eligibleAt: "2026-11-05T00:00:00.000Z" },
      { ecosystem: "Maven", name: "g:undated", version: "2", eligibleAt: "unknown" },
    ]);
  });

  it("reads a date it can't get as unknown rather than failing", async () => {
    const young = await youngOf(unit([{ name: "g:young", version: "2" }]), plan, { now, trusted: () => false, eligibleAt: async () => {
      throw new Error("registry 503");
    } });
    expect(young).toEqual([{ ecosystem: "Maven", name: "g:young", version: "2", eligibleAt: "unknown" }]);
  });

  it("keeps a rule-chosen young target young even when its date appears past the wait", async () => {
    const chosen = unit([]);
    const fix = chosen.work[0]!;
    const young = await youngOf({ ...chosen, work: [{ ...fix, to: { ...fix.to!, aged: false } }] }, plan, {
      now, trusted: () => false, eligibleAt: async () => "2026-10-30T00:00:00.000Z",
    });
    expect(young).toEqual([{ ecosystem: "Maven", name: "g:parent", version: "1.1", eligibleAt: "2026-10-30T00:00:00.000Z" }]);
  });
});

describe("assessmentOf", () => {
  const finding = (name: string, reviewed: boolean): ObservedFinding => ({ ecosystem: "npm", name, ids: [`GHSA-${name}`], versions: ["1.0.0"], reviewed, malicious: false, severity: "HIGH" });
  const fix = (overrides: Partial<SecurityFix>): SecurityFix => ({
    ecosystem: "npm", name: "lib", from: "1.0.0", locations: ["package-lock.json"], targets: [], unfixable: [], malicious: false, severity: "HIGH",
    to: undefined, problem: undefined, ...overrides,
  });
  // Through `selectWork`, as a run builds it: the blocked groups are the rule's own.
  const assess = (observations: ObservedFinding[], fixes: SecurityFix[]) => assessmentOf({
    sha: "a".repeat(40), complete: true, observations, excepted: [], units: [], blocked: selectWork(fixes).blocked, planningCauses: new Map(), trusted: () => false,
    eligibleAt: async () => undefined, now: new Date("2026-11-04T00:00:00Z"), prOf: () => undefined,
  });
  const report = fix({ problem: "lib@1.0.0 is affected by GHSA-lib, only in the project's repository advisories: no fix is proposed until a reviewed source lists it", unreviewedOnly: true });

  it("reports a package only its own repository advisories name, even when the rule listed it as not fixed", async () => {
    const { subjects } = await assess([finding("lib", false)], [report]);
    expect(subjects).toEqual([expect.objectContaining({ subject: { kind: "package", ecosystem: "npm", name: "lib" }, status: { kind: "informational" } })]);
  });

  it("keeps any other block of such a package, a strict pin's say", async () => {
    const pinned = fix({ from: "1.5.0", to: { version: "1.6.0", line: "1", aged: true, major: false, blockers: ["strictly pinned"] } });
    const { subjects } = await assess([finding("lib", false)], [report, pinned]);
    expect(subjects[0]!.status).toEqual(expect.objectContaining({ kind: "blocked", reason: "refused" }));
    expect(subjects[0]!.status).toEqual(expect.objectContaining({ detail: expect.stringContaining("lib@1.5.0: strictly pinned") }));
  });

  it("still says the rule refused a reviewed finding's every candidate", async () => {
    const { subjects } = await assess([finding("lib", true), finding("lib", false)], [fix({ problem: "no candidate passes" })]);
    expect(subjects[0]!.status).toEqual({ kind: "blocked", reason: "refused", detail: "lib@1.0.0: no candidate passes" });
  });
});
