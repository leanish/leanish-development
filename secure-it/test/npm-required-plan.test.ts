import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCompare } from "@leanish/gate/gate";
import { type Advisory, Snapshot } from "@leanish/gate/snapshot";
import { environment, files, FIXED, json, locked, metadata, NOW, OLD, postcss, tree, vite, YOUNG, securityBatch, bridgeBatch, chainBatch } from "@leanish/gate/test/required-fixture";
import { materializeInCopy } from "../src/npm-materialize.ts";
import { addedAdvisories, requiredNpmPlan } from "../src/npm-required-plan.ts";
import { npmWindowFor } from "../src/npm-window.ts";
import { planDigest, planOf, planSection } from "../src/plan-block.ts";
import { retryWithoutNamed } from "../src/retry.ts";
import type { ChangePlan, PlannedMove } from "../src/plan.ts";

const plan: ChangePlan = { kind: "routine", topic: "security", malware: false, packages: ["npm|vite"], severity: "HIGH", moves: [
  { ecosystem: "npm", name: "vite", from: "8.3.2", to: "8.3.3", mechanism: "npm-direct", locations: ["node_modules/vite"], advisories: [FIXED], major: false, commitSha: undefined, declaredAs: undefined },
] };
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("security-required npm planning and exact materialization", () => {
  it("plans a shared young requirement for a security batch that the gate proves independently", async () => {
    const batch = securityBatch();
    const h = environment(batch);
    const joint = { ...plan, packages: ["npm|vite", "npm|bundler"], moves: [plan.moves[0]!, { ...plan.moves[0]!, name: "bundler", locations: ["node_modules/bundler"] }] };
    const computed = await requiredNpmPlan(tree(batch.base), joint, h.env);
    expect(computed.requiredNpm?.map((target) => [target.name, target.version])).toEqual([["postcss", "8.5.29"], ["postcss", "8.5.29"]]);
    expect((await runCompare(tree(batch.base), tree(batch.head, "head"), h.env)).failures).toEqual([]);
    expect(h.scans).toHaveLength(2); // One for planning, one for the independent gate.
  });

  it.each([true, false])("pins the lowest required target simultaneously, restores manifests (existing copy: %s)", async (existing) => {
    const original = files("8.3.2", existing ? "8.5.28" : undefined);
    const base = tree(original);
    const h = environment();
    const computed = await requiredNpmPlan(base, plan, h.env);
    expect(computed.requiredNpm).toMatchObject([{ name: "postcss", version: "8.5.29", lockfile: "package-lock.json" }]);
    expect(computed.notes?.join()).toContain("no version satisfying");
    expect(planDigest(computed)).not.toBe(planDigest(plan));
    expect(planOf(planSection(computed))).toEqual(computed);
    expect(h.scans).toHaveLength(1);
    const window = await npmWindowFor(computed, 7, [], NOW, h.env.fetch);
    expect(window.exclude).toEqual(["postcss", "vite"]);
    const dir = await mkdtemp(join(process.cwd(), ".required-test-"));
    dirs.push(dir);
    for (const [path, text] of Object.entries(original)) {
      await mkdir(join(dir, path, ".."), { recursive: true });
      await writeFile(join(dir, path), text);
    }
    let calls = 0;
    const result = await materializeInCopy({ releaseAgeDays: 7, now: NOW }, dir, base, computed, window.exclude, async (cwd, args) => {
      if (args[0] === "--version") return { code: 0, stdout: "11.19.1", stderr: "" };
      expect(args).toContain("--min-release-age=7");
      expect(args).toContain("--min-release-age-exclude=postcss");
      const manifest = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
      if (++calls === 1) {
        expect(manifest.devDependencies).toEqual({ vite: "8.3.3", postcss: "8.5.29" });
      } else expect(manifest.devDependencies).toEqual({ vite: "^8.3.3" });
      const lock = JSON.parse(original["package-lock.json"]!);
      lock.packages[""] = manifest;
      lock.packages["node_modules/vite"] = locked("vite", "8.3.3");
      lock.packages["node_modules/postcss"] = locked("postcss", "8.5.29");
      await writeFile(join(cwd, "package-lock.json"), json(lock));
      return { code: 0, stdout: "", stderr: "" };
    });
    expect(calls).toBe(2);
    expect(result.get("package.json")).toBe(original["package.json"]!.replace("^8.3.2", "^8.3.3"));
    expect(JSON.parse(result.get("package-lock.json")!).packages["node_modules/postcss"].version).toBe("8.5.29");
  });

  it("keeps a second security root's own target where the first root's requirement reaches it", async () => {
    // 8.5.29 satisfies vite's ^8.5.29 but is vulnerable; postcss's own fix, 8.5.30, stands as vite's required target.
    const affected = { "vite@8.3.2": [FIXED], "postcss@8.5.28": ["GHSA-postcss"], "postcss@8.5.29": ["GHSA-postcss"] };
    const joint: ChangePlan = { ...plan, packages: ["npm|postcss", "npm|vite"], moves: [plan.moves[0]!,
      { ...plan.moves[0]!, name: "postcss", from: "8.5.28", to: "8.5.30", mechanism: "npm-lock", locations: ["node_modules/postcss"], advisories: ["GHSA-postcss"] }] };
    const h = environment({ affected });
    const computed = await requiredNpmPlan(tree(files()), joint, h.env);
    expect(computed.moves).toEqual(joint.moves);
    expect(computed.requiredNpm).toMatchObject([{ name: "postcss", version: "8.5.30", exempt: true, root: { name: "vite" } }]);
    expect(computed.coupled).toContainEqual(["npm|vite", "npm|postcss"]);
    // vite depends on postcss's fix: a retry that drops postcss drops vite too.
    expect(retryWithoutNamed(computed, ["compare: postcss@8.5.30 adds an advisory"]).plan).toBeUndefined();
    expect((await runCompare(tree(files()), tree(files("8.3.3", "8.5.30"), "head"), h.env)).failures).toEqual([]);
  });

  it("plans two security roots without rejecting one over a hypothetical aged bridge's requirement", async () => {
    const batch = bridgeBatch();
    const fix = (name: string, advisory: string) => ({ ...plan.moves[0]!, name, from: "1.0.0", to: "1.0.1", locations: [`node_modules/${name}`], advisories: [advisory] });
    const joint: ChangePlan = { ...plan, packages: ["npm|app", "npm|lib"], moves: [fix("app", FIXED), { ...fix("lib", "GHSA-lib"), mechanism: "npm-lock" }] };
    await expect(requiredNpmPlan(tree(batch.base), joint, environment(batch).env)).resolves.toEqual(joint);
  });

  it("keeps an aged fix that requires another aged fix's young requirement with it, so the cooldown holds both", async () => {
    const batch = chainBatch();
    const fix = (name: string, advisory: string, mechanism: PlannedMove["mechanism"]) => ({ ...plan.moves[0]!, name, from: "1.0.0", to: "1.0.1", mechanism, locations: [`node_modules/${name}`], advisories: [advisory] });
    const joint: ChangePlan = { ...plan, packages: ["npm|a", "npm|b"], moves: [fix("a", FIXED, "npm-direct"), fix("b", "GHSA-b", "npm-lock")] };
    const h = environment(batch);
    const computed = await requiredNpmPlan(tree(batch.base), joint, h.env);
    // holdRequiredYoung moves every root with an exempt target: a as well as b.
    expect(computed.requiredNpm?.filter((target) => target.exempt).map((target) => [target.root.name, target.name, target.version]).sort())
      .toEqual([["a", "c", "1.0.1"], ["b", "c", "1.0.1"]]);
    expect((await runCompare(tree(batch.base), tree(batch.head, "head"), h.env)).failures).toEqual([]);
  });

  it("does not exempt PostCSS when an aged version satisfies the security root", async () => {
    const doc = { ...vite, versions: { ...vite.versions, "8.3.3": { ...metadata, dependencies: { postcss: "^8.5.28" } } } };
    expect(await requiredNpmPlan(tree(files()), plan, environment({ docs: { vite: doc } }).env)).toEqual(plan);
  });

  it("blocks an unsafe lowest version rather than substituting a higher young one", async () => {
    const env = environment({ affected: { "postcss@8.5.29": ["GHSA-new"] } }).env;
    await expect(requiredNpmPlan(tree(files()), plan, env)).rejects.toThrow("required version postcss@8.5.29 adds GHSA-new");
  });

  it("blocks a required version whose reviewed advisory the base copy has only from the project's repository advisories", async () => {
    // The repository's range covers both postcss versions; OSV reports the group only on the required 8.5.29.
    const manifest = { body: { repository: "github:postcss/postcss" } };
    const routes = {
      "https://registry.npmjs.org/postcss/8.5.28": manifest,
      "https://registry.npmjs.org/postcss/8.5.29": manifest,
      "https://registry.npmjs.org/postcss/8.5.30": manifest,
      "https://api.github.com/repos/postcss/postcss/security-advisories?state=published&per_page=100": { body: [{
        ghsa_id: "GHSA-wide", cve_id: null, state: "published", withdrawn_at: null, severity: "medium", cwe_ids: [],
        vulnerabilities: [{ package: { ecosystem: "npm", name: "postcss" }, vulnerable_version_range: ">=8.5.0,<8.6.0", patched_versions: "8.6.0" }],
      }] },
    };
    const refused = environment({ affected: { "vite@8.3.2": [FIXED], "postcss@8.5.29": ["GHSA-wide"] }, routes }).env;
    await expect(requiredNpmPlan(tree(files()), plan, refused)).rejects.toThrow(
      "required version postcss@8.5.29 adds GHSA-wide (the base copies have it only from the project's repository advisories)");
    // Once OSV reports it on the base copy too, it's inherited.
    const inherited = environment({ affected: { "vite@8.3.2": [FIXED], "postcss@8.5.28": ["GHSA-wide"], "postcss@8.5.29": ["GHSA-wide"] }, routes }).env;
    expect((await requiredNpmPlan(tree(files()), plan, inherited)).requiredNpm).toMatchObject([{ name: "postcss", version: "8.5.29" }]);
    // Or on another base copy of postcss, whichever the lockfile lists first: the base copies count together.
    const another = { ...routes, "https://registry.npmjs.org/postcss/8.5.27": manifest };
    const tool = { time: { "1.0.0": OLD }, versions: { "1.0.0": metadata } };
    const withOlder = { time: { ...postcss.time, "8.5.27": OLD }, versions: { ...postcss.versions, "8.5.27": metadata } };
    const reviewedElsewhere = environment({ docs: { tool, postcss: withOlder }, affected: { "vite@8.3.2": [FIXED], "postcss@8.5.27": ["GHSA-wide"], "postcss@8.5.29": ["GHSA-wide"] }, routes: another }).env;
    const repositoryOnly = environment({ docs: { tool, postcss: withOlder }, affected: { "vite@8.3.2": [FIXED], "postcss@8.5.29": ["GHSA-wide"] }, routes: another }).env;
    for (const first of [true, false]) {
      const lock = JSON.parse(files()["package-lock.json"]!);
      const nested = { "node_modules/tool": locked("tool", "1.0.0"), "node_modules/tool/node_modules/postcss": locked("postcss", "8.5.27") };
      lock.packages = first ? { "": lock.packages[""], ...nested, ...lock.packages } : { ...lock.packages, ...nested };
      const twoCopies = { ...files(), "package-lock.json": json(lock) };
      expect((await requiredNpmPlan(tree(twoCopies), plan, reviewedElsewhere)).requiredNpm).toMatchObject([{ name: "postcss", version: "8.5.29" }]);
      await expect(requiredNpmPlan(tree(twoCopies), plan, repositoryOnly)).rejects.toThrow("required version postcss@8.5.29 adds GHSA-wide");
    }
  });

  it("blocks identity changes on the lowest required version", async () => {
    const doc = { ...postcss, versions: { ...postcss.versions, "8.5.29": { ...metadata, _npmUser: { name: "new-publisher" } } } };
    await expect(requiredNpmPlan(tree(files()), plan, environment({ docs: { postcss: doc } }).env)).rejects.toThrow("hadn't published");
  });

  it("judges identity against the copy the requirement replaces, never a retained one's later history", async () => {
    // A retained nested 8.5.40 by the new publisher would put them in the history; only 8.5.28 at the target path is replaced.
    const doc = { time: { ...postcss.time, "8.5.40": YOUNG }, versions: { ...postcss.versions,
      "8.5.29": { ...metadata, _npmUser: { name: "new-publisher" } }, "8.5.40": { ...metadata, _npmUser: { name: "new-publisher" } } } };
    const original = files();
    const lock = JSON.parse(original["package-lock.json"]!);
    lock.packages["node_modules/x/node_modules/postcss"] = locked("postcss", "8.5.40");
    original["package-lock.json"] = json(lock);
    await expect(requiredNpmPlan(tree(original), plan, environment({ docs: { postcss: doc } }).env)).rejects.toThrow("hadn't published");
  });

  it("still checks a required version's own provenance where it replaces no copy", async () => {
    const doc = { ...postcss, versions: { ...postcss.versions, "8.5.29": { ...metadata,
      dist: { attestations: { url: "https://example.com/x", provenance: { predicateType: "https://slsa.dev/provenance/v1" } } } } } };
    await expect(requiredNpmPlan(tree(files("8.3.2", undefined)), plan, environment({ docs: { postcss: doc } }).env)).rejects.toThrow("malformed attestations");
  });

  it("expands a required direct companion without crossing its compatible line", async () => {
    const original = files();
    const lock = JSON.parse(original["package-lock.json"]!);
    lock.packages[""].devDependencies.postcss = "^8.5.28";
    original["package.json"] = json(lock.packages[""]);
    original["package-lock.json"] = json(lock);
    const result = await requiredNpmPlan(tree(original), plan, environment().env);
    expect(result.moves).toContainEqual(expect.objectContaining({ name: "postcss", to: "8.5.29", mechanism: "npm-direct", major: false }));
    const newMajor = { time: { "8.5.28": OLD, "9.0.0": YOUNG }, versions: { "8.5.28": metadata, "9.0.0": metadata } };
    const root = { ...vite, versions: { ...vite.versions, "8.3.3": { ...metadata, dependencies: { postcss: "^9" } } } };
    await expect(requiredNpmPlan(tree(original), plan, environment({ docs: { vite: root, postcss: newMajor } }).env)).rejects.toThrow("no stable non-deprecated version satisfies");
  });
  it("records an aged bridge only when its descendant needs a young exemption", async () => {
    const root = { ...vite, versions: { ...vite.versions, "8.3.3": { ...metadata, dependencies: { bridge: "^1" } } } };
    const bridge = { time: { "1.0.0": OLD }, versions: { "1.0.0": { ...metadata, dependencies: { postcss: "^8.5.29" } } } };
    const result = await requiredNpmPlan(tree(files()), plan, environment({ docs: { vite: root, bridge } }).env);
    expect(result.requiredNpm?.map((target) => [target.name, target.version, target.exempt])).toEqual([["bridge", "1.0.0", false], ["postcss", "8.5.29", true]]);
  });

  it("keeps existing compatibility pins as constraints instead of silently widening them", async () => {
    const original = files();
    const manifest = JSON.parse(original["package.json"]!);
    manifest.overrides = { postcss: "8.5.28" };
    original["package.json"] = json(manifest);
    await expect(requiredNpmPlan(tree(original), plan, environment().env)).rejects.toThrow("no stable non-deprecated version satisfies");
  });

  it("supports a major security root in a cycle with a compatible young direct peer", async () => {
    const root = { ...vite, time: { ...vite.time, "9.0.0": YOUNG }, versions: { "8.3.2": metadata,
      "9.0.0": { ...metadata, peerDependencies: { plugin: "^1.0.1" } },
    } };
    const plugin = { time: { "1.0.0": OLD, "1.0.1": YOUNG }, versions: {
      "1.0.0": { ...metadata, peerDependencies: { vite: "^8" } },
      "1.0.1": { ...metadata, peerDependencies: { vite: "^9" } },
    } };
    const original = files();
    const lock = JSON.parse(original["package-lock.json"]!);
    lock.packages[""].devDependencies.plugin = "^1.0.0";
    lock.packages["node_modules/plugin"] = locked("plugin", "1.0.0");
    original["package.json"] = json(lock.packages[""]);
    original["package-lock.json"] = json(lock);
    const env = environment({ docs: { vite: root, plugin } }).env;
    const major = { ...plan, kind: "major" as const, moves: [{ ...plan.moves[0]!, to: "9.0.0", major: true }] };
    const result = await requiredNpmPlan(tree(original), major, env);
    expect(result.requiredNpm?.some((target) => target.name === "plugin" && target.version === "1.0.1")).toBe(true);
    lock.packages["node_modules/vite"] = locked("vite", "9.0.0");
    lock.packages["node_modules/plugin"] = locked("plugin", "1.0.1");
    lock.packages[""].devDependencies = { vite: "^9.0.0", plugin: "^1.0.1" };
    const head = { "package.json": json(lock.packages[""]), "package-lock.json": json(lock) };
    expect((await runCompare(tree(original), tree(head, "head"), env)).failures).toEqual([]);
  });

  it("can introduce a required copy while an unrelated compatibility override stays intact", async () => {
    const original = files("8.3.2", undefined);
    const manifest = JSON.parse(original["package.json"]!);
    manifest.overrides = { other: "1.0.0" };
    const lock = JSON.parse(original["package-lock.json"]!);
    lock.packages["node_modules/other"] = locked("other", "1.0.0");
    original["package.json"] = json(manifest);
    original["package-lock.json"] = json(lock);
    const other = { time: { "1.0.0": OLD }, versions: { "1.0.0": metadata } };
    const computed = await requiredNpmPlan(tree(original), plan, environment({ docs: { other } }).env);
    expect(computed.requiredNpm).toMatchObject([{ name: "postcss", version: "8.5.29" }]);
  });

});

describe("why a required version is refused", () => {
  const pkg = { ecosystem: "npm" as const, name: "c", version: "1.0.1" };
  const advisory = (id: string, source: Advisory["source"] = "osv"): Advisory => ({ id, ids: [id], source, malicious: id.startsWith("MAL-"), summary: undefined, severity: undefined });
  const snapshot = (advisories: Advisory[]) => new Snapshot(new Map([["npm|c|1.0.1", advisories]]), [], NOW);

  it("names each new group, marks the unreviewed ones, and lists malware even inherited", () => {
    const found = snapshot([advisory("GHSA-new"), advisory("GHSA-repo", "repository"), advisory("GHSA-old"), advisory("MAL-c")]);
    expect(addedAdvisories(found, pkg, new Map([["GHSA-old", true], ["MAL-c", true]]))).toBe(
      "required version c@1.0.1 adds malware (MAL-c); GHSA-new; GHSA-repo (only in the project's repository advisories, not corroborated by the sources this decision used)");
  });

  it("finds nothing when every group is inherited", () => {
    expect(addedAdvisories(snapshot([advisory("GHSA-old", "repository")]), pkg, new Map([["GHSA-old", false]]))).toBeUndefined();
  });

  it.each([
    { base: "osv", required: "osv", added: false },
    { base: "osv", required: "repository", added: false },
    { base: "repository", required: "repository", added: false },
    { base: "repository", required: "osv", added: true },
  ] as const)("inherits a $required group from a $base one on the base copies only when review allows it (added: $added)", ({ base, required, added }) => {
    const baseline = new Map([["GHSA-x", base !== "repository"]]);
    expect(addedAdvisories(snapshot([advisory("GHSA-x", required)]), pkg, baseline)).toBe(added
      ? "required version c@1.0.1 adds GHSA-x (the base copies have it only from the project's repository advisories)"
      : undefined);
  });
});
