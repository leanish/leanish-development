import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { type Assessment, type DecisionMove, type IssueRecord, type ObservedFinding, parseRecord, type SubjectAssessment, subjectId } from "../src/issue-model.ts";
import { type IssueOperation, type IssueWriter, reconcile, type TrackedIssue } from "../src/issue-reconcile.ts";
import { ISSUE_WRITER, recordOf } from "../src/issue-text.ts";

const SHA = "a".repeat(40);
const LATER = "b".repeat(40);

function finding(name: string, ids: string[], overrides: Partial<ObservedFinding> = {}): ObservedFinding {
  return { ecosystem: "npm", name, ids, versions: ["1.0.0"], reviewed: true, malicious: false, severity: "HIGH", ...overrides };
}

const move = (name: string, to = "1.0.1"): DecisionMove => ({ ecosystem: "npm", name, from: "1.0.0", to });

function decision(moves: DecisionMove[], findings: ObservedFinding[]): SubjectAssessment {
  return { subject: { kind: "decision", moves }, findings, status: { kind: "waiting", young: moves.map((m) => ({ ecosystem: m.ecosystem, name: m.name, version: m.to, eligibleAt: "2026-11-10T00:00:00.000Z" })) } };
}

function informational(name: string, findings: ObservedFinding[]): SubjectAssessment {
  return { subject: { kind: "package", ecosystem: "npm", name }, findings, status: { kind: "informational" } };
}

const assessed = (subjects: SubjectAssessment[], complete = true, sha = SHA): Assessment => ({ sha, at: "2026-11-03T00:00:00.000Z", complete, subjects });

/** Runs `reconcile` to completion against fake issues, applying each operation as GitHub would. */
function converge(assessment: Assessment, issues: TrackedIssue[] = [], rounds = 5): { issues: TrackedIssue[]; operations: IssueOperation[][]; notes: string[] } {
  const state = issues.map((issue) => ({ ...issue }));
  const operations: IssueOperation[][] = [];
  const notes: string[] = [];
  let next = Math.max(0, ...state.map((issue) => issue.number)) + 1;
  for (let round = 0; round < rounds; round++) {
    const result = reconcile(assessment, state, ISSUE_WRITER);
    notes.push(...result.notes);
    if (result.operations.length === 0) return { issues: state, operations, notes };
    operations.push([...result.operations]);
    for (const operation of result.operations) {
      if (operation.kind === "create") {
        state.push({ number: next++, state: "open", body: operation.body, record: recordOf(operation.body)!, reopened: false });
        continue;
      }
      const issue = state.find((tracked) => tracked.number === operation.number)!;
      issue.body = operation.body;
      issue.record = recordOf(operation.body)!;
      if (operation.kind === "close") issue.state = "closed";
    }
  }
  throw new Error("reconcile didn't converge");
}

const open = (issues: TrackedIssue[]) => issues.filter((issue) => issue.state === "open");
const subjectsOf = (issues: TrackedIssue[]) => open(issues).map((issue) => subjectId(issue.record.subject)).sort();

describe("reconcile", () => {
  it("opens one issue per subject, and rewrites nothing when nothing changed", () => {
    const a = decision([move("lib")], [finding("lib", ["GHSA-1"])]);
    const b = informational("other", [finding("other", ["GHSA-2"], { reviewed: false })]);
    const first = converge(assessed([a, b]));
    // Round 1 creates both; round 2 reads the waiting decision back and confirms since when it shows its young versions.
    expect(first.operations.map((round) => round.map((operation) => operation.kind))).toEqual([["create", "create"], ["update"]]);
    expect(subjectsOf(first.issues)).toEqual([subjectId(a.subject), subjectId(b.subject)].sort());
    expect(reconcile(assessed([a, b]), first.issues, ISSUE_WRITER).operations).toEqual([]);
  });

  it("supersedes a changed decision only once its successor exists, and A → B → A opens a third issue", () => {
    const fixA = decision([move("lib", "1.0.1")], [finding("lib", ["GHSA-1"])]);
    const fixB = decision([move("lib", "1.0.2")], [finding("lib", ["GHSA-1"])]);
    const start = converge(assessed([fixA])).issues;
    const toB = converge(assessed([fixB]), start);
    // Round 1 creates B; round 2, with B there, confirms what B shows and closes A as superseded by it.
    expect(toB.operations[0]!.map((operation) => operation.kind)).toEqual(["create"]);
    expect(toB.operations[1]!.map((operation) => operation.kind)).toEqual(["update", "close"]);
    const closedA = toB.issues.find((issue) => issue.number === 1)!;
    expect(closedA.record.pendingClose).toMatchObject({ reason: "superseded", successors: [2] });
    const backToA = converge(assessed([fixA]), toB.issues);
    expect(open(backToA.issues).map((issue) => issue.number)).toEqual([3]);
    expect(open(backToA.issues)[0]!.record.grant).toBeUndefined();
  });

  it("merges two decisions into one and splits one into two, closing predecessors after every successor exists", () => {
    const a = decision([move("a")], [finding("a", ["GHSA-a"])]);
    const b = decision([move("b")], [finding("b", ["GHSA-b"])]);
    const both = decision([move("a"), move("b")], [finding("a", ["GHSA-a"]), finding("b", ["GHSA-b"])]);
    const merged = converge(assessed([both]), converge(assessed([a, b])).issues);
    expect(open(merged.issues).map((issue) => issue.number)).toEqual([3]);
    expect(merged.issues.filter((issue) => issue.state === "closed").map((issue) => issue.record.pendingClose?.successors)).toEqual([[3], [3]]);
    const split = converge(assessed([a, b]), merged.issues);
    expect(split.issues.find((issue) => issue.number === 3)!.record.pendingClose?.successors).toEqual([4, 5]);
  });

  it("respects a person's closing as a dismissal until the finding goes away, and opens a new issue for a new one", () => {
    const one = informational("lib", [finding("lib", ["GHSA-1"], { reviewed: false })]);
    const [issue] = converge(assessed([one])).issues;
    const dismissed: TrackedIssue = { ...issue!, state: "closed" };
    // Still there: nothing reopens or recreates it, even under a new alias.
    expect(reconcile(assessed([informational("lib", [finding("lib", ["GHSA-1", "CVE-1"], { reviewed: false })])]), [dismissed], ISSUE_WRITER).operations).toEqual([]);
    // A new advisory on the same package: a new issue.
    const withNew = informational("lib", [finding("lib", ["GHSA-1"], { reviewed: false }), finding("lib", ["GHSA-9"])]);
    expect(reconcile(assessed([withNew]), [dismissed], ISSUE_WRITER).operations.map((operation) => operation.kind)).toEqual(["create"]);
    // Gone in a complete assessment: the episode ends on the dismissed issue; its return is new.
    const gone = converge(assessed([], true, LATER), [dismissed]);
    expect(gone.issues[0]!.record.absences).toEqual([{ finding: { ecosystem: "npm", name: "lib", ids: ["GHSA-1"] }, at: LATER }]);
    expect(reconcile(assessed([one]), gone.issues, ISSUE_WRITER).operations.map((operation) => operation.kind)).toEqual(["create"]);
  });

  it("keeps a dismissal when the dismissed finding gets a different fix", () => {
    const fixA = decision([move("lib", "1.0.1")], [finding("lib", ["GHSA-1"])]);
    const [issue] = converge(assessed([fixA])).issues;
    const dismissed: TrackedIssue = { ...issue!, state: "closed" };
    expect(reconcile(assessed([decision([move("lib", "1.0.2")], [finding("lib", ["GHSA-1"])])]), [dismissed], ISSUE_WRITER).operations).toEqual([]);
  });

  it("resolves an issue only on a complete assessment, recording where its findings went away", () => {
    const issues = converge(assessed([decision([move("lib")], [finding("lib", ["GHSA-1"])])])).issues;
    const incomplete = reconcile(assessed([], false, LATER), issues, ISSUE_WRITER);
    expect(incomplete.operations).toEqual([]);
    expect(incomplete.notes).toEqual(["#1: its subject is gone, but the assessment is incomplete; it stays open"]);
    const resolved = converge(assessed([], true, LATER), issues);
    const closed = resolved.issues[0]!;
    expect(closed.state).toBe("closed");
    expect(closed.record.pendingClose).toMatchObject({ reason: "resolved", at: LATER });
    expect(closed.record.absences).toHaveLength(1);
    expect(resolved.operations[0]![0]).toMatchObject({ kind: "close", reason: "completed" });
  });

  it("finishes an interrupted closing as decided, and drops one a person undid by reopening", () => {
    const issues = converge(assessed([decision([move("lib")], [finding("lib", ["GHSA-1"])])])).issues;
    const pending: IssueRecord = { ...issues[0]!.record, pendingClose: { id: "close:1:resolved:x", reason: "resolved", successors: [], at: LATER } };
    const interrupted: TrackedIssue = { ...issues[0]!, body: ISSUE_WRITER.withRecord(issues[0]!.body, pending), record: pending };
    const finished = reconcile(assessed([], true, LATER), [interrupted], ISSUE_WRITER).operations;
    expect(finished).toEqual([expect.objectContaining({ kind: "close", comment: expect.objectContaining({ noticeId: "close:1:resolved:x" }) })]);
    // Reopened by a person after the tool closed it: left open but retired; its subject gets a new instance.
    const reopened = converge(assessed([decision([move("lib")], [finding("lib", ["GHSA-1"])])]), [{ ...interrupted, reopened: true }]);
    expect(reopened.issues[0]).toMatchObject({ state: "open" });
    expect(reopened.issues[0]!.record.pendingClose).toBeDefined();
    expect(reopened.issues.map((issue) => issue.number)).toEqual([1, 2]);
    expect(reopened.notes).toContain("#1: a person reopened it after secure-it closed it; it stays open, retired");
  });

  it("leaves an issue a person reopened open, even once its subject is gone, and never revives its grant", () => {
    const fixA = decision([move("lib", "1.0.1")], [finding("lib", ["GHSA-1"])]);
    const fixB = decision([move("lib", "1.0.2")], [finding("lib", ["GHSA-1"])]);
    const superseded = converge(assessed([fixB]), converge(assessed([fixA])).issues).issues;
    const reopenedA = superseded.map((issue) => (issue.number === 1 ? { ...issue, state: "open" as const, reopened: true } : issue));
    // Back to A: a new instance opens and B is superseded; the reopened #1 stays retired, never current again.
    const back = converge(assessed([fixA]), reopenedA);
    expect(open(back.issues).map((issue) => issue.number)).toEqual([1, 3]);
    expect(back.issues.find((issue) => issue.number === 1)!.record.pendingClose).toMatchObject({ reason: "superseded", successors: [2] });
    const gone = reconcile(assessed([], true, LATER), [{ ...superseded[0]!, state: "open", reopened: true }], ISSUE_WRITER);
    expect(gone.operations.map((operation) => operation.kind)).toEqual(["update"]);
  });

  it("keeps going past one issue or subject it can't write, noting why", () => {
    const issues = converge(assessed([decision([move("lib")], [finding("lib", ["GHSA-1"])])])).issues;
    // A person rewrote the body without the section: the closing still writes its record, in a fresh section.
    const edited: TrackedIssue = { ...issues[0]!, body: "rewritten by hand" };
    const huge = decision(Array.from({ length: 400 }, (_, i) => move(`${"pkg".repeat(10)}-${i}`)), [finding("lib", ["GHSA-1"])]);
    const other = informational("other", [finding("other", ["GHSA-2"], { reviewed: false })]);
    const result = reconcile(assessed([huge, other], true, LATER), [edited], ISSUE_WRITER);
    expect(result.operations.map((operation) => operation.kind)).toEqual(["create"]);
    expect(result.notes).toEqual([expect.stringContaining("doesn't fit"), "#1: closes once its successors exist"]);
    const closed = reconcile(assessed([], true, LATER), [edited], ISSUE_WRITER).operations[0]!;
    expect(closed.kind).toBe("close");
    expect(recordOf((closed as { body: string }).body)?.pendingClose?.reason).toBe("resolved");
  });

  it("closes an issue for its successor only once the successor's text shows the findings that moved there", () => {
    const joining = finding("lib", ["GHSA-A"], { reviewed: false });
    const fix = decision([move("other")], [finding("other", ["GHSA-2"])]);
    const issues = converge(assessed([informational("lib", [joining]), fix])).issues;
    const joined = decision([move("other")], [...fix.findings, joining]);
    // The successor's update can't be written (too large, say): it doesn't show the joining finding, so #1 stays open.
    const failing: IssueWriter = { ...ISSUE_WRITER, render: (subject, record, sha) => {
      if (subjectId(subject.subject) === subjectId(fix.subject)) throw new Error("the decision doesn't fit");
      return ISSUE_WRITER.render(subject, record, sha);
    } };
    const result = reconcile(assessed([joined]), issues, failing);
    expect(result.operations).toEqual([]);
    expect(result.notes).toEqual(["#2: the decision doesn't fit", "#1: closes once #2 shows its findings"]);
    const written = converge(assessed([joined]), issues).issues;
    expect(written[0]!.record.pendingClose).toMatchObject({ reason: "superseded", successors: [2] });
    expect(written[1]!.record.findings.map((tracked) => tracked.ids)).toEqual([["GHSA-2"], ["GHSA-A"]]);
  });

  it("opens an issue for a subject without findings rather than taking it for dismissed", () => {
    expect(reconcile(assessed([decision([move("lib")], [])]), [], ISSUE_WRITER).operations.map((operation) => operation.kind)).toEqual(["create"]);
  });

  it("creates nothing while an open issue of the tool can't be read, but goes on updating the others", () => {
    const fix = decision([move("lib")], [finding("lib", ["GHSA-1"])]);
    const result = reconcile(assessed([fix, informational("other", [finding("other", ["GHSA-2"], { reviewed: false })])]), [], ISSUE_WRITER, [7]);
    expect(result.operations).toEqual([]);
    expect(result.notes).toEqual([expect.stringContaining("#7: its record can't be read")]);
  });

  it("closes a duplicate instance of one subject in favour of the lowest number, on an incomplete assessment too", () => {
    const fix = decision([move("lib")], [finding("lib", ["GHSA-1"])]);
    const [first] = converge(assessed([fix])).issues;
    for (const complete of [true, false]) {
      const result = converge(assessed([fix], complete), [first!, { ...first!, number: 2 }]);
      expect(open(result.issues).map((issue) => issue.number)).toEqual([1]);
      expect(result.issues[1]!.record.pendingClose).toMatchObject({ reason: "superseded", successors: [1] });
    }
  });

  it("tracks a finding that joined an issue: once its first one is gone, the issue is superseded by the joiner's fix, never resolved", () => {
    const a = finding("lib", ["GHSA-A"], { reviewed: false });
    const b = finding("lib", ["GHSA-B"]);
    const opened = converge(assessed([informational("lib", [a])])).issues;
    const joined = converge(assessed([informational("lib", [a, b])]), opened).issues;
    expect(joined[0]!.record.findings.map((tracked) => tracked.ids)).toEqual([["GHSA-A"], ["GHSA-B"]]);
    const fixed = converge(assessed([decision([move("lib")], [b])]), joined).issues;
    expect(fixed[0]!.record.pendingClose).toMatchObject({ reason: "superseded", successors: [2] });
  });

  it("starts a new episode for a finding shown again, so a person's later closing dismisses it as it is now", () => {
    const a = finding("lib", ["GHSA-A"], { reviewed: false });
    const b = finding("lib", ["GHSA-B"], { reviewed: false });
    const opened = converge(assessed([informational("lib", [a, b])])).issues;
    // A complete scan misses A (its absence is recorded) while B keeps the issue open; then A comes back.
    const missed = converge(assessed([informational("lib", [b])]), opened).issues;
    expect(missed[0]!.record.absences.map((absence) => absence.finding.ids)).toEqual([["GHSA-A"]]);
    const back = converge(assessed([informational("lib", [a, b])]), missed).issues;
    expect(back[0]!.record.absences).toEqual([]);
    // A person closes it: nothing came back after that, so no new issue opens.
    const after = converge(assessed([informational("lib", [a, b])]), [{ ...back[0]!, state: "closed" }]).issues;
    expect(open(after)).toEqual([]);
  });

  it("keeps a duplicate opened for a finding the survivor lacks while the assessment is incomplete", () => {
    const [first] = converge(assessed([informational("lib", [finding("lib", ["GHSA-A"], { reviewed: false })])])).issues;
    const [wider] = converge(assessed([informational("lib", [finding("lib", ["GHSA-A"], { reviewed: false }), finding("lib", ["GHSA-B"], { reviewed: false })])])).issues;
    const both = [first!, { ...wider!, number: 2 }];
    // An incomplete scan sees only A: B isn't shown gone, so #2, the only issue opened for it, stays.
    const now = informational("lib", [finding("lib", ["GHSA-A"], { reviewed: false })]);
    expect(reconcile(assessed([now], false), both, ISSUE_WRITER).operations).toEqual([]);
    // A complete one settles it.
    expect(open(converge(assessed([now]), both).issues).map((issue) => issue.number)).toEqual([1]);
  });

  it("never closes a duplicate a person labelled take-early, and says a person closes one", () => {
    const fix = decision([move("lib")], [finding("lib", ["GHSA-1"])]);
    const [first] = converge(assessed([fix])).issues;
    const labelled: TrackedIssue = { ...first!, number: 2, labels: ["leanish:secure-it-issue", "take-early"] };
    const result = reconcile(assessed([fix]), [first!, labelled], ISSUE_WRITER);
    expect(result.operations).toEqual([]);
    expect(result.notes).toContain("#2: duplicates #1 but carries an authorization; a person closes one of them");
  });

  it("never closes a duplicate running an early attempt", () => {
    const fix = decision([move("lib")], [finding("lib", ["GHSA-1"])]);
    const [first] = converge(assessed([fix])).issues;
    const record: IssueRecord = { ...first!.record, attempts: [{ id: "7-1", grantEventId: 7, branch: "secure-it/2026-11-04-take-early-7", startedAt: "2026-11-04T00:00:00.000Z" }] };
    const running: TrackedIssue = { ...first!, number: 2, record, body: ISSUE_WRITER.withRecord(first!.body, record) };
    expect(reconcile(assessed([fix]), [first!, running], ISSUE_WRITER).operations).toEqual([]);
  });

  it("doesn't wait for a successor a dismissal covers", () => {
    const old = informational("lib", [finding("lib", ["GHSA-1"], { reviewed: false })]);
    const [dismissedIssue] = converge(assessed([old])).issues;
    const dismissed: TrackedIssue = { ...dismissedIssue!, state: "closed" };
    const other = decision([move("lib")], [finding("lib", ["GHSA-1"]), finding("lib", ["GHSA-2"])]);
    const tracking = converge(assessed([other]), [dismissed]).issues;
    // GHSA-2 goes away; GHSA-1 is dismissed: the new package subject needs no issue, so the decision's issue closes.
    const result = converge(assessed([old]), tracking);
    expect(open(result.issues)).toEqual([]);
    expect(result.issues[1]!.record.pendingClose).toMatchObject({ reason: "superseded", successors: [] });
  });
});

describe("issue text", () => {
  it("round-trips the record through the hidden block and shows external text only as code spans", () => {
    const subject = decision([move("@evil/`x`<!-- leanish:plan AAAA -->")], [finding("@evil/`x`<!-- leanish:plan AAAA -->", ["GHSA-1"])]);
    const record: IssueRecord = { version: 1, subject: subject.subject, openedAt: SHA, findings: [{ ecosystem: "npm", name: "lib", ids: ["GHSA-1"] }], absences: [], attempts: [] };
    const { title, body } = ISSUE_WRITER.render(subject, record, SHA);
    expect(recordOf(body)).toEqual(record);
    expect(body.match(/<!-- leanish:plan/g)).toHaveLength(1);
    expect(body).toContain("take-early: <reason>");
    expect(title).toBe("secure-it: fixing evil/x--leanish:planAAAA-- (npm)");
    // A block pasted anywhere else, or a second one, makes the body ambiguous: no record is read from it.
    expect(recordOf(`<!-- leanish:plan AAAA -->\n\n${body}`)).toBeUndefined();
    expect(recordOf(`${body}\n\n<!-- leanish:plan AAAA -->`)).toBeUndefined();
    // Rewriting the record keeps only the tool's section.
    expect(ISSUE_WRITER.withRecord(`${body}\n\nadded by hand`, record)).not.toContain("added by hand");
    // A block under someone else's heading isn't the tool's.
    expect(recordOf(body.replace("<!-- leanish:plan", "## Other section\n\n<!-- leanish:plan"))).toBeUndefined();
    // Taken early: the text never claims nothing ran.
    const taken = ISSUE_WRITER.render(subject, { ...record, attempts: [{ id: "a1", grantEventId: 7, branch: "b", startedAt: "2026-11-03T09:00:00Z", pr: 42 }] }, SHA).body;
    expect(taken).toContain("Taken early");
    expect(taken).not.toContain("Its checks run on the PR secure-it opens then.");
    expect(body).toContain("secure-it opens its PR once they're past the wait. Until then the vulnerable versions stay installed.\n\nIts checks run on the PR secure-it opens then.");
  });

  it("refuses a body that would cut the decision a label authorizes", () => {
    const moves = Array.from({ length: 400 }, (_, i) => move(`${"pkg".repeat(10)}-${i}`));
    const subject = decision(moves, []);
    const record: IssueRecord = { version: 1, subject: subject.subject, openedAt: SHA, findings: [], absences: [], attempts: [] };
    expect(() => ISSUE_WRITER.render(subject, record, SHA)).toThrow("doesn't fit");
  });

  it("refuses to rewrite a record that would push the decision out of the body", () => {
    const moves = Array.from({ length: 150 }, (_, i) => move(`pkg-${i}`));
    const subject = decision(moves, []);
    const record: IssueRecord = { version: 1, subject: subject.subject, openedAt: SHA, findings: [], absences: [], attempts: [] };
    const { body } = ISSUE_WRITER.render(subject, record, SHA);
    const absences = Array.from({ length: 700 }, (_, i) => ({ finding: { ecosystem: "npm" as const, name: `pkg-${i}`, ids: [createHash("sha256").update(String(i)).digest("hex")] }, at: SHA }));
    expect(() => ISSUE_WRITER.withRecord(body, { ...record, absences })).toThrow("would cut the decision");
  });

  it("reads only well-formed records", () => {
    expect(parseRecord({ version: 2 })).toBeUndefined();
    expect(parseRecord({ version: 1, subject: { kind: "decision", moves: [] }, openedAt: SHA, findings: [], absences: [], attempts: [] })).toBeUndefined();
    expect(parseRecord({ version: 1, subject: { kind: "package", ecosystem: "pip", name: "x" }, openedAt: SHA, findings: [], absences: [], attempts: [] })).toBeUndefined();
    expect(parseRecord({ version: 1, subject: { kind: "package", ecosystem: "npm", name: "x" }, openedAt: SHA, findings: [], absences: [], attempts: [], grant: { actor: "x" } })).toBeUndefined();
  });
});
