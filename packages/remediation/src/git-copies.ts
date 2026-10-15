/**
 * Read-only git helpers over a working copy the workspace synced (its git
 * metadata in a separate directory the workspace created, so the repository
 * can't bring config, hooks or filters into these commands):
 *
 *   - `exportCommit`: a commit's files in a fresh directory, byte for byte as
 *     committed (no `export-ignore`, `export-subst`, line-ending or filter
 *     attributes applied), for the sandboxed Gradle inventory of a commit the
 *     working copy doesn't have checked out;
 *   - `changedSince`: what the working tree changed relative to a commit;
 *   - `sameTreeAs`: whether the working tree equals a commit.
 */
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";

import type { WorkingCopy } from "../../agent-basics/src/types/working-copy.ts";
import { runProcess, type RunProcess } from "../../ci/src/process.ts";
import { gitArgs as repositoryArgs, gitEnvironment } from "../../ci/src/git.ts";

function gitArgs(workingCopy: WorkingCopy, args: ReadonlyArray<string>): string[] {
  if (workingCopy.gitDir === undefined) throw new Error(`${workingCopy.path}'s git metadata must be in a separate directory`);
  return repositoryArgs(workingCopy.path, workingCopy.gitDir, args);
}

/** A git command over the working copy's own metadata, without system or global config, hooks or fsmonitor. */
export async function git(
  workingCopy: WorkingCopy,
  args: ReadonlyArray<string>,
  run: RunProcess,
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = { ...gitEnvironment(), ...extraEnv };
  return run("git", gitArgs(workingCopy, args), { cwd: workingCopy.path, env });
}

/** Where the commit verification last read is recorded, in the git metadata the agent can't write. */
const CANDIDATE_REF = "refs/leanish/candidate";

/**
 * The working tree as it is now, as a commit no branch points to: its files staged the way publication stages them
 * (`git add --all` over HEAD), in a throwaway index so the real one is left alone. Recorded as the candidate:
 * verification reads this commit, and publication refuses any other tree (see `candidateTree`), so nothing written
 * after the snapshot, by a process the agent left running or anything else, is published unverified.
 */
export async function snapshotCandidate(workingCopy: WorkingCopy, run: RunProcess = runProcess): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "candidate-index-"));
  try {
    const index = { GIT_INDEX_FILE: join(dir, "index") };
    const step = async (args: ReadonlyArray<string>, env: Readonly<Record<string, string>> = index): Promise<string> => {
      const result = await git(workingCopy, args, run, env);
      if (result.code !== 0) throw new Error(`git ${args[0]} for the verification snapshot failed: ${result.stderr.trim()}`);
      return result.stdout.trim();
    };
    await step(["read-tree", "HEAD"]);
    await step(["add", "--all"]);
    const tree = await step(["write-tree"]);
    const identity = { GIT_AUTHOR_NAME: "supply-chain", GIT_AUTHOR_EMAIL: "supply-chain@localhost", GIT_COMMITTER_NAME: "supply-chain", GIT_COMMITTER_EMAIL: "supply-chain@localhost" };
    const sha = await step(["commit-tree", tree, "-p", "HEAD", "-m", "verification snapshot"], identity);
    await step(["update-ref", CANDIDATE_REF, sha], {});
    return sha;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The tree of the last verification snapshot (see `snapshotCandidate`); undefined when there's none. */
export async function candidateTree(workingCopy: WorkingCopy, run: RunProcess = runProcess): Promise<string | undefined> {
  const result = await git(workingCopy, ["rev-parse", "--quiet", "--verify", `${CANDIDATE_REF}^{tree}`], run);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

/** `sha`'s files in a new directory (no git metadata), exactly as committed; the caller removes it with `remove`. */
export async function exportCommit(workingCopy: WorkingCopy, sha: string, run: RunProcess = runProcess): Promise<{ readonly dir: string; readonly remove: () => Promise<void> }> {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`exportCommit needs a full commit sha; got '${sha}'`);
  const parent = await mkdtemp(join(tmpdir(), "commit-"));
  const remove = () => rm(parent, { recursive: true, force: true });
  try {
    const dir = join(parent, "tree");
    await mkdir(dir);
    const listed = await git(workingCopy, ["ls-tree", "-r", "-z", "--full-tree", sha], run);
    if (listed.code !== 0) throw new Error(`git ls-tree ${sha} failed: ${listed.stderr.trim()}`);
    const entries = listed.stdout
      .split("\0")
      .filter((line) => line !== "")
      .map((line) => {
        const tab = line.indexOf("\t");
        const [mode, type, object] = line.slice(0, tab).split(" ") as [string, string, string];
        return { mode, type, object, path: line.slice(tab + 1) };
      });
    const blobs = entries.filter((entry) => entry.type === "blob");
    assertSafePaths(sha, entries);
    const contents = await catFileBatch(workingCopy, blobs.map((blob) => blob.object));
    // Regular files first, symlinks last: no write ever goes through a link the tree brought.
    const ordered = [...blobs.filter((blob) => blob.mode !== "120000"), ...blobs.filter((blob) => blob.mode === "120000")];
    for (const blob of ordered) {
      const target = join(dir, normalize(blob.path));
      if (!target.startsWith(`${dir}/`)) throw new Error(`${sha} has a path outside its tree: ${blob.path}`);
      await mkdir(dirname(target), { recursive: true });
      const content = contents.get(blob.object)!;
      if (blob.mode === "120000") {
        await symlink(content.toString("utf8"), target);
      } else {
        await writeFile(target, content, { flag: "wx" });
        if (blob.mode === "100755") await chmod(target, 0o755);
      }
    }
    // Submodules (mode 160000) have no files in this repository; they stay empty directories.
    for (const entry of entries.filter((e) => e.type === "commit")) await mkdir(join(dir, normalize(entry.path)), { recursive: true });
    return { dir, remove };
  } catch (err) {
    await remove();
    throw err;
  }
}

/**
 * Refuses a tree whose paths would collide on this filesystem (`A` and `a` on
 * a case-insensitive one: checked case-insensitively everywhere) or that puts
 * an entry under one of its own symlinks: either could write outside the copy.
 */
function assertSafePaths(sha: string, entries: ReadonlyArray<{ readonly mode: string; readonly path: string }>): void {
  const seen = new Map<string, string>();
  const links = new Set<string>();
  for (const entry of entries) {
    const folded = normalize(entry.path).toLowerCase();
    const earlier = seen.get(folded);
    if (earlier !== undefined) throw new Error(`${sha} has paths that collide: ${earlier} and ${entry.path}`);
    seen.set(folded, entry.path);
    if (entry.mode === "120000") links.add(folded);
  }
  for (const folded of seen.keys()) {
    const parts = folded.split("/");
    for (let i = 1; i < parts.length; i++) {
      const ancestor = parts.slice(0, i).join("/");
      if (links.has(ancestor)) throw new Error(`${sha} has ${seen.get(folded)} under its symlink ${seen.get(ancestor)}`);
    }
  }
}

/** Every object's raw content, read with one `git cat-file --batch`. */
function catFileBatch(workingCopy: WorkingCopy, objects: ReadonlyArray<string>): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", gitArgs(workingCopy, ["cat-file", "--batch"]), {
      cwd: workingCopy.path,
      env: gitEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`git cat-file --batch failed: ${stderr.trim()}`));
      const out = Buffer.concat(chunks);
      const found = new Map<string, Buffer>();
      let at = 0;
      for (const object of new Set(objects)) {
        const newline = out.indexOf(0x0a, at);
        const header = out.subarray(at, newline).toString("utf8");
        const [name, type, size] = header.split(" ");
        if (name !== object || type !== "blob" || size === undefined) return reject(new Error(`git cat-file --batch answered '${header}' for ${object}`));
        const start = newline + 1;
        found.set(object, out.subarray(start, start + Number(size)));
        at = start + Number(size) + 1;
      }
      resolve(found);
    });
    child.stdin.end([...new Set(objects)].map((object) => `${object}\n`).join(""));
  });
}

/** Every path the working tree changed, added or removed relative to `sha`, untracked files included (ignored ones aren't). */
export async function changedSince(workingCopy: WorkingCopy, sha: string, run: RunProcess = runProcess): Promise<string[]> {
  const tracked = await git(workingCopy, ["diff", "--name-only", "-z", "--no-renames", sha, "--"], run);
  if (tracked.code !== 0) throw new Error(`git diff ${sha} failed: ${tracked.stderr.trim()}`);
  const untracked = await git(workingCopy, ["ls-files", "--others", "--exclude-standard", "-z"], run);
  if (untracked.code !== 0) throw new Error(`git ls-files failed: ${untracked.stderr.trim()}`);
  return [...new Set([...tracked.stdout.split("\0"), ...untracked.stdout.split("\0")].filter((path) => path !== ""))].sort();
}

/** Every path `sha` changed, added or removed relative to `base`. */
export async function changedBetween(workingCopy: WorkingCopy, base: string, sha: string, run: RunProcess = runProcess): Promise<string[]> {
  const diff = await git(workingCopy, ["diff", "--name-only", "-z", "--no-renames", base, sha, "--"], run);
  if (diff.code !== 0) throw new Error(`git diff ${base} ${sha} failed: ${diff.stderr.trim()}`);
  return diff.stdout.split("\0").filter((path) => path !== "").sort();
}

/**
 * What the edit (`base` → `sha`) did with links, as verification problems. Verification reads a commit, where a link is
 * only the path it points to, so it can't check what's behind one: the edit may not add or change a symbolic link or a
 * submodule (modes 120000 and 160000), nor change anything an existing link, in `base` or `sha`, leads to. Links the
 * edit leaves alone, with nothing changed behind them, are the repository's own.
 */
export async function linkProblems(workingCopy: WorkingCopy, base: string, sha: string, run: RunProcess = runProcess): Promise<string[]> {
  const diff = await git(workingCopy, ["diff", "--raw", "-z", "--no-renames", base, sha, "--"], run);
  if (diff.code !== 0) throw new Error(`git diff ${base} ${sha} failed: ${diff.stderr.trim()}`);
  // `:<old mode> <new mode> <old> <new> <status>` NUL `<path>` NUL, per changed path.
  const fields = diff.stdout.split("\0");
  const changed: string[] = [];
  const problems: string[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const path = fields[i + 1]!;
    const mode = fields[i]!.split(" ")[1];
    changed.push(path);
    if (mode === "120000") problems.push(`the edit made ${path} a symbolic link: verification can't check what's behind one`);
    if (mode === "160000") problems.push(`the edit added or moved the submodule ${path}: verification can't read a submodule's files`);
  }
  for (const revision of [base, sha]) {
    const links = await linksOf(workingCopy, revision, run);
    for (const link of [...links.keys()].sort()) {
      const target = resolved(link, links);
      if (target === undefined) continue;
      if (target === OUTSIDE) {
        problems.push(`the link ${link} leads outside the repository: verification can't tell whether it comes back to what the edit changed`);
        continue;
      }
      for (const path of changed) {
        const changedPath = folded(path);
        if (target === "" || changedPath === target || changedPath.startsWith(`${target}/`)) {
          problems.push(`the edit changed ${path}, behind the link ${link}: verification can't check what's behind one`);
        }
      }
    }
  }
  return [...new Set(problems)].sort();
}

/** Every symbolic link in `revision`'s tree, with the path it points to. */
async function linksOf(workingCopy: WorkingCopy, revision: string, run: RunProcess): Promise<Map<string, string>> {
  const listed = await git(workingCopy, ["ls-tree", "-r", "-z", revision], run);
  if (listed.code !== 0) throw new Error(`git ls-tree ${revision} failed: ${listed.stderr.trim()}`);
  const links = new Map<string, string>();
  for (const entry of listed.stdout.split("\0")) {
    if (!entry.startsWith("120000 ")) continue;
    const object = entry.split(" ")[2]!.split("\t")[0]!;
    const target = await git(workingCopy, ["cat-file", "blob", object], run);
    if (target.code !== 0) throw new Error(`git cat-file ${object} failed: ${target.stderr.trim()}`);
    links.set(entry.slice(entry.indexOf("\t") + 1), target.stdout);
  }
  return links;
}

/** A link leading out of the repository: it may come back in anywhere (an absolute path, `../<repository>/…`). */
const OUTSIDE = Symbol("outside");

/** A path as a case- and normalization-insensitive checkout (macOS's) matches it, so a differently cased link can't slip by. */
function folded(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

/**
 * The repository path `link` leads to, folded (`folded`), walked component by component as a checkout would: links in
 * it followed, a `..` after one going up from where it leads. `""` is the repository's root; `OUTSIDE` when it leaves
 * the repository; undefined for a loop, or more links than a checkout follows, which lead nowhere it can read.
 */
function resolved(link: string, links: ReadonlyMap<string, string>): string | typeof OUTSIDE | undefined {
  const byPath = new Map([...links].map(([path, target]) => [folded(path), target]));
  const at: string[] = [];
  const pending = folded(link).split("/");
  for (let hops = 0; pending.length > 0;) {
    const part = pending.shift()!;
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (at.length === 0) return OUTSIDE;
      at.pop();
      continue;
    }
    at.push(part);
    const target = byPath.get(at.join("/"));
    if (target === undefined) continue;
    if (++hops > 40) return undefined;
    if (target.startsWith("/")) return OUTSIDE;
    at.pop();
    pending.unshift(...folded(target).split("/"));
  }
  return at.join("/");
}

/** Whether the working tree has exactly `sha`'s files. */
export async function sameTreeAs(workingCopy: WorkingCopy, sha: string, run: RunProcess = runProcess): Promise<boolean> {
  return (await changedSince(workingCopy, sha, run)).length === 0;
}
