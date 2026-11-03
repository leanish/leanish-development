import { describe, expect, it } from "vitest";

import { FakeIssues } from "@leanish/tool-runtime/test/fake-issues";

import { issueDisposition } from "../src/issue-tracking.ts";
import type { ChangePlan } from "../src/plan.ts";

describe("issueDisposition", () => {
  it("runs nothing while the issues haven't settled, even for a decision past the wait", async () => {
    const plan = { kind: "routine", topic: "security", malware: false, packages: ["npm|lib"], moves: [{ ecosystem: "npm", name: "lib", from: "1.0.0", to: "1.0.1" }] } as unknown as ChangePlan;
    const subject = { subject: { kind: "decision" as const, moves: [{ ecosystem: "npm" as const, name: "lib", from: "1.0.0", to: "1.0.1" }] }, findings: [], status: { kind: "eligible" as const, trusted: [] } };
    const tracking = { assessment: { sha: "a".repeat(40), at: "2026-11-03T00:00:00.000Z", complete: true, subjects: [subject] }, sync: { tracked: [], unreadable: [], notes: [], settled: false } };
    const client = { issues: new FakeIssues(), repo: "acme/widget", clean: (body: string) => body, now: new Date("2026-11-03T00:00:00Z") };
    expect(await issueDisposition(tracking, plan, client, () => "unused")).toEqual({ kind: "defer", reason: "the issues didn't settle this run" });
  });
});
