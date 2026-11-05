import { describe, expect, it, vi } from "vitest";

import { FakeIssues } from "@leanish/tool-runtime/test/fake-issues";

import { postNotice } from "../src/issue-notices.ts";
import { noticeMarker } from "../src/issue-text.ts";

const clientOf = (issues: FakeIssues) => ({ issues, repo: "acme/widget", clean: (body: string) => body.replaceAll("/work/repo", "<working copy>") });

describe("postNotice", () => {
  it("cleans a notice and remembers it across callers when the comment listing lags, scoped by repository, issue and id", async () => {
    const issues = new FakeIssues();
    issues.listComments = async () => [];
    const client = clientOf(issues);
    await postNotice(client, 1, "a", "couldn't read /work/repo/package-lock.json");
    await postNotice({ ...client }, 1, "a", "the same notice again");
    expect(issues.comments.get(1)?.map((comment) => comment.body)).toEqual([`couldn't read <working copy>/package-lock.json\n\n${noticeMarker("a")}`]);
    await postNotice(client, 1, "b", "another notice");
    await postNotice(client, 2, "a", "another issue");
    await postNotice({ ...client, repo: "acme/other" }, 1, "a", "another repository");
    expect(issues.comments.get(1)).toHaveLength(3);
    expect(issues.comments.get(2)).toHaveLength(1);
  });

  it("doesn't repost a notice the comment listing already shows, even through a fresh client", async () => {
    const issues = new FakeIssues();
    issues.comment(1, "leanish", `already posted\n\n${noticeMarker("a")}`);
    await postNotice(clientOf(issues), 1, "a", "don't post it again");
    expect(issues.comments.get(1)).toHaveLength(1);
  });

  it("posts a notice whose marker only someone else's comment carries, a comment without an author included", async () => {
    const issues = new FakeIssues();
    issues.comment(1, "outsider", `copied\n\n${noticeMarker("a")}`);
    issues.comments.set(1, [...issues.comments.get(1)!, { id: 1, author: null, body: noticeMarker("a"), createdAt: "2026-11-03T08:00:00Z", updatedAt: "2026-11-03T08:00:00Z" }]);
    await postNotice(clientOf(issues), 1, "a", "the tool's notice");
    expect(issues.comments.get(1)?.map((comment) => comment.author)).toEqual(["outsider", null, "leanish"]);
  });

  it("retries a failed comment write instead of remembering an unposted notice", async () => {
    const issues = new FakeIssues();
    const client = clientOf(issues);
    vi.spyOn(issues, "createComment").mockRejectedValueOnce(new Error("comment write failed"));
    await expect(postNotice(client, 1, "a", "a notice")).rejects.toThrow("comment write failed");
    await postNotice(client, 1, "a", "a notice");
    expect(issues.comments.get(1)?.map((comment) => comment.body)).toEqual([`a notice\n\n${noticeMarker("a")}`]);
  });
});
