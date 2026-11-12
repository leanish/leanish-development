import { describe, expect, it, vi } from "vitest";

import { MAX_ISSUE_BODY_CHARS, MAX_ISSUE_TITLE_CHARS } from "@leanish/tool-runtime/github-issues";
import { cleanBody } from "@leanish/tool-runtime/publication-text";

import type { IssueRecord, SubjectAssessment } from "../src/issue-model.ts";
import { CLOSING_LINE, detailLimits, ISSUE_WRITER, issueWriter, recordOf, trackingContent, withoutClosingKeywords } from "../src/issue-text.ts";

describe("issueWriter", () => {
  it.each(["", "<!-- leanish:plan "])("cleans a local path straddling the detail cut, including inside %s", (opening) => {
    const subject = { kind: "package" as const, ecosystem: "npm" as const, name: "lib" };
    // The padding and the path's length put the path across the cut (1,000 characters minus the cut marker): change them together.
    const before = "registry 502 ".padEnd(966 - opening.length, "x") + " " + opening;
    const assessment: SubjectAssessment = { subject, findings: [], status: { kind: "blocked", reason: "unassessed",
      detail: `${before}/Users/example.person/private.txt${opening === "" ? "" : " -->"} ${"y".repeat(100)}` } };
    const record: IssueRecord = { version: 1, subject, openedAt: "a".repeat(40), findings: [], absences: [], attempts: [] };
    const writer = issueWriter((body) => cleanBody(body, { workingCopy: [], other: ["/Users/example.person"] }));
    const rendered = writer.render(assessment, record, record.openedAt);
    expect(rendered.body).toContain("<local path>");
    expect(rendered.body).not.toContain("/Users");
    expect(rendered.body).toContain("[truncated]");
    expect(recordOf(rendered.body)).toEqual(record);
  });

  it("cleans a local path straddling a refusal's longer cut too", () => {
    const subject = { kind: "package" as const, ecosystem: "npm" as const, name: "lib" };
    // The padding and the path's length put the path across the cut (10,000 characters minus the cut marker): change them together.
    const assessment: SubjectAssessment = { subject, findings: [], status: { kind: "blocked", reason: "not-taken",
      detail: `${"x".repeat(9_970)} /Users/example.person/private.txt ${"y".repeat(100)}` } };
    const record: IssueRecord = { version: 1, subject, openedAt: "a".repeat(40), findings: [], absences: [], attempts: [] };
    const writer = issueWriter((body) => cleanBody(body, { workingCopy: [], other: ["/Users/example.person"] }));
    const rendered = writer.render(assessment, record, record.openedAt);
    expect(rendered.body).toContain("<local path>");
    expect(rendered.body).not.toContain("/Users");
    expect(rendered.body).toContain("[truncated]");
    expect(recordOf(rendered.body)).toEqual(record);
  });

  it("cuts a refusal shorter when its record leaves too little room, keeping the record whole", () => {
    const record = largeRecord(800);
    const rendered = renderRefusal(record, `a short first reason; ${"a long second reason ".repeat(500)}`);
    expect(rendered.body).toContain("a short first reason");
    expect(rendered.body).toContain("[truncated]");
    expect(blockedLine(rendered.body).length).toBeLessThan(10_000);
    expect(rendered.body.length).toBeLessThanOrEqual(MAX_ISSUE_BODY_CHARS);
    expect(recordOf(rendered.body)).toEqual(record);
  });

  it("says what closing the issue does, even when the rest of its body is cut", () => {
    const record = largeRecord(800);
    const rendered = renderRefusal(record, `a short first reason; ${"a long second reason ".repeat(500)}`);
    expect(rendered.body).toContain("[truncated]");
    expect(rendered.body).toContain(CLOSING_LINE);
    expect(CLOSING_LINE).toBe("Closing this issue by hand dismisses its findings; a closing by a PR, a commit or a bot doesn't. Neither changes what the gate checks or closes an open PR.");
  });

  it("cuts a refusal shorter when its backticks widen the code span around it", () => {
    // One long backtick run: the span's fence grows with it, so the line takes about three times the detail's length.
    const record = largeRecord(500);
    const rendered = renderRefusal(record, `reason ${"`".repeat(9_000)} end`);
    expect(rendered.body).toContain("[truncated]");
    expect(rendered.body.length).toBeLessThanOrEqual(MAX_ISSUE_BODY_CHARS);
    expect(recordOf(rendered.body)).toEqual(record);
  });

  it("cuts a shorter refusal without leaving half a surrogate pair", () => {
    const record = largeRecord(800);
    const rendered = renderRefusal(record, "😀".repeat(6_000));
    expect(blockedLine(rendered.body).length).toBeLessThan(10_000);
    expect(rendered.body).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
    expect(recordOf(rendered.body)).toEqual(record);
  });

  it("refuses the decision itself, not the record, once even the shortest refusal doesn't fit beside it", () => {
    // The room between the shortest cut no longer fitting and the record alone not fitting is a few hundred
    // characters of record, so search for the first refused record rather than pin a count that only fits today.
    const refusalAt = (count: number): Error | undefined => {
      try {
        renderRefusal(largeRecord(count), "x".repeat(10_000));
        return undefined;
      } catch (error) {
        return error as Error;
      }
    };
    let fits = 500;
    let refused = 1_200;
    expect(refusalAt(fits)).toBeUndefined();
    expect(refusalAt(refused)).toBeDefined();
    while (refused - fits > 1) {
      const middle = Math.floor((fits + refused) / 2);
      if (refusalAt(middle) === undefined) fits = middle;
      else refused = middle;
    }
    expect(refusalAt(refused)?.message).toContain("the issue's decision doesn't fit its body");
    // About ten renders of a record near the section's limit, each compressing it up to six times: ~3 s locally, ~10 s on CI.
  }, 60_000);

  it("cuts a planning detail without leaving half a surrogate pair", () => {
    const subject = { kind: "package" as const, ecosystem: "npm" as const, name: "lib" };
    const end = 1_000 - " ... [truncated]".length;
    const assessment: SubjectAssessment = { subject, findings: [], status: { kind: "blocked", reason: "unassessed",
      detail: `${"x".repeat(end - 1)}🚀${"y".repeat(100)}` } };
    const record: IssueRecord = { version: 1, subject, openedAt: "a".repeat(40), findings: [], absences: [], attempts: [] };
    const rendered = issueWriter((body) => body).render(assessment, record, record.openedAt);
    expect(rendered.body).toContain("[truncated]");
    expect(rendered.body.isWellFormed()).toBe(true);
  });

  it.each([
    { kind: "backtick fences", tail: "`".repeat(100_000) },
    { kind: "paths cleaning expands", tail: " /a".repeat(100_000) },
  ])("visibly cuts an enormous planning cause with $kind without overflowing or losing the issue record", ({ tail }) => {
    const subject = { kind: "package" as const, ecosystem: "npm" as const, name: "lib" };
    const assessment: SubjectAssessment = { subject, findings: Array.from({ length: 1_000 }, (_, i) => ({ ecosystem: "npm", name: "lib", ids: [`GHSA-${i}`],
      versions: ["1.0.0"], reviewed: true, malicious: false, severity: "HIGH" })),
      status: { kind: "blocked", reason: "unassessed", detail: `registry 502 reading /work/repo/package-lock.json and /a/log ${tail} end of error` } };
    const record: IssueRecord = { version: 1, subject, openedAt: "a".repeat(40), findings: [], absences: [], attempts: [] };
    const writer = issueWriter((body) => cleanBody(body, { workingCopy: ["/work/repo"], other: ["/a"] }));
    const rendered = writer.render(assessment, record, record.openedAt);
    expect(rendered.body).toContain("registry 502 reading package-lock.json and <local path>");
    expect(rendered.body).not.toContain("/work/repo");
    expect(rendered.body).not.toContain("/a");
    expect(rendered.body).toContain("[truncated]");
    expect(rendered.body).not.toContain("end of error");
    expect(rendered.body.length).toBeLessThanOrEqual(MAX_ISSUE_BODY_CHARS);
    expect(recordOf(rendered.body)).toEqual(record);
  });

  it("cleans details before cutting and whole bodies after writing their records, leaving the title and record intact", () => {
    const subject = { kind: "package" as const, ecosystem: "npm" as const, name: "lib" };
    const detail = "couldn't read /work/repo/package-lock.json";
    const assessment: SubjectAssessment = { subject, findings: [], status: { kind: "blocked", reason: "unassessed", detail } };
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
    expect(clean.mock.calls).toEqual([[detail], [raw.body.replaceAll("/work/repo", "<working copy>")], [ISSUE_WRITER.withRecord(raw.body, updated)]]);
  });
});

describe("an early attempt on a waiting decision", () => {
  const subject = { kind: "decision" as const, moves: [{ ecosystem: "npm" as const, name: "lib", from: "1.0.0", to: "1.0.1" }] };
  const assessment: SubjectAssessment = { subject, findings: [], status: { kind: "waiting", young: [{ ecosystem: "npm", name: "lib", version: "1.0.1", eligibleAt: "2026-11-10T00:00:00.000Z" }] } };
  const attempt = { id: "7-1", grantEventId: 7, branch: "secure-it/2026-11-03-take-early-7", startedAt: "2026-11-03T08:02:00.000Z" };
  const body = (attempts: IssueRecord["attempts"]) => ISSUE_WRITER.render(assessment, { version: 1, subject, openedAt: "a".repeat(40), findings: [], absences: [], attempts }, "a".repeat(40)).body;

  it("says it was taken early only once an attempt published its PR", () => {
    expect(body([{ ...attempt, pr: 9 }])).toContain("**Taken early.**");
  });

  it("says an attempt is running, not that it carried anything out, before it published", () => {
    const text = body([attempt]);
    expect(text).toContain("**Taking it early.**");
    expect(text).not.toContain("**Taken early.**");
  });

  it("goes back to waiting when an attempt ended before publishing, listing it", () => {
    const text = body([{ ...attempt, outcome: "failed" }]);
    expect(text).toContain("**Waiting for the release-age wait.**");
    expect(text).not.toContain("Taken early");
    expect(text).toContain("Early attempt `7-1` started `2026-11-03T08:02:00.000Z`: failed.");
  });

  it("goes back to waiting when the attempt's PR was closed unmerged", () => {
    const text = body([{ ...attempt, pr: 9, outcome: "pr-closed" }]);
    expect(text).toContain("**Waiting for the release-age wait.**");
    expect(text).not.toContain("Taken early");
  });

  it("says versions were selected before their wait ended, true even once their date has passed", () => {
    const text = body([]);
    expect(text).toContain("The fix takes versions selected before their wait ended; secure-it tries to open its PR once a run finds them past it.");
    expect(text).toContain("Selected before their wait ended:\n- `npm lib@1.0.1`, past it on `2026-11-10T00:00:00.000Z`");
    expect(text).not.toContain("inside the wait");
    expect(body([attempt])).toContain("The versions selected before their wait ended are listed after the moves.");
    expect(body([{ ...attempt, pr: 9 }])).toContain("The versions selected before their wait ended are listed after the moves.");
  });

  it("says when a version's publication date can't be read, instead of a date", () => {
    const unknown: SubjectAssessment = { ...assessment, status: { kind: "waiting", young: [{ ecosystem: "npm", name: "lib", version: "1.0.1", eligibleAt: "unknown" }] } };
    const text = ISSUE_WRITER.render(unknown, { version: 1, subject, openedAt: "a".repeat(40), findings: [], absences: [], attempts: [] }, "a".repeat(40)).body;
    expect(text).toContain("- `npm lib@1.0.1`, whose publication date can't be read");
    expect(text).not.toContain("past it on");
  });
});

/** A record whose findings carry ids that don't compress, so it really takes most of the issue's section. */
function largeRecord(count: number): IssueRecord {
  const subject = { kind: "package" as const, ecosystem: "npm" as const, name: "lib" };
  let seed = 7;
  const id = () => Array.from({ length: 24 }, () => ((seed = (seed * 48_271) % 2_147_483_647) % 36).toString(36)).join("");
  const findings = Array.from({ length: count }, () => ({ ecosystem: "npm" as const, name: `lib-${id()}`, ids: [`GHSA-${id()}`] }));
  return { version: 1, subject, openedAt: "a".repeat(40), findings, absences: [], attempts: [] };
}

function renderRefusal(record: IssueRecord, detail: string): { readonly title: string; readonly body: string } {
  const assessment: SubjectAssessment = { subject: record.subject, findings: [], status: { kind: "blocked", reason: "not-taken", detail } };
  return issueWriter((body) => body).render(assessment, record, record.openedAt);
}

function blockedLine(body: string): string {
  const line = body.split("\n").find((candidate) => candidate.startsWith("**Blocked:**"));
  if (line === undefined) throw new Error("the body has no blocked line");
  return line;
}

describe("detailLimits", () => {
  it("halves a blocked detail's cut down to 500 characters itself, and leaves other statuses one try", () => {
    expect(detailLimits({ kind: "blocked", reason: "not-taken", detail: "" })).toEqual([10_000, 5_000, 2_500, 1_250, 625, 500]);
    expect(detailLimits({ kind: "blocked", reason: "unassessed", detail: "" })).toEqual([1_000, 500]);
    expect(detailLimits({ kind: "eligible", trusted: [] })).toEqual([10_000]);
  });
});

describe("an issue's title", () => {
  const record = (subject: IssueRecord["subject"]): IssueRecord => ({ version: 1, subject, openedAt: "a".repeat(40), findings: [], absences: [], attempts: [] });

  it("stays within GitHub's limit, however long its names are", () => {
    const name = `${"g".repeat(200)}:${"a".repeat(200)}`;
    const subject = { kind: "decision" as const, moves: [name, `${name}2`, `${name}3`, `${name}4`].map((entry) => ({ ecosystem: "Maven" as const, name: entry, from: "1", to: "2" })) };
    const assessment: SubjectAssessment = { subject, findings: [], status: { kind: "eligible", trusted: [] } };
    const { title } = ISSUE_WRITER.render(assessment, record(subject), "a".repeat(40));
    expect(title.length).toBeLessThanOrEqual(MAX_ISSUE_TITLE_CHARS);
    expect(title).toContain("...");
  });
});

describe("withoutClosingKeywords", () => {
  it("defuses every reference form GitHub closes on, leaving other mentions alone", () => {
    expect(withoutClosingKeywords("Fixes #12. Closes: acme/widget#3, resolved https://github.com/acme/widget/issues/4; see #5"))
      .toBe("Fixes `#12`. Closes: `acme/widget#3`, resolved `https://github.com/acme/widget/issues/4`; see #5");
    expect(withoutClosingKeywords("Fixes gh-12, closes GH-3, fixed http://www.github.com/acme/widget/issues/7; see GH-8"))
      .toBe("Fixes `gh-12`, closes `GH-3`, fixed `http://www.github.com/acme/widget/issues/7`; see GH-8");
  });
});

describe("trackingContent", () => {
  it("ends the body with the one issue line it tracks, dropping any other", () => {
    const content = trackingContent({ title: "t", body: "Tracks #9.\nDone.\nTracks #8.\n", commitMessage: "m" }, 3);
    expect(content.body).toBe("Done.\n\nTracks #3.");
  });
});
