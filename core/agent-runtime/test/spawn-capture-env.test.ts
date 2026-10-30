// Copied from leanish/leanish-development core/runtime/test/unit/spawn-capture-env.test.ts at c6282df; see PROVENANCE.md.
// Local changes: imports from `../src/`; the per-line stdout callback is covered; timeout tests synchronize startup and assert process state.
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

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
  async function captureGroup(script: string, timeoutMs: number, triggerTimeout: boolean) {
    const ready = Promise.withResolvers<number>();
    let pid: number | undefined;
    // Start the timeout only after the shell acknowledges startup. Real process
    // events still run; a loaded machine cannot spend the deadline on startup.
    if (triggerTimeout) vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const inspect = (settled: string) => {
      if (pid === undefined) throw new Error(`CLI settled before acknowledging startup: ${settled}`);
      // Inspect in the settlement handler: later checks could hide early rejection.
      return { settled, cliRunning: isRunning(pid), groupRunning: isRunning(-pid) };
    };
    const outcome = spawnCapture({
      bin: "/bin/sh",
      args: ["-c", script],
      cwd: tmpdir(),
      env: {},
      timeoutMs,
      captureCapBytes: 1024,
      label: "test",
      onStdoutLine: (line) => {
        if (!line.startsWith("ready:")) return;
        pid = Number(line.slice("ready:".length));
        ready.resolve(pid);
      },
    }).then(
      (result) => inspect(`resolved ${result.responseText.replace(/^ready:\d+\n/, "").trim()}`),
      (err: Error) => inspect(err.message),
    );
    // Propagate spawn/startup failures to the readiness wait as well.
    void outcome.catch((err: unknown) => ready.reject(err));
    try {
      await ready.promise;
      if (triggerTimeout) vi.advanceTimersByTime(timeoutMs);
    } finally {
      // Group cleanup's polling runs on real time after triggering the deadline.
      if (triggerTimeout) vi.useRealTimers();
    }
    return outcome;
  }

  it("reaps a timed-out CLI before rejecting", async () => {
    // This is an exit-ordering assertion, not a latency bound: scheduling and
    // waiting for the killed group can legitimately exceed the old 2.5s limit.
    expect(await captureGroup("echo ready:$$; exec sleep 30", 300, true)).toEqual({
      settled: "test: '/bin/sh' did not return within 300ms",
      cliRunning: false,
      groupRunning: false,
    });
  }, 15_000);

  // Check the group at settlement instead of a delayed marker: SIGKILL may
  // reach a background sleep before its shell, letting that shell briefly run
  // its next command during termination. The contract is no work AFTER settling.
  it("kills the commands a timed-out CLI started, not just the CLI", async () => {
    expect(await captureGroup("sleep 30 & echo ready:$$; wait", 300, true)).toEqual({
      settled: "test: '/bin/sh' did not return within 300ms",
      cliRunning: false,
      groupRunning: false,
    });
  }, 15_000);

  it("kills a job the CLI orphaned that still holds its pipes", async () => {
    expect(await captureGroup("sleep 30 & echo ready:$$; exit 0", 300, true)).toEqual({
      settled: "test: '/bin/sh' did not return within 300ms",
      cliRunning: false,
      groupRunning: false,
    });
  }, 15_000);

  it("kills a background job a successful CLI left behind", async () => {
    expect(await captureGroup("sleep 30 >/dev/null 2>&1 & echo ready:$$; echo done", 10_000, false)).toEqual({
      settled: "resolved done",
      cliRunning: false,
      groupRunning: false,
    });
  }, 15_000);
});

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // Like killGroup: macOS reports EPERM for a group containing only zombies.
    if (code === "ESRCH" || (pid < 0 && code === "EPERM")) return false;
    throw err;
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
