import { describe, expect, it } from "vitest";

import { GitHubApiError } from "@leanish/agent-runtime/github/github-client";
import { FakeIssues } from "@leanish/tool-runtime/test/fake-issues";

import type { Assessment, ObservedFinding, SubjectAssessment } from "../src/issue-model.ts";
import { syncIssues } from "../src/issue-sync.ts";
import { ISSUE_WRITER, noticeMarker, recordOf } from "../src/issue-text.ts";

const SHA = "a".repeat(40);
const LATER = "b".repeat(40);
const finding = (name: string, id: string): ObservedFinding => ({ ecosystem: "npm", name, ids: [id], versions: ["1.0.0"], reviewed: true, malicious: false, severity: "HIGH" });
const waiting = (name: string, to: string): SubjectAssessment => ({
  subject: { kind: "decision", moves: [{ ecosystem: "npm", name, from: "1.0.0", to }] },
  findings: [finding(name, "GHSA-1")],
  status: { kind: "waiting", young: [{ ecosystem: "npm", name, version: to, eligibleAt: "2026-11-10T00:00:00.000Z" }] },
});
const assessed = (subjects: SubjectAssessment[], sha = SHA): Assessment => ({ sha, at: "2026-11-03T00:00:00.000Z", complete: true, subjects, excepted: [] });
const sync = (issues: FakeIssues) => ({ issues, repo: "acme/widget", clean: (body: string) => body.replaceAll("/Users/someone", "<local path>") });

describe("syncIssues", () => {
  it("opens an issue, then leaves it alone while nothing changes", async () => {
    const issues = new FakeIssues();
    const first = await syncIssues(sync(issues), assessed([waiting("lib", "1.0.1")]));
    expect(first.settled).toBe(true);
    expect(first.tracked.map((issue) => issue.number)).toEqual([1]);
    issues.calls.length = 0;
    await syncIssues(sync(issues), assessed([waiting("lib", "1.0.1")]));
    expect(issues.calls).toEqual([]);
  });

  it("opens each issue once and settles when GitHub's listing lags its writes", async () => {
    const issues = new FakeIssues();
    issues.lagging = true;
    const result = await syncIssues(sync(issues), assessed([waiting("lib", "1.0.1"), waiting("other", "2.0.1")]));
    expect(result.settled).toBe(true);
    expect(issues.calls.filter((call) => call.startsWith("createIssue"))).toEqual(["createIssue #1", "createIssue #2"]);
    expect(result.tracked.map((issue) => issue.number).sort()).toEqual([1, 2]);
    // The sync's last listing came after its last write, so the next run lists both and changes nothing.
    issues.calls.length = 0;
    expect((await syncIssues(sync(issues), assessed([waiting("lib", "1.0.1"), waiting("other", "2.0.1")]))).settled).toBe(true);
    expect(issues.calls).toEqual([]);
  });

  it("keeps its issues when the repository's label has another casing, as GitHub applies it", async () => {
    const issues = new FakeIssues();
    issues.lagging = true;
    issues.repoLabels.set("leanish:secure-it-issue", "Leanish:Secure-It-Issue");
    const first = await syncIssues(sync(issues), assessed([waiting("lib", "1.0.1")]));
    expect(first.settled).toBe(true);
    expect(issues.issues.get(1)!.labels).toEqual(["Leanish:Secure-It-Issue"]);
    expect(first.tracked.map((issue) => issue.number)).toEqual([1]);
    issues.calls.length = 0;
    expect((await syncIssues(sync(issues), assessed([waiting("lib", "1.0.1")]))).settled).toBe(true);
    expect(issues.calls).toEqual([]);
    expect(issues.issues.size).toBe(1);
  });

  it("takes an issue a person deleted during the sync for gone, as the listing would, and opens its subject again", async () => {
    const issues = new FakeIssues();
    issues.lagging = true;
    const create = issues.createIssue.bind(issues);
    issues.createIssue = async (args) => {
      const issue = await create(args);
      if (issue.number === 1) issues.issues.delete(1);
      return issue;
    };
    const result = await syncIssues(sync(issues), assessed([waiting("lib", "1.0.1")]));
    expect(result.settled).toBe(true);
    expect(result.tracked.map((issue) => issue.number)).toEqual([2]);
  });

  it("takes an issue a person transferred away during the sync (301) for gone, as one deleted", async () => {
    const issues = new FakeIssues();
    issues.lagging = true;
    const create = issues.createIssue.bind(issues);
    const getIssue = issues.getIssue.bind(issues);
    issues.createIssue = async (args) => {
      const issue = await create(args);
      if (issue.number === 1) issues.getIssue = async (read) => {
        if (read.number === 1) throw new GitHubApiError("getIssue", "moved", 301);
        return getIssue(read);
      };
      return issue;
    };
    const result = await syncIssues(sync(issues), assessed([waiting("lib", "1.0.1")]));
    expect(result.settled).toBe(true);
    expect(result.tracked.map((issue) => issue.number)).toEqual([2]);
  });

  it("drops a written issue a person took the tool's label off, as the listing would", async () => {
    const issues = new FakeIssues();
    issues.lagging = true;
    const create = issues.createIssue.bind(issues);
    issues.createIssue = async (args) => {
      const issue = await create(args);
      if (issue.number === 1) issues.issues.set(1, { ...issue, labels: [] });
      return issue;
    };
    const result = await syncIssues(sync(issues), assessed([waiting("lib", "1.0.1")]));
    expect(result.tracked.map((issue) => issue.number)).toEqual([2]);
  });

  it("doesn't close a duplicate a person labelled take-early after the lagging listing last saw it", async () => {
    const issues = new FakeIssues();
    await syncIssues(sync(issues), assessed([waiting("lib", "1.0.1")]));
    issues.issues.set(2, { ...issues.issues.get(1)!, number: 2 });
    issues.lagging = true;
    await issues.listIssues({ repo: "acme/widget", creator: "leanish", label: "leanish:secure-it-issue" });
    issues.label(2, "owner", "take-early");
    issues.calls.length = 0;
    const result = await syncIssues(sync(issues), assessed([waiting("lib", "1.0.1")]));
    expect(issues.issues.get(2)!.state).toBe("open");
    expect(issues.calls).toEqual([]);
    expect(result.notes).toContain("#2: duplicates #1 but carries an authorization; a person closes one of them");
  });

  it("supersedes a changed decision through to its closing with a lagging listing, posting the notice once", async () => {
    const issues = new FakeIssues();
    issues.lagging = true;
    await syncIssues(sync(issues), assessed([waiting("lib", "1.0.1")]));
    const result = await syncIssues(sync(issues), assessed([waiting("lib", "1.0.2")], LATER));
    expect(result.settled).toBe(true);
    expect(issues.calls.filter((call) => call.startsWith("createIssue"))).toEqual(["createIssue #1", "createIssue #2"]);
    expect(issues.issues.get(1)).toMatchObject({ state: "closed", stateReason: "not_planned" });
    expect(issues.comments.get(1)).toHaveLength(1);
  });

  it("supersedes a changed decision through to its closing, posting the notice once", async () => {
    const issues = new FakeIssues();
    await syncIssues(sync(issues), assessed([waiting("lib", "1.0.1")]));
    const result = await syncIssues(sync(issues), assessed([waiting("lib", "1.0.2")], LATER));
    expect(result.settled).toBe(true);
    expect(issues.issues.get(1)).toMatchObject({ state: "closed", stateReason: "not_planned" });
    expect(recordOf(issues.issues.get(1)!.body)?.pendingClose).toMatchObject({ reason: "superseded", successors: [2] });
    expect(issues.comments.get(1)).toHaveLength(1);
    expect(issues.comments.get(1)![0]!.body).toContain("superseded by #2");
  });

  it.each([
    ["earlier", "2026-11-03T07:00:00Z", "2026-11-03T07:01:00Z"],
    // The tool's closing notice is posted at 08:00 in the fake: the same second as the person's close and reopen.
    ["in the same second as the tool's closing notice", "2026-11-03T08:00:00Z", "2026-11-03T08:00:00Z"],
  ])("doesn't take a reopening from before the tool's closing (%s) for a person's dismissal of what the tool closed", async (_, closedAt, reopenedAt) => {
    const issues = new FakeIssues();
    await syncIssues(sync(issues), assessed([waiting("lib", "1.0.1")]));
    issues.setState(1, "closed", "owner", closedAt);
    issues.setState(1, "open", "owner", reopenedAt);
    await syncIssues(sync(issues), assessed([waiting("lib", "1.0.2")], LATER));
    expect(issues.issues.get(1)!.state).toBe("closed");
    expect(recordOf(issues.issues.get(1)!.body)!.pendingClose?.afterEvent).toBeGreaterThan(0);
    // Back to the first decision: closed by the tool, not dismissed, so it gets a fresh issue.
    const back = await syncIssues(sync(issues), assessed([waiting("lib", "1.0.1")]));
    expect(back.tracked.filter((issue) => issue.state === "open" && recordOf(issue.body)!.pendingClose === undefined).map((issue) => issue.number)).toEqual([3]);
  });

  /** The issues open for the subject with no closing pending: a fresh one when the tool's closing wasn't a dismissal. */
  const freshOpen = (result: Awaited<ReturnType<typeof syncIssues>>) => result.tracked.filter((issue) => issue.state === "open" && recordOf(issue.body)!.pendingClose === undefined).map((issue) => issue.number);

  /** Supersedes #1 while `actor` closes and reopens it between the recorded closing (and its notice) and the tool's close. */
  async function raceDuringClose(actor: string): Promise<FakeIssues> {
    const issues = new FakeIssues();
    await syncIssues(sync(issues), assessed([waiting("lib", "1.0.1")]));
    const comment = issues.createComment.bind(issues);
    let raced = false;
    issues.createComment = async (args) => {
      const posted = await comment(args);
      if (!raced) {
        raced = true;
        issues.setState(1, "closed", actor);
        issues.setState(1, "open", actor);
      }
      return posted;
    };
    await syncIssues(sync(issues), assessed([waiting("lib", "1.0.2")], LATER));
    expect(issues.issues.get(1)!.state).toBe("closed");
    return issues;
  }

  it("doesn't take a person's close and reopen while the tool closes an issue for the tool's closing", async () => {
    const issues = await raceDuringClose("owner");
    // Back to the first decision: the tool closed it last, so it isn't dismissed, and the subject gets a fresh issue.
    expect(freshOpen(await syncIssues(sync(issues), assessed([waiting("lib", "1.0.1")])))).toEqual([3]);
  });

  it("can't tell that race apart when the person uses the token's own account (a documented limit)", async () => {
    const issues = await raceDuringClose("leanish");
    // The person's closing reads as the tool's, and the tool's later one as a dismissal after a reopening: no fresh issue.
    expect(freshOpen(await syncIssues(sync(issues), assessed([waiting("lib", "1.0.1")])))).toEqual([]);
  });

  it("finishes an interrupted closing without taking a person's close and reopen meanwhile for the tool's", async () => {
    const issues = new FakeIssues();
    await syncIssues(sync(issues), assessed([waiting("lib", "1.0.1")]));
    // The run records the closing and posts its notice, then crashes before closing; a person closes and reopens it.
    const update = issues.updateIssue.bind(issues);
    let crashed = false;
    issues.updateIssue = async (args) => {
      if (args.state === "closed" && !crashed) {
        crashed = true;
        throw new Error("socket hang up");
      }
      return update(args);
    };
    await expect(syncIssues(sync(issues), assessed([waiting("lib", "1.0.2")], LATER))).rejects.toThrow("socket hang up");
    issues.setState(1, "closed", "owner");
    issues.setState(1, "open", "owner");
    // The next run finishes the recorded closing; back to the first decision, the subject gets a fresh issue.
    await syncIssues(sync(issues), assessed([waiting("lib", "1.0.2")], LATER));
    expect(issues.issues.get(1)!.state).toBe("closed");
    expect(freshOpen(await syncIssues(sync(issues), assessed([waiting("lib", "1.0.1")])))).toEqual([3]);
  });

  it("keeps a person's dismissal after they reopened an issue the tool closed and closed it again", async () => {
    const issues = new FakeIssues();
    await syncIssues(sync(issues), assessed([waiting("lib", "1.0.1")]));
    await syncIssues(sync(issues), assessed([waiting("lib", "1.0.2")], LATER));
    issues.setState(1, "open", "owner", "2026-11-03T09:10:00Z");
    issues.setState(1, "closed", "owner", "2026-11-03T09:20:00Z");
    // Back to the first decision: #1 is the person's dismissal of it, so no issue opens for it again.
    const back = await syncIssues(sync(issues), assessed([waiting("lib", "1.0.1")]));
    expect(freshOpen(back)).toEqual([]);
    expect(issues.issues.get(1)!.state).toBe("closed");
  });

  it("takes an issue a person reopened after the tool closed it for retired, and opens a fresh one for its subject", async () => {
    const issues = new FakeIssues();
    await syncIssues(sync(issues), assessed([waiting("lib", "1.0.1")]));
    await syncIssues(sync(issues), assessed([waiting("lib", "1.0.2")], LATER));
    issues.setState(1, "open", "owner");
    const back = await syncIssues(sync(issues), assessed([waiting("lib", "1.0.1")]));
    expect(back.tracked.filter((issue) => issue.state === "open").map((issue) => issue.number)).toEqual([1, 3]);
    expect(back.notes).toContain("#1: a person reopened it after secure-it closed it; it stays open, retired");
  });

  it("dates a closing recorded without its event only by the tool's own notice, never by someone else's marker", async () => {
    const issues = new FakeIssues();
    await syncIssues(sync(issues), assessed([waiting("lib", "1.0.1")]));
    await syncIssues(sync(issues), assessed([waiting("lib", "1.0.2")], LATER));
    // A closing recorded before `afterEvent` existed, whose notice the listing doesn't show; then a person reopens it,
    // and someone posts the same notice marker afterwards.
    const closed = issues.issues.get(1)!;
    const { afterEvent: _, ...legacy } = recordOf(closed.body)!.pendingClose!;
    issues.issues.set(1, { ...closed, body: ISSUE_WRITER.withRecord(closed.body, { ...recordOf(closed.body)!, pendingClose: legacy }) });
    issues.comments.set(1, []);
    issues.setState(1, "open", "owner", "2026-11-03T09:10:00Z");
    issues.comment(1, "outsider", `copied\n\n${noticeMarker(legacy.id)}`, "2026-11-03T09:20:00Z");
    const back = await syncIssues(sync(issues), assessed([waiting("lib", "1.0.1")]));
    expect(back.notes).toContain("#1: a person reopened it after secure-it closed it; it stays open, retired");
    expect(issues.issues.get(1)!.state).toBe("open");
  });

  it("records since when a waiting issue has shown its young versions: a newcomer moves it, an aged-out one doesn't", async () => {
    const issues = new FakeIssues();
    const young = (name: string) => ({ ecosystem: "npm" as const, name, version: "1.0.1", eligibleAt: "2026-11-10T00:00:00.000Z" });
    const subject = (names: string[]): SubjectAssessment => ({ ...waiting("lib", "1.0.1"), status: { kind: "waiting", young: names.map(young) } });
    // The run assessed at 08:00 whatever the wall clock says when it writes: `since` follows the writes, plus the margin.
    const at = (names: string[]): Assessment => ({ sha: SHA, at: "2026-11-03T08:00:00.000Z", complete: true, subjects: [subject(names)], excepted: [] });
    const writingAt = (time: string) => ({ ...sync(issues), clock: () => new Date(time) });
    const shown = () => recordOf(issues.issues.get(1)!.body)!.shown;
    await syncIssues(writingAt("2026-11-03T08:00:00.000Z"), at(["lib"]));
    expect(shown()).toEqual({ young: [{ ecosystem: "npm", name: "lib", version: "1.0.1" }], since: "2026-11-03T08:02:00.000Z" });
    await syncIssues(writingAt("2026-11-03T09:10:00.000Z"), at(["lib", "dep"]));
    expect(shown()?.since).toBe("2026-11-03T09:12:00.000Z");
    await syncIssues(writingAt("2026-11-03T10:00:00.000Z"), at(["dep"]));
    expect(shown()).toEqual({ young: [{ ecosystem: "npm", name: "dep", version: "1.0.1" }], since: "2026-11-03T09:12:00.000Z" });
  });

  it("counts a newly shown young version only from a read that saw it published, however long the writes took", async () => {
    const issues = new FakeIssues();
    const subject = (names: string[]): SubjectAssessment => ({ ...waiting("lib", "1.0.1"), status: { kind: "waiting", young: names.map((name) => ({ ecosystem: "npm" as const, name, version: "1.0.1", eligibleAt: "2026-11-10T00:00:00.000Z" })) } });
    const at = (names: string[]): Assessment => ({ sha: SHA, at: "2026-11-03T10:00:00.000Z", complete: true, subjects: [subject(names)], excepted: [] });
    await syncIssues({ ...sync(issues), clock: () => new Date("2026-11-03T09:00:00.000Z") }, at(["lib"]));
    // The round adding dep starts at 10:00; its write lands late, and the owner labels in between, seeing only lib.
    const times = ["2026-11-03T10:00:00.000Z", "2026-11-03T10:02:30.000Z", "2026-11-03T10:02:30.000Z"];
    const write = issues.updateIssue.bind(issues);
    issues.updateIssue = async (args) => {
      if (args.body?.includes("dep") === true && recordOf(issues.issues.get(1)!.body)!.shown!.young.length === 1) issues.label(1, "owner", "take-early", "2026-11-03T10:02:10Z");
      return write(args);
    };
    await syncIssues({ ...sync(issues), clock: () => new Date(times.shift() ?? "2026-11-03T10:02:30.000Z") }, at(["lib", "dep"]));
    const record = recordOf(issues.issues.get(1)!.body)!;
    expect(record.shown?.since).toBe("2026-11-03T10:04:30.000Z");
    expect(Date.parse("2026-11-03T10:02:10Z")).toBeLessThan(Date.parse(record.shown!.since));
  });

  it("rewrites a pending record a crash left when the decision now takes other young versions, then confirms them", async () => {
    const issues = new FakeIssues();
    const subject = (names: string[]): SubjectAssessment => ({ ...waiting("lib", "1.0.1"), status: { kind: "waiting", young: names.map((name) => ({ ecosystem: "npm" as const, name, version: "1.0.1", eligibleAt: "2026-11-10T00:00:00.000Z" })) } });
    const at = (names: string[]): Assessment => ({ sha: SHA, at: "2026-11-03T10:00:00.000Z", complete: true, subjects: [subject(names)], excepted: [] });
    await syncIssues({ ...sync(issues), clock: () => new Date("2026-11-03T09:00:00.000Z") }, at(["a"]));
    // A crash right after a write: the record says pending, showing a.
    const crashed = issues.issues.get(1)!;
    issues.issues.set(1, { ...crashed, body: ISSUE_WRITER.withRecord(crashed.body, { ...recordOf(crashed.body)!, shown: { young: [{ ecosystem: "npm", name: "a", version: "1.0.1" }], since: "pending" } }) });
    const result = await syncIssues({ ...sync(issues), clock: () => new Date("2026-11-03T11:00:00.000Z") }, at(["b"]));
    expect(result.settled).toBe(true);
    expect(recordOf(issues.issues.get(1)!.body)!.shown).toEqual({ young: [{ ecosystem: "npm", name: "b", version: "1.0.1" }], since: "2026-11-03T11:02:00.000Z" });
  });

  it("says what to fix when the write PAT can't write issues, and never falls back", async () => {
    const issues = new FakeIssues();
    issues.forbidden.add("createIssue");
    await expect(syncIssues(sync(issues), assessed([waiting("lib", "1.0.1")]))).rejects.toThrow("check that the write PAT has Issues: read and write");
  });

  it("says Issues are disabled when GitHub answers an issue create as gone, and only then", async () => {
    const disabled = new FakeIssues();
    disabled.createIssue = async () => { throw new GitHubApiError("createIssue", "gone", 410); };
    await expect(syncIssues(sync(disabled), assessed([waiting("lib", "1.0.1")]))).rejects.toThrow("Issues are disabled on this repository, and secure-it needs them enabled");
    // A 410 on an issue that exists is that issue deleted, not the feature off.
    const deleted = new FakeIssues();
    await syncIssues(sync(deleted), assessed([waiting("lib", "1.0.1")]));
    deleted.updateIssue = async () => { throw new GitHubApiError("updateIssue", "gone", 410); };
    const update = syncIssues(sync(deleted), assessed([waiting("lib", "1.0.2")], LATER));
    await expect(update).rejects.toThrow();
    await expect(update).rejects.not.toThrow("Issues are disabled");
  });

  it("keeps an issue open while its successor's update, skipped because a person changed that issue, isn't published", async () => {
    const issues = new FakeIssues();
    const joining = finding("lib", "GHSA-A");
    const fix: SubjectAssessment = { ...waiting("other", "2.0.1"), findings: [finding("other", "GHSA-B")] };
    await syncIssues(sync(issues), assessed([{ subject: { kind: "package", ecosystem: "npm", name: "lib" }, findings: [joining], status: { kind: "informational" } }, fix]));
    expect([...issues.issues.keys()]).toEqual([1, 2]);
    // Between this sync's listing and its write to #2, a person removes #2's hidden record: the tool skips that write.
    const get = issues.getIssue.bind(issues);
    let edited = false;
    issues.getIssue = async (args) => {
      if (args.number === 2 && !edited) {
        edited = true;
        const two = issues.issues.get(2)!;
        issues.issues.set(2, { ...two, body: two.body.replace("<!-- leanish:plan", "<!-- edited") });
      }
      return get(args);
    };
    const result = await syncIssues(sync(issues), assessed([{ ...fix, findings: [...fix.findings, joining] }]));
    expect(edited).toBe(true);
    expect(result.unreadable).toEqual([2]);
    expect(issues.issues.get(1)!.state).toBe("open");
    expect(recordOf(issues.issues.get(1)!.body)!.pendingClose).toBeUndefined();
  });

  it("blocks creates while one of its open issues can't be read", async () => {
    const issues = new FakeIssues();
    await syncIssues(sync(issues), assessed([waiting("lib", "1.0.1")]));
    const broken = issues.issues.get(1)!;
    issues.issues.set(1, { ...broken, body: broken.body.replace("<!-- leanish:plan", "<!-- edited") });
    const result = await syncIssues(sync(issues), assessed([waiting("other", "2.0.1")]));
    expect(result.unreadable).toEqual([1]);
    expect(issues.issues.size).toBe(1);
  });
});
