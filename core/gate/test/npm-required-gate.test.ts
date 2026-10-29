import { describe, expect, it } from "vitest";

import { runCompare } from "../src/gate.ts";
import { environment, files, FIXED, json, metadata, OLD, postcss, tree, vite, locked, YOUNG, securityBatch, bridgeBatch } from "./required-fixture.ts";

describe("independently gated security requirements", () => {
  it("accepts synthetic Vite 8.3.3 and its lowest required young PostCSS on one snapshot", async () => {
    const h = environment();
    const outcome = await runCompare(tree(files()), tree(files("8.3.3", "8.5.29"), "head"), h.env);
    expect(outcome.failures).toEqual([]);
    expect(outcome.notes.join()).toContain("postcss@8.5.29 is the lowest satisfying version");
    expect(h.scans).toHaveLength(1);
  });

  it("lets no repository-only advisory make a young root, nor the young requirement it would bring", async () => {
    const h = environment({ affected: {} });
    const repository = { body: { repository: "github:vitejs/vite" } };
    const advisories = { body: [{ ghsa_id: "GHSA-vite-repo", state: "published", vulnerabilities: [{ package: { ecosystem: "npm", name: "vite" }, vulnerable_version_range: "< 8.3.3" }] }] };
    const env = { ...h.env, fetch: async (url: string, init?: Parameters<typeof h.env.fetch>[1]) => {
      if (/^https:\/\/registry\.npmjs\.org\/vite\/[^/]+$/.test(url)) return { ok: true, status: 200, headers: { get: () => null }, json: async () => repository.body, text: async () => "" };
      if (url === "https://api.github.com/repos/vitejs/vite/security-advisories?state=published&per_page=100") return { ok: true, status: 200, headers: { get: () => null }, json: async () => advisories.body, text: async () => "" };
      return h.env.fetch(url, init);
    } };
    const outcome = await runCompare(tree(files()), tree(files("8.3.3", "8.5.29"), "head"), env);
    expect(outcome.failures).toEqual(expect.arrayContaining([
      expect.stringContaining("vite@8.3.3 was published"),
      expect.stringContaining("it fixes no reviewed advisory affecting 8.3.2"),
      expect.stringContaining("postcss@8.5.29 was published"),
    ]));
  });

  it("reconstructs two independently proved security roots jointly on one snapshot", async () => {
    const batch = securityBatch();
    const h = environment(batch);
    const outcome = await runCompare(tree(batch.base), tree(batch.head, "head"), h.env);
    expect(outcome.failures).toEqual([]);
    expect(outcome.notes.join()).toContain("postcss@8.5.29 is the lowest satisfying version");
    expect(h.scans).toHaveLength(1);
  });

  it("does not trust an ordinary second root to narrow the shared requirement", async () => {
    const batch = securityBatch();
    const root = { ...batch.docs.vite, versions: {
      ...batch.docs.vite.versions, "8.3.3": { ...metadata, dependencies: { postcss: "^8.5.28" } },
    } };
    const env = environment({ docs: { ...batch.docs, vite: root }, affected: { "vite@8.3.2": ["GHSA-fixed"] } }).env;
    const outcome = await runCompare(tree(batch.base), tree(batch.head, "head"), env);
    expect(outcome.failures.join()).toContain("postcss");
    expect(outcome.notes.join()).not.toContain("lowest satisfying version");
  });

  it("keeps another verified security root's version where a fix's requirement reaches it", async () => {
    // vite's fix requires postcss ^8.5.29, but 8.5.29 is vulnerable too: postcss's own fix, 8.5.30, must stand.
    const affected = { "vite@8.3.2": [FIXED], "postcss@8.5.28": ["GHSA-postcss"], "postcss@8.5.29": ["GHSA-postcss"] };
    const outcome = await runCompare(tree(files()), tree(files("8.3.3", "8.5.30"), "head"), environment({ affected }).env);
    expect(outcome.failures).toEqual([]);
    expect(outcome.notes.join()).not.toContain("postcss@8.5.29");
  });

  it("doesn't reject another verified security root over a hypothetical aged bridge's requirement", async () => {
    const batch = bridgeBatch();
    const outcome = await runCompare(tree(batch.base), tree(batch.head, "head"), environment(batch).env);
    expect(outcome.failures).toEqual([]);
  });

  it("lets an installed optional dependency replace its same-key ordinary declaration", async () => {
    const root = { ...vite, versions: {
      ...vite.versions, "8.3.3": { ...metadata, dependencies: { postcss: "8.5.28" }, optionalDependencies: { postcss: "8.5.29" } },
    } };
    const outcome = await runCompare(tree(files()), tree(files("8.3.3", "8.5.29"), "head"), environment({ docs: { vite: root } }).env);
    expect(outcome.failures).toEqual([]);
    expect(outcome.notes.join()).toContain("postcss@8.5.29 is the lowest satisfying version");
  });

  it("supports a newly introduced required package without borrowing an old child's advisory", async () => {
    const outcome = await runCompare(tree(files("8.3.2", undefined)), tree(files("8.3.3", "8.5.29"), "head"), environment().env);
    expect(outcome.failures).toEqual([]);
  });

  it.each(["ordinary", "higher", "aged-alternative"])("refuses %s even with a forged plan annotation", async (scenario) => {
    const docs: NonNullable<Parameters<typeof environment>[0]>["docs"] = scenario === "aged-alternative" ? { postcss: { ...postcss, time: { ...postcss.time, "8.5.29": OLD } } }
      : {};
    const head = files("8.3.3", scenario === "higher" || scenario === "aged-alternative" ? "8.5.30" : "8.5.29");
    head["PLAN.md"] = "postcss@8.5.30 has a release-age exemption";
    const h = environment({ docs, ...(scenario === "ordinary" ? { affected: {} } : {}) });
    const outcome = await runCompare(tree(files()), tree(head, "head"), h.env);
    expect(outcome.failures.join()).toContain("postcss");
    expect(outcome.failures.length).toBeGreaterThan(0);
  });

  it("reads dependency ranges from the registry, not the PR's lock metadata or exact declaration", async () => {
    const root = { ...vite, versions: { ...vite.versions, "8.3.3": { ...metadata, dependencies: { postcss: "^8.5.28" } } } };
    const head = files("8.3.3", "8.5.29");
    const lock = JSON.parse(head["package-lock.json"]!);
    lock.packages["node_modules/vite"].dependencies.postcss = "8.5.29";
    lock.packages[""].devDependencies.postcss = "8.5.29";
    head["package-lock.json"] = json(lock);
    head["package.json"] = json(lock.packages[""]);
    const outcome = await runCompare(tree(files()), tree(head, "head"), environment({ docs: { vite: root } }).env);
    expect(outcome.failures.join()).toContain("postcss@8.5.29");
  });

  it("checks an aged rule-picked security root too", async () => {
    const doc = { ...vite, time: { ...vite.time, "8.3.3": OLD } };
    const outcome = await runCompare(tree(files()), tree(files("8.3.3", "8.5.29"), "head"), environment({ docs: { vite: doc } }).env);
    expect(outcome.failures).toEqual([]);
  });

  it("fails closed on unknown dates", async () => {
    const docs = { postcss: { ...postcss, time: { ...postcss.time, "8.5.30": undefined } } };
    await expect(runCompare(tree(files()), tree(files("8.3.3", "8.5.29"), "head"), environment({ docs }).env)).rejects.toThrow("publish time");
  });
  it("follows an aged bridge to a forced young child", async () => {
    const root = { ...vite, versions: { ...vite.versions, "8.3.3": { ...metadata, dependencies: { bridge: "^1" } } } };
    const bridge = { time: { "1.0.0": OLD }, versions: { "1.0.0": { ...metadata, dependencies: { postcss: "^8.5.29" } } } };
    const head = files("8.3.3", "8.5.29");
    const lock = JSON.parse(head["package-lock.json"]!);
    lock.packages["node_modules/bridge"] = locked("bridge", "1.0.0");
    head["package-lock.json"] = json(lock);
    const outcome = await runCompare(tree(files()), tree(head, "head"), environment({ docs: { vite: root, bridge } }).env);
    expect(outcome.failures).toEqual([]);
    expect(outcome.notes.join()).toContain("aged bridge@1.0.0 anchors");
  });

  it("does not exempt a young child caused by an optional ordinary upgrade of an aged bridge", async () => {
    const root = { ...vite, versions: { ...vite.versions, "8.3.3": { ...metadata, dependencies: { bridge: "^1" } } } };
    const bridge = { time: { "1.0.0": OLD, "1.1.0": OLD }, versions: {
      "1.0.0": { ...metadata, dependencies: { postcss: "^8.5.28" } },
      "1.1.0": { ...metadata, dependencies: { postcss: "^8.5.29" } },
    } };
    const original = files();
    const head = files("8.3.3", "8.5.29");
    for (const [data, version] of [[original, "1.0.0"], [head, "1.1.0"]] as const) {
      const lock = JSON.parse(data["package-lock.json"]!);
      lock.packages["node_modules/bridge"] = locked("bridge", version);
      data["package-lock.json"] = json(lock);
    }
    const outcome = await runCompare(tree(original), tree(head, "head"), environment({ docs: { vite: root, bridge } }).env);
    expect(outcome.failures.join()).toContain("postcss@8.5.29");
  });

  it("reports a recursion bound as a blocker rather than granting a partial proof", async () => {
    const root = { ...vite, versions: { ...vite.versions, "8.3.3": { ...metadata, dependencies: { child0: "1.0.0" } } } };
    const docs: NonNullable<NonNullable<Parameters<typeof environment>[0]>["docs"]> = { vite: root };
    const head = files("8.3.3", undefined);
    const lock = JSON.parse(head["package-lock.json"]!);
    for (let index = 0; index < 10; index++) {
      const name = `child${index}`;
      docs[name] = { time: { "1.0.0": YOUNG }, versions: { "1.0.0": { ...metadata, ...(index < 9 ? { dependencies: { [`child${index + 1}`]: "1.0.0" } } : {}) } } };
      lock.packages[`node_modules/${name}`] = locked(name, "1.0.0");
    }
    head["package-lock.json"] = json(lock);
    const outcome = await runCompare(tree(files()), tree(head, "head"), environment({ docs }).env);
    expect(outcome.failures.join()).toContain("required-dependency proof bound reached");
    expect(outcome.failures.join()).toContain("child0@1.0.0");
  });

  it.each([
    [undefined, "trustedPackages"],
    [undefined, "ownPackages"],
    ["trustedPackages", undefined],
    ["ownPackages", undefined],
    ["trustedPackages", "trustedPackages"],
    ["ownPackages", "trustedPackages"],
    ["trustedPackages", "ownPackages"],
  ])("uses head's trust across %s → %s while still proving the third-party requirement", async (baseField, headField) => {
    const original = files();
    const head = files("8.3.3", "8.5.29");
    for (const data of [original, head]) {
      const lock = JSON.parse(data["package-lock.json"]!);
      const root = lock.packages["node_modules/vite"];
      delete lock.packages["node_modules/vite"];
      lock.packages["node_modules/@acme/tool"] = { ...root, name: "@acme/tool", resolved: `https://registry.npmjs.org/@acme/tool/-/tool-${root.version}.tgz` };
      lock.packages[""].devDependencies = { "@acme/tool": `^${root.version}` };
      data["package.json"] = json(lock.packages[""]);
      data["package-lock.json"] = json(lock);
      const field = data === original ? baseField : headField;
      data[".github/supply-chain.json"] = json(field === undefined ? {} : { [field]: { npm: { scopes: ["@acme"] } } });
    }
    const env = environment({ docs: { "@acme/tool": vite }, affected: { "@acme/tool@8.3.2": ["GHSA-fixed"] } }).env;
    const outcome = await runCompare(tree(original), tree(head, "head"), env);
    expect(outcome.failures).toEqual([]);
    expect(outcome.cooldown.evaluated && outcome.cooldown.held.map((entry) => entry.name).sort()).toEqual(headField === undefined ? ["@acme/tool", "postcss"] : ["postcss"]);
    // A policy-only PR adds no changed versions to hold.
    const renamed = { ...original, ".github/supply-chain.json": head[".github/supply-chain.json"]! };
    const configOnly = await runCompare(tree(original), tree(renamed, "renamed"), env);
    expect(configOnly.failures).toEqual([]);
    expect(configOnly.cooldown).toEqual({ evaluated: true, releaseAgeDays: 7, held: [] });
  });

});
