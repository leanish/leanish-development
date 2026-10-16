import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { WorkingCopy } from "@leanish/agent-runtime/types/working-copy";
import { defaultDeps } from "../src/deps.ts";
import { WRAPPER_JAR } from "../src/gradle-wrapper.ts";
import { SkillLoader } from "@leanish/agent-runtime/skill/skill-loader";
import { SchemaValidator } from "@leanish/agent-runtime/skill/validator";
import { filePriority } from "../src/priority.ts";
import { assertLocalFile, writeLocalFile } from "../src/files.ts";

const dirs: string[] = [];
// Under the temp dir, not the package: a sandbox may refuse the `.git/hooks` a test's `git init` writes inside the repository.
const temp = async () => { const dir = await mkdtemp(join(tmpdir(), "bump-test-")); dirs.push(dir); return dir; };
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
describe("tool boundaries", () => {
  it("loads a write-capable skill with strict input and output schemas", async () => {
    const skill = await new SkillLoader({ skillsDirs: [fileURLToPath(new URL("../skills", import.meta.url))] }).loadEntrypoint("bump-it");
    expect(skill.inputSchema).toMatchObject({ additionalProperties: false, required: ["repo", "mode", "today", "kind", "moves", "toolWritten"] });
    expect(skill.inputSchema).toMatchObject({ properties: { moves: { items: { properties: {
      ecosystem: { enum: expect.arrayContaining(["Gradle Wrapper"]) },
      mechanism: { enum: expect.arrayContaining(["gradle-wrapper"]) },
      wrapper: { additionalProperties: false, required: ["distributionUrl", "distributionSha256", "jarSha256"] },
    } } } } });
    expect(skill.body).toContain("Never touch wrapper files");
    expect(skill.body).toContain("Do not run the wrapper task");
    expect(skill.outputSchema).toMatchObject({ additionalProperties: false });
    expect(skill.compatibleCodingAgents).toEqual(["codex", "claude-code"]);
  });
  it("accepts explicit reconciliation context without relaxing the skill's input schema", async () => {
    const skill = await new SkillLoader({ skillsDirs: [fileURLToPath(new URL("../skills", import.meta.url))] }).loadEntrypoint("bump-it");
    const validator = new SchemaValidator();
    const input = { repo: "acme/widget", mode: "apply", today: "2026-10-16", kind: "major", moves: [], toolWritten: [] };
    const reconciliation = { baseSha: "a".repeat(40), revertedFiles: ["README.md"] };
    expect(validator.validate(skill.inputSchema!, input)).toEqual([]);
    expect(validator.validate(skill.inputSchema!, { ...input, reconciliation })).toEqual([]);
    for (const invalid of [{ baseSha: reconciliation.baseSha }, { revertedFiles: [] }, { ...reconciliation, baseSha: "main" }, { ...reconciliation, revertedFiles: [1] }, { ...reconciliation, allowUnrelatedChanges: true }]) {
      expect(validator.validate(skill.inputSchema!, { ...input, reconciliation: invalid })).not.toEqual([]);
    }
    expect(validator.validate(skill.inputSchema!, { ...input, allowUnrelatedChanges: true })).not.toEqual([]);
  });
  it("reads the wrapper as committed in the snapshot, jar as binary, refusing a linked file; restores from base safely", async () => {
    const root = await temp();
    await mkdir(join(root, "gradle", "wrapper"), { recursive: true });
    const bytes = Buffer.from([0x50, 0x4b, 0xff, 0x00, 0xfe, 0x80]);
    await writeFile(join(root, WRAPPER_JAR), bytes);
    await writeFile(join(root, "gradle", "wrapper", "gradle-wrapper.properties"), "distributionUrl=x\n");
    await writeFile(join(root, "gradlew"), "#!/bin/sh\n");
    await chmod(join(root, "gradlew"), 0o755);
    await writeFile(join(root, "gradlew.bat"), "@rem\n");
    const wc: WorkingCopy = { projectId: "acme/widget", path: root, gitDir: join(root, ".git"), headSha: "a".repeat(40), branch: "main" };
    const deps = defaultDeps();
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    git("init", "--quiet");
    git("add", "--all");
    git("-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "fixture");
    const base = git("rev-parse", "HEAD");
    // The working tree changing afterwards doesn't change what the snapshot holds.
    await writeFile(join(root, WRAPPER_JAR), "corrupted jar");
    const read = await deps.wrapperAt(wc, base);
    expect(read.jarSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(read.files.find((file) => file.path === "gradlew")?.executable).toBe(true);
    await deps.restoreWrapperFile(wc, base, WRAPPER_JAR);
    expect(await readFile(join(root, WRAPPER_JAR))).toEqual(bytes);
    await expect(deps.restoreWrapperFile(wc, base, "../outside")).rejects.toThrow("invalid wrapper restore");
    await rm(join(root, WRAPPER_JAR));
    await symlink(join(root, "gradlew.bat"), join(root, WRAPPER_JAR));
    git("add", "--all");
    git("-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "linked jar");
    await expect(deps.wrapperAt(wc, git("rev-parse", "HEAD"))).rejects.toThrow("regular file");
  });
  it("keeps deferred priorities through a file round trip, treating corrupt state as an error", async () => {
    const dir = await temp();
    const queue = filePriority(dir, "acme/widget");
    expect(await queue.read()).toEqual([]);
    await queue.write(["npm|a", "npm|b", "npm|a"]);
    expect(await filePriority(dir, "acme/widget").read()).toEqual(["npm|a", "npm|b"]);
    await writeFile(join(dir, "deferred", "acme__widget.json"), "{}");
    await expect(queue.read()).rejects.toThrow("deferred-major list");
  });
  it("refuses symlink writes outside the copy and traversal, leaving the target intact", async () => {
    const root = await temp(); const outside = await temp();
    await writeFile(join(outside, "package.json"), "private");
    await symlink(join(outside, "package.json"), join(root, "package.json"));
    await expect(writeLocalFile(root, "package.json", "changed")).rejects.toThrow("regular file");
    await symlink(outside, join(root, "alias"));
    await expect(assertLocalFile(root, "alias/package.json")).rejects.toThrow("outside");
    await expect(assertLocalFile(root, "../package.json")).rejects.toThrow("unsafe");
    expect(await readFile(join(outside, "package.json"), "utf8")).toBe("private");
  });
});
