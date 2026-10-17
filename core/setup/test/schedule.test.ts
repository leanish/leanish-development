import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
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
  it.each(["codex", "claude-code"] as const)("prints one needs-confirmation task for %s, without secrets or execution", async (agent) => {
    vi.stubEnv("GH_TOKEN", "secret-sentinel");
    const value = await schedule({ ...options, agent }, host);
    expect(value).toMatchObject({ command: "schedule", status: "needs-confirmation", data: {
      taskId: "leanish-bump-it-acme", title: "leanish-bump-it-acme", cron: "17 10 * * 3", timeZone: "Europe/Helsinki", ownerOffsetHours: 0, agent,
    } });
    expect(exitCode([value])).toBe(2);
    expect(value.data?.command).toBe(`/bin/bash ${join(home, ".local/share/leanish/releases/v0.7.0/core/setup/run.sh")} bump-it --owner acme --release v0.7.0`);
    expect(value.data?.prompt).toContain(value.data?.command);
    expect(value.data?.prompt).toContain("do not poll");
    expect(value.data?.unattended).toContain("cannot run unattended");
    expect(JSON.stringify(value)).not.toContain("secret-sentinel");
  });

  it("uses the secure-it daily default and counts each owner once across both tools", async () => {
    await install("acme", "secure-it");
    await install("zebra", "secure-it");
    await install("alpha");
    await mkdir(join(home, ".config/leanish/installations/empty"));
    await symlink(join(home, ".config/leanish/installations/alpha"), join(home, ".config/leanish/installations/linked"));
    expect(await scheduleSpec({ ...options, tool: "secure-it" }, host)).toMatchObject({ cron: "17 9 * * *", ownerOffsetHours: 0 });
    expect(await scheduleSpec({ ...options, owner: "alpha" }, host)).toMatchObject({ cron: "17 11 * * 3", ownerOffsetHours: 1 });
    expect(await scheduleSpec({ ...options, tool: "secure-it", owner: "zebra" }, host)).toMatchObject({ cron: "17 11 * * *", ownerOffsetHours: 2 });
  });

  it("rolls weekly cron to the following day after an hour shift crosses midnight", async () => {
    for (let index = 0; index < 15; index++) {
      const owner = `a${String(index).padStart(2, "0")}`;
      await install(owner);
      await scheduleSpec({ ...options, owner }, host);
    }
    expect(await scheduleSpec(options, host)).toMatchObject({ cron: "17 1 * * 4", ownerOffsetHours: 15 });
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

  it("persists an owner's offset across earlier-sorting additions and shares it across tools", async () => {
    const first = await schedule(options, host);
    const path = join(home, ".config/leanish/installations/acme/schedule.json");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ offsetHours: 0 });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await install("aaa");
    expect((await schedule({ ...options, owner: "aaa" }, host)).data).toMatchObject({ ownerOffsetHours: 1, cron: "17 11 * * 3" });
    expect((await schedule(options, host)).data?.cron).toBe(first.data?.cron);
    await install("acme", "secure-it");
    expect((await schedule({ ...options, tool: "secure-it" }, host)).data).toMatchObject({ ownerOffsetHours: 0, cron: "17 9 * * *" });
    expect(await readdir(join(home, ".config/leanish/installations/acme"))).toEqual(expect.arrayContaining(["schedule.json"]));
    expect((await readdir(join(home, ".config/leanish/installations"))).some((name) => name === ".schedule-lock")).toBe(false);
  });

  it("reports an installed legacy release with the manual guide, not a suggestion to select another existing release", async () => {
    const value = schedule(options, { ...host, release: async () => ({ tag: "v0.6.0", sha: "a".repeat(40), path: join(home, ".local/share/leanish/releases/v0.7.0") }) });
    await expect(value).rejects.toThrow("Found v0.6.0. Guided setup needs a stable release that ships core/setup/run.sh (v0.7.0 or newer)");
    await expect(value).rejects.toThrow("Until such a release is published, use the manual guide: docs/adopting-tools.md");
    await expect(stat(join(home, ".config/leanish/installations/acme/schedule.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses the lowest free persisted slot, including reservations whose tool configs were removed", async () => {
    await mkdir(join(home, ".config/leanish/installations/retired"));
    await writeFile(join(home, ".config/leanish/installations/retired/schedule.json"), '{"offsetHours":0}');
    await install("alpha");
    await writeFile(join(home, ".config/leanish/installations/alpha/schedule.json"), '{"offsetHours":2}');
    expect((await schedule(options, host)).data).toMatchObject({ ownerOffsetHours: 1, cron: "17 11 * * 3" });
  });

  it("does not allocate the same slot to concurrently scheduled owners", async () => {
    await install("alpha");
    // A contending caller may be blocked by the shared lock; retrying must retain distinct slots.
    await Promise.allSettled([schedule(options, host), schedule({ ...options, owner: "alpha" }, host)]);
    const first = await schedule(options, host);
    const second = await schedule({ ...options, owner: "alpha" }, host);
    expect([first.data?.ownerOffsetHours, second.data?.ownerOffsetHours].sort()).toEqual([0, 1]);
  });

  it("releases the allocation lock after a malformed reservation blocks a new owner", async () => {
    await install("alpha");
    const existing = join(home, ".config/leanish/installations/alpha/schedule.json");
    await writeFile(existing, "invalid-sentinel");
    await expect(schedule(options, host)).rejects.toThrow(/^Invalid saved schedule offset;/);
    await expect(stat(join(home, ".config/leanish/installations/acme/schedule.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(home, ".config/leanish/installations/.schedule-lock"))).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(existing, '{"offsetHours":0}');
    expect((await schedule(options, host)).data?.ownerOffsetHours).toBe(1);
  });

  it("ignores noncanonical and unrelated owner directories without reading their offsets", async () => {
    for (const name of ["Nosto", "not_an_owner", ".unrelated"]) {
      const path = join(home, ".config/leanish/installations", name);
      await mkdir(path);
      await writeFile(join(path, "schedule.json"), "invalid-sentinel");
    }
    expect((await schedule(options, host)).data?.ownerOffsetHours).toBe(0);
  });

  it("keeps schedule-check read-only when no offset has been reserved", async () => {
    await expect(scheduleCheck({ ...options, taskFile: join(home, "unused.json") }, host)).rejects.toThrow("run schedule before checking");
    await expect(stat(join(home, ".config/leanish/installations/acme/schedule.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(['{"offsetHours":-1}', '{"offsetHours":1.5}', '{"offsetHours":"invalid-sentinel"}', '{"offsetHours":0,"extra":true}', "invalid-sentinel"])("refuses invalid saved offsets without replacing or echoing them: %s", async (text) => {
    const path = join(home, ".config/leanish/installations/acme/schedule.json");
    await writeFile(path, text);
    await expect(schedule(options, host)).rejects.toThrow(/^Invalid saved schedule offset;/);
    expect(await readFile(path, "utf8")).toBe(text);
  });

  it("refuses symlink offset files without changing their targets", async () => {
    const target = join(home, "outside.json");
    await writeFile(target, '{"offsetHours":0}');
    await symlink(target, join(home, ".config/leanish/installations/acme/schedule.json"));
    await expect(schedule(options, host)).rejects.toThrow("regular schedule.json");
    expect(await readFile(target, "utf8")).toBe('{"offsetHours":0}');
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
