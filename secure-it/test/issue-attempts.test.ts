import { describe, expect, it } from "vitest";

import { GitHubApiError } from "@leanish/agent-runtime/github/github-client";
import { FakeGitHub } from "@leanish/tool-runtime/test/fake-github";
import { FakeIssues } from "@leanish/tool-runtime/test/fake-issues";

import { settleAttempt, showPullRequest } from "../src/issue-attempts.ts";
import type { Assessment, IssueRecord, SubjectAssessment } from "../src/issue-model.ts";
import { postNotice } from "../src/issue-notices.ts";
import { ISSUE_LABEL, recordOf } from "../src/issue-text.ts";
import { sealFor, TEST_TRUST, writerFor } from "./issue-seal.ts";

/** Issue records as the tool signs them for this file's repository. */
const ISSUE_WRITER = writerFor("acme/widget");
const SEAL = sealFor("acme/widget");

const SHA = "a".repeat(40);
const moves = [{ ecosystem: "npm" as const, name: "vite", from: "8.3.1", to: "8.3.3" }];
const decision = (pr?: number): SubjectAssessment => ({
  subject: { kind: "decision", moves },
  findings: [{ ecosystem: "npm", name: "vite", ids: ["GHSA-1"], versions: ["8.3.1"], reviewed: true, malicious: false, severity: "HIGH" }],
  status: { kind: "eligible", trusted: [], ...(pr === undefined ? {} : { pr: { number: pr, url: `https://github.com/acme/widget/pull/${pr}` } }) },
});
const assessed = (subject: SubjectAssessment): Assessment => ({ sha: SHA, at: "2026-11-03T00:00:00.000Z", complete: true, subjects: [subject] });

function issueWith(attemptPr: number, shown: SubjectAssessment): { issues: FakeIssues; client: Parameters<typeof settleAttempt>[0] } {
  const issues = new FakeIssues();
  const record: IssueRecord = {
    version: 1, subject: shown.subject, openedAt: SHA, findings: [{ ecosystem: "npm", name: "vite", ids: ["GHSA-1"] }], absences: [],
    attempts: [{ id: "a1", grantEventId: 5, branch: "secure-it/take-early-5", startedAt: "2026-11-01T00:00:00.000Z", pr: attemptPr }],
  };
  const body = ISSUE_WRITER.render(shown, record, SHA).body;
  issues.issues.set(1, { number: 1, url: "https://github.com/acme/widget/issues/1", title: "secure-it: vite", body, state: "open", stateReason: null, author: "leanish", labels: [ISSUE_LABEL] });
  return { issues, client: { issues, github: new FakeGitHub(), repo: "acme/widget", trust: TEST_TRUST, clean: (text: string) => text, ours: () => true } };
}

describe("records someone else wrote", () => {
  const forged = (issues: FakeIssues) => issues.issues.set(1, { ...issues.issues.get(1)!, body: issues.issues.get(1)!.body.replace(/record-sig \S{43}/, `record-sig ${"A".repeat(43)}`) });

  it("settles no attempt on a record that no longer verifies, writing nothing", async () => {
    const { issues, client } = issueWith(42, decision(42));
    forged(issues);
    issues.calls.length = 0;
    await expect(settleAttempt(client, 1, "a1", { outcome: "pr-closed" }, assessed(decision(42)))).rejects.toThrow("record can't be read");
    expect(issues.calls.filter((call) => call.startsWith("updateIssue"))).toEqual([]);
  });

  it("shows no PR on an issue whose record no longer verifies", async () => {
    const { issues, client } = issueWith(42, decision());
    forged(issues);
    const before = issues.issues.get(1)!.body;
    await showPullRequest(client, 1, { number: 9, url: "https://github.com/acme/widget/pull/9" }, assessed(decision()));
    expect(issues.issues.get(1)!.body).toBe(before);
  });
});

describe("settleAttempt", () => {
  it("renders an issue without its attempt's PR once that PR closed, from an assessment read while it was open", async () => {
    // Recovery's race: the run's assessment listed #42 open as the decision's PR, and #42 closed before recovery read it.
    const { issues, client } = issueWith(42, decision(42));
    await settleAttempt(client, 1, "a1", { outcome: "pr-closed" }, assessed(decision(42)));
    const body = issues.issues.get(1)!.body;
    expect(body).not.toContain("**In progress:** #42.");
    expect(body).toContain("**Ready.**");
    expect(recordOf(body, SEAL)!.attempts).toMatchObject([{ pr: 42, outcome: "pr-closed" }]);
  });

  it("keeps another PR the assessment names, and an attempt that didn't close its PR", async () => {
    const other = issueWith(42, decision(43));
    await settleAttempt(other.client, 1, "a1", { outcome: "pr-closed" }, assessed(decision(43)));
    expect(other.issues.issues.get(1)!.body).toContain("**In progress:** #43.");
    const merged = issueWith(42, decision(42));
    await settleAttempt(merged.client, 1, "a1", { outcome: "pr-merged" }, assessed(decision(42)));
    expect(merged.issues.issues.get(1)!.body).toContain("**In progress:** #42.");
  });

  it("writes an attempt's end through the record alone when its text can't render, keeping the visible text", async () => {
    const { issues, client } = issueWith(42, decision());
    const before = issues.issues.get(1)!.body;
    let calls = 0;
    const failingOnce = { ...client, clean: (body: string) => {
      if (calls++ === 0) throw new Error("too large");
      return body;
    } };
    await settleAttempt(failingOnce, 1, "a1", { outcome: "failed" }, assessed(decision()));
    const after = issues.issues.get(1)!.body;
    expect(recordOf(after, SEAL)!.attempts).toMatchObject([{ id: "a1", outcome: "failed" }]);
    expect(after.startsWith(before.split("<!--")[0]!)).toBe(true);
  });
});

describe("the Issues-permission hint", () => {
  const HINT = "check that the write PAT has Issues: read and write";

  it("says what to check on an attempt's write, a shown PR's and a notice's, as the sync's do", async () => {
    const written = issueWith(42, decision());
    written.issues.forbidden.add("updateIssue");
    await expect(settleAttempt(written.client, 1, "a1", { outcome: "failed" }, undefined)).rejects.toThrow(HINT);
    await expect(showPullRequest(written.client, 1, { number: 43, url: "https://github.com/acme/widget/pull/43" }, assessed(decision()))).rejects.toThrow(HINT);
    const noticed = issueWith(42, decision());
    noticed.issues.forbidden.add("createComment");
    await expect(postNotice(noticed.client, 1, "note", "text")).rejects.toThrow(HINT);
  });

  it("keeps a rate limit a rate limit", async () => {
    const { issues, client } = issueWith(42, decision());
    issues.updateIssue = async () => {
      throw new GitHubApiError("updateIssue", "rate limited", 403);
    };
    await expect(settleAttempt(client, 1, "a1", { outcome: "failed" }, undefined)).rejects.toMatchObject({ reason: "rate limited" });
  });
});
