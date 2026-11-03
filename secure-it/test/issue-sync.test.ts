import { describe, expect, it } from "vitest";

import { FakeIssues } from "@leanish/tool-runtime/test/fake-issues";

import type { Assessment, ObservedFinding, SubjectAssessment } from "../src/issue-model.ts";
import { syncIssues } from "../src/issue-sync.ts";
import { ISSUE_WRITER, recordOf } from "../src/issue-text.ts";

const SHA = "a".repeat(40);
const LATER = "b".repeat(40);
const finding = (name: string, id: string): ObservedFinding => ({ ecosystem: "npm", name, ids: [id], versions: ["1.0.0"], reviewed: true, malicious: false, severity: "HIGH" });
const waiting = (name: string, to: string): SubjectAssessment => ({
  subject: { kind: "decision", moves: [{ ecosystem: "npm", name, from: "1.0.0", to }] },
  findings: [finding(name, "GHSA-1")],
  status: { kind: "waiting", young: [{ ecosystem: "npm", name, version: to, eligibleAt: "2026-11-10T00:00:00.000Z" }] },
});
const assessed = (subjects: SubjectAssessment[], sha = SHA): Assessment => ({ sha, at: "2026-11-03T00:00:00.000Z", complete: true, subjects });
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

  it("takes an issue a person reopened after the tool closed it for retired, and opens a fresh one for its subject", async () => {
    const issues = new FakeIssues();
    await syncIssues(sync(issues), assessed([waiting("lib", "1.0.1")]));
    await syncIssues(sync(issues), assessed([waiting("lib", "1.0.2")], LATER));
    issues.setState(1, "open", "owner");
    const back = await syncIssues(sync(issues), assessed([waiting("lib", "1.0.1")]));
    expect(back.tracked.filter((issue) => issue.state === "open").map((issue) => issue.number)).toEqual([1, 3]);
    expect(back.notes).toContain("#1: a person reopened it after secure-it closed it; it stays open, retired");
  });

  it("records since when a waiting issue has shown its young versions: a newcomer moves it, an aged-out one doesn't", async () => {
    const issues = new FakeIssues();
    const young = (name: string) => ({ ecosystem: "npm" as const, name, version: "1.0.1", eligibleAt: "2026-11-10T00:00:00.000Z" });
    const subject = (names: string[]): SubjectAssessment => ({ ...waiting("lib", "1.0.1"), status: { kind: "waiting", young: names.map(young) } });
    // The run assessed at 08:00 whatever the wall clock says when it writes: `since` follows the writes, plus the margin.
    const at = (names: string[]): Assessment => ({ sha: SHA, at: "2026-11-03T08:00:00.000Z", complete: true, subjects: [subject(names)] });
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
    const at = (names: string[]): Assessment => ({ sha: SHA, at: "2026-11-03T10:00:00.000Z", complete: true, subjects: [subject(names)] });
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
    const at = (names: string[]): Assessment => ({ sha: SHA, at: "2026-11-03T10:00:00.000Z", complete: true, subjects: [subject(names)] });
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
    await expect(syncIssues(sync(issues), assessed([waiting("lib", "1.0.1")]))).rejects.toThrow("the write PAT needs Issues: read and write");
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
