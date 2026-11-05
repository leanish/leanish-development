/**
 * Where a side of the comparison reads its files from: a git commit (read
 * with `git show`, so nothing in it runs) or the working tree.
 */
import { lstat, readdir, readFile, readlink, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import type { RunProcess } from "./process.ts";
import { gitArgs, gitEnvironment } from "./git.ts";

/** A symbolic link, never followed: where it sits and the text it points to, whether or not that exists. */
export interface TreeLink {
  /** From the root. */
  readonly path: string;
  readonly target: string;
}

export interface Tree {
  /** `worktree` or the full commit SHA. */
  readonly id: string;
  /**
   * The file's content, or undefined when the tree has no such file. A working tree refuses a path that leads outside
   * the root, through `..` or symbolic links: the repository may be untrusted, and what's outside isn't its content.
   */
  read(path: string): Promise<string | undefined>;
  /**
   * Every file under `dir`, recursively, as paths from the root; empty when there's no such directory. A commit's
   * tree always lists symlinks (reading one gives its target path); a working tree lists those leading to a file
   * (reading one follows it, and refuses it when it leads outside the root) only with `symlinks`.
   */
  list(dir: string, options?: { readonly symlinks?: boolean }): Promise<string[]>;
  /**
   * The links at `path`, opening none: the first one on the way to it (a parent folder or `path` itself) and only that
   * one, or else every link under it, sorted by path. Empty when there's no such path. A commit and a working tree agree.
   */
  links(path: string): Promise<TreeLink[]>;
}

/** Each path on the way to `path`, itself last: `a`, `a/b`, `a/b/c`. */
function pathsTo(path: string): string[] {
  const parts = path.split("/");
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

function byPath(a: TreeLink, b: TreeLink): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

export function workingTree(root: string): Tree {
  const linkAt = async (path: string): Promise<TreeLink> => ({ path, target: await readlink(join(root, path)) });
  return {
    id: "worktree",
    async links(path) {
      try {
        // Checked from the root down, so nothing here goes through a link: a cycle or a target outside the root is never reached.
        let isDirectory = false;
        for (const at of pathsTo(path)) {
          const entry = await lstat(join(root, at));
          if (entry.isSymbolicLink()) return [await linkAt(at)];
          isDirectory = entry.isDirectory();
        }
        if (!isDirectory) return [];
        // A recursive listing doesn't go into a link to a directory.
        const entries = await readdir(join(root, path), { recursive: true, withFileTypes: true });
        const links = entries.filter((entry) => entry.isSymbolicLink()).map((entry) => linkAt(relative(root, join(entry.parentPath, entry.name))));
        return (await Promise.all(links)).sort(byPath);
      } catch (err) {
        if (isMissing(err)) return [];
        throw err;
      }
    },
    async read(path) {
      try {
        // Resolved first, through every link on the way (a linked file or folder); read from the resolved path only when inside.
        const resolved = await realpath(join(root, path));
        if (!within(await realpath(root), resolved)) throw new Error(`${path} leads outside the repository`);
        return await readFile(resolved, "utf8");
      } catch (err) {
        // ENOTDIR: a parent is a file (`ci.yml/action.yml`), so there's no such file either. A broken link is missing too.
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

/** Whether canonical `path` is `root` or under it, by whole components (`/repo-other` isn't under `/repo`). */
function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

const SYMLINK_MODE = "120000";

/** The tree of `revision`, resolved once through the recorded metadata; its real objects never follow replace refs. */
export async function gitTree(root: string, revision: string, run: RunProcess, gitDir: string | undefined): Promise<Tree> {
  const git = (args: ReadonlyArray<string>) => run("git", gitArgs(root, gitDir, args), { cwd: root, env: gitEnvironment() });
  const resolved = await git(["rev-parse", "--verify", `${revision}^{commit}`]);
  if (resolved.code !== 0) throw new Error(`git can't resolve ${revision} to a commit: ${resolved.stderr.trim()}`);
  const sha = resolved.stdout.trim();
  // -z: `<mode> <type> <object>\t<path>`, NUL-separated and raw.
  const entries = async (path: string, recursive: boolean): Promise<Array<{ path: string; mode: string; type: string }>> => {
    const listed = await git(["ls-tree", ...(recursive ? ["-r"] : []), "-z", sha, "--", path]);
    if (listed.code !== 0) throw new Error(`git ls-tree ${sha} ${path} failed: ${listed.stderr.trim()}`);
    return listed.stdout.split("\0").filter((line) => line !== "").map((line) => {
      const tab = line.indexOf("\t");
      const [mode, type] = line.slice(0, tab).split(" ");
      return { path: line.slice(tab + 1), mode: mode!, type: type! };
    });
  };
  const linkAt = async (path: string): Promise<TreeLink> => {
    const shown = await git(["show", `${sha}:${path}`]);
    if (shown.code !== 0) throw new Error(`git show ${sha}:${path} failed: ${shown.stderr.trim()}`);
    return { path, target: shown.stdout };
  };
  return {
    id: sha,
    async links(path) {
      let isDirectory = false;
      for (const at of pathsTo(path)) {
        const entry = (await entries(at, false))[0];
        if (entry === undefined) return [];
        if (entry.mode === SYMLINK_MODE) return [await linkAt(at)];
        isDirectory = entry.type === "tree";
      }
      if (!isDirectory) return [];
      const links = (await entries(path, true)).filter((entry) => entry.mode === SYMLINK_MODE).map((entry) => linkAt(entry.path));
      return (await Promise.all(links)).sort(byPath);
    },
    async read(path) {
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
