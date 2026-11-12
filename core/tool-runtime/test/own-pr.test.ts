import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { branchFor, comesFromTool, freeBranch, isOwnPullRequest, MARKER_ROOM, ownPullRequests, type RecordContext, stateOf, topicOf, verifiedStateOf, withMarker } from "../src/own-pr.ts";
import { planBlock, planPayload, planSection } from "../src/plan-blocks.ts";
import { BASE_SHA, HEAD_SHA, marked, OWN_BRANCH, ownPr, RULES, SIGNED, signedRecord, TOOL_LOGIN } from "./fake-github.ts";

const REPO = "leanish/widget";
const TRUSTING: RecordContext = { ...SIGNED, trust: { mode: "trusted-editors" } };

describe("own PRs", () => {
  it.each(["secure-it", "bump-it"] as const)("names %s's label and body marker after the tool", (tool) => {
    const rules = ownPullRequests(tool);
    const pr = ownPr({ headRef: `${tool}/2026-10-05-security`, body: "No marker.", labels: [`leanish:${tool}`] });
    expect(rules.label).toBe(`leanish:${tool}`);
    expect(rules.marker).toBe(`<!-- leanish:${tool} -->`);
    expect(isOwnPullRequest(rules, pr, REPO, "main", TOOL_LOGIN)).toBe(true);
    expect(isOwnPullRequest(rules, { ...pr, body: rules.marker, labels: [] }, REPO, "main", TOOL_LOGIN)).toBe(true);
    // A label-only PR, in the casing someone created the repository's label with.
    expect(isOwnPullRequest(rules, { ...pr, labels: [`Leanish:${tool.toUpperCase()}`] }, REPO, "main", TOOL_LOGIN)).toBe(true);
    const other = tool === "secure-it" ? "bump-it" : "secure-it";
    expect(isOwnPullRequest(rules, { ...pr, labels: [`leanish:${other}`] }, REPO, "main", TOOL_LOGIN)).toBe(false);
    expect(isOwnPullRequest(rules, { ...pr, labels: [], body: ownPullRequests(other).marker }, REPO, "main", TOOL_LOGIN)).toBe(false);
    expect(isOwnPullRequest(rules, { ...pr, headRepo: "someone/widget" }, REPO, "main", TOOL_LOGIN)).toBe(false);
    expect(isOwnPullRequest(rules, { ...pr, state: "closed" }, REPO, "main", TOOL_LOGIN)).toBe(false);
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
    const own = (pr: Parameters<typeof isOwnPullRequest>[1]) => isOwnPullRequest(RULES, pr, REPO, "main", TOOL_LOGIN);
    expect(own(ownPr())).toBe(true);
    expect(own(ownPr({ labels: [] }))).toBe(true);
    expect(own(ownPr({ body: "no marker" }))).toBe(true);
    expect(own(ownPr({ body: "no marker", labels: [] }))).toBe(false);
    expect(own(ownPr({ headRepo: "someone/widget" }))).toBe(false);
    expect(own(ownPr({ baseRef: "release" }))).toBe(false);
    expect(own(ownPr({ state: "closed" }))).toBe(false);
    expect(own(ownPr({ headRef: "bump-it/2026-10-05-snappy-java" }))).toBe(false);
    expect(isOwnPullRequest(ownPullRequests("bump-it"), ownPr(), REPO, "main", TOOL_LOGIN)).toBe(false);
  });

  it("takes a PR for the tool's only when the write token's login wrote it, in any casing", () => {
    expect(isOwnPullRequest(RULES, ownPr({ author: "LeAnIsH" }), REPO, "main", TOOL_LOGIN)).toBe(true);
    expect(isOwnPullRequest(RULES, ownPr(), REPO, "main", "LEANISH")).toBe(true);
    // Someone with write access copying the branch format, the marker and the label: not the tool's.
    expect(isOwnPullRequest(RULES, ownPr({ author: "a-writer" }), REPO, "main", TOOL_LOGIN)).toBe(false);
    // A deleted account is nobody's, whatever its body says.
    expect(isOwnPullRequest(RULES, ownPr({ author: null }), REPO, "main", TOOL_LOGIN)).toBe(false);
  });

  it("recognises where a closed or merged PR came from, for bookkeeping, by the same origin", () => {
    expect(comesFromTool(RULES, ownPr({ state: "closed" }), REPO, TOOL_LOGIN)).toBe(true);
    expect(comesFromTool(RULES, ownPr({ state: "closed", merged: true, body: "rewritten" }), REPO, TOOL_LOGIN)).toBe(true);
    expect(comesFromTool(RULES, ownPr({ state: "closed", author: "a-writer" }), REPO, TOOL_LOGIN)).toBe(false);
    expect(comesFromTool(RULES, ownPr({ headRef: "feature/x" }), REPO, TOOL_LOGIN)).toBe(false);
  });

  it("keeps one state and one marker at the end of the body, replacing earlier ones", () => {
    const once = marked("Fixes snappy.", { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 });
    expect(once).toMatch(new RegExp(`^Fixes snappy\\.\\n\\n<!-- leanish:state head=${HEAD_SHA} base=${BASE_SHA} adaptations=0 sig=[A-Za-z0-9_-]{43} -->\\n${RULES.marker}\\n$`));
    const twice = marked(`${once}\nMore.`, { head: BASE_SHA, base: HEAD_SHA, adaptations: 2 });
    expect(twice.match(/leanish:state/g)).toHaveLength(1);
    expect(twice.split(RULES.marker)).toHaveLength(2);
    expect(stateOf(twice)).toEqual({ head: BASE_SHA, base: HEAD_SHA, adaptations: 2 });
    expect(stateOf("no state")).toBeUndefined();
    expect(() => marked("x", { head: "nope", base: BASE_SHA, adaptations: 0 })).toThrow("invalid PR state");
  });

  describe("verifiedStateOf", () => {
    const state = { head: HEAD_SHA, base: BASE_SHA, adaptations: 1 };
    const tracked = `Fixes snappy.\n\nTracks #3.\n\n${planSection({ heading: "## Plan", people: "| a | b |", payload: { kind: "routine", moves: ["a"] }, name: "the plan" })}`;
    const body = marked(tracked, state);
    const pr = ownPr({ body });

    it("reads back the state the tool signed", () => {
      expect(verifiedStateOf(SIGNED, pr)).toEqual(state);
    });

    it.each([
      ["the head", body.replace(HEAD_SHA, "c".repeat(40))],
      ["the base", body.replace(BASE_SHA, "c".repeat(40))],
      ["the adaptations", body.replace("adaptations=1", "adaptations=0")],
      ["the signature", body.replace(/sig=.{43}/, `sig=${"A".repeat(43)}`)],
      ["the plan", body.replace(planBlock({ kind: "routine", moves: ["a"] }), planBlock({ kind: "routine", moves: ["b"] }))],
      ["the Tracks line", body.replace("Tracks #3.", "Tracks #4.")],
      ["the Tracks line's early mark", body.replace("Tracks #3.", "Tracks #3, taken early.")],
      ["an added Tracks line", body.replace("Fixes snappy.", "Fixes snappy.\n\nTracks #9.")],
      ["an added plan block before the tool's", body.replace("Fixes snappy.", `Fixes snappy.\n\n${planBlock({ kind: "forged" })}`)],
      ["a removed signature", body.replace(/ sig=.{43}/, "")],
    ])("refuses an edited %s", (_, edited) => {
      expect(edited).not.toBe(body);
      expect(verifiedStateOf(SIGNED, { ...pr, body: edited })).toBeUndefined();
    });

    it("accepts edited prose: people may write in the tool's PRs", () => {
      expect(verifiedStateOf(SIGNED, { ...pr, body: body.replace("Fixes snappy.", "Fixes snappy, as discussed.\n\n> a note") })).toEqual(state);
      expect(verifiedStateOf(SIGNED, { ...pr, body: body.replace("| a | b |", "| a | c |") })).toEqual(state);
    });

    it("refuses a state signed for another branch, into another base, by another key, repository or tool", () => {
      expect(verifiedStateOf(SIGNED, { ...pr, headRef: "secure-it/2026-10-05-other" })).toBeUndefined();
      expect(verifiedStateOf({ ...SIGNED, base: "release" }, { ...pr, baseRef: "release" })).toBeUndefined();
      expect(verifiedStateOf({ ...SIGNED, trust: { mode: "signed", key: Buffer.alloc(32, 9) } }, pr)).toBeUndefined();
      expect(verifiedStateOf(signedRecord(RULES, "leanish/other"), pr)).toBeUndefined();
      expect(verifiedStateOf(signedRecord(ownPullRequests("bump-it")), pr)).toBeUndefined();
    });

    it("refuses the state line 0.12.0's first signing wrote (#470), which covered neither branches nor plan", () => {
      const reduced = (key: Uint8Array) => createHmac("sha256", key).update(JSON.stringify(["secure-it", REPO, HEAD_SHA, BASE_SHA, 1])).digest("base64url");
      const signed = SIGNED.trust.mode === "signed" ? SIGNED.trust.key : new Uint8Array();
      expect(verifiedStateOf(SIGNED, { ...pr, body: body.replace(/sig=.{43}/, `sig=${reduced(signed)}`) })).toBeUndefined();
    });

    it("reads the repository ignoring case, as GitHub names it", () => {
      expect(verifiedStateOf(signedRecord(RULES, "Leanish/Widget"), pr)).toEqual(state);
    });

    it("refuses a body with no state, or with more than one line claiming to be it", () => {
      const line = /<!-- leanish:state .* -->/.exec(body)![0];
      expect(verifiedStateOf(SIGNED, { ...pr, body: "no state" })).toBeUndefined();
      expect(verifiedStateOf(SIGNED, { ...pr, body: `${line}\n${body}` })).toBeUndefined();
    });

    it("refuses, without failing, a plan someone nested past the stack", () => {
      for (const depth of [3_000, 20_000]) {
        const nested = `<!-- leanish:plan ${Buffer.from(`${"[".repeat(depth)}${"]".repeat(depth)}`).toString("base64")} -->`;
        const edited = body.replace(planBlock({ kind: "routine", moves: ["a"] }), nested);
        expect(edited).not.toBe(body);
        expect(verifiedStateOf(SIGNED, { ...pr, body: edited })).toBeUndefined();
        // It isn't read as a plan at all, so writing the body back walks nothing deep either.
        expect(planPayload(edited)).toBeUndefined();
        for (const record of [SIGNED, TRUSTING]) expect(planPayload(withMarker(record, edited, state, OWN_BRANCH))).toBeUndefined();
      }
    });

    // A multiline `$` matches before `\r` as before `\n`, so the Tracks line reads the same either way.
    it("keeps verifying a body someone saved in GitHub's web editor, which stores CRLF", () => {
      const crlf = body.replaceAll("\n", "\r\n");
      expect(verifiedStateOf(SIGNED, { ...pr, body: crlf })).toEqual(state);
      expect(verifiedStateOf(SIGNED, { ...pr, body: crlf.replace("Tracks #3.", "Tracks #4.") })).toBeUndefined();
    });

    it("verifies CRLF, Unicode and compressed plans as written", () => {
      const compressed = planSection({ heading: "## Plan", people: "x\n".repeat(30_000), payload: { notes: ["ünïcødé ✓"], fill: "y".repeat(40_000) }, name: "the plan" });
      expect(compressed).toContain("<!-- leanish:plan:br ");
      for (const text of ["Fixes snappy.\r\nTracks #3.\r\n", "Fixes ünïcødé ✓.\n\nTracks #3.", compressed]) {
        const written = marked(text, state);
        expect(verifiedStateOf(SIGNED, { ...pr, body: written })).toEqual(state);
      }
    });
  });

  describe("trusted-editors", () => {
    const state = { head: HEAD_SHA, base: BASE_SHA, adaptations: 1 };

    it("writes an unsigned state line and reads its own output back", () => {
      const body = withMarker(TRUSTING, "Fixes snappy.\n\nTracks #3.", state, OWN_BRANCH);
      expect(body).toContain(`<!-- leanish:state head=${HEAD_SHA} base=${BASE_SHA} adaptations=1 -->`);
      expect(body).not.toContain("sig=");
      expect(verifiedStateOf(TRUSTING, ownPr({ body }))).toEqual(state);
      // Whoever can edit it is trusted: an edited plan or Tracks line is still read.
      expect(verifiedStateOf(TRUSTING, ownPr({ body: body.replace("Tracks #3.", "Tracks #4.") }))).toEqual(state);
    });

    it("ignores a signature, valid or not", () => {
      const signed = marked("Fixes snappy.", state);
      expect(verifiedStateOf(TRUSTING, ownPr({ body: signed }))).toEqual(state);
      expect(verifiedStateOf(TRUSTING, ownPr({ body: signed.replace(/sig=.{43}/, `sig=${"A".repeat(43)}`) }))).toEqual(state);
    });

    it("isn't read by a signed tool", () => {
      expect(verifiedStateOf(SIGNED, ownPr({ body: withMarker(TRUSTING, "Fixes snappy.", state, OWN_BRANCH) }))).toBeUndefined();
    });

    it("still takes only the write token's PRs for the tool's", () => {
      expect(isOwnPullRequest(RULES, ownPr({ author: "a-writer" }), REPO, "main", TRUSTING.login)).toBe(false);
    });
  });

  it("appends no more than MARKER_ROOM to a body, for either tool", () => {
    for (const tool of ["secure-it", "bump-it"] as const) {
      const appended = withMarker(signedRecord(ownPullRequests(tool)), "x", { head: HEAD_SHA, base: BASE_SHA, adaptations: 999_999 }, `${tool}/2026-10-05-x`).length - 1;
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
      expect(planPayload(marked(`${quoted}\n\n${real}`, state))).toEqual({ kind: "routine" });
    }
  });

  it("refuses a body whose plan or machine lines differ from the text the tool composed", () => {
    const state = { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 };
    // What cleaning a local path can do: a line that wasn't a Tracks line becomes one.
    expect(() => withMarker(SIGNED, "Fixes snappy.\n\nTracks #999.", state, OWN_BRANCH, "Fixes snappy.\n\nTracks /work/root/#999.")).toThrow("changed its plan or its machine lines");
    expect(() => withMarker(SIGNED, `Fixes snappy.\n\n${planBlock({ kind: "b" })}`, state, OWN_BRANCH, `Fixes snappy.\n\n${planBlock({ kind: "a" })}`)).toThrow("changed its plan or its machine lines");
    // Prose may change on the way; what the tool acts on may not.
    expect(withMarker(SIGNED, "Fixes snappy (cleaned).\n\nTracks #3.", state, OWN_BRANCH, "Fixes snappy.\n\nTracks #3.")).toContain("Tracks #3.");
  });
});
