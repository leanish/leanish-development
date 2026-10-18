/** Real Git preparation/publication up to beforePush; no push or GitHub access. All files live under the caller's root. */
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { LocalGitWorkspace } from "@leanish/agent-runtime/working-copy/local-git-workspace";
import type { PreparedBranch, PublishBranchArgs, WorkingCopy } from "@leanish/agent-runtime/types/working-copy";

export async function retargetRepository(root: string, projectId: string, branch: string, baseFiles: Readonly<Record<string, string>>, previousFiles: Readonly<Record<string, string>>, moveBase: boolean | Readonly<Record<string, string>>) {
  const source = join(root, "source");
  await mkdir(source);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(source, "init", "-q", "-b", "main", "--separate-git-dir", join(root, "source-git"));
  git(source, "config", "maintenance.auto", "false");
  git(source, "config", "gc.auto", "0");
  const commit = async (files: Readonly<Record<string, string>>, message: string) => {
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(source, path)), { recursive: true });
      await writeFile(join(source, path), text);
    }
    git(source, "add", "-A");
    git(source, "commit", "-q", "-m", message);
    return git(source, "rev-parse", "HEAD");
  };
  const oldBase = await commit(baseFiles, "base");
  git(source, "checkout", "-q", "-b", branch);
  const oldHead = await commit(previousFiles, "previous plan");
  git(source, "checkout", "-q", "main");
  const baseSha = moveBase ? await commit(typeof moveBase === "boolean" ? { "base-moved.txt": "new base\n" } : moveBase, "base moved") : oldBase;
  const remote = join(root, "remote");
  git(source, "clone", "-q", "--bare", source, remote);
  const workspace = new LocalGitWorkspace({ workspaceRoot: join(root, "workspace"), commitIdentity: { name: "test", email: "test@example.com" } });
  const { workingCopies: [workingCopy] } = await workspace.sync([{ id: projectId, source: { url: remote, branch: "main" } }]);
  if (workingCopy === undefined) throw new Error("fixture sync produced no working copy");
  const publications: Array<{ prepared: PreparedBranch; args: PublishBranchArgs; sha: string }> = [];
  class BeforePush extends Error {
    readonly sha: string;
    constructor(sha: string) { super("stop before the push"); this.sha = sha; }
  }
  const publishBranch = async (wc: WorkingCopy, prepared: PreparedBranch, args: PublishBranchArgs) => {
    try {
      return await workspace.publishBranch(wc, prepared, { ...args, beforePush: async (sha) => {
        await args.beforePush?.(sha);
        throw new BeforePush(sha);
      } });
    } catch (error) {
      if (!(error instanceof BeforePush)) throw error;
      publications.push({ prepared, args, sha: error.sha });
      return { kind: "pushed" as const, sha: error.sha };
    }
  };
  return { workspace, workingCopy, baseSha, oldBase, oldHead, publications, publishBranch, git: (...args: string[]) => git(workingCopy.path, ...args) };
}
