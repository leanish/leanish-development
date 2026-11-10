import { describe, expect, it } from "vitest";

import type { GateEnvironment } from "@leanish/gate/gate";
import type { Tree } from "@leanish/gate/tree";

import type { BumpItDeps } from "../src/deps.ts";
import { type Computed, type Execution, verify } from "../src/operations.ts";
import type { VerifyInputs } from "../src/verify.ts";

const EXCEPTIONS = ".github/supply-chain-exceptions.json";

const tree = (id: string, files: Record<string, string>): Tree => ({
  id, read: async (path) => files[path], list: async (dir) => Object.keys(files).filter((path) => path.startsWith(`${dir}/`)),
});

const lock = (version: string) => JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "app" }, "node_modules/lib": { version, resolved: `https://registry.npmjs.org/lib/-/lib-${version}.tgz`, integrity: "sha512-AAAA" } } });
const exceptions = (...versions: string[]) =>
  `${JSON.stringify({ vulnerabilities: versions.map((version) => ({ id: `GHSA-${version}`, package: "lib", version, paths: ["node_modules/lib"], reason: "reviewed", expires: "2026-12-31" })) }, null, 2)}\n`;

const ENV: GateEnvironment = {
  run: async () => { throw new Error("no process expected"); },
  fetch: async (url) => { throw new Error(`no request expected: ${String(url)}`); },
  now: () => new Date("2026-11-10T12:00:00Z"),
  osvScanner: "osv-scanner",
  githubToken: undefined,
};

/** The routine's edit already in the working copy; verification captures what it was handed. */
function run(working: Record<string, string>) {
  const base = tree("base", { "package-lock.json": lock("1.0.0"), [EXCEPTIONS]: exceptions("1.0.0", "0.9.0") });
  const files = { ...working };
  let snapshots = 0;
  const handed: VerifyInputs[] = [];
  const deps = {
    snapshot: async () => `snapshot-${++snapshots}`,
    trees: { commit: async (_wc: unknown, sha: string) => tree(sha, { ...files }), working: () => tree("worktree", files) },
    writeFile: async (_wc: unknown, path: string, content: string) => { files[path] = content; },
    changedBetween: async () => Object.keys(files).filter((path) => files[path] !== undefined),
    linkProblems: async () => [],
    wrapperAt: async () => undefined,
    verify: async (inputs: VerifyInputs) => { handed.push(inputs); return []; },
  } as unknown as BumpItDeps;
  const execution = {
    context: { workingCopy: { path: "/synthetic" } },
    deps,
    env: ENV,
    inventories: { ofCommit: async () => undefined },
  } as unknown as Execution;
  const computed = { plan: { kind: "routine", topic: "lib", moves: [] }, files: new Map(), base, gradle: undefined } as unknown as Computed;
  return { verified: async () => { await verify(execution, computed, ["package-lock.json"]); return handed[0]!; }, files, snapshots: () => snapshots };
}

describe("verify, with the exceptions an edit leaves unused", () => {
  it("removes them first, verifies the cleaned snapshot, and counts the file among what the tool wrote", async () => {
    const edit = run({ "package-lock.json": lock("1.0.1"), [EXCEPTIONS]: exceptions("1.0.0", "0.9.0") });
    const inputs = await edit.verified();
    // lib@0.9.0's entry was already unused in the base: only the one the routine made unused goes.
    expect(edit.files[EXCEPTIONS]).toBe(exceptions("0.9.0"));
    expect(await inputs.head.read(EXCEPTIONS)).toBe(exceptions("0.9.0"));
    expect(edit.snapshots()).toBe(2);
    expect(inputs.toolWritten).toEqual(["package-lock.json", EXCEPTIONS]);
  });

  it("leaves the file, and what the tool wrote, alone when nothing became unused", async () => {
    const edit = run({ "package-lock.json": lock("1.0.0"), [EXCEPTIONS]: exceptions("1.0.0", "0.9.0") });
    const inputs = await edit.verified();
    expect(edit.files[EXCEPTIONS]).toBe(exceptions("1.0.0", "0.9.0"));
    expect(edit.snapshots()).toBe(1);
    expect(inputs.toolWritten).toEqual(["package-lock.json"]);
  });

  it("recomputes whatever a merge left in the file over the base", async () => {
    // A merge kept another text: the cleanup over the base replaces it.
    const kept = run({ "package-lock.json": lock("1.0.1"), [EXCEPTIONS]: exceptions("1.0.0") });
    await kept.verified();
    expect(kept.files[EXCEPTIONS]).toBe(exceptions("0.9.0"));
    expect(kept.snapshots()).toBe(2);
    // An earlier cleanup the head no longer justifies goes back to the base's file, which the tool then didn't change.
    const stale = run({ "package-lock.json": lock("1.0.0"), [EXCEPTIONS]: exceptions("0.9.0") });
    const inputs = await stale.verified();
    expect(stale.files[EXCEPTIONS]).toBe(exceptions("1.0.0", "0.9.0"));
    expect(inputs.toolWritten).toEqual(["package-lock.json"]);
  });
});
