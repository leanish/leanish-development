import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { WorkingCopy } from "@leanish/agent-runtime/types/working-copy";
import type { ToolRunContext } from "../src/command.ts";
import { parseToolConfig } from "../src/config.ts";
import { runSandboxed, sandboxWritable } from "../src/sandboxed.ts";

// A spy over the real `mkdtemp`, so a test can assert that nothing was made.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, mkdtemp: vi.fn(actual.mkdtemp) };
});

// Codex can apply its seatbelt here (not inside another sandbox, where `sandbox_apply` is refused).
const hasCodex = spawnSync("codex", ["sandbox", "--", "/usr/bin/true"], { stdio: "ignore" }).status === 0;
let root: string;
let workingCopy: WorkingCopy;
let secretDir: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "sandboxed-test-"));
  await mkdir(join(root, "wc"));
  await mkdir(join(root, "git"));
  secretDir = join(root, "private");
  await mkdir(secretDir);
  await writeFile(join(secretDir, "token.txt"), "not for the build");
  workingCopy = { projectId: "leanish/widget", path: join(root, "wc"), branch: "main", headSha: "a".repeat(40), gitDir: join(root, "git") };
});

afterAll(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

// A real `codex sandbox` (seatbelt on macOS): what a build run this way can and can't do.
describe.skipIf(!hasCodex || process.platform !== "darwin")("runSandboxed", () => {
  it("lets the command write in the working copy, but not read denied paths or see credential variables", async () => {
    process.env["SANDBOX_TEST_TOKEN"] = "leaked";
    try {
      const isolation = { readDenied: [secretDir], buildCacheRoot: join(root, "cache"), env: { GIT_CONFIG_GLOBAL: "/dev/null" } };
      await mkdir(join(root, "cache"));
      const result = await runSandboxed(isolation, {
        workingCopy,
        command: [
          "/bin/sh",
          "-c",
          `echo built > out.txt; cat "${join(secretDir, "token.txt")}" >/dev/null 2>&1; echo "denied=$?"; echo "token=\${SANDBOX_TEST_TOKEN:-none}"; echo "git=$GIT_CONFIG_GLOBAL"`,
        ],
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("denied=1");
      expect(result.stdout).toContain("token=none");
      expect(result.stdout).toContain("git=/dev/null");
      expect(await readFile(join(workingCopy.path, "out.txt"), "utf8")).toBe("built\n");
    } finally {
      delete process.env["SANDBOX_TEST_TOKEN"];
    }
  }, 30_000);
});

describe("runSandboxed arguments", () => {
  it("runs codex sandbox with the write profile and the command after --, in the working copy", async () => {
    const calls: Array<{ command: string; args: ReadonlyArray<string>; cwd: string | undefined; env: NodeJS.ProcessEnv | undefined }> = [];
    await runSandboxed({ readDenied: ["/Users/dev/.ssh"], buildCacheRoot: "/cache", env: {} }, { workingCopy, command: ["./gradlew", "--version"] }, async (command, args, options) => {
      calls.push({ command, args, cwd: options?.cwd, env: options?.env });
      return { code: 0, stdout: "", stderr: "" };
    });
    expect(calls[0]?.env?.["GRADLE_USER_HOME"]).toBe("/cache/gradle");
    expect(calls[0]?.env?.["npm_config_cache"]).toBe("/cache/npm");
    expect(calls[0]?.command).toBe("codex");
    expect(calls[0]?.args[0]).toBe("sandbox");
    expect(calls[0]?.args.slice(-3)).toEqual(["--", "./gradlew", "--version"]);
    expect(calls[0]?.args.join(" ")).toContain('"/Users/dev/.ssh"="deny"');
    expect(calls[0]?.args.join(" ")).toContain("network.enabled=true");
    expect(calls[0]?.cwd).toBe(workingCopy.path);
    await expect(runSandboxed({ readDenied: [], buildCacheRoot: "/cache", env: {} }, { workingCopy: { ...workingCopy, gitDir: undefined }, command: ["true"] })).rejects.toThrow("separate directory");
  });
});

describe("isolation policy validation", () => {
  // Hand-built policies (or plain JavaScript) can hold what the type forbids; the casts stand in for such a caller.
  const INVALID_POLICIES: ReadonlyArray<[string, Record<string, unknown>, string]> = [
    ["an absent buildCacheRoot", { readDenied: [], env: {} }, "buildCacheRoot must be an absolute path; got 'undefined'"],
    ["an empty buildCacheRoot", { readDenied: [], env: {}, buildCacheRoot: "" }, "buildCacheRoot must be an absolute path; got ''"],
    ["a relative buildCacheRoot", { readDenied: [], env: {}, buildCacheRoot: "cache" }, "buildCacheRoot must be an absolute path; got 'cache'"],
    ["a relative readDenied entry", { readDenied: ["secrets"], env: {}, buildCacheRoot: "/cache" }, "readDenied entries must be absolute paths; got 'secrets'"],
    ["an undefined readDenied entry", { readDenied: [undefined], env: {}, buildCacheRoot: "/cache" }, "readDenied entries must be absolute paths; got 'undefined'"],
  ];

  it.each(INVALID_POLICIES)("runSandboxed refuses %s before making a temp dir or starting a process", async (_name, policy, message) => {
    vi.mocked(mkdtemp).mockClear();
    let spawned = 0;
    await expect(runSandboxed(policy as unknown as Parameters<typeof runSandboxed>[0], { workingCopy, command: ["true"] }, async () => {
      spawned += 1;
      return { code: 0, stdout: "", stderr: "" };
    })).rejects.toThrow(`runSandboxed: ${message}`);
    expect(spawned).toBe(0);
    expect(mkdtemp).not.toHaveBeenCalled();
  });

  it.each(INVALID_POLICIES)("sandboxWritable refuses %s", (_name, policy, message) => {
    const config = parseToolConfig("bump-it", `repos: [{ repo: leanish/widget }]
agent: { codingAgent: codex, model: sol, effort: medium }
commitIdentity: { name: tool, email: tool@example.com }
dirs: { state: /state, cache: /cache }`, "test.yaml");
    const isolation = policy as unknown as ToolRunContext["isolation"];
    expect(() => sandboxWritable({ config, workingCopy, isolation })).toThrow(`sandboxWritable: ${message}`);
  });
});

describe("sandboxWritable", () => {
  it("includes the same roots, the build cache too, for gates and parsers", () => {
    const config = parseToolConfig("bump-it", `repos: [{ repo: leanish/widget }]
agent: { codingAgent: codex, model: sol, effort: medium }
commitIdentity: { name: tool, email: tool@example.com }
dirs: { state: /state, cache: /cache }`, "test.yaml");
    expect(sandboxWritable({ config, workingCopy, isolation: { readDenied: [], env: {}, buildCacheRoot: "/build-cache" } }))
      .toEqual(["/cache", workingCopy.path, tmpdir(), "/tmp", "/build-cache"]);
  });
});
