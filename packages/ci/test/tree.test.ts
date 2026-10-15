import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { namingFailures } from "../src/http.ts";
import { gitTree, workingTree } from "../src/tree.ts";
import { runProcess } from "../src/process.ts";

let root: string;

describe("the working tree", () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "supply-chain-tree-"));
    await mkdir(join(root, ".github/workflows"), { recursive: true });
    await writeFile(join(root, ".github/workflows/ci.yml"), "on: push\n");
  });

  afterAll(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  it("has no file under a path whose parent is a file", async () => {
    const tree = workingTree(root);
    expect(await tree.read(".github/workflows/ci.yml")).toBe("on: push\n");
    expect(await tree.read(".github/workflows/ci.yml/action.yml")).toBeUndefined();
    expect(await tree.read("missing/action.yml")).toBeUndefined();
    expect(await tree.list(".github/workflows/ci.yml")).toEqual([]);
  });

  it("lists symlinks that lead to files only when asked, never links to directories or broken ones", async () => {
    await mkdir(join(root, "gradle"), { recursive: true });
    await writeFile(join(root, "catalog-data.txt"), "[libraries]\n");
    await symlink("../catalog-data.txt", join(root, "gradle/tools.toml"));
    await symlink("../.github", join(root, "gradle/linked-dir"));
    await symlink("../missing.txt", join(root, "gradle/broken.toml"));
    const tree = workingTree(root);
    expect(await tree.list("gradle")).toEqual([]);
    expect(await tree.list("gradle", { symlinks: true })).toEqual(["gradle/tools.toml"]);
    expect(await tree.read("gradle/tools.toml")).toBe("[libraries]\n");
  });
});

describe("commit trees", () => {
  it("keeps the recorded baseline despite a redirected .git and replace refs in either metadata directory", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "supply-chain-baseline-"));
    try {
      const path = join(fixture, "tree");
      const metadata = join(fixture, "metadata");
      const redirected = join(fixture, "redirected");
      const git = (...args: string[]) => execFileSync("git", args, { cwd: path, encoding: "utf8" }).trim();
      await mkdir(path);
      git("init", "--quiet", `--separate-git-dir=${metadata}`);
      await writeFile(join(path, "baseline.txt"), "original baseline");
      git("add", ".");
      const commit = () => git("-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "fixture");
      commit();
      const sha = git("rev-parse", "HEAD");
      const tree = await gitTree(path, sha, runProcess, metadata);
      await writeFile(join(path, "baseline.txt"), "forged baseline");
      await writeFile(join(path, "forged.txt"), "extra");
      git("add", ".");
      commit();
      const forged = git("rev-parse", "HEAD");
      git("clone", "--quiet", "--bare", metadata, redirected);
      git(`--git-dir=${metadata}`, "replace", sha, forged);
      git(`--git-dir=${redirected}`, "replace", sha, forged);
      await writeFile(join(path, ".git"), `gitdir: ${redirected}\n`);
      expect(git("show", `${sha}:baseline.txt`)).toBe("forged baseline");
      expect(await tree.read("baseline.txt")).toBe("original baseline");
      expect(await tree.read("forged.txt")).toBeUndefined();
      expect(await tree.list(".")).toEqual(["baseline.txt"]);
      expect((await gitTree(path, "HEAD~1", runProcess, metadata)).id).toBe(sha);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});

describe("network errors", () => {
  it("name the request and the reason undici keeps in the cause", async () => {
    const failing = namingFailures(async () => {
      throw new TypeError("fetch failed", { cause: new Error("read ECONNRESET") });
    });
    await expect(failing("https://registry.npmjs.org/vite", { method: "GET" })).rejects.toThrow(
      "GET https://registry.npmjs.org/vite failed: read ECONNRESET",
    );
    const plain = namingFailures(async () => {
      throw new Error("aborted");
    });
    await expect(plain("https://api.github.com/x", { method: "HEAD" })).rejects.toThrow("HEAD https://api.github.com/x failed: aborted");
    const codeOnly = namingFailures(async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error(""), { code: "UND_ERR_SOCKET" }) });
    }, { sleep: async () => {}, random: () => 0.5 });
    await expect(codeOnly("https://plugins.gradle.org/m2/x.pom")).rejects.toThrow("GET https://plugins.gradle.org/m2/x.pom failed: UND_ERR_SOCKET");
  });
});
