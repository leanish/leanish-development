import { describe, expect, it } from "vitest";

import { GitHubApiError } from "@leanish/agent-runtime/github/github-client";
import type { GitHubPullRequest } from "@leanish/agent-runtime/types/clients";
import { FakeIssues } from "@leanish/tool-runtime/test/fake-issues";

import { decisionIssue, EarlyPrs, grantStanding, scopeOf } from "../src/decision-issues.ts";
import type { IssueRecord } from "../src/issue-model.ts";
import { ISSUE_LABEL, ISSUE_WRITER, TAKE_EARLY_LABEL } from "../src/issue-text.ts";
import type { ChangePlan } from "../src/plan.ts";

const REPO = "acme/widget";
const moves = [{ ecosystem: "npm" as const, name: "lib", from: "1.0.0", to: "1.0.1" }];
const plan = { kind: "routine", topic: "security-young-npm|lib", malware: false, packages: ["npm|lib"], moves } as unknown as ChangePlan;
const other = { ...plan, moves: [{ ...moves[0]!, to: "1.0.2" }] } as unknown as ChangePlan;
const young = [{ ecosystem: "npm" as const, name: "lib", version: "1.0.1" }];
const subject = { kind: "decision" as const, moves };
const waiting = { subject, findings: [], status: { kind: "waiting" as const, young: [{ ...young[0]!, eligibleAt: "2026-11-10T00:00:00.000Z" }] } };
const pr = (number: number, body: string) => ({ number, body, isDraft: true }) as unknown as GitHubPullRequest;

/** The tool's issue for `subject`, granted early and running an attempt for PR #7 unless said otherwise. */
function trackedIssue(issues: FakeIssues, options: { attempt?: boolean; author?: string } = {}): number {
  const record: IssueRecord = { version: 1, subject, openedAt: "a".repeat(40), findings: [], absences: [], attempts: [] };
  const created = issues.issues.size + 1;
  const body = ISSUE_WRITER.render(waiting, record, "a".repeat(40)).body;
  issues.issues.set(created, { number: created, url: `https://github.com/${REPO}/issues/${created}`, title: "secure-it: lib", body, state: "open", stateReason: null, author: options.author ?? issues.me, labels: [ISSUE_LABEL] });
  if (options.attempt === false) return created;
  issues.permissions.set("owner", "admin");
  const reason = issues.comment(created, "owner", "take-early: tested");
  issues.label(created, "owner", TAKE_EARLY_LABEL);
  const labeled = issues.events.get(created)!.find((event) => event.event === "labeled")!;
  const grant = { labelEventId: labeled.id, reasonCommentId: reason.id, actor: "owner", at: labeled.createdAt, young };
  const attempt = { id: `${labeled.id}-1`, grantEventId: labeled.id, branch: `secure-it/2026-11-03-take-early-${labeled.id}`, startedAt: "2026-11-03T08:02:00.000Z", pr: 7 };
  issues.issues.set(created, { ...issues.issues.get(created)!, body: ISSUE_WRITER.withRecord(body, { ...record, grant, attempts: [attempt] }) });
  return created;
}

/** Counts the issue reads by number, the request every lookup starts with. */
function counted(issues: FakeIssues): { reads: () => number } {
  let reads = 0;
  const getIssue = issues.getIssue.bind(issues);
  issues.getIssue = async (args) => {
    reads++;
    return getIssue(args);
  };
  return { reads: () => reads };
}

describe("decisionIssue", () => {
  it("finds the tool's issue for the plan's decision", async () => {
    const issues = new FakeIssues();
    const number = trackedIssue(issues, { attempt: false });
    expect((await decisionIssue({ issues, repo: REPO }, number, plan))?.issue.number).toBe(number);
  });

  it("finds nothing for a deleted issue, one someone else opened, or another decision's", async () => {
    const issues = new FakeIssues();
    const theirs = trackedIssue(issues, { attempt: false, author: "someone" });
    const ours = trackedIssue(issues, { attempt: false });
    expect(await decisionIssue({ issues, repo: REPO }, 99, plan)).toBeUndefined();
    expect(await decisionIssue({ issues, repo: REPO }, theirs, plan)).toBeUndefined();
    expect(await decisionIssue({ issues, repo: REPO }, ours, other)).toBeUndefined();
  });

  it.each([
    [301, "transferred to a repository the token reads"],
    [404, "transferred to one it can't read"],
    [410, "deleted"],
  ])("finds nothing for an issue GitHub answers is gone (%i: %s)", async (status) => {
    const issues = new FakeIssues();
    issues.getIssue = async () => {
      throw new GitHubApiError("getIssue", "gone", status);
    };
    expect(await decisionIssue({ issues, repo: REPO }, 1, plan)).toBeUndefined();
  });

  it("lets any other read failure through, so nothing goes ahead unread", async () => {
    const issues = new FakeIssues();
    issues.getIssue = async () => {
      throw new GitHubApiError("getIssue", "server error", 502);
    };
    await expect(decisionIssue({ issues, repo: REPO }, 1, plan)).rejects.toThrow(GitHubApiError);
  });
});

describe("grantStanding", () => {
  it("grants the running label from the issue's events, comments and the labeler's permission", async () => {
    const issues = new FakeIssues();
    const number = trackedIssue(issues);
    const { record, issue } = (await decisionIssue({ issues, repo: REPO }, number, plan))!;
    expect(await grantStanding({ issues, repo: REPO }, number, { state: issue.state, labels: issue.labels, record, status: waiting.status })).toMatchObject({ kind: "granted", grant: { actor: "owner" } });
    // Read afresh each time: a labeler who lost write access stops it on the next question.
    issues.permissions.set("owner", "read");
    expect(await grantStanding({ issues, repo: REPO }, number, { state: issue.state, labels: issue.labels, record, status: waiting.status })).toMatchObject({ kind: "refused" });
  });

  it("lets a failed read through instead of deciding without it", async () => {
    const issues = new FakeIssues();
    const number = trackedIssue(issues);
    const { record, issue } = (await decisionIssue({ issues, repo: REPO }, number, plan))!;
    issues.listEvents = async () => {
      throw new GitHubApiError("listEvents", "server error", 502);
    };
    await expect(grantStanding({ issues, repo: REPO }, number, { state: issue.state, labels: issue.labels, record, status: waiting.status })).rejects.toThrow(GitHubApiError);
  });
});

describe("EarlyPrs", () => {
  it("reads each PR's issue once, and again only after forget", async () => {
    const issues = new FakeIssues();
    const number = trackedIssue(issues);
    const { reads } = counted(issues);
    const early = new EarlyPrs({ issues, repo: REPO });
    const taken = pr(7, `Fixes lib.\n\nTracks #${number}.`);
    expect(await early.is(taken, plan)).toBe(true);
    expect(await early.is(taken, plan)).toBe(true);
    expect(reads()).toBe(1);
    early.forget();
    expect(await early.is(taken, plan)).toBe(true);
    expect(reads()).toBe(2);
  });

  it("keeps a running attempt early after its label was removed: classification isn't authorization", async () => {
    const issues = new FakeIssues();
    const number = trackedIssue(issues);
    await issues.removeLabel({ repo: REPO, number, label: TAKE_EARLY_LABEL });
    expect(await new EarlyPrs({ issues, repo: REPO }).is(pr(7, `Tracks #${number}.`), plan)).toBe(true);
  });

  it("answers from what a disposition already read, without another read", async () => {
    const issues = new FakeIssues();
    const number = trackedIssue(issues);
    const taken = pr(7, `Tracks #${number}.`);
    const scope = await scopeOf({ issues, repo: REPO }, taken, plan, number);
    const { reads } = counted(issues);
    const early = new EarlyPrs({ issues, repo: REPO });
    early.remember(taken, scope);
    expect(await early.is(taken, plan)).toBe(true);
    expect(reads()).toBe(0);
  });

  it("counts an untracked PR, another PR's attempt, or a foreign issue as not early", async () => {
    const issues = new FakeIssues();
    const number = trackedIssue(issues);
    const early = new EarlyPrs({ issues, repo: REPO });
    expect(await early.is(pr(8, "Fixes lib."), plan)).toBe(false);
    expect(await early.is(pr(9, `Tracks #${number}.`), plan)).toBe(false);
    expect(await early.is(pr(10, `Tracks #${number}.`), other)).toBe(false);
  });
});
