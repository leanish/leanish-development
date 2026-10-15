/**
 * Where a side of the comparison reads its files from: a git commit (read
 * with `git show`, so nothing in it runs) or the working tree.
 */
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

import type { RunProcess } from "./process.ts";
import { gitArgs, gitEnvironment } from "./git.ts";

export interface Tree {
  /** `worktree` or the full commit SHA. */
  readonly id: string;
  /**
   * The file's content, or undefined when the tree has no such file. With `regularFile`, a symbolic link fails instead
   * of giving its target path (a commit) or being followed (a working tree).
   */
  read(path: string, options?: ReadOptions): Promise<string | undefined>;
  /**
   * Every file under `dir`, recursively, as paths from the root; empty when there's no such directory. A commit's
   * tree always lists symlinks (reading one gives its target path); a working tree lists those leading to a file
   * (reading one follows it) only with `symlinks`.
   */
  list(dir: string, options?: { readonly symlinks?: boolean }): Promise<string[]>;
}

export interface ReadOptions {
  readonly regularFile?: boolean;
}

function linkRefused(path: string, id: string): Error {
  return new Error(`${path} in ${id} is a symbolic link: it's refused rather than read through`);
}

/**
 * `a`, `a/b`, `a/b/c` for `a/b/c`, `./a//b/c` too (git lists them so): a link on any of them leads the read elsewhere.
 * A `..` fails instead, since a link before it decides where it leads.
 */
function selfAndParents(path: string, id: string): string[] {
  const parts = path.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.includes("..")) throw new Error(`${path} in ${id} has a '..' segment: it's refused rather than resolved`);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

export function workingTree(root: string): Tree {
  return {
    id: "worktree",
    async read(path, options) {
      try {
        if (options?.regularFile === true) {
          for (const entry of selfAndParents(path, "worktree")) {
            if ((await lstat(join(root, entry))).isSymbolicLink()) throw linkRefused(entry, "worktree");
          }
        }
        return await readFile(join(root, path), "utf8");
      } catch (err) {
        // ENOTDIR: a parent is a file (`ci.yml/action.yml`), so there's no such file either.
        if (isMissing(err)) return undefined;
        throw err;
      }
    },
    async list(dir, options) {
      try {
        const entries = await readdir(join(root, dir), { recursive: true, withFileTypes: true });
        const files: string[] = [];
        for (const entry of entries) {
          const path = join(entry.parentPath, entry.name);
          // A wanted symlink counts when it leads to a file; links to directories and broken ones don't.
          if (entry.isFile() || options?.symlinks === true && entry.isSymbolicLink() && await stat(path).then((target) => target.isFile(), () => false)) files.push(relative(root, path));
        }
        return files.sort();
      } catch (err) {
        if (isMissing(err)) return [];
        throw err;
      }
    },
  };
}

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** The tree of `revision`, resolved once through the recorded metadata; its real objects never follow replace refs. */
export async function gitTree(root: string, revision: string, run: RunProcess, gitDir: string | undefined): Promise<Tree> {
  const git = (args: ReadonlyArray<string>) => run("git", gitArgs(root, gitDir, args), { cwd: root, env: gitEnvironment() });
  const resolved = await git(["rev-parse", "--verify", `${revision}^{commit}`]);
  if (resolved.code !== 0) throw new Error(`git can't resolve ${revision} to a commit: ${resolved.stderr.trim()}`);
  const sha = resolved.stdout.trim();
  return {
    id: sha,
    async read(path, options) {
      if (options?.regularFile === true) {
        // `<mode> <type> <object>\t<path>` for the path and each parent: mode 120000 is a symbolic link, and one on a
        // parent hides the file from the commit while a checkout reads through it.
        // Naming a directory also lists what's in it, so only the entries that are exactly these paths count.
        const wanted = new Set(selfAndParents(path, sha));
        const entries = await git(["ls-tree", "-z", sha, "--", ...wanted]);
        if (entries.code !== 0) throw new Error(`git ls-tree ${sha} ${path} failed: ${entries.stderr.trim()}`);
        for (const entry of entries.stdout.split("\0")) {
          const entryPath = entry.slice(entry.indexOf("\t") + 1);
          if (entry.startsWith("120000 ") && wanted.has(entryPath)) throw linkRefused(entryPath, sha);
        }
      }
      const listed = await git(["ls-tree", "-z", "--name-only", sha, "--", path]);
      if (listed.code !== 0) throw new Error(`git ls-tree ${sha} ${path} failed: ${listed.stderr.trim()}`);
      if (listed.stdout.trim() === "") return undefined;
      const shown = await git(["show", `${sha}:${path}`]);
      if (shown.code !== 0) throw new Error(`git show ${sha}:${path} failed: ${shown.stderr.trim()}`);
      return shown.stdout;
    },
    async list(dir) {
      // -z: names come back raw, NUL-separated, instead of quoted when they have unusual characters.
      const listed = await git(["ls-tree", "-r", "-z", "--name-only", sha, "--", dir]);
      if (listed.code !== 0) throw new Error(`git ls-tree ${sha} ${dir} failed: ${listed.stderr.trim()}`);
      return listed.stdout.split("\0").filter((line) => line !== "").sort();
    },
  };
}
