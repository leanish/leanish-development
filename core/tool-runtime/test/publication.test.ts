import { describe, expect, it } from "vitest";

import { MAX_BODY_CHARS, MAX_TITLE_CHARS } from "@leanish/agent-runtime/github/github-client";
import { ConsoleLogger } from "@leanish/agent-runtime/logger/console-logger";
import type { GitHubPullRequest } from "@leanish/agent-runtime/types/clients";
import type { PreparedBranch, WorkingCopy } from "@leanish/agent-runtime/types/working-copy";
import { InMemoryWorkspace } from "@leanish/agent-runtime/working-copy/in-memory-workspace";
import { ownPullRequests, stateOf, withMarker, verifiedStateOf } from "../src/own-pr.ts";
import { assertPublishable, clearLeftoverBranch, closeAndDelete, markReady, ownOpenPullRequests, publishNew, publishUpdate, recordState, rewriteText, type PublicationContext } from "../src/publication.ts";
import { BASE_SHA, FakeGitHub, HEAD_SHA, OWN_BRANCH, ownPr, PUSHED_SHA, RULES, SIGNED, signedRecord, TEST_SIGNING_KEY } from "./fake-github.ts";

const WC: WorkingCopy = { projectId: "leanish/widget", path: "/synthetic/leanish/widget", branch: "main", headSha: BASE_SHA, gitDir: "/x/.git" };
const CONTENT = { title: "fixing snappy-java", body: "Moves snappy-java to 1.1.10.10.", commitMessage: "moving snappy-java to 1.1.10.10" };

function context(github: FakeGitHub, workspace = new InMemoryWorkspace()): PublicationContext {
  return { rules: RULES, github, workspace, logger: new ConsoleLogger({ minLevel: "error" }), repo: "leanish/widget", signingKey: TEST_SIGNING_KEY, base: "main", workingCopy: WC, localRoots: ["/Users/dev"] };
}

/** Records the title and body of every body update `github` is asked for. */
function bodyUpdatesOf(github: FakeGitHub): Array<{ readonly title: string; readonly body: string }> {
  const sent: Array<{ readonly title: string; readonly body: string }> = [];
  const update = github.updatePullRequest.bind(github);
  github.updatePullRequest = async (args) => {
    sent.push({ title: args.title, body: args.body });
    return update(args);
  };
  return sent;
}

/** Every body update fails, and leaves #7 as `after` says: by default at the tool's push, its body naming the old head. */
function failingBodyUpdates(github: FakeGitHub, after: Partial<GitHubPullRequest> = { headSha: PUSHED_SHA }): void {
  const fail = () => {
    github.prs.set(7, { ...github.prs.get(7)!, ...after });
    github.fail("updatePullRequest");
    github.before("updatePullRequest", fail);
  };
  github.before("updatePullRequest", fail);
}

const fresh: PreparedBranch = { branch: "secure-it/2026-10-07-vite", baseSha: BASE_SHA, remoteHeadSha: null, preparedSha: BASE_SHA };
const existing: PreparedBranch = { branch: OWN_BRANCH, baseSha: BASE_SHA, remoteHeadSha: HEAD_SHA, preparedSha: HEAD_SHA };

describe("publication", () => {
  it.each([
    { operation: "create", body: "/t ".repeat(6_000), kind: "expanded paths" },
    { operation: "update", body: "/t ".repeat(21_000), kind: "expanded paths" },
    { operation: "create", body: "😀".repeat(32_700), kind: "astral characters" },
    { operation: "update", body: "😀".repeat(32_700), kind: "astral characters" },
  ])("refuses $kind on $operation before any push or PR edit", async ({ operation, body }) => {
    const github = new FakeGitHub(...(operation === "update" ? [ownPr({ isDraft: false })] : []));
    const workspace = new InMemoryWorkspace();
    const ctx = { ...context(github, workspace), localRoots: ["/t"] };
    // Raw text fits the client limit, but cleaning or the appended marker makes the actual body exceed it.
    expect(body.length).toBeLessThan(65_536);
    const publish = operation === "create"
      ? publishNew(ctx, fresh, { ...CONTENT, body })
      : publishUpdate(ctx, existing, 7, { ...CONTENT, body });
    await expect(publish).rejects.toThrow(new RegExp(`would be [0-9]+ UTF-16 units, over the client's ${MAX_BODY_CHARS} limit`));
    expect(workspace.pushes).toEqual([]);
    expect(github.calls.filter((call) => /createPullRequest|updatePullRequest|convertToDraft/.test(call))).toEqual([]);
    expect(github.prs.get(7)?.body).toBe(operation === "update" ? ownPr().body : undefined);
  });

  it.each(["create", "update"] as const)("refuses invalid cleaned titles on %s before any push or PR edit", async (operation) => {
    for (const title of ["", "  ", "x".repeat(MAX_TITLE_CHARS + 1), "😀".repeat(129), "/t ".repeat(20)]) {
      const github = new FakeGitHub(...(operation === "update" ? [ownPr({ isDraft: false })] : []));
      const workspace = new InMemoryWorkspace();
      const ctx = { ...context(github, workspace), localRoots: ["/t"] };
      const content = { ...CONTENT, title };
      const publish = operation === "create" ? publishNew(ctx, fresh, content) : publishUpdate(ctx, existing, 7, content);
      await expect(publish).rejects.toThrow(/the PR title/);
      expect(workspace.pushes).toEqual([]);
      expect(github.calls.filter((call) => /createPullRequest|updatePullRequest|convertToDraft/.test(call))).toEqual([]);
      expect(github.prs.get(7)?.body).toBe(operation === "update" ? ownPr().body : undefined);
    }
  });

  it("accepts a cleaned title at the client's limit and refuses invalid text-only rewrites", async () => {
    const title = "😀".repeat(MAX_TITLE_CHARS / 2);
    const created = await publishNew(context(new FakeGitHub()), fresh, { ...CONTENT, title });
    expect(created?.title).toBe(title);
    const github = new FakeGitHub(ownPr({ title: "/t ".repeat(20) }));
    await expect(rewriteText({ ...context(github), localRoots: ["/t"] }, 7, HEAD_SHA, (body) => body)).resolves.toBeDefined();
    // Rewriting text keeps the stored title verbatim; an invalid stored title is refused before its API write.
    github.prs.set(7, ownPr({ title: "x".repeat(MAX_TITLE_CHARS + 1) }));
    const calls = github.calls.length;
    await expect(rewriteText(context(github), 7, HEAD_SHA, (body) => body)).rejects.toThrow("the PR title would be 257");
    expect(github.calls.slice(calls).some((call) => call.startsWith("updatePullRequest"))).toBe(false);
  });

  it.each(["create", "update"] as const)("checks the exact %s client limit in UTF-16 units, including its marker", async (operation) => {
    const limit = MAX_BODY_CHARS;
    const state = { head: PUSHED_SHA, base: BASE_SHA, adaptations: 0 };
    const tail = withMarker(SIGNED, "x", state).length - 1;
    const available = limit - tail;
    const body = "😀".repeat(Math.floor(available / 2)) + "x".repeat(available % 2);
    const github = new FakeGitHub(...(operation === "update" ? [ownPr()] : []));
    const ctx = context(github);
    if (operation === "create") {
      const pr = await publishNew(ctx, fresh, { ...CONTENT, body });
      expect(pr!.body).toHaveLength(limit);
      await expect(publishNew(context(new FakeGitHub()), fresh, { ...CONTENT, body: body + "x" })).rejects.toThrow(`${limit + 1} UTF-16 units`);
    } else {
      const pr = await publishUpdate(ctx, existing, 7, { ...CONTENT, body });
      expect(pr.pr.body).toHaveLength(limit);
      await expect(publishUpdate(context(new FakeGitHub(ownPr())), existing, 7, { ...CONTENT, body: body + "x" })).rejects.toThrow(`${limit + 1} UTF-16 units`);
    }
  });

  it("lets callers check the text publication would send, cleaned and marked, without touching GitHub", () => {
    const github = new FakeGitHub();
    const tail = withMarker(SIGNED, "x", { head: PUSHED_SHA, base: BASE_SHA, adaptations: 0 }).length - 1;
    const body = "x".repeat(MAX_BODY_CHARS - tail);
    expect(() => assertPublishable(context(github), { ...CONTENT, body })).not.toThrow();
    expect(() => assertPublishable(context(github), { ...CONTENT, body: `${body}x` })).toThrow(`${MAX_BODY_CHARS + 1} UTF-16 units`);
    // Raw text that fits, but cleaning expands its paths past the limit.
    const paths = "/t ".repeat(6_000);
    expect(paths.length).toBeLessThan(MAX_BODY_CHARS);
    expect(() => assertPublishable({ ...context(github), localRoots: ["/t"] }, { ...CONTENT, body: paths })).toThrow(`over the client's ${MAX_BODY_CHARS} limit`);
    expect(() => assertPublishable(context(github), { ...CONTENT, title: " " })).toThrow("the PR title is empty");
    expect(github.calls).toEqual([]);
  });

  it("makes the fake enforce the same UTF-16 body cap on create and update as the real client", async () => {
    const github = new FakeGitHub(ownPr());
    const body = "😀".repeat(MAX_BODY_CHARS / 2);
    const created = await github.createPullRequest({ repo: WC.projectId, head: fresh.branch, base: "main", title: CONTENT.title, body, draft: true });
    expect(created.body).toHaveLength(MAX_BODY_CHARS);
    await expect(github.createPullRequest({ repo: WC.projectId, head: fresh.branch, base: "main", title: CONTENT.title, body: body + "x", draft: true })).rejects.toThrow("body too long");
    await github.updatePullRequest({ repo: WC.projectId, number: 7, title: CONTENT.title, body });
    await expect(github.updatePullRequest({ repo: WC.projectId, number: 7, title: CONTENT.title, body: body + "x" })).rejects.toThrow("body too long");
    expect(github.prs.get(7)?.body).toBe(body);
  });

  it("refuses oversized text rewrites without changing the PR", async () => {
    const github = new FakeGitHub(ownPr());
    await expect(rewriteText({ ...context(github), localRoots: ["/t"] }, 7, HEAD_SHA, () => "/t ".repeat(21_000)))
      .rejects.toThrow("over the client's 65536 limit");
    expect(github.prs.get(7)?.body).toBe(ownPr().body);
    expect(github.calls.some((call) => call.startsWith("updatePullRequest"))).toBe(false);
  });

  it("rewrites a PR's text from its body as it is now, keeping its state and an owner's edit", async () => {
    const state = { head: HEAD_SHA, base: BASE_SHA, adaptations: 1 };
    const github = new FakeGitHub(ownPr({ body: withMarker(SIGNED, "An owner's added note.\n\nold reasons", state) }));
    await rewriteText(context(github), 7, HEAD_SHA, (body) => body.replace("old reasons", "new reasons"));
    const body = github.prs.get(7)!.body;
    expect([body.includes("An owner's added note."), body.includes("new reasons"), body.includes("old reasons")]).toEqual([true, true, false]);
    expect(stateOf(body)).toEqual(state);
    await expect(rewriteText(context(github), 7, PUSHED_SHA, (text) => text)).rejects.toThrow();
  });

  it.each(["secure-it", "bump-it"] as const)("adds %s's label when publishing or updating", async (tool) => {
    const rules = ownPullRequests(tool);
    const branch = `${tool}/2026-10-05-security`;
    const created = new FakeGitHub();
    const pr = await publishNew({ ...context(created), rules }, { ...fresh, branch }, CONTENT);
    expect(created.prs.get(pr!.number)?.labels).toEqual([`leanish:${tool}`]);

    for (const unchanged of [false, true]) {
      const github = new FakeGitHub(ownPr({ headRef: branch, labels: [], body: withMarker(signedRecord(rules), "Body.", { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }), isDraft: false }));
      const workspace = new InMemoryWorkspace();
      if (unchanged) workspace.setPublishUnchanged();
      await publishUpdate({ ...context(github, workspace), rules }, { ...existing, branch }, 7, CONTENT);
      expect(github.prs.get(7)?.labels).toEqual([`leanish:${tool}`]);
      expect(github.calls.filter((call) => call.startsWith("addLabels"))).toEqual([`addLabels 7 leanish:${tool}`]);
    }

    // The label already there in another casing is the same label: nothing to add.
    const cased = new FakeGitHub(ownPr({ headRef: branch, labels: [`Leanish:${tool.toUpperCase()}`], body: withMarker(signedRecord(rules), "Body.", { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }), isDraft: false }));
    await publishUpdate({ ...context(cased), rules }, { ...existing, branch }, 7, CONTENT);
    expect(cased.calls.filter((call) => call.startsWith("addLabels"))).toEqual([]);
  });

  // Restoring a saved publication adds it too: ownership.test.ts.
  it("adds the label when recording state or marking a PR ready", async () => {
    const updated = new FakeGitHub(ownPr({ labels: [] }));
    await recordState(context(updated), 7, HEAD_SHA, { head: HEAD_SHA, base: BASE_SHA, adaptations: 1 });
    expect(updated.prs.get(7)?.labels).toEqual(["leanish:secure-it"]);

    const ready = new FakeGitHub(ownPr({ labels: [] }));
    await markReady(context(ready), 7, HEAD_SHA);
    expect(ready.prs.get(7)).toMatchObject({ isDraft: false, labels: ["leanish:secure-it"] });
  });

  it("opens a labelled draft PR recording the pushed head and its base, or nothing when nothing changed", async () => {
    const github = new FakeGitHub();
    const pr = await publishNew(context(github), fresh, CONTENT);
    expect(pr).toMatchObject({ isDraft: true, headRef: "secure-it/2026-10-07-vite" });
    expect(stateOf(github.prs.get(pr!.number)!.body)).toEqual({ head: PUSHED_SHA, base: BASE_SHA, adaptations: 0 });
    expect(github.prs.get(pr!.number)?.labels).toEqual([RULES.label]);

    const workspace = new InMemoryWorkspace();
    workspace.setPublishUnchanged();
    expect(await publishNew(context(new FakeGitHub(), workspace), fresh, CONTENT)).toBeUndefined();
    await expect(publishNew(context(github), existing, CONTENT)).rejects.toThrow("exists already");
  });

  it("hands publishBranch the verified tree, and publishes nothing when nothing was verified", async () => {
    const workspace = new InMemoryWorkspace();
    await publishNew({ ...context(new FakeGitHub(), workspace), verifiedTree: async () => "7".repeat(40) }, fresh, CONTENT);
    expect(workspace.publications.map(({ args }) => args.expectedTree)).toEqual(["7".repeat(40)]);

    const unverified = new InMemoryWorkspace();
    await expect(publishNew({ ...context(new FakeGitHub(), unverified), verifiedTree: async () => undefined }, fresh, CONTENT))
      .rejects.toThrow("nothing was verified, so nothing is published");
    expect(unverified.publications).toEqual([]);
  });

  it("updates an existing PR as a draft, then puts a ready PR back to ready when nothing new was pushed", async () => {
    const github = new FakeGitHub(ownPr({ isDraft: false }));
    const { pr, pushed } = await publishUpdate(context(github), existing, 7, CONTENT);
    expect(pushed).toBe(true);
    expect(github.calls.filter((call) => /convertToDraft|markReadyForReview/.test(call))).toEqual(["convertToDraft PR_node7"]);
    expect(stateOf(pr.body)).toEqual({ head: PUSHED_SHA, base: BASE_SHA, adaptations: 0 });

    const unchanged = new FakeGitHub(ownPr({ isDraft: false, body: withMarker(SIGNED, "Body.", { head: HEAD_SHA, base: BASE_SHA, adaptations: 1 }) }));
    const workspace = new InMemoryWorkspace();
    workspace.setPublishUnchanged();
    const result = await publishUpdate(context(unchanged, workspace), existing, 7, CONTENT);
    expect(result.pushed).toBe(false);
    expect(unchanged.prs.get(7)?.isDraft).toBe(false);
    // The adaptation count carries over unless the caller sets it.
    expect(stateOf(result.pr.body)).toEqual({ head: HEAD_SHA, base: BASE_SHA, adaptations: 1 });
  });

  it.each([
    ["publishing an update", (github: FakeGitHub) => publishUpdate(context(github), existing, 7, CONTENT)],
    ["recording state", (github: FakeGitHub) => recordState(context(github), 7, HEAD_SHA, { head: HEAD_SHA, base: BASE_SHA, adaptations: 1 })],
    ["rewriting text", (github: FakeGitHub) => rewriteText(context(github), 7, HEAD_SHA, (body) => body)],
  ])("refuses %s over a body the tool didn't sign for that head, and writes nothing", async (_, act) => {
    const unsigned = withMarker({ ...SIGNED, signingKey: Buffer.alloc(32, 9) }, "Forged.", { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 });
    const olderHead = withMarker(SIGNED, "Restored.", { head: BASE_SHA, base: BASE_SHA, adaptations: 0 });
    for (const body of [unsigned, olderHead]) {
      const github = new FakeGitHub(ownPr({ body }));
      await expect(act(github)).rejects.toThrow("has no state the tool signed");
      expect(github.prs.get(7)?.body).toBe(body);
      expect(github.calls.filter((call) => call.startsWith("updatePullRequest"))).toEqual([]);
    }
  });

  it("carries the adaptations of the state it signed into the next one", async () => {
    const github = new FakeGitHub(ownPr({ body: withMarker(SIGNED, "Body.", { head: HEAD_SHA, base: BASE_SHA, adaptations: 1 }) }));
    const { pr } = await publishUpdate(context(github), existing, 7, CONTENT);
    expect(verifiedStateOf(SIGNED, pr.body)).toEqual({ head: PUSHED_SHA, base: BASE_SHA, adaptations: 1 });
  });

  it("signs what it opens and what it records, so its own next look takes the PR as its own", async () => {
    const github = new FakeGitHub();
    const created = await publishNew(context(github), fresh, CONTENT);
    expect(verifiedStateOf(SIGNED, created!.body)?.head).toBe(PUSHED_SHA);
    const recorded = await recordState(context(github), created!.number, PUSHED_SHA, { head: PUSHED_SHA, base: BASE_SHA, adaptations: 1 });
    expect(verifiedStateOf(SIGNED, recorded.body)?.adaptations).toBe(1);
  });

  it("tries the body update once more after a push, with the same text, closing nothing when that works", async () => {
    const github = new FakeGitHub(ownPr());
    const sent = bodyUpdatesOf(github);
    github.fail("updatePullRequest");
    const result = await publishUpdate(context(github), existing, 7, CONTENT);
    expect(result.pushed).toBe(true);
    expect(stateOf(result.pr.body)?.head).toBe(PUSHED_SHA);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(github.calls.filter((call) => call.startsWith("closePullRequest"))).toEqual([]);
  });

  it("covers a response lost after the update applied with the same retry", async () => {
    const github = new FakeGitHub(ownPr());
    const update = github.updatePullRequest.bind(github);
    let lost = false;
    github.updatePullRequest = async (args) => {
      const updated = await update(args);
      if (lost) return updated;
      lost = true;
      throw new Error("socket hang up");
    };
    const sent = bodyUpdatesOf(github);
    const result = await publishUpdate(context(github), existing, 7, CONTENT);
    expect(stateOf(result.pr.body)?.head).toBe(PUSHED_SHA);
    expect(github.prs.get(7)?.state).toBe("open");
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
  });

  it("leaves the PR when someone removes its state right before the close", async () => {
    const github = new FakeGitHub(ownPr());
    failingBodyUpdates(github);
    const workspace = new InMemoryWorkspace();
    let reads = 0;
    const read = github.getPullRequest.bind(github);
    github.getPullRequest = async (args) => {
      // Before the update, each attempt's own re-read, then retirement's two: the last is the one right before closing.
      if (++reads === 5) github.prs.set(7, { ...github.prs.get(7)!, body: `Rewritten.\n\n${RULES.marker}\n` });
      return read(args);
    };
    await expect(publishUpdate(context(github, workspace), existing, 7, CONTENT)).rejects.toThrow(/the tool leaves it/);
    expect(github.prs.get(7)?.state).toBe("open");
    expect(workspace.deletions).toEqual([]);
  });

  it("closes the PR when its body can't be updated after a push, and still reports an error", async () => {
    const github = new FakeGitHub(ownPr());
    failingBodyUpdates(github);
    const workspace = new InMemoryWorkspace();
    await expect(publishUpdate(context(github, workspace), existing, 7, CONTENT)).rejects.toThrow(/pushed c+ to leanish\/widget#7 but couldn't confirm its body update .*closed the PR, and a later run recomputes it/);
    expect(github.prs.get(7)?.state).toBe("closed");
    expect(github.calls).toContainEqual(expect.stringMatching(/^createComment 7 secure-it couldn't confirm updating this PR's description/));
    expect(workspace.deletions).toHaveLength(1);
  });

  it.each([
    { taken: "a moved head", after: { headSha: "9".repeat(40) } },
    { taken: "being marked ready", after: { headSha: PUSHED_SHA, isDraft: false } },
    { taken: "a removed state", after: { headSha: PUSHED_SHA, body: `Rewritten.\n\n${RULES.marker}\n` } },
  ])("leaves a PR someone took over ($taken) open when its body can't be updated", async ({ after }) => {
    const github = new FakeGitHub(ownPr());
    failingBodyUpdates(github, after);
    await expect(publishUpdate(context(github), existing, 7, CONTENT)).rejects.toThrow(/couldn't confirm its body update .*the tool leaves it: if it's still open and nobody took it over, close it/);
    expect(github.prs.get(7)?.state).toBe("open");
    expect(github.calls.filter((call) => call.startsWith("closePullRequest"))).toEqual([]);
  });

  it("tells a person to close the PR when closing it fails too", async () => {
    const github = new FakeGitHub(ownPr());
    failingBodyUpdates(github);
    github.fail("closePullRequest");
    await expect(publishUpdate(context(github), existing, 7, CONTENT)).rejects.toThrow(/couldn't finish closing it .*nobody took it over, close it by hand/);
    expect(github.prs.get(7)?.state).toBe("open");
  });

  it("doesn't retire a PR when the failed update followed no push", async () => {
    const github = new FakeGitHub(ownPr());
    github.fail("updatePullRequest");
    const workspace = new InMemoryWorkspace();
    workspace.setPublishUnchanged();
    await expect(publishUpdate(context(github, workspace), existing, 7, CONTENT)).rejects.toThrow("unexpected response");
    expect(github.calls.filter((call) => call.startsWith("closePullRequest"))).toEqual([]);
  });

  it("publishes and rewrites text with local paths cleaned", async () => {
    const leaky = { title: "fixing snappy-java", body: `Checked with \`GRADLE_USER_HOME=/Users/dev/cache ./gradlew check\` in ${WC.path}/lib.`, commitMessage: `moving snappy-java\n\nin ${WC.path}` };
    const cleanBody = "Checked with `GRADLE_USER_HOME=<local path> ./gradlew check` in lib.";
    const github = new FakeGitHub(ownPr());
    const workspace = new InMemoryWorkspace();
    const { pr } = await publishUpdate(context(github, workspace), existing, 7, leaky);
    expect(workspace.publications.at(-1)?.args.message).toBe("moving snappy-java\n\nin .");
    expect(pr.body).toBe(withMarker(SIGNED, cleanBody, { head: PUSHED_SHA, base: BASE_SHA, adaptations: 0 }));
    const fresh2 = new FakeGitHub();
    await publishNew(context(fresh2), fresh, leaky);
    expect([...fresh2.prs.values()][0]?.body).toContain(cleanBody);
    const state = { head: HEAD_SHA, base: BASE_SHA, adaptations: 1 };
    const rewritten = new FakeGitHub(ownPr({ body: withMarker(SIGNED, "old note", state) }));
    await rewriteText(context(rewritten), 7, HEAD_SHA, () => "new note from /Users/dev/state/plan.json");
    expect(rewritten.prs.get(7)!.body).toContain("new note from <local path>");
  });

  it("refuses to publish over a PR that moved or stopped being the tool's", async () => {
    const moved = new FakeGitHub(ownPr({ headSha: "9".repeat(40) }));
    await expect(publishUpdate(context(moved), existing, 7, CONTENT)).rejects.toThrow("moved to 9999");
    const taken = new FakeGitHub(ownPr({ labels: [], body: "someone's now" }));
    await expect(publishUpdate(context(taken), existing, 7, CONTENT)).rejects.toThrow("no longer an open secure-it PR");
  });

  it("closes with a comment and deletes the branch, keeping it when it moved after the check", async () => {
    const github = new FakeGitHub(ownPr());
    const workspace = new InMemoryWorkspace();
    workspace.setDeleteMoved(OWN_BRANCH, "9".repeat(40));
    await closeAndDelete(context(github, workspace), 7, HEAD_SHA, "fixed on main already");
    expect(github.prs.get(7)?.state).toBe("closed");
    expect(github.calls).toContain("createComment 7 fixed on main already");
    expect(workspace.deletions).toHaveLength(1);
  });

  it("lists the tool's open PRs oldest first, and clears a leftover branch but not one with an open PR", async () => {
    const github = new FakeGitHub(ownPr({ number: 9, nodeId: "n9" }), ownPr(), ownPr({ number: 3, nodeId: "n3", labels: [], body: "not ours" }));
    expect((await ownOpenPullRequests(github, RULES, "leanish/widget", "main")).map((pr) => pr.number)).toEqual([7, 9]);
    github.branches.add("secure-it/2026-10-07-vite");
    await clearLeftoverBranch(github, RULES, "leanish/widget", "secure-it/2026-10-07-vite");
    expect(github.branches.has("secure-it/2026-10-07-vite")).toBe(false);
    await clearLeftoverBranch(github, RULES, "leanish/widget", "secure-it/2026-10-07-gone");
    await expect(clearLeftoverBranch(github, RULES, "leanish/widget", OWN_BRANCH)).rejects.toThrow("already has an open PR (#");
  });
});
