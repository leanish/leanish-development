import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { gte } from "semver";

import { gitArgs } from "@leanish/gate/git";

import { Commands } from "./commands.ts";
import { result, type SetupResult } from "./contracts.ts";
import { candidateRelease, isReleaseTag, latestRelease, RELEASE_REPOSITORY, type VerifiedRelease } from "./github-release.ts";

async function entry(path: string) {
  try { return await lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function directory(path: string): Promise<void> {
  const found = await entry(path);
  if (found?.isDirectory() !== true) throw new Error("Release paths must be real directories, not symlinks or files");
}

function git(commands: Commands, path: string, args: ReadonlyArray<string>, message: string): Promise<string> {
  return commands.checked("git", gitArgs(path, join(path, ".git"), ["-c", "credential.helper=", "-c", "protocol.file.allow=never", ...args]), message, path);
}

/** Refuse changed, attached or mismatched checkouts; never repair them or move their HEAD. */
async function verifyCheckout(commands: Commands, path: string, release: VerifiedRelease): Promise<void> {
  await directory(path);
  await directory(join(path, ".git"));
  const top = await git(commands, path, ["rev-parse", "--show-toplevel"], "Release checkout is not a Git repository");
  if (await realpath(top) !== await realpath(path)) throw new Error("Release path is not the checkout root");
  const head = await git(commands, path, ["rev-parse", "--verify", "HEAD^{commit}"], "Could not read release HEAD");
  const tag = await git(commands, path, ["rev-parse", "--verify", `refs/tags/${release.tag}^{commit}`], "Could not peel the checked-out release tag");
  if (head !== release.sha || tag !== release.sha) throw new Error("Existing release checkout has a different SHA; refusing to repair it");
  const branch = await git(commands, path, ["rev-parse", "--abbrev-ref", "HEAD"], "Could not verify detached release HEAD");
  if (branch !== "HEAD") throw new Error("Release checkout must have a detached HEAD; refusing to change its branch");
  const changes = await git(commands, path, ["status", "--porcelain", "--untracked-files=all"], "Could not check release cleanliness");
  if (changes !== "") throw new Error("Release checkout is dirty; refusing to overwrite local changes");
}

function receiptPath(path: string): string { return join(path, ".git", "leanish-setup.json"); }

const STAGING_MARKER = ".leanish-setup-staging";
const STAGING_OWNER = `${RELEASE_REPOSITORY} setup staging v1\n`;

/** Called only while holding the installation lock; never follow a staging or marker symlink. */
async function cleanStaleStaging(root: string): Promise<void> {
  const uid = process.getuid?.();
  if (uid === undefined) return;
  for (const name of await readdir(root)) {
    if (!/^\.install-[A-Za-z0-9]{6}$/.test(name)) continue;
    const path = join(root, name);
    const found = await entry(path);
    if (!found?.isDirectory() || found.uid !== uid) continue;
    const marker = join(path, STAGING_MARKER);
    const ownership = await entry(marker);
    if (!ownership?.isFile() || ownership.uid !== uid || ownership.size !== Buffer.byteLength(STAGING_OWNER)) continue;
    if (await readFile(marker, "utf8") !== STAGING_OWNER) continue;
    await rm(path, { recursive: true, force: true });
  }
}

async function installed(path: string, release: VerifiedRelease): Promise<boolean> {
  const receipt = await entry(receiptPath(path));
  if (receipt === undefined) return false;
  if (!receipt.isFile()) throw new Error("Release installation receipt must be a regular file");
  let saved: unknown;
  try { saved = JSON.parse(await readFile(receiptPath(path), "utf8")); } catch { throw new Error("Release installation receipt is unreadable"); }
  const expected = saved as { schemaVersion?: unknown; tag?: unknown; sha?: unknown } | null;
  if (expected?.schemaVersion !== 1 || expected.tag !== release.tag || expected.sha !== release.sha) {
    throw new Error("Release installation receipt does not match the verified release");
  }
  const modules = await entry(join(path, "node_modules"));
  if (modules === undefined) return false;
  if (!modules.isDirectory()) throw new Error("Release node_modules must be a real directory");
  return (await entry(join(path, "node_modules", ".package-lock.json")))?.isFile() === true;
}

export interface InstalledRelease extends VerifiedRelease { readonly path: string }

export const GUIDED_SETUP_REQUIREMENT = "Guided setup needs a stable release that ships core/setup/run.sh (v0.7.0 or newer). Until such a release is published, use the manual guide: docs/adopting-tools.md.";

/** Candidates of 0.7.0 count: they are how guided setup is accepted before its release. */
export async function hasGuidedSetup(release: InstalledRelease): Promise<boolean> {
  return gte(release.tag.slice(1), "0.7.0-rc.0") && (await entry(join(release.path, "core", "setup", "run.sh")))?.isFile() === true;
}

async function releaseResult(release: InstalledRelease, status: "changed" | "already-done", message: string): Promise<SetupResult> {
  if (!await hasGuidedSetup(release)) return result("release", "checkout", "blocked", `Installed ${release.tag}. ${GUIDED_SETUP_REQUIREMENT}`, { ...release });
  return result("release", "checkout", status, message, { ...release });
}

/** Reuse a completed installation's recorded pin offline; never select or upgrade a release as a side effect. */
export async function readInstalledRelease(tag: string, commands = new Commands(), home = homedir()): Promise<InstalledRelease> {
  if (!isReleaseTag(tag)) throw new Error("Select an installed vX.Y.Z release or vX.Y.Z-rc.N candidate");
  const path = join(home, ".local", "share", "leanish", "releases", tag);
  await directory(path);
  await directory(join(path, ".git"));
  if (!(await entry(receiptPath(path)))?.isFile()) throw new Error("Installed release receipt is missing");
  let receipt: { schemaVersion?: unknown; tag?: unknown; sha?: unknown };
  try { receipt = JSON.parse(await readFile(receiptPath(path), "utf8")); } catch { throw new Error("Installed release receipt is unreadable"); }
  if (receipt?.schemaVersion !== 1 || receipt.tag !== tag || typeof receipt.sha !== "string" || !/^[a-f0-9]{40}$/.test(receipt.sha)) throw new Error("Installed release receipt is invalid");
  const release = { tag, sha: receipt.sha };
  await verifyCheckout(commands, path, release);
  if (!await installed(path, release)) throw new Error("Release dependencies are incomplete; run release installation first");
  return { ...release, path };
}

async function installDependencies(commands: Commands, path: string, release: VerifiedRelease): Promise<void> {
  const modules = await entry(join(path, "node_modules"));
  if (modules !== undefined && !modules.isDirectory()) throw new Error("Release node_modules must be a real directory");
  await rm(receiptPath(path), { force: true });
  await commands.checked("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], "Release npm ci failed; no installation marked complete", path);
  await verifyCheckout(commands, path, release);
  const temporary = `${receiptPath(path)}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ schemaVersion: 1, ...release }) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temporary, receiptPath(path));
  } finally {
    await rm(temporary, { force: true });
  }
}

export interface ReleaseOptions {
  /** A `vX.Y.Z-rc.N` published as an immutable prerelease, to accept it before its release; undefined: the newest stable release. */
  readonly candidate?: string;
}

/** Install only a GitHub-verified release, outside the source checkout; retain every previous release. */
export async function installRelease(options: ReleaseOptions = {}, commands: Commands = new Commands(), home: string = homedir()): Promise<SetupResult> {
  const release = options.candidate === undefined ? await latestRelease(commands) : await candidateRelease(commands, options.candidate);
  const root = join(home, ".local", "share", "leanish", "releases");
  await mkdir(root, { recursive: true, mode: 0o700 });
  await directory(root);
  const lock = join(root, ".setup-lock");
  try { await mkdir(lock, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Release installation is locked; check for a running or interrupted installer before removing .setup-lock");
    throw error;
  }
  let staging: string | undefined;
  let failed = false;
  try {
    await cleanStaleStaging(root);
    const path = join(root, release.tag);
    if (await entry(path) !== undefined) {
      await verifyCheckout(commands, path, release);
      if (await installed(path, release)) return await releaseResult({ ...release, path }, "already-done", "Verified installed release");
      await installDependencies(commands, path, release);
      return await releaseResult({ ...release, path }, "changed", "Installed locked dependencies in the verified checkout");
    }
    staging = await mkdtemp(join(root, ".install-"));
    await writeFile(join(staging, STAGING_MARKER), STAGING_OWNER, { mode: 0o600, flag: "wx" });
    const checkout = join(staging, "checkout");
    await mkdir(checkout);
    await git(commands, checkout, ["init", "--quiet"], "Could not initialize release checkout");
    await git(commands, checkout, ["remote", "add", "origin", `https://github.com/${RELEASE_REPOSITORY}.git`], "Could not set release origin");
    await git(commands, checkout, ["fetch", "--quiet", "--depth=1", "origin", `refs/tags/${release.tag}:refs/tags/${release.tag}`], "Could not fetch release tag");
    const fetched = await git(commands, checkout, ["rev-parse", "--verify", `refs/tags/${release.tag}^{commit}`], "Could not peel fetched release tag");
    if (fetched !== release.sha) throw new Error("Fetched release tag differs from GitHub's verified SHA");
    await git(commands, checkout, ["checkout", "--quiet", "--detach", release.sha], "Could not detach release checkout at the verified SHA");
    await verifyCheckout(commands, checkout, release);
    await installDependencies(commands, checkout, release);
    await rename(checkout, path);
    return await releaseResult({ ...release, path }, "changed", options.candidate === undefined ? "Installed immutable stable release" : "Installed immutable release candidate");
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      try {
        if (staging !== undefined) await rm(staging, { recursive: true, force: true });
      } finally {
        await rm(lock, { recursive: true, force: true });
      }
    } catch (error) {
      if (!failed) throw error;
    }
  }
}
