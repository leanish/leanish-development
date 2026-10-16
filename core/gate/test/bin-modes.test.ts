/**
 * npm marks every `bin` target executable on install; one committed without
 * the bit shows up as a change in a tool's own working copy. Read the mode git
 * records: `npm ci` fixes the working tree's before the tests run.
 */
import { execFileSync } from "node:child_process";
import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = new URL("../../../", import.meta.url).pathname;

describe("bin targets", () => {
  const workspaces = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { workspaces: string[] }).workspaces;
  const bins = workspaces.flatMap((pattern) => globSync(pattern, { cwd: ROOT })).flatMap((directory) => {
    const manifest = JSON.parse(readFileSync(join(ROOT, directory, "package.json"), "utf8")) as { bin?: Record<string, string> };
    return Object.values(manifest.bin ?? {}).map((target) => join(directory, target));
  });

  it("are found", () => {
    expect(bins.length).toBeGreaterThan(0);
  });

  it.each(bins)("%s is committed executable, as npm would make it", (path) => {
    const entry = execFileSync("git", ["ls-files", "--stage", "--", path], { cwd: ROOT, encoding: "utf8" });
    expect(entry.split(" ")[0]).toBe("100755");
  });
});
