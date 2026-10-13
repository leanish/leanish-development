import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const exec = promisify(execFile);
const SCRIPT = new URL("../scripts/install-osv-scanner.sh", import.meta.url);
const pinned = `${process.platform}/${process.arch}` === "darwin/arm64" || `${process.platform}/${process.arch}` === "linux/x64";
const BINARY = "fake osv-scanner\n";

/**
 * The installer in a scratch copy of its package: a tools.json pinning `pinnedSha` for both platforms, and a `curl`
 * on PATH that writes `content` to its `-o` file after a short pause (so concurrent installs overlap).
 */
async function sandbox(content: string, pinnedSha = createHash("sha256").update(BINARY).digest("hex")) {
  const root = await mkdtemp(join(tmpdir(), "osv-installer-"));
  await mkdir(join(root, "scripts"));
  await mkdir(join(root, "bin"));
  await copyFile(SCRIPT, join(root, "scripts", "install-osv-scanner.sh"));
  await writeFile(join(root, "tools.json"), JSON.stringify({ "osv-scanner": { version: "2.6.0", sha256: { linux_amd64: pinnedSha, darwin_arm64: pinnedSha } } }));
  const curl = join(root, "bin", "curl");
  await writeFile(curl, `#!/bin/bash\nwhile [ $# -gt 0 ]; do [ "$1" = "-o" ] && out=$2; shift; done\nsleep 0.2\nprintf '%s' '${content.replace(/'/g, "")}' > "$out"\n`);
  await chmod(curl, 0o755);
  const install = (dest: string) =>
    exec("bash", [join(root, "scripts", "install-osv-scanner.sh"), dest], { env: { ...process.env, PATH: `${join(root, "bin")}:${process.env["PATH"]}` } });
  return { root, install };
}

describe.skipIf(!pinned)("install-osv-scanner.sh", () => {
  it("installs once per destination even when several installs run at the same time", async () => {
    const { root, install } = await sandbox(BINARY);
    const dest = join(root, "tools");
    const results = await Promise.all(Array.from({ length: 6 }, () => install(dest)));
    for (const result of results) expect(result.stdout.trim()).toBe(join(dest, "osv-scanner"));
    expect(await readFile(join(dest, "osv-scanner"), "utf8")).toBe(BINARY);
    expect((await stat(join(dest, "osv-scanner"))).mode & 0o111).not.toBe(0);
    // No download is left behind.
    expect(await readdir(dest)).toEqual(["osv-scanner"]);
  });

  it("refuses a download that doesn't match the pinned sha256, leaving nothing", async () => {
    const { root, install } = await sandbox("tampered\n");
    const dest = join(root, "tools");
    await expect(install(dest)).rejects.toMatchObject({ stderr: expect.stringContaining("expected") });
    expect(await readdir(dest)).toEqual([]);
  });
});
