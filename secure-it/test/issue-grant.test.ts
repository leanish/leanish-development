import { describe, expect, it } from "vitest";

import { type GrantComment, type GrantEvent, type GrantInput, grantOf, type Permission } from "../src/issue-grant.ts";
import type { Attempt, IssueRecord, SubjectStatus } from "../src/issue-model.ts";

const LABELED_AT = "2026-11-03T08:01:00Z";
const young = (version: string) => ({ ecosystem: "npm" as const, name: "lib", version, eligibleAt: "2026-11-10T00:00:00Z" });

const record: IssueRecord = {
  version: 1,
  subject: { kind: "decision", moves: [{ ecosystem: "npm", name: "lib", from: "1.0.0", to: "1.0.1" }] },
  openedAt: "a".repeat(40),
  findings: [{ ecosystem: "npm", name: "lib", ids: ["GHSA-1"] }],
  absences: [],
  attempts: [],
  // What the issue showed before the label.
  shown: { young: [{ ecosystem: "npm", name: "lib", version: "1.0.1" }], since: "2026-11-03T07:00:00.000Z" },
};

const labeled = (id: number, actor = "owner", createdAt = LABELED_AT): GrantEvent => ({ id, event: "labeled", actor, createdAt, label: "take-early" });
const reason = (id: number, author = "owner", createdAt = "2026-11-03T08:00:00Z", updatedAt = createdAt, body = "take-early: actively exploited"): GrantComment => ({ id, author, body, createdAt, updatedAt });

function input(overrides: Partial<GrantInput> = {}): GrantInput {
  return {
    state: "open",
    labels: ["take-early"],
    record,
    status: { kind: "waiting", young: [young("1.0.1")] },
    events: [labeled(7)],
    comments: [reason(5)],
    permissions: new Map<string, Permission>([["owner", "admin"], ["helper", "triage"]]),
    ...overrides,
  };
}

describe("grantOf", () => {
  it("grants the current label of a writer after their reason, for the young versions of now", () => {
    expect(grantOf(input())).toEqual({
      kind: "granted",
      grant: { labelEventId: 7, reasonCommentId: 5, actor: "owner", at: LABELED_AT, young: [{ ecosystem: "npm", name: "lib", version: "1.0.1" }] },
    });
  });

  it("reads a take-early label made by hand in another casing as the label, as GitHub matches it", () => {
    const cased = (event: GrantEvent): GrantEvent => ({ ...event, label: "Take-Early" });
    expect(grantOf(input({ labels: ["Take-Early"], events: [cased(labeled(7))] }))).toMatchObject({ kind: "granted", grant: { labelEventId: 7 } });
    // Its removal and a later label are read too, in either casing: the later one, with its own new reason, grants.
    const removed = cased({ id: 8, event: "unlabeled", actor: "owner", createdAt: "2026-11-03T08:02:00Z" });
    const again = reason(6, "owner", "2026-11-03T08:02:30Z", "2026-11-03T08:02:30Z", "take-early: still exploited");
    expect(grantOf(input({ labels: ["take-early"], events: [cased(labeled(7)), removed, labeled(9, "owner", "2026-11-03T08:03:00Z")], comments: [reason(5), again] })))
      .toMatchObject({ kind: "granted", grant: { labelEventId: 9, reasonCommentId: 6 } });
  });

  it("never grants a first label for a young version its issue didn't show, even when the times allow it", () => {
    // The issue showed only lib@1.0.1 (an update adding lib-dep couldn't be written); the decision now takes both.
    const status: SubjectStatus = { kind: "waiting", young: [young("1.0.1"), { ecosystem: "npm", name: "lib-dep", version: "2.0.1", eligibleAt: "2026-11-10T00:00:00Z" }] };
    expect(grantOf(input({ status }))).toEqual({
      kind: "refused", noticeId: "take-early:7:young-unshown",
      reason: "the decision takes npm lib-dep@2.0.1, which its issue didn't show when it was labeled; label it again once it shows that",
    });
    // Only versions it showed still grant, as before.
    expect(grantOf(input())).toMatchObject({ kind: "granted" });
  });

  it("doesn't let a first label cover young versions the issue showed only after it was added", () => {
    // The same moves now also take lib-dep@2.0.1 (a probe brought it in), shown by the run after the label.
    const later = { ...record, shown: { young: [{ ecosystem: "npm" as const, name: "lib", version: "1.0.1" }, { ecosystem: "npm" as const, name: "lib-dep", version: "2.0.1" }], since: "2026-11-03T09:00:00.000Z" } };
    const status: SubjectStatus = { kind: "waiting", young: [young("1.0.1"), { ...young("2.0.1"), name: "lib-dep" }] };
    expect(grantOf(input({ record: later, status }))).toMatchObject({ kind: "refused", noticeId: "take-early:7:young-shown",
      reason: "the decision's young versions changed after the label (now npm lib@1.0.1, npm lib-dep@2.0.1); a new reason and label authorize them" });
    // Nothing recorded what the issue showed: fail closed.
    const { shown: _shown, ...unknown } = record;
    expect(grantOf(input({ record: unknown }))).toMatchObject({ kind: "refused", noticeId: "take-early:7:young-shown" });
    // While the issue is being rewritten with a newcomer, nothing authorizes anything.
    expect(grantOf(input({ record: { ...record, shown: { ...record.shown!, since: "pending" } } }))).toMatchObject({ kind: "refused", noticeId: "take-early:7:young-pending" });
    // A label added after that run covers both.
    expect(grantOf(input({ record: later, status, events: [labeled(9, "owner", "2026-11-03T09:05:00Z")], comments: [reason(8, "owner", "2026-11-03T09:04:00Z")] }))).toMatchObject({ kind: "granted" });
  });

  it("has nothing to grant without a current label", () => {
    expect(grantOf(input({ labels: [] }))).toEqual({ kind: "none" });
    expect(grantOf(input({ events: [labeled(7), { id: 8, event: "unlabeled", actor: "owner", createdAt: LABELED_AT, label: "take-early" }] }))).toEqual({ kind: "none" });
    // Nothing waits: no early fix to authorize.
    expect(grantOf(input({ status: { kind: "eligible", trusted: [] } }))).toEqual({ kind: "none" });
  });

  it("refuses a label without write access, without a reason before it, or with a reason edited after it", () => {
    expect(grantOf(input({ events: [labeled(7, "helper")], comments: [reason(5, "helper")] }))).toMatchObject({ kind: "refused", noticeId: "take-early:7:permission" });
    expect(grantOf(input({ events: [labeled(7, "stranger")], comments: [reason(5, "stranger")] }))).toMatchObject({ kind: "refused", noticeId: "take-early:7:permission" });
    expect(grantOf(input({ comments: [] }))).toMatchObject({ kind: "refused", noticeId: "take-early:7:reason" });
    expect(grantOf(input({ comments: [reason(5, "someone-else")] }))).toMatchObject({ kind: "refused", noticeId: "take-early:7:reason" });
    expect(grantOf(input({ comments: [reason(9, "owner", "2026-11-03T09:00:00Z")] }))).toMatchObject({ kind: "refused", noticeId: "take-early:7:reason" });
    expect(grantOf(input({ comments: [reason(5, "owner", "2026-11-03T08:00:00Z", "2026-11-03T09:00:00Z")] }))).toMatchObject({ kind: "refused", noticeId: "take-early:7:reason" });
    expect(grantOf(input({ comments: [reason(5, "owner", undefined, undefined, "take-early:   ")] }))).toMatchObject({ kind: "refused", noticeId: "take-early:7:reason" });
  });

  it("refuses on a closed, closing or package issue", () => {
    expect(grantOf(input({ state: "closed" }))).toMatchObject({ kind: "refused", noticeId: "take-early:7:closed" });
    expect(grantOf(input({ record: { ...record, pendingClose: { id: "c", reason: "superseded", successors: [9], at: "x" } } }))).toMatchObject({ kind: "refused", noticeId: "take-early:7:closing" });
    expect(grantOf(input({ record: { ...record, subject: { kind: "package", ecosystem: "npm", name: "lib" } } }))).toMatchObject({ kind: "refused", noticeId: "take-early:7:no-decision" });
  });

  it("keeps a recorded grant while its young versions age, and voids it when a new young one appears", () => {
    const granted = { ...record, grant: { labelEventId: 7, reasonCommentId: 5, actor: "owner", at: LABELED_AT, young: [{ ecosystem: "npm" as const, name: "lib", version: "1.0.1" }, { ecosystem: "npm" as const, name: "peer", version: "2.0.0" }] } };
    const fewer: SubjectStatus = { kind: "waiting", young: [young("1.0.1")] };
    expect(grantOf(input({ record: granted, status: fewer }))).toEqual({ kind: "granted", grant: granted.grant });
    const more: SubjectStatus = { kind: "waiting", young: [young("1.0.1"), { ecosystem: "npm", name: "other", version: "3.0.0", eligibleAt: "x" }] };
    expect(grantOf(input({ record: granted, status: more }))).toMatchObject({ kind: "refused", noticeId: "take-early:7:young" });
  });

  it("voids a recorded grant whose reason was edited or deleted since", () => {
    const grant = { labelEventId: 7, reasonCommentId: 5, actor: "owner", at: LABELED_AT, young: [{ ecosystem: "npm" as const, name: "lib", version: "1.0.1" }] };
    const granted = { ...record, grant };
    expect(grantOf(input({ record: granted, comments: [reason(5, "owner", "2026-11-03T08:00:00Z", "2026-11-03T09:00:00Z")] }))).toMatchObject({ kind: "refused", noticeId: "take-early:7:reason-changed" });
    expect(grantOf(input({ record: granted, comments: [] }))).toMatchObject({ kind: "refused", noticeId: "take-early:7:reason-changed" });
  });

  it("runs one attempt per label, continues a running one, and never lets a new label replace it", () => {
    const grant = { labelEventId: 7, reasonCommentId: 5, actor: "owner", at: LABELED_AT, young: [{ ecosystem: "npm" as const, name: "lib", version: "1.0.1" }] };
    const attempt = (overrides: Partial<Attempt> = {}): Attempt => ({ id: "a1", grantEventId: 7, branch: "secure-it/x", startedAt: LABELED_AT, ...overrides });
    expect(grantOf(input({ record: { ...record, grant, attempts: [attempt()] } }))).toEqual({ kind: "granted", grant });
    expect(grantOf(input({ record: { ...record, grant, attempts: [attempt({ outcome: "pr-closed" })] } }))).toMatchObject({ kind: "refused", noticeId: "take-early:7:spent" });
    // A new label and reason after the spent attempt: a new grant.
    const renewed = input({ record: { ...record, grant, attempts: [attempt({ outcome: "pr-closed" })] }, events: [labeled(7), { id: 8, event: "unlabeled", actor: "owner", createdAt: LABELED_AT, label: "take-early" }, labeled(9, "owner", "2026-11-04T10:00:00Z")], comments: [reason(5), reason(11, "owner", "2026-11-04T09:00:00Z")] });
    expect(grantOf(renewed)).toMatchObject({ kind: "granted", grant: { labelEventId: 9, reasonCommentId: 11 } });
    // A new label reusing the spent grant's reason, or one written before that grant: refused.
    const reused = input({ record: { ...record, grant, attempts: [attempt({ outcome: "pr-closed" })] }, events: [labeled(7), { id: 8, event: "unlabeled", actor: "owner", createdAt: LABELED_AT, label: "take-early" }, labeled(9, "owner", "2026-11-04T10:00:00Z")] });
    expect(grantOf(reused)).toMatchObject({ kind: "refused", noticeId: "take-early:9:reason-reused" });
    // A new label while the earlier attempt still runs: refused.
    const replacing = input({ record: { ...record, grant, attempts: [attempt()] }, events: [labeled(7), { id: 8, event: "unlabeled", actor: "owner", createdAt: LABELED_AT, label: "take-early" }, labeled(9)] });
    expect(grantOf(replacing)).toMatchObject({ kind: "refused", noticeId: "take-early:9:running" });
  });
});
