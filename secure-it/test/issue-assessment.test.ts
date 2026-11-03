import { describe, expect, it } from "vitest";

import { youngOf } from "../src/issue-assessment.ts";
import type { ChangePlan, SecurityUnit } from "../src/plan.ts";

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
});
