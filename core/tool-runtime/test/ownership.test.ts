import { describe, expect, it } from "vitest";

import { withMarker } from "../src/own-pr.ts";
import { inspectOwnership, type Ours, samePlan } from "../src/ownership.ts";
import { BASE_SHA, HEAD_SHA, ownPr, PUSHED_SHA, RULES, SIGNED } from "./fake-github.ts";

describe("inspectOwnership", () => {
  it("takes a body recording the current head as the tool's", () => {
    const pr = ownPr();
    expect(inspectOwnership(SIGNED, pr)).toEqual({ kind: "ours", pr, state: { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 } });
  });

  it("tells a head nobody recorded apart: pushed by someone else when the body has a signed state, untracked without one", () => {
    expect(inspectOwnership(SIGNED, ownPr({ headSha: PUSHED_SHA }))).toEqual({ kind: "pushed-by-someone-else", recordedHead: HEAD_SHA });
    expect(inspectOwnership(SIGNED, ownPr({ body: `Rewritten.\n\n${RULES.marker}\n` }))).toEqual({ kind: "untracked" });
  });

  it("doesn't take a PR as the tool's on a state someone else wrote, whatever head it claims", () => {
    const forge = (head: string) => withMarker({ ...SIGNED, signingKey: Buffer.alloc(32, 9) }, "Mine now.", { head, base: BASE_SHA, adaptations: 0 });
    expect(inspectOwnership(SIGNED, ownPr({ headSha: PUSHED_SHA, body: forge(PUSHED_SHA) }))).toEqual({ kind: "untracked" });
    expect(inspectOwnership(SIGNED, ownPr({ headSha: PUSHED_SHA, body: forge(HEAD_SHA) }))).toEqual({ kind: "untracked" });
  });

  it("leaves a push alone even when the pusher edits the recorded head to match", () => {
    const signed = ownPr().body;
    expect(inspectOwnership(SIGNED, ownPr({ headSha: PUSHED_SHA, body: signed.replace(HEAD_SHA, PUSHED_SHA) }))).toEqual({ kind: "untracked" });
  });

  it("keeps a PR the tool's when only its prose changes", () => {
    const pr = ownPr({ body: `A person's note.\n\n${ownPr().body}` });
    expect(inspectOwnership(SIGNED, pr).kind).toBe("ours");
  });
});

describe("samePlan", () => {
  const read = (body: string) => /plan=(\w+)/.exec(body)?.[1];
  const ours = (body: string): Ours => {
    const ownership = inspectOwnership(SIGNED, ownPr({ body }));
    if (ownership.kind !== "ours") throw new Error("the fixture should be the tool's");
    return ownership;
  };
  const planned = ours(withMarker(SIGNED, "plan=same", { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }));

  it("matches a plan that reads as the digest", () => {
    expect(samePlan(planned, "same", read)).toBe(true);
    expect(samePlan(planned, "other", read)).toBe(false);
  });

  it("doesn't match a plan it can't read", () => {
    expect(samePlan(planned, "same", () => undefined)).toBe(false);
  });
});
