import { describe, expect, it } from "vitest";

import { safePath } from "../src/local-files.ts";

describe("safePath", () => {
  // The lexical check every tool write and floor record path goes through before any filesystem call.
  it.each([
    { path: "package.json", safe: true },
    { path: "packages/app/package-lock.json", safe: true },
    { path: ".github/workflows/ci.yml", safe: true },
    { path: "", safe: false },
    { path: "/etc/passwd", safe: false },
    { path: "../package.json", safe: false },
    { path: "packages/../../secret", safe: false },
    { path: "./package.json", safe: false },
    { path: "packages//package.json", safe: false },
    { path: "packages/", safe: false },
    { path: "packages\\package.json", safe: false },
    { path: "package.json\0", safe: false },
    { path: 7, safe: false },
    { path: undefined, safe: false },
  ])("counts $path as safe: $safe", ({ path, safe }) => {
    expect(safePath(path)).toBe(safe);
  });
});
