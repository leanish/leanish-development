import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configure } from "../src/configuration.ts";
import { exitCode } from "../src/contracts.ts";
import { schedule, scheduleCheck, scheduleSpec, type ScheduleMachine } from "../src/schedule.ts";

let home: string;
let host: ScheduleMachine;
const options = { tool: "bump-it" as const, owner: "acme", release: "v0.7.0", agent: "codex" as const };
const install = (owner: string, tool: "bump-it" | "secure-it" = "bump-it") => configure({ tool, owner, repos: [`${owner}/one`], agent: "codex", name: "Dev", email: "dev@example.com" }, home);
beforeEach(async () => {
  vi.stubEnv("CODEX_HOME", undefined);
  home = await mkdtemp(join(tmpdir(), "setup-schedule-"));
  await install("acme");
  await mkdir(join(home, ".local/share/leanish/releases/v0.7.0/core/setup"), { recursive: true });
  await writeFile(join(home, ".local/share/leanish/releases/v0.7.0/core/setup/run.sh"), "# not executed\n");
  host = { home, timeZone: "Europe/Helsinki", release: vi.fn(async (tag) => ({ tag, sha: "a".repeat(40), path: join(home, ".local/share/leanish/releases", tag) })) };
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); });

async function readback(overrides: Record<string, unknown> = {}) {
  const spec = await scheduleSpec(options, host);
  const file = join(home, "readback.json");
  const snapshot = { id: spec.taskId, title: spec.title, cron: spec.cron, timeZone: spec.timeZone, enabled: true, prompt: spec.prompt, folder: spec.folder, ...overrides };
  await writeFile(file, JSON.stringify(snapshot));
  return { file, snapshot, spec, check: () => scheduleCheck({ ...options, taskFile: file }, host) };
}

describe("local task specifications", () => {
  it("quotes an unusual home path the same way in the command and in the Codex rule, under CODEX_HOME", async () => {
    const odd = await mkdtemp(join(tmpdir(), `setup schedule "é\\ `));
    try {
      await configure({ tool: "bump-it", owner: "acme", repos: ["acme/one"], agent: "codex", name: "Dev", email: "dev@example.com" }, odd);
      const launcher = join(odd, ".local/share/leanish/releases/v0.7.0/core/setup/run.sh");
      await mkdir(join(launcher, ".."), { recursive: true });
      await writeFile(launcher, "# not executed\n");
      vi.stubEnv("CODEX_HOME", "/opt/codex-home");
      const value = await schedule(options, { ...host, home: odd, release: async (tag) => ({ tag, sha: "a".repeat(40), path: join(odd, ".local/share/leanish/releases", tag) }) });
      expect(value.data?.command).toBe(`/bin/bash '${launcher.replaceAll("'", "'\\''")}' bump-it --owner acme --release v0.7.0`);
      expect(value.data?.commandRule).toEqual({ file: "/opt/codex-home/rules/leanish-bump-it-acme.rules", entry: expect.stringContaining(`        ${JSON.stringify(launcher)},\n`) });
      expect(JSON.stringify(launcher)).toContain('\\"é\\\\ ');
    } finally {
      await rm(odd, { recursive: true, force: true });
    }
  });

  it.each(["codex", "claude-code"] as const)("prints one needs-confirmation task for %s, without secrets or execution", async (agent) => {
    vi.stubEnv("GH_TOKEN", "secret-sentinel");
    const value = await schedule({ ...options, agent }, host);
    expect(value).toMatchObject({ command: "schedule", status: "needs-confirmation", data: {
      taskId: "leanish-bump-it-acme", title: "leanish-bump-it-acme", cron: "17 10 * * 3", timeZone: "Europe/Helsinki", agent,
    } });
    expect(exitCode([value])).toBe(2);
    expect(value.data?.command).toBe(`/bin/bash ${join(home, ".local/share/leanish/releases/v0.7.0/core/setup/run.sh")} bump-it --owner acme --release v0.7.0`);
    expect(value.data?.prompt).toContain(value.data?.command);
    // Each app's own way to wait for one long command, with no other command started to inspect it.
    if (agent === "claude-code") {
      expect(value.data?.prompt).toContain("run_in_background: true");
      expect(value.data?.prompt).toContain("do not poll");
      expect(value.data?.unattended).toContain("completion notifications");
    } else {
      expect(value.data?.prompt).toContain("continuation/wait facility for that same session");
      expect(value.data?.prompt).toContain("never stop or restart it");
      expect(value.data?.prompt).not.toContain("completion notification");
      expect(value.data?.unattended).toContain("session");
    }
    expect(value.data?.prompt).toContain("Never run another shell command to inspect output");
    const launcher = join(home, ".local/share/leanish/releases/v0.7.0/core/setup/run.sh");
    expect(value.data?.commandRule).toEqual(agent === "claude-code"
      ? { file: "~/.claude/settings.json (permissions.allow)", entry: `Bash(${value.data?.command})` }
      : { file: "~/.codex/rules/leanish-bump-it-acme.rules", entry: `prefix_rule(\n    pattern = [\n        "/bin/bash",\n        ${JSON.stringify(launcher)},\n        "bump-it",\n        "--owner",\n        "acme",\n        "--release",\n        "v0.7.0",\n    ],\n    decision = "allow",\n)\n` });
    expect(value.data?.unattended).toContain("cannot run unattended");
    expect(JSON.stringify(value)).not.toContain("secret-sentinel");
    expect(value.data).not.toHaveProperty("ownerOffsetHours");
  });

  it("uses each tool's default for every owner, writing no schedule state", async () => {
    await install("acme", "secure-it");
    await install("alpha");
    expect(await scheduleSpec({ ...options, tool: "secure-it" }, host)).toMatchObject({ cron: "17 9 * * *" });
    expect(await scheduleSpec({ ...options, owner: "alpha" }, host)).toMatchObject({ cron: "17 10 * * 3" });
    expect(await scheduleSpec(options, host)).toMatchObject({ cron: "17 10 * * 3" });
    expect(await readdir(join(home, ".config/leanish/installations/acme"))).not.toContain("schedule.json");
    expect(await readdir(join(home, ".config/leanish/installations"))).not.toContain(".schedule-lock");
  });

  it("places the task where the person says: time and weekday independently or together", async () => {
    expect(await scheduleSpec({ ...options, time: { hour: 7, minute: 5 } }, host)).toMatchObject({ cron: "5 7 * * 3" });
    expect(await scheduleSpec({ ...options, weekday: 0 }, host)).toMatchObject({ cron: "17 10 * * 0" });
    expect(await scheduleSpec({ ...options, time: { hour: 23, minute: 59 }, weekday: 6 }, host)).toMatchObject({ cron: "59 23 * * 6" });
    await install("acme", "secure-it");
    expect(await scheduleSpec({ ...options, tool: "secure-it", time: { hour: 0, minute: 0 } }, host)).toMatchObject({ cron: "0 0 * * *" });
  });

  it("schedules a release candidate only for an installation of fixture repositories", async () => {
    await mkdir(join(home, ".local/share/leanish/releases/v0.7.0-rc.1/core/setup"), { recursive: true });
    await writeFile(join(home, ".local/share/leanish/releases/v0.7.0-rc.1/core/setup/run.sh"), "# not executed\n");
    const candidate = { ...options, release: "v0.7.0-rc.1" };
    await expect(scheduleSpec(candidate, host)).rejects.toThrow("runs only on leanish-development[_<tool>]_TEST_* fixture repositories");
    await configure({ tool: "bump-it", owner: "fixtures", repos: ["fixtures/leanish-development_TEST_one"], agent: "codex", name: "Dev", email: "dev@example.com" }, home);
    expect(await scheduleSpec({ ...candidate, owner: "fixtures" }, host)).toMatchObject({ command: expect.stringContaining("--release v0.7.0-rc.1") });
  });

  it("refuses a weekday for a daily tool instead of ignoring it", async () => {
    await install("acme", "secure-it");
    await expect(scheduleSpec({ ...options, tool: "secure-it", weekday: 1 }, host)).rejects.toThrow("secure-it runs daily; choose only --time");
    const release = vi.fn(host.release);
    await expect(scheduleSpec({ ...options, tool: "secure-it", weekday: 1 }, { ...host, release })).rejects.toThrow("runs daily");
    expect(release).not.toHaveBeenCalled();
  });

  it("quotes release paths with spaces and apostrophes for the literal shell command", async () => {
    const path = join(home, "a person's releases/v0.7.0");
    await mkdir(join(path, "core/setup"), { recursive: true });
    await writeFile(join(path, "core/setup/run.sh"), "# not executed\n");
    const spec = await scheduleSpec(options, { ...host, release: async (tag) => ({ tag, sha: "a".repeat(40), path }) });
    expect(spec.command).toBe(`/bin/bash '${path.replaceAll("'", "'\\''")}/core/setup/run.sh' bump-it --owner acme --release v0.7.0`);
    expect(spec.folder).toBe(path);
  });

  it("requires the selected installation and an offline verified release", async () => {
    await expect(scheduleSpec({ ...options, owner: "missing" }, host)).rejects.toThrow();
    const release = vi.fn(async () => { throw new Error("Release is dirty or pin mismatched"); });
    await expect(scheduleSpec(options, { ...host, release })).rejects.toThrow("pin mismatched");
    expect(release).toHaveBeenCalledWith("v0.7.0");
    await rm(join(home, ".local/share/leanish/releases/v0.7.0/core/setup/run.sh"));
    await expect(scheduleSpec(options, host)).rejects.toThrow("Until such a release is published, use the manual guide: docs/adopting-tools.md");
  });

  it("reports an installed legacy release with the manual guide, not a suggestion to select another existing release", async () => {
    const value = schedule(options, { ...host, release: async () => ({ tag: "v0.6.0", sha: "a".repeat(40), path: join(home, ".local/share/leanish/releases/v0.7.0") }) });
    await expect(value).rejects.toThrow("Found v0.6.0. Guided setup needs a release that ships core/setup/run.sh (v0.7.0 or newer)");
    await expect(value).rejects.toThrow("Until such a release is published, use the manual guide: docs/adopting-tools.md");
  });

});

describe("app task readback", () => {
  it("compares canonical folder paths, including macOS /var and /private/var aliases", async () => {
    const snapshot = await readback();
    const canonical = await realpath(snapshot.spec.folder);
    let alias: string;
    if (process.platform === "darwin" && canonical.startsWith("/private/var/")) alias = canonical.replace(/^\/private\/var\//, "/var/");
    else {
      alias = join(home, "release-folder-alias");
      await symlink(snapshot.spec.folder, alias);
    }
    await writeFile(snapshot.file, JSON.stringify({ ...snapshot.snapshot, folder: alias }));
    expect((await snapshot.check()).status).toBe("already-done");
  });

  it("ignores trailing prompt whitespace and newlines, but preserves leading and internal whitespace", async () => {
    const snapshot = await readback();
    await writeFile(snapshot.file, JSON.stringify({ ...snapshot.snapshot, prompt: snapshot.spec.prompt + "  \t\r\n\n" }));
    expect((await snapshot.check()).status).toBe("already-done");
    for (const prompt of [" " + snapshot.spec.prompt, snapshot.spec.prompt.replace("Nobody is", "Nobody  is")]) {
      await writeFile(snapshot.file, JSON.stringify({ ...snapshot.snapshot, prompt }));
      expect(await snapshot.check()).toMatchObject({ status: "blocked", data: { differences: ["prompt"] } });
    }
  });
  it("accepts an exact enabled snapshot and an opaque native ID with the exact observed title", async () => {
    const first = await readback();
    expect(await first.check()).toMatchObject({ status: "already-done", data: { differences: [] } });
    expect(exitCode([await first.check()])).toBe(0);
    const opaque = await readback({ id: "native-app-uuid" });
    expect((await opaque.check()).status).toBe("already-done");
  });

  it.each([
    ["id/title", { id: "wrong", title: undefined }], ["title", { title: "wrong" }],
    ["cron/schedule", { cron: "0 0 * * *" }], ["timeZone", { timeZone: "UTC" }],
    ["enabled", { enabled: false }], ["enabled", { enabled: "true" }],
    ["prompt", { prompt: "secret-sentinel" }], ["folder", { folder: "/wrong" }], ["folder", { folder: undefined }],
  ] as const)("blocks a %s mismatch without reflecting observed values", async (field, values) => {
    const snapshot = await readback(values);
    const value = await snapshot.check();
    expect(value.status).toBe("blocked");
    expect(value.data?.differences).toContain(field);
    expect(exitCode([value])).toBe(1);
    expect(JSON.stringify(value)).not.toContain("secret-sentinel");
  });

  it("compares against the schedule chosen at schedule time, passed again to schedule-check", async () => {
    const chosen = { ...options, time: { hour: 6, minute: 30 }, weekday: 1 };
    const spec = await scheduleSpec(chosen, host);
    const file = join(home, "chosen.json");
    await writeFile(file, JSON.stringify({ id: spec.taskId, cron: spec.cron, enabled: true, prompt: spec.prompt, folder: spec.folder }));
    expect(spec.cron).toBe("30 6 * * 1");
    expect((await scheduleCheck({ ...chosen, taskFile: file }, host)).status).toBe("already-done");
    expect(await scheduleCheck({ ...options, taskFile: file }, host)).toMatchObject({ status: "blocked", data: { differences: ["cron/schedule"] } });
  });

  it("accepts a Claude readback without a folder, since its scheduling tool stores none, but never a Codex one", async () => {
    for (const agent of ["claude-code", "codex"] as const) {
      const spec = await scheduleSpec({ ...options, agent }, host);
      const file = join(home, `${agent}.json`);
      await writeFile(file, JSON.stringify({ id: spec.taskId, title: spec.title, cron: spec.cron, enabled: true, prompt: spec.prompt }));
      const value = await scheduleCheck({ ...options, agent, taskFile: file }, host);
      expect(value.data?.differences).toEqual(agent === "claude-code" ? [] : ["folder"]);
    }
    const claude = await scheduleSpec({ ...options, agent: "claude-code" }, host);
    const crossed = join(home, "crossed.json");
    await writeFile(crossed, JSON.stringify({ id: claude.taskId, cron: claude.cron, enabled: true, prompt: claude.prompt, folder: claude.folder }));
    expect((await scheduleCheck({ ...options, agent: "codex", taskFile: crossed }, host)).data?.differences).toEqual(["prompt"]);
    const wrong = join(home, "wrong-folder.json");
    await writeFile(wrong, JSON.stringify({ id: claude.taskId, cron: claude.cron, enabled: true, prompt: claude.prompt, folder: "/wrong" }));
    expect((await scheduleCheck({ ...options, agent: "claude-code", taskFile: wrong }, host)).data?.differences).toEqual(["folder"]);
  });

  it("compares the supported weekly and daily RRULEs without ignoring extra constraints", async () => {
    const snapshot = await readback({ cron: undefined, schedule: "RRULE:FREQ=WEEKLY;BYDAY=WE;BYHOUR=10;BYMINUTE=17;BYSECOND=0;INTERVAL=1" });
    expect((await snapshot.check()).status).toBe("already-done");
    await writeFile(snapshot.file, JSON.stringify({ ...snapshot.snapshot, schedule: "RRULE:FREQ=WEEKLY;BYDAY=WE;BYHOUR=10;BYMINUTE=17;COUNT=2" }));
    expect((await snapshot.check()).status).toBe("blocked");
    await install("acme", "secure-it");
    const daily = await scheduleSpec({ ...options, tool: "secure-it" }, host);
    await writeFile(snapshot.file, JSON.stringify({ id: daily.taskId, enabled: true, schedule: "RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=17", prompt: daily.prompt, folder: daily.folder }));
    expect((await scheduleCheck({ ...options, tool: "secure-it", taskFile: snapshot.file }, host)).status).toBe("already-done");
  });

  it("does not ignore conflicting schedules or absent schedule evidence", async () => {
    for (const values of [{ schedule: "0 0 * * *" }, { cron: undefined, schedule: undefined }]) {
      const snapshot = await readback(values);
      expect(await snapshot.check()).toMatchObject({ status: "blocked", data: { differences: ["cron/schedule"] } });
    }
  });

  it.each(["secret-sentinel", "[]", "null", "{", "42"])("blocks a malformed task file without echoing it: %s", async (text) => {
    const snapshot = await readback();
    await writeFile(snapshot.file, text);
    const value = await snapshot.check();
    expect(value).toMatchObject({ status: "blocked", message: expect.stringContaining("exported regular JSON") });
    expect(JSON.stringify(value)).not.toContain("secret-sentinel");
  });

  it("refuses app storage, missing, oversized and symlink snapshots, preserving source files", async () => {
    const snapshot = await readback();
    const original = await readFile(snapshot.file, "utf8");
    for (const path of [join(home, ".claude/task.json"), join(home, ".codex/task.json"), join(home, "Library/app/tasks.json"), join(home, "missing.json")]) {
      expect((await scheduleCheck({ ...options, taskFile: path }, host)).status).toBe("blocked");
    }
    const linked = join(home, "linked.json");
    await symlink(snapshot.file, linked);
    expect((await scheduleCheck({ ...options, taskFile: linked }, host)).status).toBe("blocked");
    expect(await readFile(snapshot.file, "utf8")).toBe(original);
    await writeFile(snapshot.file, " ".repeat(1_000_001));
    expect((await snapshot.check()).status).toBe("blocked");
  });
});
