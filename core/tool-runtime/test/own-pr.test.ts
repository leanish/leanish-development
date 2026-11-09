import { describe, expect, it } from "vitest";

import { branchFor, freeBranch, isOwnPullRequest, MARKER_ROOM, ownPullRequests, stateOf, topicOf, verifiedStateOf, withMarker } from "../src/own-pr.ts";
import { planBlock, planPayload } from "../src/plan-blocks.ts";
import { BASE_SHA, HEAD_SHA, ownPr, RULES, SIGNED, signedRecord, TEST_SIGNING_KEY } from "./fake-github.ts";

describe("own PRs", () => {
  it.each(["secure-it", "bump-it"] as const)("names %s's label and body marker after the tool", (tool) => {
    const rules = ownPullRequests(tool);
    const pr = ownPr({ headRef: `${tool}/2026-10-05-security`, body: "No marker.", labels: [`leanish:${tool}`] });
    expect(rules.label).toBe(`leanish:${tool}`);
    expect(rules.marker).toBe(`<!-- leanish:${tool} -->`);
    expect(isOwnPullRequest(rules, pr, "leanish/widget", "main")).toBe(true);
    expect(isOwnPullRequest(rules, { ...pr, body: rules.marker, labels: [] }, "leanish/widget", "main")).toBe(true);
    // A label-only PR, in the casing someone created the repository's label with.
    expect(isOwnPullRequest(rules, { ...pr, labels: [`Leanish:${tool.toUpperCase()}`] }, "leanish/widget", "main")).toBe(true);
    const other = tool === "secure-it" ? "bump-it" : "secure-it";
    expect(isOwnPullRequest(rules, { ...pr, labels: [`leanish:${other}`] }, "leanish/widget", "main")).toBe(false);
    expect(isOwnPullRequest(rules, { ...pr, labels: [], body: ownPullRequests(other).marker }, "leanish/widget", "main")).toBe(false);
    expect(isOwnPullRequest(rules, { ...pr, headRepo: "someone/widget" }, "leanish/widget", "main")).toBe(false);
    expect(isOwnPullRequest(rules, { ...pr, state: "closed" }, "leanish/widget", "main")).toBe(false);
  });

  it("names a branch by tool, UTC date and a branch-safe topic", () => {
    const now = new Date("2026-10-07T23:30:00Z");
    expect(branchFor(RULES, now, "org.xerial.snappy:snappy-java")).toBe("secure-it/2026-10-07-org.xerial.snappy-snappy-java");
    expect(branchFor(ownPullRequests("bump-it"), now, "@types/node 26")).toBe("bump-it/2026-10-07-types-node-26");
    expect(() => branchFor(RULES, now, "@@@")).toThrow("needs a topic");
    expect(branchFor(RULES, now, ".-.vite-.-")).toBe("secure-it/2026-10-07-vite");
    // A long run of dashes that doesn't end the topic: trimmed in linear time, not retried from every dash.
    const started = performance.now();
    expect(branchFor(RULES, now, `${"-".repeat(200_000)}x${"-".repeat(200_000)}y`)).toBe(`secure-it/2026-10-07-x${"-".repeat(59)}`);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(topicOf(RULES, branchFor(RULES, now, "vite"))).toBe("vite");
    expect(topicOf(RULES, "secure-it/2026-01-02-vite")).toBe("vite");
    expect(topicOf(RULES, "bump-it/2026-01-02-vite")).toBeUndefined();
  });

  it("finds a free branch by numbering after the topic is cut, so a long taken topic still ends", () => {
    const now = new Date("2026-10-07T23:30:00Z");
    expect(freeBranch(RULES, now, "vite", new Set())).toBe("secure-it/2026-10-07-vite");
    expect(freeBranch(RULES, now, "vite", new Set(["secure-it/2026-10-07-vite"]))).toBe("secure-it/2026-10-07-vite-2");
    const long = "a".repeat(70);
    const first = branchFor(RULES, now, long);
    const second = freeBranch(RULES, now, long, new Set([first]));
    expect(second).toBe(`secure-it/2026-10-07-${"a".repeat(58)}-2`);
    expect(freeBranch(RULES, now, long, new Set([first, second]))).toBe(`secure-it/2026-10-07-${"a".repeat(58)}-3`);
  });

  it("recognises the tool's open PRs from its own branches and repo, by marker or label", () => {
    const repo = "leanish/widget";
    expect(isOwnPullRequest(RULES, ownPr(), repo, "main")).toBe(true);
    expect(isOwnPullRequest(RULES, ownPr({ labels: [] }), repo, "main")).toBe(true);
    expect(isOwnPullRequest(RULES, ownPr({ body: "no marker" }), repo, "main")).toBe(true);
    expect(isOwnPullRequest(RULES, ownPr({ body: "no marker", labels: [] }), repo, "main")).toBe(false);
    expect(isOwnPullRequest(RULES, ownPr({ headRepo: "someone/widget" }), repo, "main")).toBe(false);
    expect(isOwnPullRequest(RULES, ownPr({ baseRef: "release" }), repo, "main")).toBe(false);
    expect(isOwnPullRequest(RULES, ownPr({ state: "closed" }), repo, "main")).toBe(false);
    expect(isOwnPullRequest(RULES, ownPr({ headRef: "bump-it/2026-10-05-snappy-java" }), repo, "main")).toBe(false);
    expect(isOwnPullRequest(ownPullRequests("bump-it"), ownPr(), repo, "main")).toBe(false);
  });

  it("keeps one state and one marker at the end of the body, replacing earlier ones", () => {
    const once = withMarker(SIGNED, "Fixes snappy.", { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 });
    expect(once).toMatch(new RegExp(`^Fixes snappy\\.\\n\\n<!-- leanish:state head=${HEAD_SHA} base=${BASE_SHA} adaptations=0 sig=[A-Za-z0-9_-]{43} -->\\n${RULES.marker}\\n$`));
    const twice = withMarker(SIGNED, `${once}\nMore.`, { head: BASE_SHA, base: HEAD_SHA, adaptations: 2 });
    expect(twice.match(/leanish:state/g)).toHaveLength(1);
    expect(twice.split(RULES.marker)).toHaveLength(2);
    expect(stateOf(twice)).toEqual({ head: BASE_SHA, base: HEAD_SHA, adaptations: 2 });
    expect(stateOf("no state")).toBeUndefined();
    expect(() => withMarker(SIGNED, "x", { head: "nope", base: BASE_SHA, adaptations: 0 })).toThrow("invalid PR state");
  });

  describe("verifiedStateOf", () => {
    const state = { head: HEAD_SHA, base: BASE_SHA, adaptations: 1 };
    const body = withMarker(SIGNED, "Fixes snappy.", state);

    it("reads back the state the tool signed", () => {
      expect(verifiedStateOf(SIGNED, body)).toEqual(state);
    });

    it.each([
      ["the head", body.replace(HEAD_SHA, "c".repeat(40))],
      ["the base", body.replace(BASE_SHA, "c".repeat(40))],
      ["the adaptations", body.replace("adaptations=1", "adaptations=0")],
      ["the signature", body.replace(/sig=.{43}/, `sig=${"A".repeat(43)}`)],
    ])("refuses an edited %s", (_, edited) => {
      expect(edited).not.toBe(body);
      expect(verifiedStateOf(SIGNED, edited)).toBeUndefined();
    });

    it("refuses a state signed with another key, for another repository or by another tool", () => {
      expect(verifiedStateOf({ ...SIGNED, signingKey: Buffer.alloc(32, 9) }, body)).toBeUndefined();
      expect(verifiedStateOf(signedRecord(RULES, "leanish/other"), body)).toBeUndefined();
      expect(verifiedStateOf({ rules: ownPullRequests("bump-it"), repo: SIGNED.repo, signingKey: TEST_SIGNING_KEY }, body)).toBeUndefined();
    });

    it("reads the repository ignoring case, as GitHub names it", () => {
      expect(verifiedStateOf(signedRecord(RULES, "Leanish/Widget"), body)).toEqual(state);
    });

    it("refuses a body with no state, or with more than one line claiming to be it", () => {
      const line = /<!-- leanish:state .* -->/.exec(body)![0];
      expect(verifiedStateOf(SIGNED, "no state")).toBeUndefined();
      expect(verifiedStateOf(SIGNED, `${line}\n${body}`)).toBeUndefined();
    });

    it("doesn't read a state line without a signature as a state at all", () => {
      expect(stateOf(`<!-- leanish:state head=${HEAD_SHA} base=${BASE_SHA} adaptations=0 -->`)).toBeUndefined();
    });
  });

  it("appends no more than MARKER_ROOM to a body, for either tool", () => {
    for (const tool of ["secure-it", "bump-it"] as const) {
      const appended = withMarker(signedRecord(ownPullRequests(tool)), "x", { head: HEAD_SHA, base: BASE_SHA, adaptations: 999_999 }).length - 1;
      expect(appended).toBeLessThanOrEqual(MARKER_ROOM);
    }
  });

  it("never joins the text around a removed marker into a plan block, so the tool's own block stays the first", () => {
    const state = { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 };
    const old = `<!-- leanish:state head=${BASE_SHA} base=${BASE_SHA} adaptations=1 sig=${"a".repeat(43)} -->`;
    const forged = planBlock({ kind: "forged" }).slice("<!-- leanish:".length);
    const [payload, tail] = [forged.slice(0, 20), forged.slice(20)];
    const real = planBlock({ kind: "routine" });
    for (const quoted of [`<!-- leanish:${RULES.marker}${forged}`, `<!-- leanish:${old}${forged}`, `<!-- leanish:${payload}${RULES.marker}${tail}`]) {
      expect(planPayload(withMarker(SIGNED, `${quoted}\n\n${real}`, state))).toEqual({ kind: "routine" });
    }
  });
});
