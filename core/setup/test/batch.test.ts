import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { parseToolConfig } from "@leanish/tool-runtime/config";

import { batch, executeBatch, invokeTool } from "../src/batch.ts";
import { memoryLog } from "./memory-batch-log.ts";

const options = { tool: "bump-it" as const, owner: "acme" };
const report = { msg: "run finished", tool: "bump-it", repo: "acme/one", status: "ok", result: { outcome: "completed" }, totals: { estimatedApiCostUsd: 0.01 } };
const ok = () => ({ code: 0, report });
let root: string | undefined;
afterEach(async () => { vi.unstubAllEnvs(); if (root !== undefined) await rm(root, { recursive: true, force: true }); root = undefined; });

describe("batch runner", () => {
  it("matches PRs whatever the configured name's case, and lists a PR reported twice once", async () => {
    const records: Readonly<Record<string, unknown>>[] = [];
    const reviewed = { ...report, result: { reviewed: [{ number: 1, url: "https://github.com/acme/one/pull/1", outcome: "closed" }] } };
    await executeBatch(options, ["Acme/One"], async () => ({ code: 0, report: reviewed }), (record) => records.push(record));
    expect(records.at(-1)).toMatchObject({ prs: ["https://github.com/acme/one/pull/1"], attention: [{ pr: "https://github.com/acme/one/pull/1", outcome: "closed" }] });
  });

  it("counts attention entries past its limit instead of dropping them silently", async () => {
    const records: Readonly<Record<string, unknown>>[] = [];
    const reviewed = Array.from({ length: 102 }, (_, index) => ({ number: index, url: `https://github.com/acme/one/pull/${index}`, outcome: "held" }));
    await executeBatch(options, ["acme/one"], async (_repo, action) => action === "review" ? { code: 0, report: { ...report, result: { reviewed } } } : ok(), (record) => records.push(record));
    expect(records[0]).toMatchObject({ attentionOmitted: 2 });
    expect((records[0]!["attention"] as unknown[]).length).toBe(100);
    expect(records.at(-1)).toMatchObject({ attentionOmitted: 2 });
  });

  it("keeps review outcomes a person should hear about, with their PR, and never the tool's free text", async () => {
    const records: Readonly<Record<string, unknown>>[] = [];
    const reviewed = { ...report, result: { reviewed: [
      { number: 1, url: "https://github.com/acme/one/pull/1", outcome: "closed", detail: "secret-sentinel" },
      { number: 2, url: "https://github.com/acme/one/pull/2", outcome: "no-checks", detail: "secret-sentinel" },
      { number: 3, url: "https://github.com/acme/one/pull/3", outcome: "marked-ready", detail: "secret-sentinel" },
      { number: 4, url: "https://github.com/other/repo/pull/4", outcome: "closed" },
      { number: 5, url: "https://github.com/acme/one/pull/5", outcome: "ready-missing-required", detail: "secret-sentinel" },
    ] } };
    expect(await executeBatch(options, ["acme/one"], async (_repo, action) => action === "review" ? { code: 0, report: reviewed } : ok(), (record) => records.push(record))).toBe(0);
    const expected = [
      { pr: "https://github.com/acme/one/pull/1", outcome: "closed" },
      { pr: "https://github.com/acme/one/pull/2", outcome: "no-checks" },
      { pr: "https://github.com/acme/one/pull/5", outcome: "ready-missing-required" },
    ];
    expect(records[0]).toMatchObject({ action: "review", outcome: "completed", errors: 0, notes: 0, attention: expected, attentionOmitted: 0 });
    expect(records.at(-1)).toMatchObject({ action: "summary", outcome: "completed", attention: expected, attentionOmitted: 0 });
    expect(JSON.stringify(records)).not.toContain("secret-sentinel");
  });

  it("runs one review then run chain per repository, keeping failures isolated and reporting PRs", async () => {
    const calls = new Map<string, string[]>();
    const records: Readonly<Record<string, unknown>>[] = [];
    expect(await executeBatch(options, ["acme/one", "acme/two", "acme/three"], async (repo, action) => {
      calls.set(repo, [...(calls.get(repo) ?? []), action]);
      if (repo === "acme/one" && action === "review") throw new Error("secret-sentinel");
      if (repo === "acme/two") return { code: 0, report: { ...report, result: { outcome: "verification-failed", error: "secret-sentinel" } } };
      return { code: 0, report: { ...report, result: { pullRequest: `https://github.com/${repo}/pull/1`, notes: ["secret-sentinel"] } } };
    }, (record) => records.push(record))).toBe(1);
    for (const value of calls.values()) expect(value).toEqual(["review", "run"]);
    expect(records.at(-1)).toMatchObject({ action: "summary", commands: 6, failed: 3, outcome: "partial-failure", prs: ["https://github.com/acme/three/pull/1", "https://github.com/acme/one/pull/1"] });
    expect(JSON.stringify(records)).not.toContain("secret-sentinel");
  });

  it("counts coverage gaps, bump-it's listed and secure-it's counted, without their text", async () => {
    const records: Readonly<Record<string, unknown>>[] = [];
    expect(await executeBatch(options, ["acme/one", "acme/two"], async (repo, action) => {
      if (action === "review") return ok();
      return { code: 0, report: { ...report, totals: { gaps: ["cost-sentinel"] },
        result: repo === "acme/one" ? { outcome: "completed", gaps: ["secret-sentinel advisories unavailable", "another"] } : { outcome: "completed", gaps: 3 } } };
    }, (record) => records.push(record))).toBe(0);
    expect(records.filter((record) => record["action"] === "run").map((record) => [record["repo"], record["outcome"], record["gaps"]]))
      .toEqual(expect.arrayContaining([["acme/one", "completed", 2], ["acme/two", "completed", 3]]));
    expect(records.filter((record) => record["action"] === "review").every((record) => record["gaps"] === 0)).toBe(true);
    expect(records.at(-1)).toMatchObject({ action: "summary", outcome: "completed", gaps: 5 });
    expect(JSON.stringify(records)).not.toContain("sentinel");
  });

  it("counts only the result's own gaps, not a nested breakdown next to the total", async () => {
    const records: Readonly<Record<string, unknown>>[] = [];
    await executeBatch(options, ["acme/one"], async (_repo, action) => action === "review" ? ok()
      : { code: 0, report: { ...report, result: { outcome: "completed", gaps: 3, units: [{ topic: "routine", gaps: ["a", "b", "c"] }] } } },
    (record) => records.push(record));
    expect(records.find((record) => record["action"] === "run")).toMatchObject({ gaps: 3 });
    expect(records.at(-1)).toMatchObject({ action: "summary", gaps: 3 });
  });

  it("logs startup and invocation failures with their message for the person, never in the agent's output", async () => {
    const config = parseToolConfig("bump-it", "repos: [{repo: acme/one}]\nagent: {codingAgent: codex, model: sol, effort: medium}\ncommitIdentity: {name: Dev, email: dev@example.com}\n", "agent.yaml", "/home");
    const log = memoryLog();
    const lines: string[] = [];
    const machine = {
      release: vi.fn(async () => ({ tag: "v0.7.0", sha: "a".repeat(40), path: "/release" })), installation: vi.fn(async () => ({ path: "/config", config })),
      preflight: vi.fn(async () => { throw new Error("scanner-sentinel"); }), log: async () => log, invoke: vi.fn(async () => ok()),
    };
    expect(await batch({ ...options, release: "v0.7.0" }, (line) => lines.push(line), machine)).toBe(1);
    expect(log.entries).toEqual([{ event: "startup-failed", phase: "scanner", message: "scanner-sentinel" }]);
    expect(lines.join("")).not.toContain("scanner-sentinel");
    const invoked = memoryLog();
    const records: Readonly<Record<string, unknown>>[] = [];
    await executeBatch(options, ["acme/one"], async () => { throw new Error("spawn-sentinel"); }, (record) => records.push(record), invoked);
    expect(invoked.entries.filter((entry) => entry["event"] === "invoke-failed").map((entry) => entry["message"])).toEqual(["spawn-sentinel", "spawn-sentinel"]);
    expect(JSON.stringify(records)).not.toContain("spawn-sentinel");
    expect(records.at(-1)).not.toHaveProperty("logFailed");
  });

  it("fills, but never exceeds, eight parallel chains", async () => {
    const repos = Array.from({ length: 12 }, (_, index) => `acme/r${index}`);
    let running = 0;
    let peak = 0;
    const gates: Array<() => void> = [];
    let done = false;
    const execution = executeBatch(options, repos, async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise<void>((resolve) => gates.push(resolve));
      running--;
      return ok();
    }, () => {}).finally(() => { done = true; });
    while (!done) { gates.shift()?.(); await setImmediate(); }
    expect(await execution).toBe(0);
    expect(peak).toBe(8);
  });

  it("fails closed on absent reports, embedded failures, or lock refusal, and preserves unknown usage", async () => {
    const records: Readonly<Record<string, unknown>>[] = [];
    expect(await executeBatch(options, ["acme/one"], async () => ({ code: 75 }), (entry) => records.push(entry))).toBe(1);
    expect(records[0]).toMatchObject({ outcome: "error", estimatedApiCostUsd: null, exitCode: 75 });
    expect(records.at(-1)).toMatchObject({ commands: 2, failed: 2 });
  });

  it("stops scheduling and drains active commands if its output sink fails", async () => {
    const calls: string[] = [];
    await expect(executeBatch(options, Array.from({ length: 20 }, (_, index) => `acme/r${index}`), async (repo, action) => {
      calls.push(`${repo} ${action}`);
      return ok();
    }, () => { throw new Error("secret-sentinel"); })).rejects.toThrow(/^Batch output failed/);
    expect(calls).toHaveLength(8);
    expect(calls.every((call) => call.endsWith("review"))).toBe(true);
  });

  it("uses the installation's explicit config, preflights once, and never invokes unselected repositories", async () => {
    const config = parseToolConfig("bump-it", "repos: [{repo: acme/one}, {repo: acme/two}]\nagent: {codingAgent: codex, model: sol, effort: medium}\ncommitIdentity: {name: Dev, email: dev@example.com}\n", "agent.yaml", "/home");
    const release = { tag: "v0.7.0", sha: "a".repeat(40), path: "/release" };
    const machine = {
      release: vi.fn(async () => release), installation: vi.fn(async () => ({ path: "/config/acme/bump-it/agent.yaml", config })),
      preflight: vi.fn(async () => {}), log: async () => memoryLog(), invoke: vi.fn(async () => ok()),
    };
    const lines: string[] = [];
    expect(await batch({ ...options, release: release.tag, repo: "acme/one" }, (line) => lines.push(line), machine)).toBe(0);
    expect(machine.preflight).toHaveBeenCalledOnce();
    expect(machine.invoke.mock.calls).toEqual([
      [release, "/config/acme/bump-it/agent.yaml", "bump-it", "acme/one", "review", expect.any(Function)],
      [release, "/config/acme/bump-it/agent.yaml", "bump-it", "acme/one", "run", expect.any(Function)],
    ]);
    machine.invoke.mockClear();
    expect(await batch({ ...options, release: release.tag, repo: "acme/unselected" }, () => {}, machine)).toBe(1);
    expect(machine.invoke).not.toHaveBeenCalled();
    machine.preflight.mockRejectedValue(new Error("secret-sentinel"));
    const failed: string[] = [];
    expect(await batch({ ...options, release: release.tag }, (line) => failed.push(line), machine)).toBe(1);
    expect(JSON.parse(failed[0]!)).toMatchObject({ action: "summary", commands: 0, failed: 1 });
    expect(failed.join("")).not.toContain("secret-sentinel");
  });

  it("runs a release candidate only when every selected repository is a fixture", async () => {
    const config = parseToolConfig("bump-it", "repos: [{repo: acme/leanish-development_TEST_one}, {repo: acme/two}]\nagent: {codingAgent: codex, model: sol, effort: medium}\ncommitIdentity: {name: Dev, email: dev@example.com}\n", "agent.yaml", "/home");
    const release = { tag: "v0.7.0-rc.1", sha: "a".repeat(40), path: "/release" };
    const machine = {
      release: vi.fn(async () => release), installation: vi.fn(async () => ({ path: "/config/acme/bump-it/agent.yaml", config })),
      preflight: vi.fn(async () => {}), log: async () => memoryLog(), invoke: vi.fn(async () => ok()),
    };
    const lines: string[] = [];
    expect(await batch({ ...options, release: release.tag }, (line) => lines.push(line), machine)).toBe(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ action: "summary", outcome: "error", phase: "candidate-scope" });
    expect(machine.invoke).not.toHaveBeenCalled();
    expect(await batch({ ...options, release: release.tag, repo: "acme/leanish-development_TEST_one" }, () => {}, machine)).toBe(0);
    expect(machine.invoke.mock.calls.map((call) => call.slice(3, 5))).toEqual([["acme/leanish-development_TEST_one", "review"], ["acme/leanish-development_TEST_one", "run"]]);
  });

  it("invokes the release launcher with --config, ignores raw output, and strips ambient secrets and TOOL_CLI", async () => {
    root = await mkdtemp(join(tmpdir(), "setup-batch-"));
    await mkdir(join(root, "core/tool-runtime"), { recursive: true });
    const script = `#!/bin/bash\nif [ -n "\${GH_TOKEN:-}\${GITHUB_TOKEN:-}\${TOOL_CLI:-}" ]; then exit 9; fi\n[ "$1" = bump-it ] && [ "$2" = review ] && [ "$3" = acme/one ] && [ "$4" = --config ] && [ "$5" = '/a config/agent.yaml' ] || exit 8\nprintf '%s\\n' secret-sentinel '${JSON.stringify(report)}' >&2\n`;
    await writeFile(join(root, "core/tool-runtime/run.sh"), script);
    vi.stubEnv("GH_TOKEN", "secret-sentinel");
    vi.stubEnv("GITHUB_TOKEN", "secret-sentinel");
    vi.stubEnv("TOOL_CLI", "/not/the/installed/tool");
    const recorded: [string, string][] = [];
    const execution = await invokeTool({ tag: "v0.7.0", sha: "a".repeat(40), path: root }, "/a config/agent.yaml", "bump-it", "acme/one", "review", (stream, line) => recorded.push([stream, line]));
    expect(execution.code).toBe(0);
    expect(execution.report).toEqual(report);
    expect(JSON.stringify(execution)).not.toContain("secret-sentinel");
    // The person's log gets every line, raw output included.
    expect(recorded).toEqual([["stderr", "secret-sentinel"], ["stderr", JSON.stringify(report)]]);
  });

  it("logs a missing launcher's own error, while the command just fails", async () => {
    const recorded: string[] = [];
    const execution = await invokeTool({ tag: "v0.7.0", sha: "a".repeat(40), path: "/nonexistent-release" }, "/config", "bump-it", "acme/one", "run", (_stream, line) => recorded.push(line));
    expect(execution.code).not.toBe(0);
    expect(execution.report).toBeUndefined();
    expect(recorded.join("\n")).toMatch(/run\.sh|No such file/);
  });

  it("logs a very long child line cut to 100,000 characters, with how many it left out", async () => {
    root = await mkdtemp(join(tmpdir(), "setup-batch-"));
    await mkdir(join(root, "core/tool-runtime"), { recursive: true });
    await writeFile(join(root, "core/tool-runtime/run.sh"), `#!/bin/bash\nprintf 'x%.0s' $(seq 1 150000)\necho\n`);
    const recorded: string[] = [];
    await invokeTool({ tag: "v0.7.0", sha: "a".repeat(40), path: root }, "/config", "bump-it", "acme/one", "run", (_stream, line) => recorded.push(line));
    expect(recorded).toEqual([`${"x".repeat(100_000)} [50000 more characters not logged]`]);
  });

  it.each([
    ["configuration", "configuration: could not read or validate the installation"],
    ["release", "release: could not verify the installed release"],
    ["repository-selection", "repository-selection: no valid opted-in repository selected"],
    ["scanner", "scanner: could not initialize the pinned scanner"],
  ])("names a failed %s phase without forwarding raw errors", async (phase, reason) => {
    const config = parseToolConfig("bump-it", "repos: [{repo: acme/one}]\nagent: {codingAgent: codex, model: sol, effort: medium}\ncommitIdentity: {name: Dev, email: dev@example.com}\n", "agent.yaml", "/home");
    const machine = {
      release: vi.fn(async () => ({ tag: "v0.7.0", sha: "a".repeat(40), path: "/release" })),
      installation: vi.fn(async () => ({ path: "/config", config })),
      preflight: vi.fn(async () => {}), log: async () => memoryLog(), invoke: vi.fn(async () => ok()),
    };
    if (phase === "configuration") machine.installation.mockRejectedValue(new Error("secret-sentinel"));
    if (phase === "release") machine.release.mockRejectedValue(new Error("secret-sentinel"));
    if (phase === "scanner") machine.preflight.mockRejectedValue(new Error("secret-sentinel"));
    const lines: string[] = [];
    expect(await batch({ ...options, release: "v0.7.0", ...(phase === "repository-selection" ? { repo: "acme/unselected" } : {}) }, (line) => lines.push(line), machine)).toBe(1);
    expect(lines.map((line) => JSON.parse(line))).toEqual([expect.objectContaining({ phase, reason, commands: 0, failed: 1 })]);
    expect(lines.join("")).not.toContain("secret-sentinel");
    expect(machine.invoke).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform !== "darwin")("respects the real installed run.sh per-tool/repository lock", async () => {
    root = await mkdtemp(join(tmpdir(), "setup-lock-"));
    await mkdir(join(root, "core/tool-runtime"), { recursive: true });
    await mkdir(join(root, "bump-it/src"), { recursive: true });
    await copyFile(new URL("../../tool-runtime/run.sh", import.meta.url), join(root, "core/tool-runtime/run.sh"));
    const started = join(root, "started");
    const finish = join(root, "finish");
    await writeFile(join(root, "bump-it/src/cli.ts"), `import { existsSync, writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(started)}, 'started');\nwhile (!existsSync(${JSON.stringify(finish)})) await new Promise(done => setTimeout(done, 10));\nwriteFileSync(process.env.TOOL_REPORT_MARKER, 'reported');\nprocess.stderr.write(${JSON.stringify(JSON.stringify(report) + "\n")});\n`);
    vi.stubEnv("HOME", root);
    vi.stubEnv("XDG_STATE_HOME", join(root, "state"));
    const release = { tag: "v0.7.0", sha: "a".repeat(40), path: root };
    const first = invokeTool(release, "/config", "bump-it", "acme/one", "review");
    try {
      for (let attempt = 0; attempt < 200; attempt++) {
        try { await readFile(started); break; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
      }
      expect(await readFile(started, "utf8")).toBe("started");
      expect((await invokeTool(release, "/config", "bump-it", "acme/one", "run")).code).toBe(75);
    } finally { await writeFile(finish, "finish"); await first; }
  }, 15_000);
});
