// Copied from leanish/leanish-development core/runtime/test/unit/spawn-capture-env.test.ts at c6282df; see PROVENANCE.md.
// Local changes: imports this package's modules from `../src/` instead of `../../src/`; the per-line stdout callback is covered.
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  MIN_LINE_CAP,
  SCRUBBED_AWS_ENV_VARS,
  scrubbedProcessEnv,
  spawnCapture,
} from "../src/skill/spawn-capture.ts";

/**
 * Fake binary that prints selected env vars, so we can assert what the
 * subprocess actually saw: the AWS credential scrub, the per-invocation
 * merge, and the secret redaction of captured output.
 */
let envEchoBin: string;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "spawn-capture-env-"));
  envEchoBin = join(dir, "env-echo");
  await writeFile(
    envEchoBin,
    `#!/bin/sh
echo "AWS_ACCESS_KEY_ID=[$AWS_ACCESS_KEY_ID]"
echo "AWS_PROFILE=[$AWS_PROFILE]"
echo "MY_TOKEN=[$MY_TOKEN]"
echo "KEPT_VAR=[$KEPT_VAR]"
`,
  );
  await chmod(envEchoBin, 0o755);
});

const TOUCHED = ["AWS_ACCESS_KEY_ID", "AWS_PROFILE", "KEPT_VAR"] as const;
const saved = new Map<string, string | undefined>();

function setProcessEnv(name: string, value: string): void {
  if (!saved.has(name)) saved.set(name, process.env[name]);
  process.env[name] = value;
}

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
});

function capture(env: Record<string, string>, secrets?: { name: string; value: string }[]) {
  return spawnCapture({
    bin: envEchoBin,
    args: [],
    cwd: tmpdir(),
    env,
    timeoutMs: 10_000,
    captureCapBytes: 1024 * 1024,
    label: "EnvEchoTest",
    ...(secrets !== undefined ? { secrets } : {}),
  });
}

describe("spawnCapture subprocess env", () => {
  it("scrubs AWS credential vars from the inherited base", async () => {
    for (const name of TOUCHED) setProcessEnv(name, `leak-${name}`);
    const result = await capture({});
    expect(result.responseText).toContain("AWS_ACCESS_KEY_ID=[]");
    expect(result.responseText).toContain("AWS_PROFILE=[]");
    // Non-credential vars still inherit.
    expect(result.responseText).toContain("KEPT_VAR=[leak-KEPT_VAR]");
  });

  it("lets explicit options.env re-add scrubbed vars (deliberate operator override)", async () => {
    setProcessEnv("AWS_ACCESS_KEY_ID", "ambient");
    const result = await capture({ AWS_ACCESS_KEY_ID: "deliberate" });
    expect(result.responseText).toContain("AWS_ACCESS_KEY_ID=[deliberate]");
  });

  it("redacts secret values from captured stdout", async () => {
    const result = await capture({ MY_TOKEN: "s3cr3t-value" }, [
      { name: "MY_TOKEN", value: "s3cr3t-value" },
    ]);
    expect(result.responseText).toContain("MY_TOKEN=[<redacted:MY_TOKEN>]");
    expect(result.responseText).not.toContain("s3cr3t-value");
  });

  it("scrubbedProcessEnv removes exactly the documented set", () => {
    for (const name of SCRUBBED_AWS_ENV_VARS) setProcessEnv(name, "x");
    const env = scrubbedProcessEnv();
    for (const name of SCRUBBED_AWS_ENV_VARS) {
      expect(env[name]).toBeUndefined();
    }
  });
});

describe("spawnCapture timeout", () => {
  it("rejects once the process has exited, even while a grandchild holds its pipes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spawn-capture-timeout-"));
    const pidFile = join(dir, "pid");
    const started = Date.now();

    // Checked in the rejection handler itself, before anything else can run:
    // a killed child that hasn't been reaped yet would still answer signal 0.
    const outcome = await spawnCapture({
      bin: "/bin/sh",
      // The background sleep inherits stdout and outlives its killed parent.
      args: ["-c", `echo $$ > "${pidFile}"; sleep 3 & sleep 30`],
      cwd: dir,
      env: {},
      timeoutMs: 300,
      captureCapBytes: 1024,
      label: "test",
    }).then(
      () => ({ message: "resolved", stillRunning: true }),
      (err: Error) => ({ message: err.message, stillRunning: isRunning(Number(readFileSync(pidFile, "utf8"))) }),
    );

    expect(outcome).toEqual({ message: "test: '/bin/sh' did not return within 300ms", stillRunning: false });
    expect(Date.now() - started).toBeLessThan(2500);
  });

  // Each command below leaves a background job that would touch `marker` 1s later; none may get there.
  async function leavesNoBackgroundWork(script: string, timeoutMs: number): Promise<{ settled: string; marker: boolean }> {
    const dir = await mkdtemp(join(tmpdir(), "spawn-capture-group-"));
    const marker = join(dir, "marker");
    const settled = await spawnCapture({
      bin: "/bin/sh",
      args: ["-c", script.replaceAll("MARKER", `"${marker}"`)],
      cwd: dir,
      env: {},
      timeoutMs,
      captureCapBytes: 1024,
      label: "test",
    }).then(
      (result) => `resolved ${result.responseText.trim()}`,
      (err: Error) => err.message,
    );
    await new Promise((done) => setTimeout(done, 1500));
    return { settled, marker: existsSync(marker) };
  }

  it("kills the commands a timed-out CLI started, not just the CLI", async () => {
    expect(await leavesNoBackgroundWork("(sleep 1; touch MARKER) & sleep 30", 300)).toEqual({
      settled: "test: '/bin/sh' did not return within 300ms",
      marker: false,
    });
  }, 15_000);

  it("kills a job the CLI orphaned that still holds its pipes", async () => {
    expect(await leavesNoBackgroundWork("(sleep 1; touch MARKER) & exit 0", 300)).toEqual({
      settled: "test: '/bin/sh' did not return within 300ms",
      marker: false,
    });
  }, 15_000);

  it("kills a background job a successful CLI left behind", async () => {
    expect(await leavesNoBackgroundWork("(sleep 1; touch MARKER) >/dev/null 2>&1 & echo done", 10_000)).toEqual({
      settled: "resolved done",
      marker: false,
    });
  }, 15_000);
});

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("spawnCapture's stdout lines", () => {
  it("hands every stdout line to onStdoutLine as it arrives, redacted, also when the run then fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spawn-capture-lines-"));
    const bin = join(dir, "lines");
    // Lines split across writes, a secret, and a last line without a newline before a failing exit.
    await writeFile(bin, "#!/bin/sh\nprintf 'one\\ntw'\nsleep 0.1\nprintf 'o tok-123\\nthree'\nexit 3\n");
    await chmod(bin, 0o755);
    const lines: string[] = [];
    await expect(spawnCapture({
      bin, args: [], cwd: dir, env: {}, timeoutMs: 10_000, captureCapBytes: 4, label: "Test",
      secrets: [{ name: "TOKEN", value: "tok-123" }],
      onStdoutLine: (line) => lines.push(line),
    })).rejects.toThrow(/exited with code 3/);
    expect(lines).toEqual(["one", "two <redacted:TOKEN>", "three"]);
  });

  it("decodes characters split across reads and cuts a runaway line short, dropping its rest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spawn-capture-long-"));
    const bin = join(dir, "long");
    // "é" is 0xc3 0xa9: the first byte ends one write, the second starts the next. Then a line over the line cap.
    await writeFile(bin, `#!/bin/sh\nprintf 'caf\\303'\nsleep 0.1\nprintf '\\251\\n'\nhead -c ${MIN_LINE_CAP + 10} /dev/zero | tr '\\0' x\nprintf '\\nnext\\n'\n`);
    await chmod(bin, 0o755);
    const lines: string[] = [];
    await spawnCapture({ bin, args: [], cwd: dir, env: {}, timeoutMs: 10_000, captureCapBytes: 4, label: "Test", onStdoutLine: (line) => lines.push(line) });
    expect(lines.map((line) => (line.length > 20 ? `x*${line.length}` : line))).toEqual(["café", `x*${MIN_LINE_CAP}`, "next"]);
  });
});
