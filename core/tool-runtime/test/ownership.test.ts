import { describe, expect, it } from "vitest";

import type { GitHubPullRequest } from "@leanish/agent-runtime/types/clients";
import { withMarker } from "../src/own-pr.ts";
import { inspectOwnership, samePlan } from "../src/ownership.ts";
import { BASE_SHA, HEAD_SHA, ownPr, PUSHED_SHA, RULES } from "./fake-github.ts";

describe("inspectOwnership", () => {
  it("takes a body recording the current head as the tool's", () => {
    const pr = ownPr();
    expect(inspectOwnership(pr)).toEqual({ kind: "ours", pr });
  });

  it("tells a head nobody recorded apart: pushed by someone else when the body has a state, untracked without one", () => {
    expect(inspectOwnership(ownPr({ headSha: PUSHED_SHA }))).toEqual({ kind: "pushed-by-someone-else", recordedHead: HEAD_SHA });
    expect(inspectOwnership(ownPr({ body: `Rewritten.\n\n${RULES.marker}\n` }))).toEqual({ kind: "untracked" });
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

  it("never matches a body that doesn't record the current head, without reading its plan", () => {
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
