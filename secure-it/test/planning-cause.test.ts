import { describe, expect, it } from "vitest";

import { planningCause } from "../src/planning-cause.ts";

describe("planningCause", () => {
  it("keeps the URL's registry and package path without userinfo, query credentials or fragments", () => {
    expect(planningCause("registry 502 from https://reader:password@registry.example/pkg?token=query-secret#private-fragment"))
      .toBe("registry 502 from https://registry.example/pkg");
  });

  it("redacts an unreadable URL rather than publishing its credentials", () => {
    expect(planningCause("registry 502 from https://reader:password@%"))
      .toBe("registry 502 from [redacted URL]");
  });

  it.each(["ghp_fake123", "gho_fake123", "ghu_fake123", "ghs_fake123", "ghr_fake123", "github_pat_fake123", "npm_fake123"])("redacts a %s token while keeping the failure", (token) => {
    expect(planningCause(`registry 502, credential=${token}; retry later`)).toBe("registry 502, credential=[redacted]; retry later");
  });

  it.each(["Bearer fake-secret", "bearer fake-secret", "Authorization: Basic fake-secret", "authorization: fake-secret"])("redacts %s", (header) => {
    expect(planningCause(`registry 502, ${header}`)).toBe(`registry 502, ${header.toLowerCase().startsWith("authorization") ? "Authorization:" : "Bearer"} [redacted]`);
  });

  it.each(["\n", "\r\n"])("publishes only the first line, leaving multiline file excerpts out (%j)", (newline) => {
    expect(planningCause(`registry 502${newline}private file contents: some-secret`)).toBe("registry 502");
  });
});
