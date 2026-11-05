import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { actionChanges, actionGaps } from "../src/actions-changes.ts";
import { ActionsGitHub } from "../src/actions-github.ts";
import { type ActionsInventory, readActionsInventory } from "../src/actions-inventory.ts";
import { parseConfig } from "../src/config.ts";
import { type Inventory, isEmpty } from "../src/inventory.ts";
import { runProcess } from "../src/process.ts";
import { gitTree, type Tree, workingTree } from "../src/tree.ts";
import { fakeFetch } from "./fake-fetch.ts";

const STEP = "jobs:\n  a:\n    steps:\n      - uses: acme/behind-a-link@main\n";
const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/** A real repository with `files` and `links` (path to target), committed; both of its trees. */
async function repository(files: Record<string, string>, links: Record<string, string>): Promise<{ commit: Tree; working: Tree }> {
  const root = await mkdtemp(join(tmpdir(), "actions-links-"));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  for (const [path, target] of Object.entries(links)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await symlink(target, join(root, path));
  }
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { stdio: "pipe" });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "--allow-empty", "-m", "fixture");
  return { commit: await gitTree(root, "HEAD", runProcess, join(root, ".git")), working: workingTree(root) };
}

/** What both of a repository's trees read, which must agree. */
async function read(files: Record<string, string>, links: Record<string, string>): Promise<ActionsInventory> {
  const { commit, working } = await repository(files, links);
  const inventory = await readActionsInventory(commit);
  expect(await readActionsInventory(working)).toEqual(inventory);
  return inventory;
}

const at = (path: string, target: string, usedBy?: string) => ({ path, target, usedBy });

describe("a tree's links", () => {
  it("gives the first link on the way, or else every link under a folder, the same from a commit and a working tree", async () => {
    const trees = await repository({ "real/file.txt": "text", "real/nested/other.txt": "text" }, { "real/z-link": "file.txt", "real/nested/a-link": "../missing", folder: "real" });
    for (const tree of [trees.commit, trees.working]) {
      expect(await tree.links("folder")).toEqual([{ path: "folder", target: "real" }]);
      expect(await tree.links("folder/nested/other.txt")).toEqual([{ path: "folder", target: "real" }]);
      expect(await tree.links("real/z-link")).toEqual([{ path: "real/z-link", target: "file.txt" }]);
      expect(await tree.links("real")).toEqual([{ path: "real/nested/a-link", target: "../missing" }, { path: "real/z-link", target: "file.txt" }]);
      expect(await tree.links("real/file.txt")).toEqual([]);
      expect(await tree.links("real/file.txt/below")).toEqual([]);
      expect(await tree.links("missing/below")).toEqual([]);
    }
  });
});

describe("links on the paths actions are read from", () => {
  it.each([
    ["a linked workflow file", { ".github/workflows/ci.yml": "../../shared/ci.yml" }, ".github/workflows/ci.yml", "../../shared/ci.yml"],
    ["a linked workflows folder", { ".github/workflows": "../shared" }, ".github/workflows", "../shared"],
    ["a linked .github", { ".github": "shared" }, ".github", "shared"],
    ["a linked actions folder", { ".github/actions": "../shared" }, ".github/actions", "../shared"],
    ["a linked action folder", { ".github/actions/build": "../../shared" }, ".github/actions/build", "../../shared"],
    ["a linked action metadata file", { ".github/actions/build/action.yml": "../../../shared/ci.yml" }, ".github/actions/build/action.yml", "../../../shared/ci.yml"],
    ["a linked root action.yml", { "action.yml": "shared/ci.yml" }, "action.yml", "shared/ci.yml"],
    ["a linked root action.yaml", { "action.yaml": "shared/ci.yml" }, "action.yaml", "shared/ci.yml"],
    ["a link to a missing file", { ".github/workflows/ci.yml": "missing.yml" }, ".github/workflows/ci.yml", "missing.yml"],
    ["a link outside the repository", { ".github/workflows/ci.yml": "/etc/hosts" }, ".github/workflows/ci.yml", "/etc/hosts"],
    ["a link to itself", { ".github/workflows/ci.yml": "ci.yml" }, ".github/workflows/ci.yml", "ci.yml"],
  ])("records %s without opening it", async (_, links, path, target) => {
    const inventory = await read({ "shared/ci.yml": STEP }, links);
    expect(inventory.links).toEqual([at(path, target)]);
    expect(inventory.uses).toEqual([]);
    expect(inventory.files).toEqual([]);
  });

  it("records a link a `uses:` leads through, with the file using it, instead of a missing-metadata gap", async () => {
    const inventory = await read(
      { ".github/workflows/ci.yml": "jobs:\n  a:\n    steps:\n      - uses: ./tools/build\n      - uses: ./tools/build\n", "shared/build/action.yml": `runs:\n  using: composite\n  steps:\n    - uses: acme/behind-a-link@main\n` },
      { tools: "shared" },
    );
    expect(inventory.links).toEqual([at("tools", "shared", ".github/workflows/ci.yml")]);
    expect(inventory.uses).toEqual([]);
    expect(inventory.gaps).toEqual([]);
  });

  it("records a linked local reusable workflow as found on its own and as used, so a new `uses:` of it is a change", async () => {
    const inventory = await read({ ".github/workflows/ci.yml": "jobs:\n  a:\n    uses: ./.github/workflows/shared.yml\n", "shared/ci.yml": STEP }, { ".github/workflows/shared.yml": "../../shared/ci.yml" });
    expect(inventory.links).toEqual([at(".github/workflows/shared.yml", "../../shared/ci.yml"), at(".github/workflows/shared.yml", "../../shared/ci.yml", ".github/workflows/ci.yml")]);
  });

  it("ignores a link in the workflows folder that couldn't be a workflow, and reads the real files around it", async () => {
    const inventory = await read({ ".github/workflows/ci.yml": STEP, "notes.md": "notes" }, { ".github/workflows/notes.md": "../../notes.md", ".github/workflows/nested/x.yml": "../ci.yml" });
    expect(inventory.links).toEqual([]);
    expect(inventory.uses.map((use) => use.name)).toEqual(["acme/behind-a-link"]);
  });

  it("isn't caught by links that lead to each other, inside or around a followed action", async () => {
    const inventory = await read({ ".github/workflows/ci.yml": "jobs:\n  a:\n    steps:\n      - uses: ./loop/x\n" }, { loop: "other", other: "loop", ".github/actions/self": "self" });
    expect(inventory.links).toEqual([at(".github/actions/self", "self"), at("loop", "other", ".github/workflows/ci.yml")]);
  });

  it("counts as something to check when links are all a repository's workflows have", async () => {
    const actions = await read({}, { ".github/workflows/ci.yml": "../../shared/ci.yml" });
    expect(isEmpty({ tree: "head", npm: [], gradle: undefined, actions } satisfies Inventory)).toBe(false);
    expect(isEmpty({ tree: "head", npm: [], gradle: undefined, actions: await read({}, {}) })).toBe(true);
  });
});

describe("the verdict on a link", () => {
  const compare = async (base: ActionsInventory, head: ActionsInventory) =>
    actionChanges(base, head, new Map(), new ActionsGitHub(fakeFetch({}), undefined), parseConfig({}));
  const inventory = (...links: ReturnType<typeof at>[]): ActionsInventory => ({ uses: [], docker: [], files: [], gaps: [], links });
  const LINK = at(".github/workflows/ci.yml", "../../shared/ci.yml");
  const problem = (label: string) => `GitHub Actions link ${label} is new or changed, and the gate doesn't read what's behind a link: commit the file itself`;
  const gap = (label: string) => `GitHub Actions link ${label}: the gate doesn't read what's behind a link, so what it uses can't be told`;
  const LABEL = `.github/workflows/ci.yml -> "../../shared/ci.yml"`;

  it("fails a new link", async () => {
    expect(await compare(inventory(), inventory(LINK))).toEqual({ problems: [problem(LABEL)], gaps: [], changes: [] });
  });

  it("fails a link retargeted at the same path", async () => {
    const retargeted = at(".github/workflows/ci.yml", "../../other.yml");
    expect((await compare(inventory(LINK), inventory(retargeted))).problems).toEqual([problem(`.github/workflows/ci.yml -> "../../other.yml"`)]);
  });

  it("fails a new `uses:` through a link base already had", async () => {
    const folder = at(".github/actions/build", "../../shared");
    const used = at(".github/actions/build", "../../shared", ".github/workflows/ci.yml");
    const result = await compare(inventory(folder), inventory(folder, used));
    expect(result.problems).toEqual([problem(`.github/actions/build -> "../../shared" (used by .github/workflows/ci.yml)`)]);
    expect(result.gaps).toEqual([gap(`.github/actions/build -> "../../shared"`)]);
  });

  it("reports a link base has too as a gap, in a comparison and a full scan alike", async () => {
    const result = await compare(inventory(LINK), inventory(LINK));
    expect(result).toEqual({ problems: [], gaps: [gap(LABEL)], changes: [] });
    expect(actionGaps(inventory(LINK), new Map())).toEqual(result.gaps);
  });

  it("has nothing to say about a link head removed", async () => {
    expect(await compare(inventory(LINK), inventory())).toEqual({ problems: [], gaps: [], changes: [] });
  });

  it("quotes and cuts a target, which is the repository's own text", () => {
    const [text] = actionGaps(inventory(at("action.yml", `a\n${"b".repeat(300)}`)), new Map());
    expect(text).toContain(`action.yml -> "a\\n${"b".repeat(198)}"`);
    expect(text).not.toContain("\n");
  });
});
