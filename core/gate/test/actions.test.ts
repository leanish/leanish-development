import { describe, expect, it } from "vitest";

import { ActionsCatalog, actionChanges, actionGaps, actionsLocated, resolveUses } from "../src/actions-changes.ts";
import { ActionsGitHub } from "../src/actions-github.ts";
import { type ActionsInventory, parseUses, readActionsInventory } from "../src/actions-inventory.ts";
import { parseConfig } from "../src/config.ts";
import type { Tree } from "../src/tree.ts";
import { fakeFetch, type FakeResponse } from "./fake-fetch.ts";

const API = "https://api.github.com";
const CHECKOUT_SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const OLD_CHECKOUT_SHA = "11bd71901bbe5b1630ceea73d27597364c9af683";
const TAG_OBJECT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function tree(files: Record<string, string>): Tree {
  return {
    id: "tree",
    read: async (path) => files[path],
    list: async (dir) => Object.keys(files).filter((path) => path.startsWith(`${dir}/`)).sort(),
  };
}

/** GitHub: actions/checkout's v7.0.1 is a lightweight tag, v4.2.2 an annotated one; immutable releases for both. */
function github(extra: Record<string, FakeResponse> = {}): ActionsGitHub {
  return new ActionsGitHub(
    fakeFetch({
      [`${API}/repos/actions/checkout/git/ref/tags/v7.0.1`]: { body: { object: { type: "commit", sha: CHECKOUT_SHA } } },
      [`${API}/repos/actions/checkout/git/ref/tags/v4.2.2`]: { body: { object: { type: "tag", sha: TAG_OBJECT } } },
      [`${API}/repos/actions/checkout/git/tags/${TAG_OBJECT}`]: { body: { object: { type: "commit", sha: OLD_CHECKOUT_SHA } } },
      [`${API}/repos/actions/checkout/releases?per_page=100&page=1`]: {
        body: [
          { tag_name: "v7.0.1", published_at: "2026-04-10T17:31:14Z", draft: false, immutable: true },
          { tag_name: "v4.2.2", published_at: "2024-10-23T14:46:00Z", draft: false, immutable: true },
        ],
      },
      ...extra,
    }),
    undefined,
  );
}

describe("reading workflows", () => {
  it("reads a key named `uses` outside a job or step only when it's an action, and stays strict in steps", () => {
    const workflow = [
      "on: push",
      "env:",
      "  uses: production",
      "  SHADOW: { uses: acme/shadow@v1 }",
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: acme/tool@0123456789abcdef0123456789abcdef01234567 # v1.0.0",
      "        with:",
      "          uses: not-an-action",
      "  call:",
      "    uses: ./.github/workflows/reusable.yml",
    ].join("\n");
    const parsed = parseUses(workflow, "ci.yml");
    expect(parsed.uses.map((use) => use.name)).toEqual(["acme/shadow", "acme/tool"]);
    expect(parsed.local).toEqual(["./.github/workflows/reusable.yml"]);
    // A `uses` key written as an alias still counts.
    expect(parseUses("x: &k uses\njobs:\n  a:\n    steps:\n      - { *k : acme/aliased@0123456789abcdef0123456789abcdef01234567, run: echo }\n", "ci.yml").uses.map((use) => use.name)).toEqual(["acme/aliased"]);
    expect(() => parseUses("jobs:\n  a:\n    steps:\n      - uses: production\n", "ci.yml")).toThrow("can't read `uses: production`");
    expect(() => parseUses("jobs:\n  a:\n    uses: 3\n", "ci.yml")).toThrow("isn't a string");
    expect(() => parseUses("runs:\n  using: composite\n  steps:\n    - uses: [x]\n", "action.yml")).toThrow("isn't a string");
  });

  it("reads every uses: with its comment, follows local actions, and keeps docker uses apart", async () => {
    const workflow = `on: pull_request
jobs:
  reuse:
    uses: acme/shared/.github/workflows/ci.yml@0123456789abcdef0123456789abcdef01234567 # v1.2.3
  test:
    steps:
      - uses: actions/checkout@${CHECKOUT_SHA} # v7.0.1
      - name: setup
        uses: "Actions/Setup-Node@v7"
      - run: |
          echo uses: not/an-action@v1
      - uses: ./.github/local-action
      - uses: docker://alpine:3.20
      - "u\\u0073es": escaped/key@v1
`;
    const composite = `runs:
  using: composite
  steps:
    - uses: actions/cache@0400d5f644dc74513175e3cd8d07132dd4860809 # tag=v4.2.4
`;
    const inventory = await readActionsInventory(
      tree({ ".github/workflows/ci.yml": workflow, ".github/workflows/notes.md": "uses: x/y@z", ".github/local-action/action.yml": composite }),
    );
    expect(inventory.uses.map((use) => [use.name, use.path, use.ref, use.comment, use.file])).toEqual([
      ["acme/shared", ".github/workflows/ci.yml", "0123456789abcdef0123456789abcdef01234567", "v1.2.3", ".github/workflows/ci.yml"],
      ["actions/checkout", undefined, CHECKOUT_SHA, "v7.0.1", ".github/workflows/ci.yml"],
      ["actions/setup-node", undefined, "v7", undefined, ".github/workflows/ci.yml"],
      ["escaped/key", undefined, "v1", undefined, ".github/workflows/ci.yml"],
      ["actions/cache", undefined, "0400d5f644dc74513175e3cd8d07132dd4860809", "tag=v4.2.4", ".github/local-action/action.yml"],
    ]);
    expect(inventory.docker).toEqual(["docker://alpine:3.20 (.github/workflows/ci.yml)"]);
  });

  it("fails on YAML that doesn't parse and on a uses: it can't read", () => {
    expect(() => parseUses("jobs: [", "bad.yml")).toThrow("bad.yml isn't valid YAML");
    expect(() => parseUses("steps:\n  - uses: not-an-action\n", "odd.yml")).toThrow("odd.yml: can't read `uses: not-an-action`");
    expect(() => parseUses("steps:\n  - uses: [a]\n", "odd.yml")).toThrow("odd.yml: a `uses:` isn't a string");
  });

  it("can't read a remote action whose owner or repo is `.` or `..`, but reads dot-led names and local actions", () => {
    const sha = "a".repeat(40);
    for (const value of [`../..@${sha}`, "acme/..@v1", "acme/.@v1", "../checkout@v1"]) {
      expect(() => parseUses(`steps:\n  - uses: ${value}\n`, "odd.yml")).toThrow(`odd.yml: can't read \`uses: ${value}\``);
    }
    const read = parseUses("steps:\n  - uses: acme/.github/deploy@v1\n  - uses: ./.github/actions/build\n", "ci.yml");
    expect(read.uses.map((use) => [use.name, use.path])).toEqual([["acme/.github", "deploy"]]);
    expect(read.local).toEqual(["./.github/actions/build"]);
    // Outside a job or step such a value doesn't read as an action, so it isn't counted (nor looked up).
    expect(parseUses("env:\n  uses: acme/..@v1\nsteps:\n  - uses: acme/x@v1\n", "ci.yml").uses.map((use) => use.name)).toEqual(["acme/x"]);
  });

  it("follows a local action named with trailing slashes, and reads a long slash run in linear time", async () => {
    const composite = "runs:\n  using: composite\n  steps:\n    - uses: actions/cache@v4\n";
    const workflow = `jobs:\n  a:\n    steps:\n      - uses: ./.github/local-action///\n      - uses: ./a${"/".repeat(100_000)}b\n`;
    const started = performance.now();
    // The replaced regex rescanned the run from each slash: seconds at this length.
    const read = await readActionsInventory(tree({ ".github/workflows/ci.yml": workflow, ".github/local-action/action.yml": composite }));
    const elapsed = performance.now() - started;
    expect(read.uses.map((use) => [use.name, use.file])).toEqual([["actions/cache", ".github/local-action/action.yml"]]);
    expect(read.gaps).toEqual([expect.stringMatching(/^GitHub Actions local action \.\/a\/+b \(\.github\/workflows\/ci\.yml\) has no action\.yml/)]);
    expect(elapsed).toBeLessThan(2_000);
  });
});

describe("resolving uses", () => {
  const use = (ref: string, comment: string | undefined) => ({ name: "actions/checkout", path: undefined, ref, comment, file: "ci.yml" });
  const inventory = (...uses: ReturnType<typeof use>[]): ActionsInventory => ({ uses, docker: [], files: ["ci.yml"], gaps: [] });

  it("pins a commit whose comment names a tag pointing at it, annotated tags included", async () => {
    const resolutions = await resolveUses(
      [
        inventory(
          use(CHECKOUT_SHA, "v7.0.1"),
          use(OLD_CHECKOUT_SHA, "pin v4.2.2"),
          use("v7", undefined),
          use(CHECKOUT_SHA.replace("3d", "4d"), "v7.0.1"),
          use(OLD_CHECKOUT_SHA.replace("11", "22"), "no version"),
          use(OLD_CHECKOUT_SHA.replace("11", "33"), "v9.9.9"),
        ),
      ],
      github(),
    );
    expect([...resolutions.values()]).toEqual([
      { kind: "pinned", version: "v7.0.1" },
      { kind: "pinned", version: "v4.2.2" },
      { kind: "unpinned" },
      { kind: "unverified", reason: `tag v7.0.1 of actions/checkout points at ${CHECKOUT_SHA.slice(0, 12)}, not 4d3c42e5aac5` },
      { kind: "unverified", reason: "no `# vX.Y.Z` comment names its full version" },
      { kind: "unverified", reason: "actions/checkout has no tag v9.9.9" },
    ]);
  });

  it("fails on changed uses that aren't pinned or verified, gaps the unchanged ones, and dates changed ones by their release", async () => {
    const config = parseConfig({});
    const base = inventory(use(OLD_CHECKOUT_SHA, "v4.2.2"), use("v6", undefined));
    const head: ActionsInventory = {
      uses: [use(CHECKOUT_SHA, "v7.0.1"), use("v6", undefined), { ...use("v7", undefined), name: "actions/setup-node" }],
      docker: ["docker://alpine:3.20 (ci.yml)"],
      files: ["ci.yml"],
      gaps: [],
    };
    const gh = github();
    const resolutions = await resolveUses([base, head], gh);
    const result = await actionChanges(base, head, resolutions, gh, config);
    expect(result.problems).toEqual([
      "actions/setup-node@v7 (ci.yml) is new or changed, so it must be pinned to a full commit SHA with a `# vX.Y.Z` comment",
    ]);
    expect(result.gaps).toEqual([
      "GitHub Actions docker://alpine:3.20 (ci.yml): no advisory source covers container images",
      "GitHub Actions actions/checkout@v6 (ci.yml): not pinned to a commit, so its version (and advisories) can't be told",
    ]);
    expect(result.changes).toEqual([
      {
        pkg: { ecosystem: "GitHub Actions", name: "actions/checkout", version: "v7.0.1" },
        published: new Date("2026-04-10T17:31:14Z"),
        replaced: ["v4.2.2"],
      },
    ]);
    expect(actionsLocated(head, resolutions)).toEqual([
      { ecosystem: "GitHub Actions", name: "actions/checkout", version: "v7.0.1", locations: ["ci.yml"] },
    ]);
    expect(actionGaps(head, resolutions)).toHaveLength(3);
  });

  it("words an unchanged use's gap as a full scan does, folder included", async () => {
    const unpinned = { name: "acme/tools", path: "lint", ref: "v1", comment: undefined, file: "ci.yml" };
    const uncommented = { ...unpinned, path: "build", ref: CHECKOUT_SHA };
    const tree: ActionsInventory = { uses: [unpinned, uncommented], docker: [], files: ["ci.yml"], gaps: [] };
    const gh = github();
    const resolutions = await resolveUses([tree], gh);
    const { gaps } = await actionChanges(tree, tree, resolutions, gh, parseConfig({}));
    expect(gaps).toEqual([
      "GitHub Actions acme/tools/lint@v1 (ci.yml): not pinned to a commit, so its version (and advisories) can't be told",
      `GitHub Actions acme/tools/build@${CHECKOUT_SHA} (ci.yml): no \`# vX.Y.Z\` comment names its full version`,
    ]);
    expect(actionGaps(tree, resolutions)).toEqual(gaps);
  });

  it("fails a changed action without a published release, unless it's an own action", async () => {
    const own = { name: "acme/tools", path: undefined, ref: CHECKOUT_SHA, comment: "v1.0.0", file: "ci.yml" };
    const gh = github({
      [`${API}/repos/acme/tools/git/ref/tags/v1.0.0`]: { body: { object: { type: "commit", sha: CHECKOUT_SHA } } },
    });
    const head: ActionsInventory = { uses: [own], docker: [], files: ["ci.yml"], gaps: [] };
    const none: ActionsInventory = { uses: [], docker: [], files: [], gaps: [] };
    const resolutions = await resolveUses([head], gh);
    expect((await actionChanges(none, head, resolutions, gh, parseConfig({}))).problems).toEqual([
      "acme/tools@3d3c42e5aac5ba805825da76410c181273ba90b1 (ci.yml): acme/tools has no immutable GitHub release for v1.0.0, so the gate can't trust its age",
    ]);
    const config = parseConfig({ ownPackages: { "GitHub Actions": { owners: ["acme"] } } });
    expect(await actionChanges(none, head, resolutions, gh, config)).toEqual({ problems: [], gaps: [], changes: [] });
  });
});

describe("mutable releases", () => {
  // A mutable release's tag can be moved to newer code, which would then inherit the release's age.
  const use = { name: "acme/tools", path: undefined, ref: CHECKOUT_SHA, comment: "v2.0.0", file: "ci.yml" };
  const tags = {
    [`${API}/repos/acme/tools/git/ref/tags/v2.0.0`]: { body: { object: { type: "commit", sha: CHECKOUT_SHA } } },
  };

  it("fails a changed action whose release is mutable, and gives the catalog its tag without a date", async () => {
    const gh = github({
      ...tags,
      [`${API}/repos/acme/tools/releases?per_page=100&page=1`]: {
        body: [{ tag_name: "v2.0.0", published_at: "2024-01-01T00:00:00Z", draft: false, immutable: false }],
      },
    });
    const head: ActionsInventory = { uses: [use], docker: [], files: ["ci.yml"], gaps: [] };
    const none: ActionsInventory = { uses: [], docker: [], files: [], gaps: [] };
    expect((await actionChanges(none, head, await resolveUses([head], gh), gh, parseConfig({}))).problems).toEqual([
      "acme/tools@3d3c42e5aac5ba805825da76410c181273ba90b1 (ci.yml): acme/tools has no immutable GitHub release for v2.0.0, so the gate can't trust its age",
    ]);
    const catalog = new ActionsCatalog(gh);
    expect(await catalog.versions({ ecosystem: "GitHub Actions", name: "acme/tools" })).toEqual(["v2.0.0"]);
    expect(await catalog.published({ ecosystem: "GitHub Actions", name: "acme/tools", version: "v2.0.0" })).toBeUndefined();
  });

  it("dates a release found by its tag alone only when it's immutable", async () => {
    const release = (immutable: boolean | undefined) => github({
      [`${API}/repos/acme/tools/releases?per_page=100&page=1`]: { body: [] },
      [`${API}/repos/acme/tools/releases/tags/v2.0.0`]: { body: { tag_name: "v2.0.0", published_at: "2024-01-01T00:00:00Z", draft: false, ...(immutable === undefined ? {} : { immutable }) } },
    });
    expect(await release(true).releasePublished("acme/tools", "v2.0.0")).toEqual(new Date("2024-01-01T00:00:00Z"));
    expect(await release(false).releasePublished("acme/tools", "v2.0.0")).toBeUndefined();
    expect(await release(undefined).releasePublished("acme/tools", "v2.0.0")).toBeUndefined();
  });
});

describe("occurrences and edge cases", () => {
  const use = (ref: string, comment: string | undefined, file = "ci.yml") => ({ name: "actions/checkout", path: undefined, ref, comment, file });
  const inventory = (...uses: ReturnType<typeof use>[]): ActionsInventory => ({ uses, docker: [], files: ["ci.yml"], gaps: [] });

  it("judges each occurrence: a dropped comment, or an unpinned ref copied to another workflow, is a change", async () => {
    const gh = github();
    const base = inventory(use(CHECKOUT_SHA, "v7.0.1"), use("v6", undefined));
    const dropped = inventory(use(CHECKOUT_SHA, undefined), use("v6", undefined));
    const copied = inventory(use(CHECKOUT_SHA, "v7.0.1"), use("v6", undefined), use("v6", undefined, "release.yml"));
    const config = parseConfig({});
    const resolutions = await resolveUses([base, dropped, copied], gh);
    expect((await actionChanges(base, dropped, resolutions, gh, config)).problems).toEqual([
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 (ci.yml): no `# vX.Y.Z` comment names its full version",
    ]);
    expect((await actionChanges(base, copied, resolutions, gh, config)).problems).toEqual([
      "actions/checkout@v6 (release.yml) is new or changed, so it must be pinned to a full commit SHA with a `# vX.Y.Z` comment",
    ]);
  });

  it("counts occurrences, subdirectory included: another action of the same repository, a second copy or an aliased step is new", async () => {
    const gh = github();
    const config = parseConfig({});
    const at = (path: string | undefined, file = "ci.yml") => ({ name: "acme/actions", path, ref: "main", comment: undefined, file });
    const of = (...uses: ReturnType<typeof at>[]): ActionsInventory => ({ uses, docker: [], files: ["ci.yml"], gaps: [] });
    const base = of(at("safe"), at("safe"));
    const resolutions = await resolveUses([base], gh);
    const problems = async (head: ActionsInventory) => (await actionChanges(base, head, resolutions, gh, config)).problems;
    const unpinned = (path: string) => `acme/actions/${path}@main (ci.yml) is new or changed, so it must be pinned to a full commit SHA with a \`# vX.Y.Z\` comment`;
    expect(await problems(of(at("safe"), at("unsafe")))).toEqual([unpinned("unsafe")]);
    expect(await problems(of(at("safe"), at("safe"), at("safe")))).toEqual([unpinned("safe")]);
    // Unchanged or fewer copies stay grandfathered (gaps).
    expect(await problems(of(at("safe"), at("safe")))).toEqual([]);
    expect(await problems(of(at("safe")))).toEqual([]);
    const aliased = (copies: number) => `on: push\njobs:\n  a:\n    steps:\n      - &step\n        uses: acme/actions/safe@main\n${"      - *step\n".repeat(copies)}`;
    const read = (copies: number): ActionsInventory => ({ ...parseUses(aliased(copies), "ci.yml"), files: ["ci.yml"], gaps: [] });
    expect((await actionChanges(read(1), read(2), resolutions, gh, config)).problems).toEqual([unpinned("safe")]);
  });

  it("keeps occurrences apart whose ref or comment holds a separator", async () => {
    const gh = github({ [`${API}/repos/acme/actions/git/ref/tags/v1.2.3`]: { body: { object: { type: "commit", sha: CHECKOUT_SHA } } } });
    const at = (ref: string, comment: string) => ({ name: "acme/actions", path: undefined, ref, comment, file: "ci.yml" });
    const of = (...uses: ReturnType<typeof at>[]): ActionsInventory => ({ uses, docker: [], files: ["ci.yml"], gaps: [] });
    const base = of(at(CHECKOUT_SHA, "reviewed|note v1.2.3"));
    const head = of(at(`${CHECKOUT_SHA}|reviewed`, "note v1.2.3"));
    const resolutions = await resolveUses([base, head], gh);
    expect((await actionChanges(base, head, resolutions, gh, parseConfig({}))).problems).toEqual([
      `acme/actions@${CHECKOUT_SHA}|reviewed (ci.yml) is new or changed, so it must be pinned to a full commit SHA with a \`# vX.Y.Z\` comment`,
    ]);
  });

  it("refuses YAML whose aliases expand past a budget", () => {
    const levels = ["a: &a [x, x, x, x, x, x, x, x, x, x]"];
    for (let level = 1; level < 8; level++) levels.push(`${String.fromCharCode(97 + level)}: &${String.fromCharCode(97 + level)} [${Array(10).fill(`*${String.fromCharCode(96 + level)}`).join(", ")}]`);
    expect(() => parseUses(levels.join("\n"), "bomb.yml")).toThrow("too many YAML nodes");
  });

  it("won't take a floating major tag as the version", async () => {
    const gh = github({ [`${API}/repos/actions/checkout/git/ref/tags/v7`]: { body: { object: { type: "commit", sha: CHECKOUT_SHA } } } });
    expect([...(await resolveUses([inventory(use(CHECKOUT_SHA, "v7"))], gh)).values()]).toEqual([
      { kind: "unverified", reason: "no `# vX.Y.Z` comment names its full version" },
    ]);
  });

  it("follows YAML aliases with the anchor's comment, and reports a local action without metadata", async () => {
    const workflow = `on: push
x-checkout: &checkout actions/checkout@${CHECKOUT_SHA} # v7.0.1
jobs:
  a:
    steps:
      - uses: *checkout
      - &setup
        uses: actions/setup-node@v7
  b:
    steps:
      - *setup
      - uses: ./missing-action
`;
    const read = await readActionsInventory(tree({ ".github/workflows/ci.yml": workflow, ".github/workflows/shell.yml": "on: push\njobs:\n  a:\n    steps:\n      - run: echo hi\n" }));
    expect(read.uses.map((found) => [found.name, found.ref, found.comment])).toEqual([
      ["actions/checkout", CHECKOUT_SHA, "v7.0.1"],
      ["actions/setup-node", "v7", undefined],
      // The alias in job b runs the step again: a use of its own.
      ["actions/setup-node", "v7", undefined],
    ]);
    expect(read.files).toEqual([".github/workflows/ci.yml", ".github/workflows/shell.yml"]);
    expect(read.gaps).toEqual(["GitHub Actions local action ./missing-action (.github/workflows/ci.yml) has no action.yml, so what it uses isn't read"]);
  });

  it("refuses a local action outside the repository before reading it, and reads one that only passes through a parent", async () => {
    const reads: string[] = [];
    const recorded = (files: Record<string, string>): Tree => ({ ...tree(files), read: async (path) => (reads.push(path), files[path]) });
    const step = (uses: string) => `on: push\njobs:\n  a:\n    steps:\n      - uses: ${uses}\n`;
    for (const uses of ["./../x", "./a/../../x", "./.."]) {
      reads.length = 0;
      await expect(readActionsInventory(recorded({ ".github/workflows/ci.yml": step(uses) }))).rejects.toThrow(`\`uses: ${uses}\` points outside the repository`);
      expect(reads).toEqual([".github/workflows/ci.yml"]);
    }
    const inside = await readActionsInventory(recorded({ ".github/workflows/ci.yml": step("./a/../b"), "b/action.yml": "runs:\n  using: composite\n  steps:\n    - uses: actions/setup-node@v7\n" }));
    expect(inside.files).toEqual([".github/workflows/ci.yml", "b/action.yml"]);
    expect(inside.uses.map((use) => use.name)).toEqual(["actions/setup-node"]);
    // `./` is the root action, read and counted once though it's also read on its own.
    const root = await readActionsInventory(recorded({ ".github/workflows/ci.yml": step("./"), "action.yml": "runs:\n  using: composite\n  steps:\n    - uses: actions/setup-node@v7\n" }));
    expect(root.files).toEqual([".github/workflows/ci.yml", "action.yml"]);
    expect(root.uses.map((use) => use.name)).toEqual(["actions/setup-node"]);
  });

  it("reads a local reusable workflow once, as the workflow it is, and reports one that doesn't exist", async () => {
    const caller = `on: push
jobs:
  ci:
    uses: ./.github/workflows/ci.yml
  gone:
    uses: ./.github/workflows/gone.yml
`;
    const ci = `on: workflow_call\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@${CHECKOUT_SHA} # v7.0.1\n`;
    const read = await readActionsInventory(tree({ ".github/workflows/ci.yml": ci, ".github/workflows/publish.yml": caller }));
    expect(read.files).toEqual([".github/workflows/ci.yml", ".github/workflows/publish.yml"]);
    expect(read.uses.map((found) => [found.name, found.file])).toEqual([["actions/checkout", ".github/workflows/ci.yml"]]);
    expect(read.gaps).toEqual(["GitHub Actions local workflow ./.github/workflows/gone.yml (.github/workflows/publish.yml) doesn't exist, so what it uses isn't read"]);
  });
});

describe("GitHub's advisory database", () => {
  it("asks for reviewed and malware advisories by version, and reads aliases, malware and withdrawals", async () => {
    const affects = (type: string) => `${API}/advisories?ecosystem=actions&affects=${encodeURIComponent("tj-actions/changed-files@v45.0.7")}&type=${type}&per_page=100`;
    const gh = new ActionsGitHub(
      fakeFetch({
        [affects("reviewed")]: {
          body: [
            {
              ghsa_id: "GHSA-mrrh-fwg8-r2c3",
              cve_id: "CVE-2025-30066",
              type: "reviewed",
              severity: "high",
              summary: "tj-actions changed-files through 45.0.7 allows remote attackers to discover secrets",
              identifiers: [{ type: "GHSA", value: "GHSA-mrrh-fwg8-r2c3" }, { type: "CVE", value: "CVE-2025-30066" }],
              cwes: [{ cwe_id: "CWE-506" }],
              withdrawn_at: null,
            },
            { ghsa_id: "GHSA-gone", type: "reviewed", withdrawn_at: "2026-01-01T00:00:00Z" },
          ],
        },
        [affects("malware")]: { body: [{ ghsa_id: "GHSA-mal1", type: "malware", summary: "Malicious code" }] },
      }),
      "token",
    );
    const found = await gh.advisories("tj-actions/changed-files", "v45.0.7");
    expect(found.map((advisory) => [advisory.id, advisory.ids, advisory.malicious, advisory.severity])).toEqual([
      ["GHSA-mrrh-fwg8-r2c3", ["GHSA-mrrh-fwg8-r2c3", "CVE-2025-30066"], true, "HIGH"],
      ["GHSA-mal1", ["GHSA-mal1"], true, undefined],
    ]);
  });

  it("counts global coverage only for reviewed or malware records, and follows every page", async () => {
    const affects = (type: string) => `${API}/advisories?ecosystem=actions&affects=${encodeURIComponent("a/b@v1.0.0")}&type=${type}&per_page=100`;
    const vulnerable = { vulnerabilities: [{ package: { ecosystem: "actions", name: "a/b" } }] };
    const gh = new ActionsGitHub(
      fakeFetch({
        [`${API}/advisories/GHSA-unrv-unrv-unrv`]: { body: { ghsa_id: "GHSA-unrv-unrv-unrv", type: "unreviewed", ...vulnerable } },
        [`${API}/advisories/GHSA-revd-revd-revd`]: { body: { ghsa_id: "GHSA-revd-revd-revd", type: "reviewed", ...vulnerable } },
        [affects("reviewed")]: { body: [{ ghsa_id: "GHSA-page-one1-aaaa", type: "reviewed" }], headers: { link: `<${API}/advisories?page=2>; rel="next"` } },
        [`${API}/advisories?page=2`]: { body: [{ ghsa_id: "GHSA-page-two2-bbbb", type: "reviewed" }] },
        [affects("malware")]: { body: [] },
      }),
      undefined,
    );
    expect(await gh.globalCovers("GHSA-unrv-unrv-unrv", "a/b")).toBe(false);
    expect(await gh.globalCovers("GHSA-revd-revd-revd", "a/b")).toBe(true);
    expect((await gh.advisories("a/b", "v1.0.0")).map((advisory) => advisory.id)).toEqual(["GHSA-page-one1-aaaa", "GHSA-page-two2-bbbb"]);
  });

  it("reads the next page after other links, and a long run of `<` in a Link header in linear time", async () => {
    const affects = (type: string) => `${API}/advisories?ecosystem=actions&affects=${encodeURIComponent("a/b@v1.0.0")}&type=${type}&per_page=100`;
    const gh = new ActionsGitHub(
      fakeFetch({
        [affects("reviewed")]: { body: [{ ghsa_id: "GHSA-page-one1-aaaa", type: "reviewed" }], headers: { link: `<${API}/advisories?page=9>; rel="last", <${API}/advisories?page=2>; rel="next"` } },
        [`${API}/advisories?page=2`]: { body: [{ ghsa_id: "GHSA-page-two2-bbbb", type: "reviewed" }] },
        [affects("malware")]: { body: [{ ghsa_id: "GHSA-page-mal1-cccc", type: "malware" }], headers: { link: "<".repeat(100_000) } },
      }),
      undefined,
    );
    const started = performance.now();
    // The replaced regex rescanned the run from each `<`: seconds at this length.
    expect((await gh.advisories("a/b", "v1.0.0")).map((advisory) => advisory.id)).toEqual(["GHSA-page-one1-aaaa", "GHSA-page-two2-bbbb", "GHSA-page-mal1-cccc"]);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("refuses a record the reviewed query returns that isn't reviewed: only reviewed ones may trigger a fix", async () => {
    const affects = (type: string) => `${API}/advisories?ecosystem=actions&affects=${encodeURIComponent("a/b@v1.0.0")}&type=${type}&per_page=100`;
    const gh = new ActionsGitHub(fakeFetch({ [affects("reviewed")]: { body: [{ ghsa_id: "GHSA-unrv-unrv-unrv", type: "unreviewed" }] }, [affects("malware")]: { body: [] } }), undefined);
    await expect(gh.advisories("a/b", "v1.0.0")).rejects.toThrow("GitHub advisory GHSA-unrv-unrv-unrv isn't reviewed (type unreviewed)");
  });

  it("marks a release listing past the page cap incomplete, so the young-fix proof can't use it", async () => {
    const page = (n: number) =>
      Array.from({ length: 100 }, (_, i) => ({ tag_name: `v1.${n}.${i}`, published_at: "2026-01-01T00:00:00Z", draft: false }));
    const routes = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`${API}/repos/a/b/releases?per_page=100&page=${i + 1}`, { body: page(i + 1) }]));
    const gh = new ActionsGitHub(fakeFetch(routes), undefined);
    expect((await gh.releasesOf("a/b")).complete).toBe(false);
    const { ActionsCatalog } = await import("../src/actions-changes.ts");
    expect(await new ActionsCatalog(gh).versions({ ecosystem: "GitHub Actions", name: "a/b" })).toBeUndefined();
  });

  it("fails closed on errors other than a 404", async () => {
    const gh = new ActionsGitHub(fakeFetch({ [`${API}/repos/a/b/git/ref/tags/v1`]: { status: 502 } }), undefined);
    await expect(gh.tagCommit("a/b", "v1")).rejects.toThrow("failed with HTTP 502");
    expect(await gh.tagCommit("a/b", "v2")).toBeUndefined();
  });
});
