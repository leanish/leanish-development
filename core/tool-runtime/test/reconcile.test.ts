import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { WorkingCopy } from "@leanish/agent-runtime/types/working-copy";
import { candidateTree, changedSince, fileState, snapshotCandidate } from "../src/git-copies.ts";
import { publicationParent, revertToBase } from "../src/reconcile.ts";
import { assertAgentWorkspace } from "../src/command.ts";

let root: string | undefined;

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function repo(): Promise<{ workingCopy: WorkingCopy; git: (...args: string[]) => { status: number | null; stdout: string } }> {
  root = await mkdtemp(join(tmpdir(), "reconcile-"));
  const workingCopy: WorkingCopy = { projectId: "leanish/widget", path: join(root, "wc"), branch: "main", headSha: "", gitDir: join(root, "git") };
  spawnSync("git", ["init", "-q", "-b", "main", "--separate-git-dir", workingCopy.gitDir!, workingCopy.path]);
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd: workingCopy.path, encoding: "utf8" });
    return { status: result.status, stdout: result.stdout.trim() };
  };
  // A commit can detach maintenance: spawnSync waits for git, not that writer,
  // which could recreate files while afterEach removes this disposable repo.
  git("config", "maintenance.auto", "false");
  git("config", "gc.auto", "0");
  return { workingCopy, git };
}

const write = (wc: WorkingCopy, path: string, text: string) => writeFile(join(wc.path, path), text);

describe("revertToBase", () => {
  it("puts every path a conflicted merge leaves different from the new base back to the base's content", async () => {
    const { workingCopy, git } = await repo();
    await write(workingCopy, "package.json", '{"dependencies":{"vite":"^8.3.0"}}\n');
    await write(workingCopy, "gone.txt", "base\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "bump-it/2026-10-07-routine");
    // The PR: a range edit, a new file, a removed one.
    await write(workingCopy, "package.json", '{"dependencies":{"vite":"^8.4.0"}}\n');
    await write(workingCopy, "added.txt", "pr\n");
    git("rm", "-q", "gone.txt");
    git("add", "-A");
    git("commit", "-q", "-m", "pr");
    const oldHead = git("rev-parse", "HEAD").stdout;
    // The default branch moves: the same line, differently, and something else.
    git("checkout", "-q", "main");
    await write(workingCopy, "package.json", '{"dependencies":{"vite":"^8.3.5"}}\n');
    await write(workingCopy, "other.txt", "base moved\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base moved");
    const newBase = git("rev-parse", "HEAD").stdout;
    git("checkout", "-q", "bump-it/2026-10-07-routine");
    expect(git("merge", "-q", "--no-edit", "main").status).not.toBe(0);
    const prepared = { branch: "bump-it/2026-10-07-routine", baseSha: newBase, remoteHeadSha: oldHead, preparedSha: oldHead };
    // An explained resolve workspace keeps its HEAD and conflicted index intact.
    await assertAgentWorkspace(workingCopy, { mode: "resolve", conflicted: ["package.json"], toolWritten: [] });
    await expect(assertAgentWorkspace(workingCopy, { mode: "apply", toolWritten: ["package.json"] })).rejects.toThrow("other.txt");
    for (const kind of ["unstaged", "staged", "staged-then-restored"]) {
      await write(workingCopy, "other.txt", "unrelated\n");
      if (kind !== "unstaged") git("add", "other.txt");
      if (kind === "staged-then-restored") await write(workingCopy, "other.txt", "base moved\n");
      await expect(assertAgentWorkspace(workingCopy, { mode: "resolve", conflicted: ["package.json"] })).rejects.toThrow("undeclared changes against HEAD: other.txt");
      await write(workingCopy, "other.txt", "base moved\n");
      git("add", "other.txt");
    }
    // A tool's explicit restore is guard metadata, not an instruction to preserve these dependency bytes.
    const conflict = await readFile(join(workingCopy.path, "package.json"), "utf8");
    await write(workingCopy, "package.json", '{"dependencies":{"vite":"^8.3.5"}}\n');
    await expect(assertAgentWorkspace(workingCopy, { mode: "resolve" })).rejects.toThrow("package.json");
    await assertAgentWorkspace(workingCopy, { mode: "resolve" }, [await fileState(workingCopy, "package.json")]);
    await write(workingCopy, "package.json", conflict);
    expect(await publicationParent(workingCopy, prepared)).toEqual(prepared);
    expect(git("ls-files", "-u").stdout).not.toBe("");
    // An untracked leftover counts as a change too.
    await write(workingCopy, "scratch.log", "x\n");

    const reverted = await revertToBase(workingCopy, newBase);
    expect(reverted).toEqual(["added.txt", "gone.txt", "package.json", "scratch.log"]);
    expect(await changedSince(workingCopy, newBase)).toEqual([]);
    expect(await readFile(join(workingCopy.path, "package.json"), "utf8")).toBe('{"dependencies":{"vite":"^8.3.5"}}\n');
    expect(git("rev-parse", "HEAD").stdout).toBe(newBase);
    expect(git("symbolic-ref", "--quiet", "HEAD").status).toBe(1);
    expect(git("diff", "--cached", "--name-only").stdout).toBe("");
    await assertAgentWorkspace(workingCopy, { mode: "apply", toolWritten: [] });
    await write(workingCopy, "package.json", '{"dependencies":{"vite":"^9.0.0"}}\n');
    await snapshotCandidate(workingCopy);
    const verifiedTree = await candidateTree(workingCopy);
    const parent = await publicationParent(workingCopy, prepared);
    expect(parent.preparedSha).toBe(oldHead);
    expect(git("rev-parse", "HEAD").stdout).toBe(oldHead);
    git("add", "-A");
    expect(git("commit", "-q", "-m", "merging main").status).toBe(0);
    expect(git("show", "-s", "--format=%P").stdout.split(" ")).toEqual([oldHead, newBase]);
    expect(git("rev-parse", "HEAD^{tree}").stdout).toBe(verifiedTree);
  });

  it("detaches even when the tree is already the base, and wants a full sha", async () => {
    const { workingCopy, git } = await repo();
    await write(workingCopy, "a.txt", "a\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    expect(await revertToBase(workingCopy, git("rev-parse", "HEAD").stdout)).toEqual([]);
    expect(git("symbolic-ref", "--quiet", "HEAD").status).toBe(1);
    await expect(revertToBase(workingCopy, "main")).rejects.toThrow("full commit sha");
  });

  it.each(["worktree", "staged", "staged-then-restored"])("refuses a restored lockfile changed in the %s before invocation", async (kind) => {
    const { workingCopy, git } = await repo();
    await write(workingCopy, "package-lock.json", "base\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    await write(workingCopy, "package-lock.json", "restored\n");
    const restoredFiles = [await fileState(workingCopy, "package-lock.json")];
    await assertAgentWorkspace(workingCopy, { mode: "resolve" }, restoredFiles);
    await write(workingCopy, "package-lock.json", "unexpected\n");
    if (kind !== "worktree") git("add", "package-lock.json");
    if (kind === "staged-then-restored") await write(workingCopy, "package-lock.json", "restored\n");
    await expect(assertAgentWorkspace(workingCopy, { mode: "resolve" }, restoredFiles)).rejects.toThrow("changed after tool restore: package-lock.json");
  });

  it.each(["worktree", "index"])("keeps a restored deletion absent and rejects later %s changes", async (kind) => {
    const { workingCopy, git } = await repo();
    await write(workingCopy, "package-lock.json", "base\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    await rm(join(workingCopy.path, "package-lock.json"));
    const restoredFiles = [await fileState(workingCopy, "package-lock.json")];
    expect(restoredFiles[0]?.sha256).toBeNull();
    await assertAgentWorkspace(workingCopy, { mode: "resolve" }, restoredFiles);
    if (kind === "index") git("add", "package-lock.json");
    else await write(workingCopy, "package-lock.json", "unexpected\n");
    await expect(assertAgentWorkspace(workingCopy, { mode: "resolve" }, restoredFiles)).rejects.toThrow("changed after tool restore: package-lock.json");
  });

  it.each(["staged", "unstaged", "untracked", "staged-then-restored"])("refuses undeclared %s edits before an agent, permitting only declared writes and resolve paths", async (kind) => {
    const { workingCopy, git } = await repo();
    await write(workingCopy, "README.md", "base\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    const path = kind === "untracked" ? "new-file.txt" : "README.md";
    await write(workingCopy, path, "unexpected\n");
    if (kind.startsWith("staged")) git("add", "-A");
    if (kind === "staged-then-restored") await write(workingCopy, path, "base\n");
    await expect(assertAgentWorkspace(workingCopy, { mode: "apply", toolWritten: [] })).rejects.toThrow(`agent workspace has undeclared changes against HEAD: ${path}`);
    await expect(assertAgentWorkspace(workingCopy, { mode: "apply", conflicted: [path] })).rejects.toThrow("undeclared changes");
    await assertAgentWorkspace(workingCopy, { mode: "apply", toolWritten: [path] });
    await assertAgentWorkspace(workingCopy, { mode: "resolve", conflicted: [path] });
    await expect(assertAgentWorkspace(workingCopy, { toolWritten: ["../README.md"] })).rejects.toThrow("repository-relative");
  });

  it.each(["branch", "HEAD"])("refuses publication when the prepared %s moved while the agent worked on base", async (moved) => {
    const { workingCopy, git } = await repo();
    await write(workingCopy, "a.txt", "base\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    const baseSha = git("rev-parse", "HEAD").stdout;
    git("checkout", "-q", "-b", "pr");
    await write(workingCopy, "a.txt", "old PR\n");
    git("add", "-A");
    git("commit", "-q", "-m", "old PR");
    const oldHead = git("rev-parse", "HEAD").stdout;
    const prepared = { branch: "pr", baseSha, preparedSha: oldHead, remoteHeadSha: oldHead };
    await revertToBase(workingCopy, baseSha);
    if (moved === "branch") git("update-ref", "refs/heads/pr", baseSha, oldHead);
    else git("checkout", "--detach", "-q", oldHead);
    await expect(publicationParent(workingCopy, prepared)).rejects.toThrow(moved === "branch" ? "update-ref" : "no longer at the prepared base");
  });
});
