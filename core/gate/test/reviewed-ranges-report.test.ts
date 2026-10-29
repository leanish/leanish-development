import { describe, expect, it } from "vitest";

import { securityCandidates, bumpCandidates } from "../src/candidates.ts";
import { runCompare, runScan } from "../src/gate.ts";
import { markdownSummary, REPORT_SCHEMA_VERSION } from "../src/report.ts";
import { environment, files, tree } from "./required-fixture.ts";

const GHSA = "GHSA-reviewed-ranges";

describe("reviewed-range decisions in the gate report", () => {
  it.each(["compare", "scan"] as const)("puts a drop in Notes, with no coverage gap, for %s", async (mode) => {
    const source = files();
    const { env } = environment({ affected: {}, routes: {
      "https://registry.npmjs.org/vite/8.3.2": { body: { repository: "github:owner/project" } },
      "https://registry.npmjs.org/postcss/8.5.28": { body: { repository: "github:owner/project" } },
      "https://api.github.com/repos/owner/project/security-advisories?state=published&per_page=100": { body: [{
        ghsa_id: GHSA, state: "published", vulnerabilities: [
          { package: { ecosystem: "npm", name: "vite" }, vulnerable_version_range: "<9.0.0" },
        ],
      }] },
      [`https://api.osv.dev/v1/vulns/${GHSA}`]: { body: { id: GHSA, affected: [
        { package: { ecosystem: "npm", name: "vite" }, versions: ["8.3.1"] },
      ] } },
    } });
    const outcome = mode === "compare"
      ? await runCompare(tree(source), tree(source, "head"), env)
      : await runScan(tree(source, "head"), env);
    expect(outcome.failures).toEqual([]);
    expect(outcome.gaps).toEqual([]);
    expect(outcome.notes).toEqual([expect.stringContaining("the reviewed ranges apply")]);
    const summary = markdownSummary({
      ...outcome, schemaVersion: REPORT_SCHEMA_VERSION, mode, tool: { commit: undefined, osvScanner: outcome.osvScannerVersion },
      configDigest: "default", baseSha: mode === "compare" ? "base" : undefined, headSha: "head",
      startedAt: env.now().toISOString(), completedAt: env.now().toISOString(),
      completed: true, verdict: "pass", error: undefined, cooldown: undefined,
    });
    expect(summary).toContain(`### Notes (1)\n\n- ${outcome.notes[0]}`);
    expect(summary).not.toContain("Coverage gaps");
  });

  it.each(["security", "bump"] as const)("preserves snapshot notes for %s planning even without a security fix", async (mode) => {
    const { env } = environment({ affected: {}, routes: {
      "https://registry.npmjs.org/vite/8.3.2": { body: { repository: "github:owner/project" } },
      "https://registry.npmjs.org/postcss/8.5.28": { body: { repository: "github:owner/project" } },
      "https://api.github.com/repos/owner/project/security-advisories?state=published&per_page=100": { body: [{
        ghsa_id: GHSA, state: "published", vulnerabilities: [
          { package: { ecosystem: "npm", name: "vite" }, vulnerable_version_range: "<9.0.0" },
        ],
      }] },
      [`https://api.osv.dev/v1/vulns/${GHSA}`]: { body: { id: GHSA, affected: [
        { package: { ecosystem: "npm", name: "vite" }, versions: ["8.3.1"] },
      ] } },
    } });
    const source = tree(files(), "head");
    const outcome = mode === "security" ? await securityCandidates(source, env) : await bumpCandidates(source, env);
    expect(outcome.notes).toContainEqual(expect.stringContaining("the reviewed ranges apply"));
    expect(outcome.gaps.some((gap) => gap.includes("the reviewed ranges apply"))).toBe(false);
    if ("fixes" in outcome) expect(outcome.fixes).toEqual([]);
  });

});
