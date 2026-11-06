import { describe, expect, it, vi } from "vitest";

import { MAX_ISSUE_BODY_CHARS } from "@leanish/tool-runtime/github-issues";
import { cleanBody } from "@leanish/tool-runtime/publication-text";

import type { IssueRecord, SubjectAssessment } from "../src/issue-model.ts";
import { ISSUE_WRITER, issueWriter, recordOf, trackingContent, withoutClosingKeywords } from "../src/issue-text.ts";

describe("issueWriter", () => {
  it.each(["", "<!-- leanish:plan "])("cleans a local path straddling the detail cut, including inside %s", (opening) => {
    const subject = { kind: "package" as const, ecosystem: "npm" as const, name: "lib" };
    const before = "registry 502 ".padEnd(966 - opening.length, "x") + " " + opening;
    const assessment: SubjectAssessment = { subject, findings: [], status: { kind: "blocked", reason: "unassessed",
      detail: `${before}/Users/leandro.aguiar/private.txt${opening === "" ? "" : " -->"} ${"y".repeat(100)}` } };
    const record: IssueRecord = { version: 1, subject, openedAt: "a".repeat(40), findings: [], absences: [], attempts: [] };
    const writer = issueWriter((body) => cleanBody(body, { workingCopy: [], other: ["/Users/leandro.aguiar"] }));
    const rendered = writer.render(assessment, record, record.openedAt);
    expect(rendered.body).toContain("<local path>");
    expect(rendered.body).not.toContain("/Users");
    expect(rendered.body).toContain("[truncated]");
    expect(recordOf(rendered.body)).toEqual(record);
  });

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
});

describe("withoutClosingKeywords", () => {
  it("defuses every reference form GitHub closes on, leaving other mentions alone", () => {
    expect(withoutClosingKeywords("Fixes #12. Closes: acme/widget#3, resolved https://github.com/acme/widget/issues/4; see #5"))
      .toBe("Fixes `#12`. Closes: `acme/widget#3`, resolved `https://github.com/acme/widget/issues/4`; see #5");
    expect(withoutClosingKeywords("Fixes gh-12, closes GH-3, fixed http://www.github.com/acme/widget/issues/7; see GH-8"))
      .toBe("Fixes `gh-12`, closes `GH-3`, fixed `http://www.github.com/acme/widget/issues/7`; see GH-8");
  });

  const URL = "https://github.com/acme/widget/issues/4";

  // The forms a real squash-merge closed an issue with, through a PR's description.
  it.each([
    [`Fixes [the bug](${URL})`, `Fixes \`[the bug](${URL})\``],
    [`Fixes: [the bug](${URL})`, `Fixes: \`[the bug](${URL})\``],
    [`Fixes [#4](${URL})`, `Fixes \`[#4](${URL})\``],
    [`Fixes [the bug](${URL} "title")`, `Fixes \`[the bug](${URL} "title")\``],
    [`Fixes [the bug](${URL}#issuecomment-1)`, `Fixes \`[the bug](${URL}#issuecomment-1)\``],
    [`Fixes [the bug](<${URL}>)`, `Fixes \`[the bug](<${URL}>)\``],
    [`Fixes [](${URL})`, `Fixes \`[](${URL})\``],
    [`Fixes [**the [x] bug**](${URL})`, `Fixes \`[**the [x] bug**](${URL})\``],
    [`Fixes [the bug][1]\n\n[1]: ${URL}`, `Fixes \`[the bug][1]\`\n\n[1]: ${URL}`],
    [`Fixes [the bug]\n\n[the bug]: ${URL}`, `Fixes \`[the bug]\`\n\n[the bug]: ${URL}`],
    [`Fixes <${URL}>`, `Fixes \`<${URL}>\``],
    [`Fixes <a href="${URL}">the bug</a>, and more`, `Fixes \`<a href="${URL}">the bug</a>\`, and more`],
    [`FIXES <A HREF="${URL}">the bug</A>`, `FIXES \`<A HREF="${URL}">the bug</A>\``],
    [`Fixes [the long bug\ndescription](${URL})`, `Fixes \`[the long bug description](${URL})\``],
    [`Fixes [\nthe bug](${URL})`, `Fixes \`[ the bug](${URL})\``],
    [`Fixes [the\nbug][1]\n\n[1]: ${URL}`, `Fixes \`[the bug][1]\`\n\n[1]: ${URL}`],
    [`Fixes [the bug](${URL} "title (x)")`, `Fixes \`[the bug](${URL} "title (x)")\``],
    [`Fixes <a\nhref="${URL}">the bug</a>`, `Fixes \`<a href="${URL}">the bug</a>\``],
  ])("defuses a link after a keyword: %s", (text, defused) => {
    expect(withoutClosingKeywords(text)).toBe(defused);
  });

  it("keeps a link's own backticks inside its code span", () => {
    expect(withoutClosingKeywords(`Fixes [the \`bug\`](${URL})`)).toBe(`Fixes \`\`[the \`bug\`](${URL})\`\``);
  });

  it("leaves links no keyword names alone", () => {
    const text = `See [the bug](${URL}), <${URL}> and <a href="${URL}">it</a>. **Fixes** nothing, and [Fixes](${URL}) neither.`;
    expect(withoutClosingKeywords(text)).toBe(text);
  });
});

describe("trackingContent", () => {
  it("ends the body with the one issue line it tracks, dropping any other", () => {
    const content = trackingContent({ title: "t", body: "Tracks #9.\nDone.\nTracks #8.\n", commitMessage: "m" }, 3);
    expect(content.body).toBe("Done.\n\nTracks #3.");
  });
});
