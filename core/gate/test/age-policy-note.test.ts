import { describe, expect, it } from "vitest";

import { runCompare } from "../src/gate.ts";
import { markdownSummary, REPORT_SCHEMA_VERSION } from "../src/report.ts";
import { environment, files, json, tree } from "./required-fixture.ts";

const changed = "This PR changes the release-age policy in .github/supply-chain.json; head's policy applies to this comparison.";
const unknown = "The comparison couldn't tell whether the release-age policy changed because base's .github/supply-chain.json couldn't be read or parsed; head's policy applies.";

async function compare(base: string | undefined, head: string | undefined) {
  const configured = (config: string | undefined) => ({ ...files(), ...(config === undefined ? {} : { ".github/supply-chain.json": config }) });
  return runCompare(tree(configured(base)), tree(configured(head), "head"), environment({ affected: {} }).env);
}

describe("a note about changes to the policy judging the PR", () => {
  it.each([0, 1, 14])("notes a changed releaseAgeDays of %s even when nothing is held", async (releaseAgeDays) => {
    const outcome = await compare(undefined, json({ releaseAgeDays }));
    expect(outcome.failures).toEqual([]);
    expect(outcome.cooldown).toEqual({ evaluated: true, releaseAgeDays, held: [] });
    expect(outcome.notes).toEqual([changed]);
  });

  it.each([
    { npm: { scopes: ["@acme"] } },
    { Maven: { groups: ["com.acme"] } },
    { Maven: { pluginIdPrefixes: ["com.acme."] } },
    { "GitHub Actions": { owners: ["acme"] } },
  ])("notes added or removed trust: %j", async (trustedPackages) => {
    const policy = json({ trustedPackages });
    expect((await compare("{}", policy)).notes).toEqual([changed]);
    expect((await compare(policy, "{}")).notes).toEqual([changed]);
  });

  it("gives one note for several changes, including replacement of trust", async () => {
    expect((await compare(
      json({ releaseAgeDays: 1, trustedPackages: { npm: { scopes: ["@old"] } } }),
      json({ releaseAgeDays: 14, trustedPackages: { npm: { scopes: ["@new"] } } }),
    )).notes).toEqual([changed]);
  });

  it("notes deletion even when the file specified only defaults", async () => {
    expect((await compare("{}", undefined)).notes).toEqual([changed]);
  });

  it.each(["{", json({ releaseAgeDays: "invalid" }), json({ trustedPackages: null })])("notes an unparseable base without failing: %s", async (base) => {
    const outcome = await compare(base, "{}");
    expect(outcome.failures).toEqual([]);
    expect(outcome.cooldown).toEqual({ evaluated: true, releaseAgeDays: 7, held: [] });
    expect(outcome.notes).toEqual([unknown]);
  });

  it.each([
    [undefined, undefined],
    [undefined, "{}"],
    ["{}", json({ releaseAgeDays: 7, npm: { registries: ["https://registry.npmjs.org"] } })],
    [json({ ownPackages: { npm: { scopes: ["@b", "@a"] }, "GitHub Actions": { owners: ["ACME"] } } }),
      json({ trustedPackages: { "GitHub Actions": { owners: ["acme"] }, npm: { scopes: ["@a", "@b"] } } })],
  ])("omits the note for equivalent age policies (%s -> %s)", async (base, head) => {
    expect((await compare(base, head)).notes).toEqual([]);
  });

  it("reads only base's config for the note, ignoring malformed exceptions", async () => {
    const base = tree({ ...files(), ".github/supply-chain-exceptions.json": "{" });
    const outcome = await runCompare(base, tree(files(), "head"), environment({ affected: {} }).env);
    expect(outcome.failures).toEqual([]);
    expect(outcome.notes).toEqual([]);
  });

  it("notes an unreadable base policy without failing", async () => {
    const base = tree(files());
    const outcome = await runCompare({ ...base, read: async (path) => {
      if (path === ".github/supply-chain.json") throw new Error("unreadable config");
      return base.read(path);
    } }, tree(files(), "head"), environment({ affected: {} }).env);
    expect(outcome.failures).toEqual([]);
    expect(outcome.notes).toEqual([unknown]);
  });

  it("shows the note in the step summary with an empty held list", async () => {
    const outcome = await compare(undefined, json({ releaseAgeDays: 1 }));
    const summary = markdownSummary({
      ...outcome, schemaVersion: REPORT_SCHEMA_VERSION, mode: "compare", tool: { commit: undefined, osvScanner: outcome.osvScannerVersion },
      configDigest: "default", baseSha: "base", headSha: "head", startedAt: "2026-10-09T05:05:00Z", completedAt: "2026-10-09T05:05:00Z",
      completed: true, verdict: "pass", error: undefined,
    });
    expect(summary).toContain(`### Notes (1)\n\n- ${changed}`);
    expect(summary).not.toContain("Held by");
  });
});
