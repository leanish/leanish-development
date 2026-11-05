import { describe, expect, it } from "vitest";

import type { GitHubPullRequest } from "@leanish/agent-runtime/types/clients";
import { FakeGitHub } from "@leanish/tool-runtime/test/fake-github";
import { FakeIssues } from "@leanish/tool-runtime/test/fake-issues";

import { EarlyPrs } from "../src/decision-issues.ts";
import type { IssueRecord, SubjectAssessment } from "../src/issue-model.ts";
import { foreignLink, type ReviewIssues, reviewDisposition } from "../src/issue-review.ts";
import { ISSUE_LABEL, ISSUE_WRITER } from "../src/issue-text.ts";
import type { ChangePlan } from "../src/plan.ts";

const SHA = "a".repeat(40);
const VITE = { ecosystem: "npm" as const, name: "vite", from: "8.3.1", to: "8.3.3" };
const LEFT_PAD = { ecosystem: "npm" as const, name: "left-pad", from: "1.0.0", to: "1.0.1" };
const planOf = (...moves: ReadonlyArray<typeof VITE>) => ({ kind: "routine", topic: "security", malware: false, packages: moves.map((move) => `npm|${move.name}`), moves }) as unknown as ChangePlan;
const FOREIGN = "it tracks #1, which isn't this decision's issue; close it by hand and run secure-it again";
const pullRequest = (line: string) => ({ number: 7, body: line, headSha: SHA, headRef: "secure-it/2026-11-01-security", isDraft: true, state: "open", merged: false }) as unknown as GitHubPullRequest;

function clientFor(...moves: ReadonlyArray<typeof VITE>): { issues: FakeIssues; client: ReviewIssues } {
  const issues = new FakeIssues();
  const subject: SubjectAssessment = { subject: { kind: "decision", moves }, findings: [], status: { kind: "eligible", trusted: [] } };
  const record: IssueRecord = { version: 1, subject: subject.subject, openedAt: SHA, findings: [], absences: [], attempts: [] };
  issues.issues.set(1, { number: 1, url: "https://github.com/acme/widget/issues/1", title: "secure-it", body: ISSUE_WRITER.render(subject, record, SHA).body, state: "open", stateReason: null, author: "leanish", labels: [ISSUE_LABEL] });
  return { issues, client: { issues, github: new FakeGitHub(), repo: "acme/widget", clean: (text) => text, ours: () => true, now: new Date("2026-11-03T00:00:00Z"), trusted: () => false, retire: async () => "closed", eligibleAt: async () => undefined } };
}

describe("a PR's link to an issue", () => {
  it("holds for its whole decision's issue", async () => {
    const { client } = clientFor(VITE, LEFT_PAD);
    expect(await foreignLink(client, pullRequest("Tracks #1."), planOf(VITE, LEFT_PAD))).toBeUndefined();
  });

  it("holds for the plan a retry reduced, still under its whole decision's issue, which gets no notices from it", async () => {
    const { issues, client } = clientFor(VITE, LEFT_PAD);
    const reduced = planOf(VITE);
    expect(await foreignLink(client, pullRequest("Tracks #1."), reduced)).toBeUndefined();
    expect(await reviewDisposition(client, pullRequest("Tracks #1."), reduced, new EarlyPrs(client))).toEqual({ kind: "proceed", permit: { early: false, young: [] } });
    expect(issues.calls).toEqual([]);
  });

  it("doesn't hold for a plan with a move its issue's decision lacks, or that moves to another version", async () => {
    const { client } = clientFor(VITE);
    expect(await foreignLink(client, pullRequest("Tracks #1."), planOf(VITE, LEFT_PAD))).toEqual({ kind: "leave", reason: FOREIGN });
    expect(await foreignLink(client, pullRequest("Tracks #1."), planOf({ ...VITE, to: "8.3.4" }))).toEqual({ kind: "leave", reason: FOREIGN });
  });

  it("doesn't hold for an issue opened by another login", async () => {
    const { issues, client } = clientFor(VITE);
    issues.issues.set(1, { ...issues.issues.get(1)!, author: "someone" });
    expect(await foreignLink(client, pullRequest("Tracks #1."), planOf(VITE))).toEqual({ kind: "leave", reason: FOREIGN });
  });

  it("asks nothing of a PR with no `Tracks` line", async () => {
    const { issues, client } = clientFor(VITE);
    issues.gone.set("getIssue", 500);
    expect(await foreignLink(client, pullRequest("No line."), planOf(VITE))).toBeUndefined();
  });

  it("doesn't let a PR taken early through on an issue that only covers it: it's never reduced", async () => {
    const { client } = clientFor(VITE, LEFT_PAD);
    const taken = pullRequest("Tracks #1, taken early.");
    expect(await foreignLink(client, taken, planOf(VITE))).toEqual({ kind: "leave", reason: FOREIGN });
    expect(await reviewDisposition(client, taken, planOf(VITE), new EarlyPrs(client))).toEqual({ kind: "leave", reason: FOREIGN });
    expect(await foreignLink(client, taken, planOf(VITE, LEFT_PAD))).toBeUndefined();
  });

  it("lets a read that fails for another reason go through, so it's that PR's error", async () => {
    const { issues, client } = clientFor(VITE);
    issues.gone.set("getIssue", 500);
    await expect(foreignLink(client, pullRequest("Tracks #1."), planOf(VITE))).rejects.toMatchObject({ status: 500 });
  });
});
