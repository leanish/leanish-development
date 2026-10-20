import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";

import { componentsBelow, configure, configPath, readInstallation, type ConfigureOptions } from "../src/configuration.ts";
import { descriptor, type Tool } from "../src/tools.ts";

let home: string;
const options: ConfigureOptions = { tool: "bump-it", owner: "acme", repos: ["acme/one"], agent: "codex", name: "Dev", email: "dev@example.com" };
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "setup-config-")); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

describe("owner installations", () => {
  it("writes and reads with a HOME that ends in a slash, and never walks a path outside home", async () => {
    // Before 0.7.1 the walk compared against home verbatim: with a trailing slash it never met it and kept climbing.
    expect((await configure(options, `${home}/`)).status).toBe("changed");
    expect((await readInstallation(options, `${home}/`)).path).toBe(join(home, ".config/leanish/installations/acme/bump-it/agent.yaml"));
    expect(componentsBelow(join(home, "a", "b"), `${home}/`)).toEqual([join(home, "a"), join(home, "a", "b")]);
    expect(() => componentsBelow("/elsewhere/a", home)).toThrow(`/elsewhere/a must be under ${home}`);
  });

  it.each(["bump-it", "secure-it"] as const)("reads %s contribution as data and writes a strict owner-scoped config", async (tool) => {
    const selected = { ...options, tool };
    const first = await configure(selected, home);
    expect(first.status).toBe("changed");
    const { path, config } = await readInstallation(selected, home);
    expect(path).toBe(join(home, ".config/leanish/installations/acme", tool, "agent.yaml"));
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect(config.secrets).toEqual({ write: `leanish-${tool}-acme-write`, read: `leanish-${tool}-acme-read` });
    expect(config.dirs.state).toBe(join(home, ".local/share/leanish/installations/acme", tool));
    expect(config.dirs.cache).toBe(join(home, ".cache/leanish/installations/acme", tool));
    expect(config.agent).toEqual({ codingAgent: "codex", model: "sol", effort: "medium" });
    const contribution = (await descriptor(tool)).descriptor;
    expect(contribution.schedule).toMatchObject({ frequency: tool === "bump-it" ? "weekly" : "daily" });
    expect(contribution.permissions.map(({ name, write, read }) => [name, write, read])).toEqual([
      ["contents", "write", "read"], ["pull_requests", "write", "read"], ["workflows", "write", "none"], ["actions", "read", "read"],
      ["statuses", "read", "read"], ["metadata", "read", "read"], ["checks", "none", "none"],
    ]);
    expect((await configure(selected, home)).status).toBe("already-done");
  });

  it("preserves restored choices and comments while adding only selected repository opt-ins", async () => {
    await configure(options, home);
    const path = configPath(options, home);
    const text = parse(await readFile(path, "utf8"));
    text.agent = { codingAgent: "claude-code", model: "custom-model", effort: "low" };
    text.secrets = { write: "restored-write", read: "restored-read" };
    text.repos[0].branch = "release";
    text.readDeny = ["~/private"];
    text.maxNewMajorsPerRun = 0;
    await writeFile(path, "# keep this note\n" + stringify(text));
    await chmod(path, 0o644);
    await configure({ ...options, repos: ["ACME/ONE", "acme/two"], model: "new-model", name: "Other" }, home);
    const config = (await readInstallation(options, home)).config;
    expect(config.agent).toEqual(text.agent);
    expect(config.commitIdentity.name).toBe("Dev");
    expect(config.secrets).toEqual(text.secrets);
    expect(config.repos).toEqual([{ repo: "acme/one", branch: "release" }, { repo: "acme/two", branch: undefined }]);
    expect(config.maxNewMajorsPerRun).toBe(0);
    expect(await readFile(path, "utf8")).toContain("# keep this note");
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    const before = await readFile(path, "utf8");
    await configure({ ...options, repos: ["acme/two"] }, home);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("keeps owners and tools isolated and asks for missing first-install choices", async () => {
    expect((await configure({ tool: "bump-it", owner: "acme", repos: ["acme/one"] }, home)).status).toBe("needs-confirmation");
    await configure(options, home);
    await configure({ ...options, owner: "personal", repos: ["personal/one"] }, home);
    expect((await readInstallation(options, home)).config.repos).toHaveLength(1);
    expect((await readInstallation({ tool: "bump-it", owner: "personal" }, home)).config.secrets.write).toBe("leanish-bump-it-personal-write");
  });

  it("refuses foreign opt-ins, unsafe owners, malformed YAML and unknown fields without echoing values", async () => {
    await expect(configure({ ...options, repos: ["other/one"] }, home)).rejects.toThrow("another installation");
    await expect(configure({ ...options, owner: "../bad" }, home)).rejects.toThrow("Invalid GitHub");
    await configure(options, home);
    const path = configPath(options, home);
    for (const text of ["secret-sentinel: [invalid", "secret-sentinel: true"]) {
      await writeFile(path, text);
      await expect(configure(options, home)).rejects.toThrow(/^Installation config is invalid;/);
      expect(await readFile(path, "utf8")).toBe(text);
    }
  });

  it("refuses locks, file symlinks and parent symlinks, preserving targets", async () => {
    await configure(options, home);
    const path = configPath(options, home);
    await mkdir(join(dirname(path), ".setup-lock"));
    await expect(configure({ ...options, repos: ["acme/two"] }, home)).rejects.toThrow("locked");
    await rm(join(dirname(path), ".setup-lock"), { recursive: true });
    const saved = await readFile(path, "utf8");
    await rename(path, path + ".saved");
    await symlink(path + ".saved", path);
    await expect(configure(options, home)).rejects.toThrow("regular file");
    await rm(path);
    await rename(path + ".saved", path);
    await rename(join(home, ".config"), join(home, "saved-config"));
    await symlink(join(home, "saved-config"), join(home, ".config"));
    await expect(configure(options, home)).rejects.toThrow("must not be symlinks");
    await expect(readInstallation(options, home)).rejects.toThrow("real directories");
    expect(await readFile(join(home, "saved-config/leanish/installations/acme/bump-it/agent.yaml"), "utf8")).toBe(saved);
  });

  it("preserves every supported per-repo key and its YAML comments when adding a repo", async () => {
    await configure(options, home);
    const path = configPath(options, home);
    const original = parse(await readFile(path, "utf8"));
    original.repos[0].branch = "release";
    await writeFile(path, stringify(original).replace("repo: acme/one", "repo: acme/one # repository choice").replace("branch: release", "branch: release # branch choice"));
    await configure({ ...options, repos: ["acme/two"] }, home);
    const updated = await readFile(path, "utf8");
    // parseToolConfig currently accepts exactly repo and branch on a repository entry.
    expect(parse(updated).repos).toEqual([{ repo: "acme/one", branch: "release" }, { repo: "acme/two" }]);
    expect(updated).toContain("# repository choice");
    expect(updated).toContain("# branch choice");
  });

  it("refuses a live PID lock but reclaims a lock whose process is gone", async () => {
    await configure(options, home);
    const lock = join(dirname(configPath(options, home)), ".setup-lock");
    await writeFile(lock, String(process.pid));
    await expect(configure({ ...options, repos: ["acme/two"] }, home)).rejects.toThrow("locked");
    const child = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
    expect(child.status).toBe(0);
    await writeFile(lock, String(child.pid));
    expect((await configure({ ...options, repos: ["acme/two"] }, home)).status).toBe("changed");
    expect((await readInstallation(options, home)).config.repos).toHaveLength(2);
    await expect(lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.getuid?.() === 0)("reports permission errors as such instead of claiming a held lock", async () => {
    await configure(options, home);
    const directory = dirname(configPath(options, home));
    await chmod(directory, 0o500);
    try {
      await expect(configure({ ...options, repos: ["acme/two"] }, home)).rejects.toThrow(/Could not create installation configuration lock \((EACCES|EPERM)\)/);
    } finally { await chmod(directory, 0o700); }
  });
});
