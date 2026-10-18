import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runProcess, type RunProcess } from "@leanish/gate/process";

import { Commands } from "../src/commands.ts";
import { RELEASE_REPOSITORY } from "../src/github-release.ts";
import { installRelease, readInstalledRelease } from "../src/release.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rm: vi.fn(actual.rm) };
});
const { rm: realRm } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

let root: string;
let source: string;
let home: string;
let sha: string;
let releases: string;

async function git(path: string, ...args: string[]): Promise<string> {
  const execution = await runProcess("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd: path, env: { PATH: process.env["PATH"], HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  if (execution.code !== 0) throw new Error(execution.stderr);
  return execution.stdout.trim();
}

beforeEach(async () => {
  vi.mocked(rm).mockClear();
  root = await mkdtemp(join(tmpdir(), "setup-release-test-"));
  source = join(root, "source");
  home = join(root, "home");
  releases = join(home, ".local", "share", "leanish", "releases");
  await mkdir(source);
  await mkdir(home);
  await mkdir(join(source, "fixture"));
  await mkdir(join(source, "core/setup"), { recursive: true });
  await writeFile(join(source, "core/setup/run.sh"), "# fixture launcher, never executed\n");
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "release-fixture", version: "1.0.0", private: true, workspaces: ["fixture"],
    scripts: { preinstall: "node -e \"require('fs').writeFileSync('lifecycle-ran', 'unsafe')\"" } }));
  await writeFile(join(source, "fixture", "package.json"), JSON.stringify({ name: "@fixture/empty", version: "1.0.0", private: true }));
  await writeFile(join(source, "package-lock.json"), JSON.stringify({ name: "release-fixture", version: "1.0.0", lockfileVersion: 3, requires: true, packages: {
    "": { name: "release-fixture", version: "1.0.0", hasInstallScript: true, workspaces: ["fixture"] },
    fixture: { name: "@fixture/empty", version: "1.0.0" }, "node_modules/@fixture/empty": { resolved: "fixture", link: true },
  } }));
  await writeFile(join(source, ".gitignore"), "node_modules/\n");
  await git(source, "init", "--quiet", "--initial-branch=main");
  await git(source, "add", ".");
  await git(source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "--quiet", "-m", "fixture");
  sha = await git(source, "rev-parse", "HEAD");
  await git(source, "tag", "v0.7.0");
});

afterEach(async () => {
  vi.mocked(rm).mockImplementation(realRm);
  await realRm(root, { recursive: true, force: true });
});

function installer({ realNpm = false, failNpm = false, remoteSha = sha, beforeNpm, tag = "v0.7.0" }: {
  realNpm?: boolean; failNpm?: boolean; remoteSha?: string; beforeNpm?: (path: string) => Promise<void>; tag?: string;
} = {}) {
  const calls: Array<{ command: string; args: ReadonlyArray<string>; cwd?: string }> = [];
  const run: RunProcess = async (command, args, options) => {
    calls.push({ command, args, cwd: options?.cwd });
    if (command === "gh") {
      expect(args.slice(0, 5)).toEqual(["api", "--hostname", "github.com", "--method", "GET"]);
      const endpoint = args.at(-1)!;
      const response = endpoint.includes("/releases?")
        ? [[{ tag_name: tag, published_at: "2026-10-17T00:00:00Z", draft: false, prerelease: false, immutable: true }]]
        : { ref: `refs/tags/${tag}`, object: { type: "commit", sha: remoteSha } };
      return { code: 0, stdout: JSON.stringify(response), stderr: "" };
    }
    if (command === "npm") {
      expect(args).toEqual(["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
      expect(options?.env?.["GH_TOKEN"]).toBeUndefined();
      expect(options?.env?.["NODE_OPTIONS"]).toBeUndefined();
      await beforeNpm?.(options!.cwd!);
      if (failNpm) return { code: 1, stdout: "secret-sentinel", stderr: "secret-sentinel" };
      if (realNpm) return runProcess(command, args, { ...options, env: { ...options?.env, npm_config_cache: join(root, "npm-cache"), npm_config_offline: "true" } });
      await mkdir(join(options!.cwd!, "node_modules"), { recursive: true });
      await writeFile(join(options!.cwd!, "node_modules", ".package-lock.json"), "{}");
      return { code: 0, stdout: "", stderr: "" };
    }
    // Only the network fetch is substituted: all Git checkout/verification operations are real, in temp directories.
    if (command === "git" && args.includes("fetch")) {
      const modified = [...args];
      modified[modified.indexOf("origin")] = source;
      return runProcess(command, ["-c", "protocol.file.allow=always", ...modified.filter((arg, i) => !(arg === "-c" && modified[i + 1] === "protocol.file.allow=never") && arg !== "protocol.file.allow=never")], options);
    }
    return runProcess(command, args, options);
  };
  return { commands: new Commands(run, { HOME: home, PATH: process.env["PATH"], GH_TOKEN: "secret-sentinel", NODE_OPTIONS: "secret-sentinel" }), calls };
}

describe("release installation", () => {
  it.each(["v0.6.0", "v0.7.0"])("installs %s without a launcher, then reports the found tag blocked with the manual fallback on every reuse path", async (tag) => {
    await git(source, "rm", "core/setup/run.sh");
    await git(source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "--quiet", "-m", "legacy release");
    sha = await git(source, "rev-parse", "HEAD");
    await git(source, "tag", "--force", tag);
    const { commands, calls } = installer({ tag });
    for (const reinstall of [false, false, true]) {
      if (reinstall) await rm(join(releases, tag, "node_modules"), { recursive: true });
      const value = await installRelease(commands, home);
      expect(value).toMatchObject({ status: "blocked", data: { tag, sha, path: join(releases, tag) } });
      expect(value.message).toContain(`Installed ${tag}`);
      expect(value.message).toContain("v0.7.0 or newer");
      expect(value.message).toContain("Until such a release is published");
      expect(value.message).toContain("docs/adopting-tools.md");
      expect(value.message).not.toContain("select");
      expect(await git(join(releases, tag), "rev-parse", "HEAD")).toBe(sha);
    }
    expect(calls.filter(({ command }) => command === "npm")).toHaveLength(2);
    // A completed checkout remains usable for the manual/gate-only path.
    expect((await readInstalledRelease(tag, commands, home)).tag).toBe(tag);
  });

  it("installs and reuses a detached tag-named checkout without rerunning npm", async () => {
    const { commands, calls } = installer();
    const expectedPath = join(releases, "v0.7.0");
    expect(await installRelease(commands, home)).toMatchObject({ status: "changed", data: { tag: "v0.7.0", sha, path: expectedPath } });
    expect(await git(expectedPath, "rev-parse", "HEAD")).toBe(sha);
    expect(await git(expectedPath, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
    expect(await git(expectedPath, "status", "--porcelain")).toBe("");
    expect(await git(expectedPath, "remote", "get-url", "origin")).toBe(`https://github.com/${RELEASE_REPOSITORY}.git`);
    expect(JSON.parse(await readFile(join(expectedPath, ".git", "leanish-setup.json"), "utf8"))).toEqual({ schemaVersion: 1, tag: "v0.7.0", sha });
    expect((await stat(join(expectedPath, ".git", "leanish-setup.json"))).mode & 0o777).toBe(0o600);
    expect((await installRelease(commands, home)).status).toBe("already-done");
    expect(calls.filter(({ command }) => command === "npm")).toHaveLength(1);
    expect(await readdir(releases)).toEqual(["v0.7.0"]);
    expect(await git(source, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  });

  it("runs a real offline npm ci and suppresses lifecycle scripts", async () => {
    const { commands } = installer({ realNpm: true });
    expect((await installRelease(commands, home)).status).toBe("changed");
    const path = join(releases, "v0.7.0");
    await expect(stat(join(path, "lifecycle-ran"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await installRelease(commands, home)).status).toBe("already-done");
  });

  it("reuses an explicitly selected installed release offline without selecting a new version", async () => {
    const { commands, calls } = installer();
    await installRelease(commands, home);
    calls.length = 0;
    expect(await readInstalledRelease("v0.7.0", commands, home)).toEqual({ tag: "v0.7.0", sha, path: join(releases, "v0.7.0") });
    expect(calls.every(({ command }) => command === "git")).toBe(true);
    await expect(readInstalledRelease("../escape", commands, home)).rejects.toThrow("stable vX.Y.Z");
    await rm(join(releases, "v0.7.0/node_modules"), { recursive: true });
    await expect(readInstalledRelease("v0.7.0", commands, home)).rejects.toThrow("dependencies are incomplete");
  });

  it("checks out the peeled commit of a real annotated tag", async () => {
    await git(source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "tag", "--force", "--annotate", "v0.7.0", "--message", "fixture release");
    expect(await git(source, "rev-parse", "refs/tags/v0.7.0")).not.toBe(sha);
    const { commands } = installer();
    expect((await installRelease(commands, home)).data?.sha).toBe(sha);
    expect(await git(join(releases, "v0.7.0"), "rev-parse", "HEAD")).toBe(sha);
  });

  it("verifies the fetched tag before checkout or npm and cleans failed staging", async () => {
    const { commands, calls } = installer({ remoteSha: "a".repeat(40) });
    await expect(installRelease(commands, home)).rejects.toThrow("differs from GitHub");
    expect(calls.some(({ args }) => args.includes("checkout"))).toBe(false);
    expect(calls.some(({ command }) => command === "npm")).toBe(false);
    expect(await readdir(releases)).toEqual([]);
  });

  it("cleans a failed dependency install and permits a successful retry", async () => {
    await expect(installRelease(installer({ failNpm: true }).commands, home)).rejects.toThrow(/^Release npm ci failed/);
    expect(await readdir(releases)).toEqual([]);
    expect((await installRelease(installer().commands, home)).status).toBe("changed");
  });

  it("refuses an existing checkout with a different SHA without repairing it", async () => {
    const { commands } = installer();
    await installRelease(commands, home);
    const { commands: mismatch, calls } = installer({ remoteSha: "a".repeat(40) });
    await expect(installRelease(mismatch, home)).rejects.toThrow("different SHA");
    expect(await git(join(releases, "v0.7.0"), "rev-parse", "HEAD")).toBe(sha);
    expect(calls.some(({ command, args }) => command === "npm" || args.includes("checkout") || args.includes("fetch"))).toBe(false);
  });

  it("refuses attached HEAD even at the correct SHA, leaving the branch alone", async () => {
    const { commands, calls } = installer();
    await installRelease(commands, home);
    const path = join(releases, "v0.7.0");
    await git(path, "checkout", "-qb", "keep-me");
    calls.length = 0;
    await expect(installRelease(commands, home)).rejects.toThrow("detached HEAD");
    expect(await git(path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("keep-me");
    expect(calls.some(({ command, args }) => command === "npm" || args.includes("checkout"))).toBe(false);
  });

  it.each(["package.json", "untracked.txt"])("refuses dirty checkouts (%s), preserving bytes", async (file) => {
    const { commands, calls } = installer();
    await installRelease(commands, home);
    const path = join(releases, "v0.7.0");
    await writeFile(join(path, file), "keep me");
    calls.length = 0;
    await expect(installRelease(commands, home)).rejects.toThrow("dirty");
    expect(await readFile(join(path, file), "utf8")).toBe("keep me");
    expect(calls.some(({ command }) => command === "npm")).toBe(false);
  });

  it("completes a clean checkout whose dependency installation was not recorded", async () => {
    const { commands, calls } = installer();
    await installRelease(commands, home);
    const path = join(releases, "v0.7.0");
    await rm(join(path, ".git", "leanish-setup.json"));
    expect((await installRelease(commands, home)).status).toBe("changed");
    expect(calls.filter(({ command }) => command === "npm")).toHaveLength(2);
  });

  it("reinstalls missing dependencies without moving the checkout", async () => {
    const { commands } = installer();
    await installRelease(commands, home);
    const path = join(releases, "v0.7.0");
    await rm(join(path, "node_modules"), { recursive: true });
    expect((await installRelease(commands, home)).status).toBe("changed");
    expect(await git(path, "rev-parse", "HEAD")).toBe(sha);
  });

  it("invalidates the old receipt before reinstalling, even if npm partially succeeds then fails", async () => {
    const { commands } = installer();
    await installRelease(commands, home);
    const path = join(releases, "v0.7.0");
    await rm(join(path, "node_modules", ".package-lock.json"));
    const failed = installer({ failNpm: true, beforeNpm: async (checkout) => {
      await expect(stat(join(checkout, ".git", "leanish-setup.json"))).rejects.toMatchObject({ code: "ENOENT" });
      await writeFile(join(checkout, "node_modules", ".package-lock.json"), "{}");
    } });
    await expect(installRelease(failed.commands, home)).rejects.toThrow("npm ci failed");
    await expect(stat(join(path, ".git", "leanish-setup.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await installRelease(commands, home)).status).toBe("changed");
  });

  it("does not mask a failed install when the lock has already disappeared", async () => {
    const { commands } = installer({ failNpm: true, beforeNpm: async () => {
      await rm(join(releases, ".setup-lock"), { recursive: true });
    } });
    await expect(installRelease(commands, home)).rejects.toThrow("npm ci failed");
    expect(await readdir(releases)).toEqual([]);
  });

  it("preserves the original failure when lock removal itself fails", async () => {
    const cleanupError = new Error("lock removal failed");
    vi.mocked(rm).mockImplementation(async (path, options) => {
      if (path === join(releases, ".setup-lock")) throw cleanupError;
      return realRm(path, options);
    });
    await expect(installRelease(installer({ failNpm: true }).commands, home)).rejects.toThrow("npm ci failed");
    expect(rm).toHaveBeenCalledWith(join(releases, ".setup-lock"), { recursive: true, force: true });
  });

  it("reports cleanup errors when there is no earlier installation failure", async () => {
    const cleanupError = new Error("lock removal failed");
    vi.mocked(rm).mockImplementation(async (path, options) => {
      if (path === join(releases, ".setup-lock")) throw cleanupError;
      return realRm(path, options);
    });
    await expect(installRelease(installer().commands, home)).rejects.toBe(cleanupError);
  });

  it("cleans only owned stale staging directories, leaving unmarked paths and symlinks alone", async () => {
    await mkdir(releases, { recursive: true });
    const marker = ".leanish-setup-staging";
    const owner = `${RELEASE_REPOSITORY} setup staging v1\n`;
    const owned = join(releases, ".install-owned1");
    await mkdir(owned);
    await writeFile(join(owned, marker), owner);
    await writeFile(join(owned, "partial"), "old checkout");
    const unmarked = join(releases, ".install-raw123");
    await mkdir(unmarked);
    await writeFile(join(unmarked, "keep"), "unrelated");
    const wrong = join(releases, ".install-wrong1");
    await mkdir(wrong);
    await writeFile(join(wrong, marker), owner.replace(" v1", " v2"));
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, marker), owner);
    await symlink(outside, join(releases, ".install-alias1"));
    const linkedMarker = join(releases, ".install-links1");
    await mkdir(linkedMarker);
    await symlink(join(outside, marker), join(linkedMarker, marker));
    const otherName = join(releases, ".install-other-name");
    await mkdir(otherName);
    await writeFile(join(otherName, marker), owner);
    expect((await installRelease(installer().commands, home)).status).toBe("changed");
    await expect(stat(owned)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(unmarked, "keep"), "utf8")).toBe("unrelated");
    expect(await readFile(join(wrong, marker), "utf8")).toBe(owner.replace(" v1", " v2"));
    expect(await readFile(join(outside, marker), "utf8")).toBe(owner);
    expect(await readFile(join(linkedMarker, marker), "utf8")).toBe(owner);
    expect(await readFile(join(otherName, marker), "utf8")).toBe(owner);
  });

  it("marks newly created staging so interrupted work can be identified", async () => {
    const { commands } = installer({ beforeNpm: async (checkout) => {
      expect(await readFile(join(checkout, "..", ".leanish-setup-staging"), "utf8")).toBe(`${RELEASE_REPOSITORY} setup staging v1\n`);
    } });
    await installRelease(commands, home);
    expect(await readdir(releases)).toEqual(["v0.7.0"]);
  });

  it("refuses symlink destinations and never writes into their target", async () => {
    const { commands } = installer();
    await mkdir(releases, { recursive: true });
    await symlink(source, join(releases, "v0.7.0"));
    await expect(installRelease(commands, home)).rejects.toThrow("real directories");
    await expect(stat(join(source, "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a symlink release root", async () => {
    const { commands } = installer();
    await mkdir(join(home, ".local", "share", "leanish"), { recursive: true });
    await symlink(source, releases);
    await expect(installRelease(commands, home)).rejects.toThrow("real directories");
    await expect(stat(join(source, ".setup-lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses node_modules symlinks and mismatched receipts without running npm", async () => {
    const { commands, calls } = installer();
    await installRelease(commands, home);
    const path = join(releases, "v0.7.0");
    await rm(join(path, "node_modules"), { recursive: true });
    await symlink(source, join(path, "node_modules"));
    calls.length = 0;
    await expect(installRelease(commands, home)).rejects.toThrow(/dirty|real directory/);
    expect(calls.some(({ command }) => command === "npm")).toBe(false);
    await rm(join(path, "node_modules"));
    await writeFile(join(path, ".git", "leanish-setup.json"), JSON.stringify({ schemaVersion: 1, tag: "v0.7.0", sha: "a".repeat(40) }));
    await expect(installRelease(commands, home)).rejects.toThrow("receipt does not match");
    expect(calls.some(({ command }) => command === "npm")).toBe(false);
  });

  it("blocks a concurrent or interrupted installer without taking or removing its lock", async () => {
    const { commands, calls } = installer();
    await mkdir(join(releases, ".setup-lock"), { recursive: true });
    const staging = join(releases, ".install-active");
    await mkdir(staging);
    await writeFile(join(staging, ".leanish-setup-staging"), `${RELEASE_REPOSITORY} setup staging v1\n`);
    await expect(installRelease(commands, home)).rejects.toThrow("locked");
    expect(calls.every(({ command }) => command === "gh")).toBe(true);
    expect((await stat(join(releases, ".setup-lock"))).isDirectory()).toBe(true);
    expect((await stat(staging)).isDirectory()).toBe(true);
  });

  it("retains older releases", async () => {
    await mkdir(join(releases, "v0.6.0"), { recursive: true });
    await writeFile(join(releases, "v0.6.0", "keep"), "rollback");
    await installRelease(installer().commands, home);
    expect(await readFile(join(releases, "v0.6.0", "keep"), "utf8")).toBe("rollback");
  });
});
