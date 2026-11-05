import { describe, expect, it } from "vitest";

import { GitHubApiError } from "@leanish/agent-runtime/github/github-client";
import type { GitHubPullRequest } from "@leanish/agent-runtime/types/clients";
import { FakeGitHub } from "@leanish/tool-runtime/test/fake-github";
import { FakeIssues } from "@leanish/tool-runtime/test/fake-issues";

import { EarlyPrs } from "../src/decision-issues.ts";
import { endAttempt, recoverAttempts, settleAttempt, showPullRequest } from "../src/issue-attempts.ts";
import type { Assessment, IssueRecord, SubjectAssessment } from "../src/issue-model.ts";
import { postNotice } from "../src/issue-notices.ts";
import { type ReviewIssues, reviewDisposition } from "../src/issue-review.ts";
import { syncIssues } from "../src/issue-sync.ts";
import { ISSUE_LABEL, ISSUE_WRITER, recordOf, TAKE_EARLY_LABEL } from "../src/issue-text.ts";
import { inactiveLabelNotices, issueDisposition } from "../src/issue-tracking.ts";
import type { ChangePlan } from "../src/plan.ts";

const REPO = "acme/widget";
const SHA = "a".repeat(40);
const moves = [{ ecosystem: "npm" as const, name: "lib", from: "1.0.0", to: "1.0.1" }];
const plan = { kind: "routine", topic: "security", malware: false, packages: ["npm|lib"], moves } as unknown as ChangePlan;
const findings = [{ ecosystem: "npm" as const, name: "lib", ids: ["GHSA-1"], versions: ["1.0.0"], reviewed: true, malicious: false, severity: "HIGH" }];
const eligible: SubjectAssessment = { subject: { kind: "decision", moves }, findings, status: { kind: "eligible", trusted: [] } };
const assessed = (subject: SubjectAssessment): Assessment => ({ sha: SHA, at: "2026-11-03T00:00:00.000Z", complete: true, subjects: [subject], excepted: [] });
const RUNNING = { id: "a1", grantEventId: 5, branch: "secure-it/2026-11-01-take-early-5", startedAt: "2026-11-01T00:00:00.000Z", pr: 7 };
const YOUNG = { ecosystem: "npm" as const, name: "lib", version: "1.0.1" };
const GONE = [301, 404, 410];
const GRANT = { labelEventId: 5, reasonCommentId: 9, actor: "owner", at: "2026-11-01T00:00:00Z", young: [YOUNG] };

function withIssue(record: Partial<IssueRecord> = {}): { issues: FakeIssues; github: FakeGitHub; client: ReviewIssues } {
  const issues = new FakeIssues();
  const github = new FakeGitHub();
  const full: IssueRecord = { version: 1, subject: eligible.subject, openedAt: SHA, findings: [{ ecosystem: "npm", name: "lib", ids: ["GHSA-1"] }], absences: [], attempts: [RUNNING], ...record };
  issues.issues.set(1, { number: 1, url: "https://github.com/acme/widget/issues/1", title: "secure-it: lib", body: ISSUE_WRITER.render(eligible, full, SHA).body, state: "open", stateReason: null, author: "leanish", labels: [ISSUE_LABEL] });
  const client: ReviewIssues = {
    issues, github, repo: REPO, clean: (text) => text, ours: () => true, now: new Date("2026-11-03T00:00:00Z"), trusted: () => false,
    retire: async () => "closed", eligibleAt: async () => "2026-12-01T00:00:00.000Z",
  };
  return { issues, github, client };
}

const pullRequest = (body: string) => ({ number: 7, body, headSha: SHA, headRef: RUNNING.branch, draft: true, state: "open", merged: false }) as unknown as GitHubPullRequest;
const SHOWN = { number: 7, url: "https://github.com/acme/widget/pull/7" };

describe("an issue gone, on the lifecycle's reads and writes", () => {
  it.each(GONE)("has nothing to settle when reading it answers %d", async (status) => {
    const { issues, client } = withIssue();
    issues.gone.set("getIssue", status);
    expect(await settleAttempt(client, 1, "a1", { outcome: "pr-closed" }, undefined)).toBe(false);
    expect(issues.calls).toEqual([]);
  });

  it.each([301, 410])("stops settling, returning no label, when it goes between the read and the write with %d", async (status) => {
    const { issues, client } = withIssue();
    issues.gone.set("updateIssue", status);
    issues.gone.set("listEvents", 500);
    expect(await settleAttempt(client, 1, "a1", { outcome: "pr-closed" }, undefined)).toBe(false);
  });

  it("doesn't take a 404 on a write, right after a read that worked, for gone: it may be the token", async () => {
    const { issues, client } = withIssue();
    issues.gone.set("updateIssue", 404);
    issues.gone.set("createComment", 404);
    await expect(settleAttempt(client, 1, "a1", { outcome: "pr-closed" }, undefined)).rejects.toMatchObject({ status: 404 });
    await expect(showPullRequest(client, 1, SHOWN, assessed(eligible))).rejects.toMatchObject({ status: 404 });
    await expect(postNotice(client, 1, "note", "text")).rejects.toMatchObject({ status: 404 });
  });

  it("doesn't take a server error or a rate limit for gone", async () => {
    const { issues, client } = withIssue();
    issues.gone.set("getIssue", 500);
    await expect(settleAttempt(client, 1, "a1", { outcome: "pr-closed" }, undefined)).rejects.toBeInstanceOf(GitHubApiError);
    await expect(endAttempt(client, 1, "a1", assessed(eligible))).rejects.toBeInstanceOf(GitHubApiError);
    await expect(showPullRequest(client, 1, SHOWN, assessed(eligible))).rejects.toBeInstanceOf(GitHubApiError);
    issues.gone.delete("getIssue");
    issues.gone.set("updateIssue", 429);
    await expect(settleAttempt(client, 1, "a1", { outcome: "pr-closed" }, undefined)).rejects.toBeInstanceOf(GitHubApiError);
  });

  it("ends no attempt and looks for no PR on an issue gone", async () => {
    const { issues, github, client } = withIssue({ attempts: [{ ...RUNNING, pr: undefined } as never] });
    issues.gone.set("getIssue", 410);
    await endAttempt(client, 1, "a1", assessed(eligible));
    expect(issues.calls).toEqual([]);
    expect(github.calls ?? []).not.toContainEqual(expect.stringContaining("findPullRequests"));
  });

  it("shows no PR on an issue gone, at the read or at the write", async () => {
    const read = withIssue();
    read.issues.gone.set("getIssue", 410);
    await showPullRequest(read.client, 1, SHOWN, assessed(eligible));
    expect(read.issues.calls).toEqual([]);
    const write = withIssue();
    write.issues.gone.set("updateIssue", 301);
    await expect(showPullRequest(write.client, 1, SHOWN, assessed(eligible))).resolves.toBeUndefined();
  });

  it("notes no recovered attempt on an issue gone since the sync read it", async () => {
    const { issues, client } = withIssue({ attempts: [{ ...RUNNING, pr: undefined } as never] });
    const record = recordOf(issues.issues.get(1)!.body)!;
    issues.gone.set("getIssue", 410);
    const tracked = [{ number: 1, state: "open" as const, body: "", record, reopened: false, labels: [ISSUE_LABEL] }];
    expect(await recoverAttempts(client, tracked, assessed(eligible))).toEqual([]);
  });

  it("says a recovered attempt's label couldn't come off when GitHub won't say, and returns one on an issue gone quietly", async () => {
    const { issues, client } = withIssue({ attempts: [{ ...RUNNING, outcome: "pr-closed" }], grant: GRANT });
    const record = recordOf(issues.issues.get(1)!.body)!;
    const tracked = [{ number: 1, state: "open" as const, body: "", record, reopened: false, labels: [ISSUE_LABEL, TAKE_EARLY_LABEL] }];
    issues.gone.set("listEvents", 410);
    expect(await recoverAttempts(client, tracked, assessed(eligible))).toEqual([]);
    issues.gone.set("listEvents", 500);
    expect(await recoverAttempts(client, tracked, assessed(eligible))).toEqual([expect.stringContaining("couldn't be removed yet")]);
  });

  it.each(["listComments", "createComment"])("posts no notice on an issue gone at %s, and tries again if it comes back", async (operation) => {
    const { issues, client } = withIssue();
    issues.gone.set(operation, 410);
    await postNotice(client, 1, "note", "text");
    expect(issues.comments.get(1)).toBeUndefined();
    issues.gone.delete(operation);
    await postNotice(client, 1, "note", "text");
    expect(issues.comments.get(1)).toHaveLength(1);
  });
});

describe("execution on an issue gone", () => {
  const syncedEligible = async () => {
    const issues = new FakeIssues();
    const clean = (body: string) => body;
    const sync = await syncIssues({ issues, repo: REPO, clean }, assessed(eligible));
    return { issues, tracking: { assessment: assessed(eligible), sync }, client: { issues, repo: REPO, clean, now: new Date("2026-11-03T00:00:00Z") } };
  };
  const waiting: SubjectAssessment = { subject: eligible.subject, findings, status: { kind: "waiting", young: [{ ...YOUNG, eligibleAt: "2026-12-01T00:00:00.000Z" }] } };
  const syncedWaiting = async () => {
    const issues = new FakeIssues();
    const clean = (body: string) => body;
    // The label comes after the text showed the version, past the margin the sync allows.
    const sync0 = await syncIssues({ issues, repo: REPO, clean, clock: () => new Date("2026-11-03T07:00:00Z") }, assessed(waiting));
    issues.permissions.set("owner", "admin");
    issues.comment(sync0.tracked[0]!.number, "owner", `${TAKE_EARLY_LABEL}: an urgent fix`);
    issues.label(sync0.tracked[0]!.number, "owner", TAKE_EARLY_LABEL);
    const sync = await syncIssues({ issues, repo: REPO, clean, clock: () => new Date("2026-11-03T07:00:00Z") }, assessed(waiting));
    return { issues, tracking: { assessment: assessed(waiting), sync }, client: { issues, repo: REPO, clean, now: new Date("2026-11-03T09:00:00Z") } };
  };

  it.each(GONE)("defers when the fresh read answers %d", async (status) => {
    const { issues, tracking, client } = await syncedEligible();
    issues.gone.set("getIssue", status);
    expect(await issueDisposition(tracking, plan, client, () => "unused")).toEqual({ kind: "defer", reason: "its issue #1 is gone" });
  });

  it("starts an early attempt only once it's recorded, deferring when the issue goes at that write", async () => {
    const started = await syncedWaiting();
    expect(await issueDisposition(started.tracking, plan, started.client, () => "secure-it/take-early")).toMatchObject({ kind: "proceed", tracked: { attempt: { branch: "secure-it/take-early" } } });
    const gone = await syncedWaiting();
    gone.issues.gone.set("updateIssue", 410);
    expect(await issueDisposition(gone.tracking, plan, gone.client, () => "secure-it/take-early")).toEqual({ kind: "defer", reason: "its issue #1 is gone" });
  });

  it("defers when the issue goes while its grant is read", async () => {
    const { issues, tracking, client } = await syncedWaiting();
    issues.gone.set("listEvents", 410);
    expect(await issueDisposition(tracking, plan, client, () => "unused")).toEqual({ kind: "defer", reason: "its issue #1 is gone" });
  });

  it("says nothing about a label on an issue gone", async () => {
    const issues = new FakeIssues();
    const clean = (body: string) => body;
    const sync = await syncIssues({ issues, repo: REPO, clean }, assessed(eligible));
    issues.gone.set("listEvents", 410);
    const record = sync.tracked[0]!;
    const labelled = { ...record, state: "closed" as const, labels: [ISSUE_LABEL, TAKE_EARLY_LABEL] };
    await expect(inactiveLabelNotices({ issues, repo: REPO, clean }, { assessment: assessed(eligible), sync: { ...sync, tracked: [labelled] } })).resolves.toBeUndefined();
    expect(issues.comments.get(1)).toBeUndefined();
  });
});

describe("a review with its issue gone", () => {
  const taken = pullRequest("Tracks #1, taken early.");
  const ordinary = pullRequest("Tracks #1.");
  const heldPlan = { ...plan, cooldown: [] } as unknown as ChangePlan;
  const early = (client: ReviewIssues) => new EarlyPrs(client);

  it.each([301, 410])("leaves a PR taken early when reading its issue answers %d, and writes nothing", async (status) => {
    const { issues, client } = withIssue();
    issues.gone.set("getIssue", status);
    expect(await reviewDisposition(client, taken, heldPlan, early(client))).toEqual({ kind: "leave", reason: "it tracks #1, which isn't this decision's issue" });
    expect(issues.calls).toEqual([]);
  });

  it("lets an ordinary PR go on when its issue is gone", async () => {
    const { issues, client } = withIssue();
    issues.gone.set("getIssue", 410);
    expect(await reviewDisposition(client, ordinary, heldPlan, early(client))).toEqual({ kind: "proceed", permit: { early: false, young: [] } });
  });

  it("leaves a PR taken early when its issue goes while the grant is read, posting nothing", async () => {
    const { issues, client } = withIssue({ grant: GRANT });
    issues.gone.set("listEvents", 410);
    issues.gone.set("listComments", 410);
    expect(await reviewDisposition(client, ordinary, heldPlan, early(client))).toEqual({ kind: "leave", reason: "its issue #1 is gone" });
    expect(issues.calls).toEqual([]);
  });
});

describe("the Issues-permission hint", () => {
  const HINT = "check that the write PAT has Issues: read and write";

  it("says what to check on every lifecycle write, as the sync's do", async () => {
    const settle = withIssue();
    settle.issues.forbidden.add("updateIssue");
    await expect(settleAttempt(settle.client, 1, "a1", { pr: 7 }, undefined)).rejects.toThrow(HINT);
    await expect(showPullRequest(settle.client, 1, SHOWN, assessed(eligible))).rejects.toThrow(HINT);
    const notice = withIssue();
    notice.issues.forbidden.add("createComment");
    await expect(postNotice(notice.client, 1, "note", "text")).rejects.toThrow(HINT);
  });

  it("reaches a recovered label's note, and doesn't stop an attempt's end being recorded", async () => {
    const closing = withIssue({ grant: GRANT });
    closing.issues.forbidden.add("removeLabel");
    closing.issues.events.set(1, [{ id: 5, event: "labeled", actor: "owner", label: TAKE_EARLY_LABEL, createdAt: "2026-11-01T00:00:00Z" }]);
    expect(await settleAttempt(closing.client, 1, "a1", { outcome: "pr-closed" }, undefined)).toBe(true);
    const record = recordOf(closing.issues.issues.get(1)!.body)!;
    expect(record.attempts).toMatchObject([{ outcome: "pr-closed" }]);
    const tracked = [{ number: 1, state: "open" as const, body: "", record, reopened: false, labels: [ISSUE_LABEL, TAKE_EARLY_LABEL] }];
    expect(await recoverAttempts(closing.client, tracked, assessed(eligible))).toEqual([expect.stringContaining(HINT)]);
  });

  it("keeps a rate limit a rate limit, and doesn't call a 403 of another kind a permission", async () => {
    const { issues, client } = withIssue();
    issues.updateIssue = async () => {
      throw new GitHubApiError("updateIssue", "rate limited", 403);
    };
    await expect(settleAttempt(client, 1, "a1", { pr: 7 }, undefined)).rejects.toMatchObject({ reason: "rate limited" });
  });
});

describe("the label boundary when showing a new PR", () => {
  it("shows it on an open issue with the tool's label, in any casing", async () => {
    const { issues, client } = withIssue();
    issues.issues.set(1, { ...issues.issues.get(1)!, labels: [ISSUE_LABEL.toUpperCase()] });
    await showPullRequest(client, 1, SHOWN, assessed(eligible));
    expect(issues.issues.get(1)!.body).toContain("#7");
    expect(issues.calls).toEqual(["updateIssue #1"]);
  });

  it("leaves alone an issue a person took the tool's label off, as execution does", async () => {
    const { issues, client } = withIssue();
    issues.issues.set(1, { ...issues.issues.get(1)!, labels: [] });
    await showPullRequest(client, 1, SHOWN, assessed(eligible));
    expect(issues.calls).toEqual([]);
  });

  it("still reads an early PR's issue by its number in review, whatever its labels", async () => {
    const { issues, client } = withIssue({ grant: GRANT });
    issues.issues.set(1, { ...issues.issues.get(1)!, labels: [] });
    const reached = await reviewDisposition(client, pullRequest("Tracks #1, taken early."), plan, new EarlyPrs(client));
    // Not "isn't this decision's issue": it read the issue and judged the attempt's grant.
    expect(reached).toEqual({ kind: "leave", reason: "its `take-early` label was removed" });
  });
});

describe("what an attempt keeps when its text can't render", () => {
  it("writes the attempt's end through the record alone, keeping the visible text", async () => {
    const { issues, client } = withIssue();
    const before = issues.issues.get(1)!.body;
    const text = before.split("<!--")[0]!;
    let calls = 0;
    const failingOnce = { ...client, clean: (body: string) => {
      if (calls++ === 0) throw new Error("too large");
      return body;
    } };
    expect(await settleAttempt(failingOnce, 1, "a1", { outcome: "failed" }, assessed(eligible))).toBe(true);
    const after = issues.issues.get(1)!.body;
    expect(recordOf(after)!.attempts).toMatchObject([{ id: "a1", outcome: "failed" }]);
    expect(after.startsWith(text)).toBe(true);
  });
});
