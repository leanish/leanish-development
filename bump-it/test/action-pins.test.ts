import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import type { Tree } from "@leanish/gate/tree";
import { plannedPinsLanded } from "../src/action-pins.ts";
import { writePins } from "../src/operations.ts";
import type { PlannedMove } from "../src/plan.ts";
const file = ".github/workflows/ci.yml";
const tree = (text: string): Tree => ({ id: "tree", read: async (path) => path === file ? text : undefined, list: async (dir) => file.startsWith(`${dir}/`) ? [file] : [] });
const workflow = (uses: ReadonlyArray<[string, string]>) => `on: push\njobs:\n  build:\n    steps:\n${uses.map(([sha, tag]) => `      - uses: actions/checkout@${sha.repeat(40)} # ${tag}`).join("\n")}\n`;
const move = (from: string, to: string, sha: string): PlannedMove => ({ ecosystem: "GitHub Actions", mechanism: "action-pin", name: "actions/checkout", from, to, commitSha: sha.repeat(40), locations: [file], declarations: [], major: false });
describe("action source versions", () => {
  it("lands two lines of an action in one workflow at their separate targets", async () => {
    expect(await plannedPinsLanded([move("v1.0.0", "v1.1.0", "a"), move("v2.0.0", "v2.1.0", "b")], tree(workflow([["0", "v1.0.0"], ["1", "v2.0.0"]])), tree(workflow([["a", "v1.1.0"], ["b", "v2.1.0"]])))).toEqual([]);
  });
  it("keeps an unplanned version of a planned action at base, even in the same file", async () => {
    const before = tree(workflow([["0", "v1.0.0"], ["1", "v2.0.0"]]));
    const planned = [move("v1.0.0", "v1.1.0", "a")];
    expect(await plannedPinsLanded(planned, before, tree(workflow([["a", "v1.1.0"], ["1", "v2.0.0"]])))).toEqual([]);
    expect(await plannedPinsLanded(planned, before, tree(workflow([["a", "v1.1.0"], ["b", "v2.1.0"]])))).toContain(`${file}: actions/checkout at v2.0.0 changed outside its planned source version`);
  });
});

describe("tool-written pins", () => {
  it("writes each file it can rewrite in place and leaves the rest, untouched, to the agent", async () => {
    const plain = ".github/workflows/ci.yml";
    const aliased = ".github/workflows/release.yml";
    const files: Record<string, string> = {
      [plain]: `jobs:\n  j:\n    steps:\n      - uses: actions/checkout@${"0".repeat(40)} # v1.0.0\n`,
      [aliased]: `x: &a actions/checkout@${"0".repeat(40)}\njobs:\n  j:\n    steps:\n      - uses: *a # v1.0.0\n`,
    };
    const before = { ...files };
    const root = await mkdtemp(join(tmpdir(), "bump-it-pins-"));
    await mkdir(join(root, ".github/workflows"), { recursive: true });
    for (const [path, text] of Object.entries(files)) await writeFile(join(root, path), text);
    const execution = {
      context: { workingCopy: { path: root } },
      deps: {
        trees: { working: () => ({ read: async (path: string) => files[path] }) },
        writeFile: async (_wc: unknown, path: string, text: string) => { files[path] = text; },
        fileState: async () => { throw new Error("no restored files here"); },
      },
    } as unknown as Parameters<typeof writePins>[0];
    const computed = { plan: { moves: [{ ...move("v1.0.0", "v1.1.0", "a"), locations: [plain, aliased] }] } } as unknown as Parameters<typeof writePins>[1];
    expect(await writePins(execution, computed)).toEqual({ written: [plain], complete: false });
    expect(files[plain]).toBe(before[plain]!.replace(`${"0".repeat(40)} # v1.0.0`, `${"a".repeat(40)} # v1.1.0`));
    expect(files[aliased]).toBe(before[aliased]);
    await rm(root, { recursive: true, force: true });
  });
});

describe("tool-written pin locations", () => {
  it("never reads a location outside the working copy, or one that isn't a workflow or action file", async () => {
    const root = await mkdtemp(join(tmpdir(), "bump-it-pins-"));
    try {
      await mkdir(join(root, ".github/workflows"), { recursive: true });
      await writeFile(join(root, "outside.yml"), "x");
      const reads: string[] = [];
      const execution = {
        context: { workingCopy: { path: join(root, "repo") } },
        deps: { trees: { working: () => ({ read: async (path: string) => { reads.push(path); return undefined; } }) }, writeFile: async () => {}, fileState: async () => { throw new Error("unused"); } },
      } as unknown as Parameters<typeof writePins>[0];
      await mkdir(join(root, "repo/.github/workflows"), { recursive: true });
      const locations = [".github/workflows/../../../outside.yml", "../outside.yml", "README.md", "/dev/zero"];
      const computed = { plan: { moves: [{ ...move("v1.0.0", "v1.1.0", "a"), locations }] } } as unknown as Parameters<typeof writePins>[1];
      expect(await writePins(execution, computed)).toEqual({ written: [], complete: false });
      expect(reads).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
