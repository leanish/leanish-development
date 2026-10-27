import { describe, expect, it } from "vitest";

import { MAX_BODY_CHARS, MAX_TITLE_CHARS } from "@leanish/agent-runtime/github/github-client";
import { ConsoleLogger } from "@leanish/agent-runtime/logger/console-logger";
import type { GitHubPullRequest } from "@leanish/agent-runtime/types/clients";
import type { WorkingCopy } from "@leanish/agent-runtime/types/working-copy";
import { InMemoryWorkspace } from "@leanish/agent-runtime/working-copy/in-memory-workspace";
import type { PublicationJournal, PushedState } from "../src/journal.ts";
import { stateOf, withMarker } from "../src/own-pr.ts";
import { inspectOwnership, type Ours, repairOwnership, samePlan } from "../src/ownership.ts";
import type { PublicationContext } from "../src/publication.ts";
import { MemoryJournal } from "./memory-journal.ts";
import { BASE_SHA, FakeGitHub, HEAD_SHA, ownPr, PUSHED_SHA, RULES } from "./fake-github.ts";

const REPO = "leanish/widget";
const WC: WorkingCopy = { projectId: REPO, path: "/synthetic/leanish/widget", branch: "main", headSha: BASE_SHA, gitDir: "/x/.git" };
const OTHER_SHA = "9".repeat(40);
const URL = "https://github.com/leanish/widget/pull/7";

function context(github: FakeGitHub, journal: PublicationJournal = new MemoryJournal()): PublicationContext {
  return { rules: RULES, github, workspace: new InMemoryWorkspace(), logger: new ConsoleLogger({ minLevel: "error" }), repo: REPO, base: "main", workingCopy: WC, journal, localRoots: [] };
}

/** What the tool published at PUSHED_SHA, as the journal saves it before the push. */
function saved(state = { head: PUSHED_SHA, base: BASE_SHA, adaptations: 1 }, adaptations = 1) {
  return { title: "new plan title", body: withMarker(RULES, "New plan.", state), adaptations };
}

/** A journal holding `entry` for #7, counting its reads. */
async function journalWith(entry?: PushedState): Promise<MemoryJournal & { reads: number }> {
  const journal = Object.assign(new MemoryJournal(), { reads: 0 });
  if (entry !== undefined) await journal.pushed(REPO, 7, entry);
  const last = journal.last.bind(journal);
  journal.last = async (repo, number) => {
    journal.reads += 1;
    return last(repo, number);
  };
  return journal;
}

/** #7 pushed to PUSHED_SHA while its body still records HEAD_SHA (a failed body update), or with `body`. */
const lagging = (overrides: Partial<GitHubPullRequest> = {}) => ownPr({ headSha: PUSHED_SHA, ...overrides });
const rewritten = (overrides: Partial<GitHubPullRequest> = {}) => lagging({ body: `Rewritten by a person.\n\n${RULES.marker}\n`, ...overrides });

describe("inspectOwnership", () => {
  it("takes a body recording the current head as the tool's without reading the journal", async () => {
    const pr = ownPr();
    const journal = await journalWith();
    journal.last = async () => { throw new Error("the journal was read"); };
    expect(await inspectOwnership(context(new FakeGitHub(pr), journal), pr)).toEqual({ kind: "ours", pr, recovery: "none" });
  });

  it("restores the journal's publication for the exact head as the effective content", async () => {
    const pr = lagging();
    const publication = saved();
    const journal = await journalWith({ head: PUSHED_SHA, base: BASE_SHA, publication });
    expect(await inspectOwnership(context(new FakeGitHub(pr), journal), pr)).toEqual({
      kind: "ours", pr: { ...pr, title: publication.title, body: publication.body }, recovery: "saved", saved: publication,
    });
  });

  it("keeps the raw PR for an old journal entry that records only the head", async () => {
    const pr = lagging();
    const journal = await journalWith({ head: PUSHED_SHA, base: BASE_SHA });
    expect(await inspectOwnership(context(new FakeGitHub(pr), journal), pr)).toEqual({ kind: "ours", pr, recovery: "legacy" });
  });

  it("tells a head nobody recorded apart: pushed by someone else when the body has a state, untracked without one", async () => {
    for (const entry of [undefined, { head: OTHER_SHA, base: BASE_SHA }]) {
      const pushed = lagging();
      expect(await inspectOwnership(context(new FakeGitHub(pushed), await journalWith(entry)), pushed)).toEqual({ kind: "pushed-by-someone-else", recordedHead: HEAD_SHA });
      const untracked = rewritten();
      expect(await inspectOwnership(context(new FakeGitHub(untracked), await journalWith(entry)), untracked)).toEqual({ kind: "untracked" });
    }
  });

  it("keeps a PR whose state someone removed as the tool's, with a read-only view of a valid saved publication", async () => {
    const pr = rewritten();
    const valid = saved();
    const exposed = await inspectOwnership(context(new FakeGitHub(pr), await journalWith({ head: PUSHED_SHA, base: BASE_SHA, publication: valid })), pr);
    expect(exposed).toEqual({ kind: "ours", pr, recovery: "state-removed", saved: valid });
    // An old entry saved none: no view.
    expect(await inspectOwnership(context(new FakeGitHub(pr), await journalWith({ head: PUSHED_SHA, base: BASE_SHA })), pr)).toEqual({ kind: "ours", pr, recovery: "state-removed" });
    // A mismatched one is refused, as for a body with a state: the raw body never stands in for it.
    for (const publication of [saved({ head: PUSHED_SHA, base: OTHER_SHA, adaptations: 1 }), { ...valid, body: "No state at all." }]) {
      await expect(inspectOwnership(context(new FakeGitHub(pr), await journalWith({ head: PUSHED_SHA, base: BASE_SHA, publication })), pr))
        .rejects.toThrow("the journal has no matching publication content");
    }
  });

  it.each([
    ["its head", saved({ head: OTHER_SHA, base: BASE_SHA, adaptations: 1 })],
    ["its base", saved({ head: PUSHED_SHA, base: OTHER_SHA, adaptations: 1 })],
    ["its adaptations", saved({ head: PUSHED_SHA, base: BASE_SHA, adaptations: 1 }, 2)],
    ["any state", { ...saved(), body: "New plan, no state." }],
  ])("refuses a saved publication that doesn't match %s", async (_name, publication) => {
    const pr = lagging();
    const github = new FakeGitHub(pr);
    await expect(inspectOwnership(context(github, await journalWith({ head: PUSHED_SHA, base: BASE_SHA, publication })), pr))
      .rejects.toThrow(`${URL}: the journal has no matching publication content; rerun the tool to recompute before reviewing`);
    expect(github.calls).toEqual([]);
  });

  it("never calls GitHub, whatever it finds", async () => {
    const cases: Array<[GitHubPullRequest, PushedState | undefined]> = [
      [ownPr(), undefined],
      [lagging(), { head: PUSHED_SHA, base: BASE_SHA, publication: saved() }],
      [lagging(), { head: PUSHED_SHA, base: BASE_SHA }],
      [lagging(), undefined],
      [rewritten(), { head: PUSHED_SHA, base: BASE_SHA, publication: saved() }],
      [rewritten(), undefined],
    ];
    for (const [pr, entry] of cases) {
      const github = new FakeGitHub(pr);
      await inspectOwnership(context(github, await journalWith(entry)), pr);
      expect(github.calls).toEqual([]);
    }
  });

  it("lets a journal it can't read fail the inspection", async () => {
    const pr = lagging();
    const journal = await journalWith();
    journal.last = async () => { throw new Error("leanish__widget.json isn't a journal"); };
    await expect(inspectOwnership(context(new FakeGitHub(pr), journal), pr)).rejects.toThrow("isn't a journal");
  });
});

describe("repairOwnership", () => {
  const publication = saved();
  const recovered = (pr: GitHubPullRequest): Ours => ({ kind: "ours", pr: { ...pr, title: publication.title, body: publication.body }, recovery: "saved", saved: publication });

  it("writes the saved publication back, with the label, and returns the PR as updated", async () => {
    const github = new FakeGitHub(lagging({ labels: [] }));
    const repaired = await repairOwnership(context(github), recovered(lagging()));
    expect(repaired).toMatchObject({ title: publication.title, body: publication.body, headSha: PUSHED_SHA });
    expect(github.prs.get(7)).toMatchObject({ title: publication.title, body: publication.body, labels: [RULES.label] });
    expect(stateOf(github.prs.get(7)!.body)).toEqual({ head: PUSHED_SHA, base: BASE_SHA, adaptations: 1 });
    expect(github.calls).toEqual(["getPullRequest 7", "updatePullRequest 7", "addLabels 7 leanish:secure-it"]);
  });

  it("writes nothing for any other ownership, returning its PR as is", async () => {
    const owned: Ours[] = [
      { kind: "ours", pr: ownPr(), recovery: "none" },
      { kind: "ours", pr: lagging(), recovery: "legacy" },
      { kind: "ours", pr: rewritten(), recovery: "state-removed" },
      { kind: "ours", pr: rewritten(), recovery: "state-removed", saved: publication },
    ];
    for (const ownership of owned) {
      const github = new FakeGitHub(ownership.pr);
      expect(await repairOwnership(context(github), ownership)).toBe(ownership.pr);
      expect(github.calls).toEqual([]);
    }
  });

  it("refuses a PR that moved since it was inspected, or is no longer the tool's, before writing", async () => {
    const moved = new FakeGitHub(lagging({ headSha: OTHER_SHA }));
    await expect(repairOwnership(context(moved), recovered(lagging()))).rejects.toThrow(`moved to ${OTHER_SHA}`);
    const taken = new FakeGitHub(lagging({ labels: [], body: "someone's now" }));
    await expect(repairOwnership(context(taken), recovered(lagging()))).rejects.toThrow("no longer an open secure-it PR");
    for (const github of [moved, taken]) expect(github.calls.filter((call) => !call.startsWith("getPullRequest"))).toEqual([]);
  });

  it("refuses a PR someone pushed to while its publication was restored, before restoring its label", async () => {
    const github = new FakeGitHub(lagging({ labels: [] }));
    const update = github.updatePullRequest.bind(github);
    github.updatePullRequest = async (args) => ({ ...await update(args), headSha: OTHER_SHA });
    await expect(repairOwnership(context(github), recovered(lagging()))).rejects.toThrow(`${URL} moved to ${OTHER_SHA} while secure-it restored its publication`);
    expect(github.calls).not.toContain("addLabels 7 leanish:secure-it");
  });

  it("refuses a saved title or body over the client's limits before writing", async () => {
    const long = { ...publication, body: withMarker(RULES, "x".repeat(MAX_BODY_CHARS), { head: PUSHED_SHA, base: BASE_SHA, adaptations: 1 }) };
    const body = new FakeGitHub(lagging());
    await expect(repairOwnership(context(body), { kind: "ours", pr: lagging(), recovery: "saved", saved: long }))
      .rejects.toThrow(`over the client's ${MAX_BODY_CHARS} limit`);
    const title = new FakeGitHub(lagging());
    await expect(repairOwnership(context(title), { kind: "ours", pr: lagging(), recovery: "saved", saved: { ...publication, title: "x".repeat(MAX_TITLE_CHARS + 1) } }))
      .rejects.toThrow("the PR title would be");
    for (const github of [body, title]) expect(github.calls.some((call) => call.startsWith("updatePullRequest"))).toBe(false);
  });
});

describe("samePlan", () => {
  const read = (body: string) => /plan=(\w+)/.exec(body)?.[1];
  const planned = (state: { head: string } | undefined, overrides: Partial<GitHubPullRequest> = {}) => ownPr({
    body: state === undefined ? `plan=same\n\n${RULES.marker}\n` : withMarker(RULES, "plan=same", { head: state.head, base: BASE_SHA, adaptations: 0 }),
    ...overrides,
  });

  it("matches only a body recording the current head whose plan reads as the digest", () => {
    expect(samePlan(planned({ head: HEAD_SHA }), "same", read)).toBe(true);
    expect(samePlan(planned({ head: HEAD_SHA }), "other", read)).toBe(false);
  });

  it("never matches a legacy or state-removed PR, without reading its plan", () => {
    let reads = 0;
    const counting = (body: string) => {
      reads += 1;
      return read(body);
    };
    expect(samePlan(planned({ head: HEAD_SHA }, { headSha: PUSHED_SHA }), "same", counting)).toBe(false);
    expect(samePlan(planned(undefined), "same", counting)).toBe(false);
    expect(reads).toBe(0);
  });

  it("doesn't match a plan it can't read", () => {
    expect(samePlan(ownPr(), "same", () => undefined)).toBe(false);
  });
});
