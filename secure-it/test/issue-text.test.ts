import { describe, expect, it, vi } from "vitest";

import type { IssueRecord, SubjectAssessment } from "../src/issue-model.ts";
import { ISSUE_WRITER, issueWriter, recordOf, trackingContent, withoutClosingKeywords } from "../src/issue-text.ts";

describe("issueWriter", () => {
  it("cleans rendered and record-only bodies after writing their records, leaving the title and record intact", () => {
    const subject = { kind: "package" as const, ecosystem: "npm" as const, name: "lib" };
    const assessment: SubjectAssessment = { subject, findings: [], status: { kind: "blocked", reason: "unassessed", detail: "couldn't read /work/repo/package-lock.json" } };
    const record: IssueRecord = { version: 1, subject, openedAt: "a".repeat(40), findings: [], absences: [], attempts: [] };
    const clean = vi.fn((body: string) => body.replaceAll("/work/repo", "<working copy>"));
    const writer = issueWriter(clean);
    const raw = ISSUE_WRITER.render(assessment, record, record.openedAt);
    const rendered = writer.render(assessment, record, record.openedAt);
    expect(rendered.title).toBe(raw.title);
    expect(rendered.body).toContain("<working copy>/package-lock.json");
    expect(rendered.body).not.toContain("/work/repo");
    expect(recordOf(rendered.body)).toEqual(record);
    const updated: IssueRecord = { ...record, attempts: [{ id: "a1", grantEventId: 7, branch: "secure-it/2026-11-04-take-early-7", startedAt: "2026-11-04T00:00:00Z" }] };
    const rewritten = writer.withRecord(raw.body, updated);
    expect(rewritten).toContain("<working copy>/package-lock.json");
    expect(rewritten).not.toContain("/work/repo");
    expect(recordOf(rewritten)).toEqual(updated);
    expect(clean.mock.calls).toEqual([[raw.body], [ISSUE_WRITER.withRecord(raw.body, updated)]]);
  });
});

describe("withoutClosingKeywords", () => {
  it("defuses every reference form GitHub closes on, leaving other mentions alone", () => {
    expect(withoutClosingKeywords("Fixes #12. Closes: acme/widget#3, resolved https://github.com/acme/widget/issues/4; see #5"))
      .toBe("Fixes `#12`. Closes: `acme/widget#3`, resolved `https://github.com/acme/widget/issues/4`; see #5");
  });
});

describe("trackingContent", () => {
  it("ends the body with the one issue line it tracks, dropping any other", () => {
    const content = trackingContent({ title: "t", body: "Tracks #9.\nDone.\nTracks #8.\n", commitMessage: "m" }, 3);
    expect(content.body).toBe("Done.\n\nTracks #3.");
  });
});
