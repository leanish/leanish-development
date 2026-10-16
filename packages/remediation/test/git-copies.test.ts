import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { WorkingCopy } from "../../agent-basics/src/types/working-copy.ts";
import { candidateTree, changedBetween, changedSince, exportCommit, linkProblems, sameTreeAs, snapshotCandidate } from "../src/git-copies.ts";

let root: string;
let workingCopy: WorkingCopy;
let first: string;

function git(args: ReadonlyArray<string>): string {
  const result = spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd: workingCopy.path, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "git-copies-"));
  workingCopy = { projectId: "leanish/widget", path: join(root, "wc"), branch: "main", headSha: "", gitDir: join(root, "git") };
  spawnSync("git", ["init", "-q", "-b", "main", "--separate-git-dir", workingCopy.gitDir!, workingCopy.path]);
  await writeFile(join(workingCopy.path, "package.json"), '{"name":"a"}\n');
  await writeFile(join(workingCopy.path, ".gitignore"), "build/\n");
  // Attributes `git archive` would apply: a dropped file and a substituted one.
  await writeFile(join(workingCopy.path, ".gitattributes"), "hidden.gradle export-ignore\nversion.txt export-subst\n");
  await writeFile(join(workingCopy.path, "hidden.gradle"), "dependencies {}\n");
  await writeFile(join(workingCopy.path, "version.txt"), "$Format:%H$\n");
  await writeFile(join(workingCopy.path, "gradlew"), "#!/bin/sh\n");
  await chmod(join(workingCopy.path, "gradlew"), 0o755);
  await symlink("package.json", join(workingCopy.path, "link.json"));
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "one"]);
  first = git(["rev-parse", "HEAD"]);
});

afterAll(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

describe("git copies", () => {
  it("diffs and exports real baseline objects despite replaced commits, blobs and a redirected .git", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "git-copies-replaced-"));
    try {
      const path = join(fixture, "tree");
      const gitDir = join(fixture, "metadata");
      const alternate = join(fixture, "alternate");
      await mkdir(path);
      const git = (...args: string[]) => {
        const result = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { cwd: path, encoding: "utf8" });
        if (result.status !== 0) throw new Error(result.stderr);
        return result.stdout.trim();
      };
      git("init", "--quiet", `--separate-git-dir=${gitDir}`);
      await writeFile(join(path, "package.json"), "original");
      git("add", ".");
      git("commit", "--quiet", "-m", "original");
      const base = git("rev-parse", "HEAD");
      const blob = git("rev-parse", "HEAD:package.json");
      await writeFile(join(path, "package.json"), "forged");
      git("add", ".");
      git("commit", "--quiet", "-m", "forged");
      const forged = git("rev-parse", "HEAD");
      const forgedBlob = git("rev-parse", "HEAD:package.json");
      git("clone", "--quiet", "--bare", gitDir, alternate);
      git(`--git-dir=${gitDir}`, "replace", base, forged);
      git(`--git-dir=${gitDir}`, "replace", blob, forgedBlob);
      await writeFile(join(path, ".git"), `gitdir: ${alternate}\n`);
      const wc: WorkingCopy = { projectId: "fixture", path, gitDir, branch: "main", headSha: base };
      expect(await changedSince(wc, base)).toEqual(["package.json"]);
      expect(await sameTreeAs(wc, base)).toBe(false);
      const exported = await exportCommit(wc, base);
      try {
        expect(await readFile(join(exported.dir, "package.json"), "utf8")).toBe("original");
      } finally {
        await exported.remove();
      }
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it("exports a commit's files into a fresh directory, and removes it", async () => {
    await writeFile(join(workingCopy.path, "package.json"), '{"name":"b"}\n');
    const copy = await exportCommit(workingCopy, first);
    expect(await readFile(join(copy.dir, "package.json"), "utf8")).toBe('{"name":"a"}\n');
    // Exactly as committed: no export-ignore, no export-subst, modes and links kept.
    expect(await readFile(join(copy.dir, "hidden.gradle"), "utf8")).toBe("dependencies {}\n");
    expect(await readFile(join(copy.dir, "version.txt"), "utf8")).toBe("$Format:%H$\n");
    expect((await lstat(join(copy.dir, "gradlew"))).mode & 0o111).not.toBe(0);
    expect(await readlink(join(copy.dir, "link.json"))).toBe("package.json");
    await copy.remove();
    await expect(readFile(join(copy.dir, "package.json"))).rejects.toThrow();
    await expect(exportCommit(workingCopy, "HEAD")).rejects.toThrow("full commit sha");
  });

  it("lists what the working tree changed since a commit, untracked files included and ignored ones not", async () => {
    await writeFile(join(workingCopy.path, "package.json"), '{"name":"b"}\n');
    await writeFile(join(workingCopy.path, "new.txt"), "x\n");
    spawnSync("mkdir", ["-p", join(workingCopy.path, "build")]);
    await writeFile(join(workingCopy.path, "build", "out.txt"), "x\n");
    expect(await changedSince(workingCopy, first)).toEqual(["new.txt", "package.json"]);
    expect(await sameTreeAs(workingCopy, first)).toBe(false);
    await writeFile(join(workingCopy.path, "package.json"), '{"name":"a"}\n');
    await rm(join(workingCopy.path, "new.txt"));
    expect(await sameTreeAs(workingCopy, first)).toBe(true);
  });

  it("refuses a tree with an entry under its own symlink, case-insensitively: a symlink A and a file under a/", async () => {
    const input = (args: ReadonlyArray<string>, stdin: string) => {
      const result = spawnSync("git", ["--git-dir", workingCopy.gitDir!, ...args], { input: stdin, encoding: "utf8" });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    const file = input(["hash-object", "-w", "--stdin"], "written through the link\n");
    const link = input(["hash-object", "-w", "--stdin"], "/tmp");
    const sub = input(["mktree"], `100644 blob ${file}\tfile\n`);
    const root = input(["mktree"], `120000 blob ${link}\tA\n040000 tree ${sub}\ta\n`);
    const commit = input(["-c", "user.email=t@example.com", "-c", "user.name=t", "commit-tree", root, "-m", "collision"], "");
    await expect(exportCommit(workingCopy, commit)).rejects.toThrow("has a/file under its symlink A");
    const twins = input(["mktree"], `100644 blob ${file}\tREADME\n100644 blob ${file}\treadme\n`);
    const twinCommit = input(["-c", "user.email=t@example.com", "-c", "user.name=t", "commit-tree", twins, "-m", "twins"], "");
    await expect(exportCommit(workingCopy, twinCommit)).rejects.toThrow("has paths that collide: README and readme");
  });
});

describe("the verification snapshot", () => {
  /** A repository of its own: these tests commit, stage and write freely. */
  async function repository(): Promise<{ readonly copy: WorkingCopy; readonly run: (args: ReadonlyArray<string>) => string; readonly base: string }> {
    const dir = await mkdtemp(join(tmpdir(), "candidate-"));
    const copy: WorkingCopy = { projectId: "leanish/widget", path: join(dir, "wc"), branch: "main", headSha: "", gitDir: join(dir, "git") };
    spawnSync("git", ["init", "-q", "-b", "main", "--separate-git-dir", copy.gitDir!, copy.path]);
    const run = (args: ReadonlyArray<string>) => {
      const result = spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd: copy.path, encoding: "utf8" });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    await writeFile(join(copy.path, "package-lock.json"), '{"v":1}\n');
    await writeFile(join(copy.path, ".gitignore"), "build/\n");
    run(["add", "--all"]);
    run(["commit", "-q", "-m", "base"]);
    return { copy, run, base: run(["rev-parse", "HEAD"]) };
  }

  it("records the working tree as publication stages it, without touching the index, and keeps it whatever comes later", async () => {
    const { copy, run, base } = await repository();
    await writeFile(join(copy.path, "package-lock.json"), '{"v":2}\n');
    await writeFile(join(copy.path, "added.txt"), "new\n");
    await mkdir(join(copy.path, "build"), { recursive: true });
    await writeFile(join(copy.path, "build", "out.txt"), "ignored\n");
    const candidate = await snapshotCandidate(copy);
    expect(run(["diff", "--cached", "--name-only"])).toBe("");
    expect(await changedBetween(copy, base, candidate)).toEqual(["added.txt", "package-lock.json"]);
    expect(await candidateTree(copy)).toBe(run(["rev-parse", `${candidate}^{tree}`]));
    // A write after the snapshot changes neither the snapshot nor what publication must find staged.
    await writeFile(join(copy.path, "package-lock.json"), '{"v":"unverified"}\n');
    expect(run(["show", `${candidate}:package-lock.json`])).toBe('{"v":2}');
    expect(await candidateTree(copy)).toBe(run(["rev-parse", `${candidate}^{tree}`]));
  });

  it("has no candidate before a snapshot", async () => {
    const { copy } = await repository();
    expect(await candidateTree(copy)).toBeUndefined();
  });

  it("refuses links and submodules the edit adds, a directory replaced by a link included", async () => {
    const { copy, base } = await repository();
    await mkdir(join(copy.path, "real"), { recursive: true });
    await writeFile(join(copy.path, "real", "lock.json"), '{"v":2}\n');
    await rm(join(copy.path, "package-lock.json"));
    await symlink("real/lock.json", join(copy.path, "package-lock.json"));
    await symlink("real", join(copy.path, "gradle"));
    const sub = join(copy.path, "vendor");
    await mkdir(sub);
    spawnSync("git", ["init", "-q", "-b", "main", sub]);
    await writeFile(join(sub, "action.yml"), "runs: {}\n");
    spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "sub"], { cwd: sub });
    expect(await linkProblems(copy, base, await snapshotCandidate(copy))).toEqual([
      "the edit added the submodule vendor: verification can't read a submodule's files",
      "the edit made gradle a symbolic link: verification can't check what's behind one",
      "the edit made package-lock.json a symbolic link: verification can't check what's behind one",
      // The new links lead to a file the edit also wrote.
      "the edit changed real/lock.json, behind the link gradle: verification can't check what's behind one",
      "the edit changed real/lock.json, behind the link package-lock.json: verification can't check what's behind one",
    ].sort());
  });

  it("refuses a link whose target the commit has only by another case or form, and any link leading out", async () => {
    const { copy, run } = await repository();
    await mkdir(join(copy.path, "tools"));
    await writeFile(join(copy.path, "tools", "recipe.txt"), "runs: {}\n");
    await mkdir(join(copy.path, "local"));
    await symlink("../TOOLS/recipe.txt", join(copy.path, "local", "action.yml"));
    // A final sigma lowercases differently from a medial one: only folding further than any filesystem matches it.
    await mkdir(join(copy.path, "recipes", "aσ"), { recursive: true });
    await writeFile(join(copy.path, "recipes", "aσ", "ci.yml"), "runs: {}\n");
    await symlink("recipes/AΣ/ci.yml", join(copy.path, "sigma.yml"));
    run(["add", "--all"]);
    run(["commit", "-q", "-m", "a differently cased link"]);
    const cased = run(["rev-parse", "HEAD"]);
    await writeFile(join(copy.path, "tools", "recipe.txt"), "runs: { using: node }\n");
    expect(await linkProblems(copy, cased, await snapshotCandidate(copy))).toEqual([
      "the link local/action.yml leads through TOOLS, which this commit has only by another case or form: verification can't tell where a checkout takes it",
      "the link sigma.yml leads through recipes/AΣ, which this commit has only by another case or form: verification can't tell where a checkout takes it",
    ]);
    run(["checkout", "-q", "--", "."]);
    await symlink("../wc/tools/recipe.txt", join(copy.path, "reentering"));
    await symlink("/etc/hosts", join(copy.path, "absolute"));
    run(["add", "--all"]);
    run(["commit", "-q", "-m", "links out"]);
    const out = run(["rev-parse", "HEAD"]);
    await writeFile(join(copy.path, "package-lock.json"), '{"v":3}\n');
    expect(await linkProblems(copy, out, await snapshotCandidate(copy))).toEqual([
      "the link absolute leads outside the repository: verification can't tell whether it comes back to what the edit changed",
      "the link local/action.yml leads through TOOLS, which this commit has only by another case or form: verification can't tell where a checkout takes it",
      "the link reentering leads outside the repository: verification can't tell whether it comes back to what the edit changed",
      "the link sigma.yml leads through recipes/AΣ, which this commit has only by another case or form: verification can't tell where a checkout takes it",
    ]);
  });

  it("lets an edit remove a link that leaves the repository or reaches a variant, and checks variants on the way", async () => {
    const { copy, run } = await repository();
    await mkdir(join(copy.path, "scripts"));
    await writeFile(join(copy.path, "scripts", "file"), "x\n");
    await symlink("scripts", join(copy.path, "alias"));
    // Through `Alias`, which only a case-insensitive checkout resolves to the `alias` link.
    await symlink("Alias/file", join(copy.path, "outer"));
    await symlink("../../shared", join(copy.path, "shared"));
    run(["add", "--all"]);
    run(["commit", "-q", "-m", "links out and through a variant"]);
    const base = run(["rev-parse", "HEAD"]);
    await writeFile(join(copy.path, "README.md"), "edited\n");
    expect(await linkProblems(copy, base, await snapshotCandidate(copy))).toEqual([
      "the link outer leads through Alias, which this commit has only by another case or form: verification can't tell where a checkout takes it",
      "the link shared leads outside the repository: verification can't tell whether it comes back to what the edit changed",
    ]);
    await rm(join(copy.path, "outer"));
    await rm(join(copy.path, "shared"));
    expect(await linkProblems(copy, base, await snapshotCandidate(copy))).toEqual([]);
  });

  it("says when the edit moves an existing submodule to another commit", async () => {
    const { copy, run } = await repository();
    const index = join(copy.gitDir!, "submodule-index");
    const env = { ...process.env, GIT_INDEX_FILE: index, GIT_DIR: copy.gitDir! };
    const plumb = (args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: copy.path, env, encoding: "utf8" }).stdout.trim();
    const head = run(["rev-parse", "HEAD"]);
    const commitWith = (parent: string, gitlink: string) => {
      plumb(["read-tree", parent]);
      plumb(["update-index", "--add", "--cacheinfo", `160000,${gitlink},vendor`]);
      return plumb(["commit-tree", plumb(["write-tree"]), "-p", parent, "-m", "submodule"]);
    };
    const added = commitWith(head, "1".repeat(40));
    const moved = commitWith(added, "2".repeat(40));
    expect(await linkProblems(copy, added, moved)).toEqual([
      "the edit moved the submodule vendor to another commit: verification can't read a submodule's files",
    ]);
  });

  it("matches an added path behind a link loosely, as a case-insensitive checkout puts `FOO/x` in `foo/`", async () => {
    const { copy, run } = await repository();
    await mkdir(join(copy.path, "foo"));
    await writeFile(join(copy.path, "foo", "y.txt"), "y\n");
    await symlink("foo", join(copy.path, "L"));
    run(["add", "--all"]);
    run(["commit", "-q", "-m", "a link to a folder"]);
    const base = run(["rev-parse", "HEAD"]);
    // `FOO/x.txt` beside `foo/` can't be written on a case-insensitive disk: built from git objects instead.
    const index = join(copy.gitDir!, "variant-index");
    const env = { ...process.env, GIT_INDEX_FILE: index, GIT_DIR: copy.gitDir! };
    const plumb = (args: string[], input?: string) => spawnSync("git", args, { cwd: copy.path, env, input, encoding: "utf8" }).stdout.trim();
    plumb(["read-tree", base]);
    const blob = plumb(["hash-object", "-w", "--stdin"], "x\n");
    plumb(["update-index", "--add", "--cacheinfo", `100644,${blob},FOO/x.txt`]);
    const variant = plumb(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit-tree", plumb(["write-tree"]), "-p", base, "-m", "variant"]);
    expect(await linkProblems(copy, base, variant)).toEqual([
      "the edit changed FOO/x.txt, behind the link L: verification can't check what's behind one",
    ]);
  });

  it("refuses an edit behind a link the repository already has, through linked directories and chains of links", async () => {
    const { copy, run } = await repository();
    for (const dir of ["actual", "d", ".github/workflows"]) await mkdir(join(copy.path, dir), { recursive: true });
    await writeFile(join(copy.path, "recipe.txt"), "runs: {}\n");
    await writeFile(join(copy.path, "actual", "action.yml"), "runs: {}\n");
    await writeFile(join(copy.path, "d", "c.yml"), "runs: {}\n");
    await writeFile(join(copy.path, "unrelated.txt"), "one\n");
    await mkdir(join(copy.path, "local"));
    await symlink("../recipe.txt", join(copy.path, "local", "action.yml"));
    await symlink("actual", join(copy.path, "linked"));
    await symlink("d", join(copy.path, "b"));
    await symlink("b/c.yml", join(copy.path, "chained.yml"));
    // Back to the root, so still inside; and a loop, which leads nowhere a checkout can read.
    await symlink("../../outside.yml", join(copy.path, ".github", "workflows", "outside.yml"));
    await symlink("loop-b", join(copy.path, "loop-a"));
    await symlink("loop-a", join(copy.path, "loop-b"));
    run(["add", "--all"]);
    run(["commit", "-q", "-m", "links the repository has"]);
    const inherited = run(["rev-parse", "HEAD"]);
    await writeFile(join(copy.path, "unrelated.txt"), "two\n");
    expect(await linkProblems(copy, inherited, await snapshotCandidate(copy))).toEqual([]);
    for (const path of ["recipe.txt", "actual/action.yml", "d/c.yml"]) await writeFile(join(copy.path, path), "runs: { using: node }\n");
    expect(await linkProblems(copy, inherited, await snapshotCandidate(copy))).toEqual([
      "the edit changed actual/action.yml, behind the link linked: verification can't check what's behind one",
      "the edit changed d/c.yml, behind the link b: verification can't check what's behind one",
      "the edit changed d/c.yml, behind the link chained.yml: verification can't check what's behind one",
      "the edit changed recipe.txt, behind the link local/action.yml: verification can't check what's behind one",
    ]);
  });

  it("refuses an edit that adds a path behind a link to the repository's root, `.` or `..` alike", async () => {
    const { copy, run } = await repository();
    await mkdir(join(copy.path, "sub"));
    await symlink(".", join(copy.path, "root"));
    await symlink("..", join(copy.path, "sub", "up"));
    run(["add", "--all"]);
    run(["commit", "-q", "-m", "links to the root"]);
    const inherited = run(["rev-parse", "HEAD"]);
    await writeFile(join(copy.path, "added.txt"), "new\n");
    expect(await linkProblems(copy, inherited, await snapshotCandidate(copy))).toEqual([
      "the edit changed added.txt, behind the link root: verification can't check what's behind one",
      "the edit changed added.txt, behind the link sub/up: verification can't check what's behind one",
    ]);
  });
});
