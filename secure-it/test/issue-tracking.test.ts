import { describe, expect, it } from "vitest";

import { FakeIssues } from "@leanish/tool-runtime/test/fake-issues";

import { attemptBranchAllowed, attemptBranches, issueDisposition } from "../src/issue-tracking.ts";
import { syncIssues } from "../src/issue-sync.ts";
import type { ChangePlan } from "../src/plan.ts";

const plan = { kind: "routine", topic: "security", malware: false, packages: ["npm|lib"], moves: [{ ecosystem: "npm", name: "lib", from: "1.0.0", to: "1.0.1" }] } as unknown as ChangePlan;
const subject = {
  subject: { kind: "decision" as const, moves: [{ ecosystem: "npm" as const, name: "lib", from: "1.0.0", to: "1.0.1" }] },
  findings: [{ ecosystem: "npm" as const, name: "lib", ids: ["GHSA-1"], versions: ["1.0.0"], reviewed: true, malicious: false, severity: "HIGH" }],
  status: { kind: "eligible" as const, trusted: [] },
};
const assessment = { sha: "a".repeat(40), at: "2026-11-03T00:00:00.000Z", complete: true, subjects: [subject] };
const clientOf = (issues: FakeIssues) => ({ issues, repo: "acme/widget", clean: (body: string) => body, now: new Date("2026-11-03T00:00:00Z") });

describe("issueDisposition", () => {
  it("runs nothing while the issues haven't settled, even for a decision past the wait", async () => {
    const tracking = { assessment, sync: { tracked: [], unreadable: [], notes: [], settled: false } };
    expect(await issueDisposition(tracking, plan, clientOf(new FakeIssues()), () => "unused")).toEqual({ kind: "defer", reason: "the issues didn't settle this run" });
  });

  it("lets a decision past the wait go ahead through its open issue", async () => {
    const issues = new FakeIssues();
    const sync = await syncIssues({ issues, repo: "acme/widget", clean: (body: string) => body }, assessment);
    expect(await issueDisposition({ assessment, sync }, plan, clientOf(issues), () => "unused")).toEqual({ kind: "proceed", tracked: { issue: 1, young: [] } });
  });

  it("reads the issue again before anything runs: one a person closed after the sync read it stops the decision", async () => {
    const issues = new FakeIssues();
    const sync = await syncIssues({ issues, repo: "acme/widget", clean: (body: string) => body }, assessment);
    issues.setState(1, "closed", "owner");
    expect(await issueDisposition({ assessment, sync }, plan, clientOf(issues), () => "unused")).toEqual({ kind: "defer", reason: "its issue #1 is no longer open as secure-it's" });
  });
});

describe("attemptBranchAllowed", () => {
  it("allows only the branch the grant reserved, on any day, or this run's branch for the attempt", () => {
    expect(attemptBranchAllowed({ branch: "secure-it/2026-10-07-take-early-7", grantEventId: 7 }, "secure-it/2026-11-04-take-early-7")).toBe(true);
    expect(attemptBranchAllowed({ branch: "secure-it/2026-10-07-vite", grantEventId: 7 }, "secure-it/2026-10-07-vite")).toBe(true);
    expect(attemptBranchAllowed({ branch: "secure-it/2026-10-07-take-early-8", grantEventId: 7 }, "secure-it/2026-11-04-take-early-7")).toBe(false);
    expect(attemptBranchAllowed({ branch: "main", grantEventId: 7 }, "secure-it/2026-11-04-take-early-7")).toBe(false);
    expect(attemptBranchAllowed({ branch: "secure-it/2026-10-07-take-early-70", grantEventId: 7 }, "secure-it/2026-11-04-take-early-7")).toBe(false);
  });
});

describe("attemptBranches", () => {
  it("gives a grant's later asks (a retry names no branch) the reused PR branch its unit named", () => {
    const branches = attemptBranches((id) => `secure-it/2026-11-04-take-early-${id}`);
    expect(branches(7)).toBe("secure-it/2026-11-04-take-early-7");
    expect(branches(7, "secure-it/2026-11-03-security-cooldown-lib")).toBe("secure-it/2026-11-03-security-cooldown-lib");
    expect(branches(7)).toBe("secure-it/2026-11-03-security-cooldown-lib");
    expect(attemptBranchAllowed({ branch: "secure-it/2026-11-03-security-cooldown-lib", grantEventId: 7 }, branches(7))).toBe(true);
    expect(branches(8)).toBe("secure-it/2026-11-04-take-early-8");
  });
});

describe("issueDisposition with duplicates", () => {
  it("runs nothing while two open issues track the same decision", async () => {
    const issues = new FakeIssues();
    const sync = await syncIssues({ issues, repo: "acme/widget", clean: (body: string) => body }, assessment);
    const twin = { ...sync.tracked[0]!, number: 2 };
    const tracking = { assessment, sync: { ...sync, tracked: [...sync.tracked, twin] } };
    expect(await issueDisposition(tracking, plan, clientOf(issues), () => "unused")).toEqual({ kind: "defer", reason: "#1 and #2 both track this decision; a person closes one" });
  });
});
