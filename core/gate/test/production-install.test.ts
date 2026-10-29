import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const repository = fileURLToPath(new URL("../../..", import.meta.url));
let installRoot: string | undefined;

afterEach(async () => {
  if (installRoot !== undefined) await rm(installRoot, { recursive: true, force: true });
  installRoot = undefined;
});

/** A lockfile path in a workspace other than core/gate (the workspace itself or anything npm nests under it). */
function otherWorkspace(path: string): boolean {
  const segments = path.split("/");
  const workspace = segments[0] === "core" ? segments.slice(0, 2).join("/") : segments[0]!;
  return (segments[0] === "core" || workspace === "bump-it" || workspace === "secure-it") && workspace !== "core/gate";
}

describe("which lockfile entries the production install drops", () => {
  it("drops the other workspaces and what's nested under them, keeping what's nested under core/gate", () => {
    expect(["core/agent-runtime", "core/agent-runtime/node_modules/ajv", "bump-it", "bump-it/node_modules/x", "secure-it"].every(otherWorkspace)).toBe(true);
    expect(["core/gate", "core/gate/node_modules/ajv", "node_modules/ajv", ""].some(otherWorkspace)).toBe(false);
  });
});

describe("CI production install", () => {
  it("runs the CLI with only its production workspace dependencies", async () => {
    installRoot = await mkdtemp(join(tmpdir(), "supply-chain-ci-production-"));
    const packageDirectory = join(installRoot, "core", "gate");
    await mkdir(packageDirectory, { recursive: true });

    const rootManifest = JSON.parse(await readFile(join(repository, "package.json"), "utf8")) as {
      workspaces: string[];
    };
    rootManifest.workspaces = ["core/gate"];
    await writeFile(join(installRoot, "package.json"), `${JSON.stringify(rootManifest, null, 2)}\n`);

    const lockfile = JSON.parse(await readFile(join(repository, "package-lock.json"), "utf8")) as {
      packages: Record<string, { workspaces?: string[] } | undefined>;
    };
    const ciLockEntry = lockfile.packages["core/gate"] as { dependencies?: Record<string, string> } | undefined;
    expect(ciLockEntry?.dependencies?.semver).toBe("^7.8.5");
    lockfile.packages[""]!.workspaces = ["core/gate"];
    for (const path of Object.keys(lockfile.packages)) {
      // Drop the other workspaces and what npm nests under them, but keep what it nests under core/gate: a dependency
      // npm can't hoist to the root (an ajv 8 next to eslint's ajv 6) lives at core/gate/node_modules/.
      if (otherWorkspace(path)) delete lockfile.packages[path];
      if (path.startsWith("node_modules/@leanish/") && path !== "node_modules/@leanish/gate") {
        delete lockfile.packages[path];
      }
    }
    await writeFile(join(installRoot, "package-lock.json"), `${JSON.stringify(lockfile, null, 2)}\n`);

    await cp(join(repository, "core/gate/package.json"), join(packageDirectory, "package.json"));
    await cp(join(repository, "core/gate/src"), join(packageDirectory, "src"), { recursive: true });

    const install = spawnSync("npm", ["ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--omit=dev", "--workspace", "core/gate"], {
      cwd: installRoot,
      encoding: "utf8",
    });
    expect(install.status, `${install.stdout}\n${install.stderr}`).toBe(0);

    const installedWorkspaces = await readdir(join(installRoot, "node_modules", "@leanish"));
    expect(installedWorkspaces).toEqual(["gate"]);
    for (const dependency of ["semver", "yaml"]) {
      const resolved = spawnSync(process.execPath, ["-p", `require.resolve(${JSON.stringify(dependency)})`], {
        cwd: packageDirectory,
        encoding: "utf8",
      });
      expect(resolved.status, resolved.stderr).toBe(0);
      const pathFromInstall = relative(await realpath(installRoot), await realpath(resolved.stdout.trim()));
      expect(pathFromInstall.startsWith(`..${sep}`), `${dependency} resolved outside ${installRoot}: ${resolved.stdout.trim()}`).toBe(false);
    }

    const cli = spawnSync(process.execPath, ["src/cli.ts", "--help"], {
      cwd: packageDirectory,
      encoding: "utf8",
    });
    expect(cli.status).toBe(2);
    expect(`${cli.stdout}\n${cli.stderr}`).toContain("usage:");
  });
});
