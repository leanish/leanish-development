import { describe, expect, it } from "vitest";

import { isDependencyFile, isMechanical } from "../src/edit-checks.ts";

describe("isMechanical", () => {
  it("takes the base's side for the dependency files a move touches, workflows aside, matching the catalog by whole folder", () => {
    for (const path of ["package-lock.json", "web/package.json", "npm-shrinkwrap.json", "gradle.lockfile", "app/buildscript-gradle.lockfile", "build.gradle", "app/build.gradle.kts", "gradle/libs.versions.toml", "app/gradle/libs.versions.toml", ".github/dependency-floors.json"]) {
      expect(isMechanical(path), path).toBe(true);
    }
    for (const path of ["xgradle/libs.versions.toml", "app/xgradle/libs.versions.toml", ".github/workflows/ci.yml", "action.yml", "README.md"]) {
      expect(isMechanical(path), path).toBe(false);
    }
    expect(isDependencyFile(".github/workflows/ci.yml", true)).toBe(true);
  });
});
