import { describe, expect, it } from "vitest";

import { trackingContent, withoutClosingKeywords } from "../src/issue-text.ts";

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
