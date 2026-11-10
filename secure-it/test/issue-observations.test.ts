import { describe, expect, it } from "vitest";

import type { Located } from "@leanish/gate/findings";
import { type Advisory, Snapshot } from "@leanish/gate/snapshot";

import { observationsOf } from "../src/issue-observations.ts";

const TODAY = "2026-11-05";

const advisory = (id: string, aliases: string[] = []): Advisory => ({ id, ids: [id, ...aliases], source: "osv", malicious: false, summary: undefined, severity: "HIGH" });
const npm = (name: string, version: string, locations = [`node_modules/${name}`]): Located => ({ ecosystem: "npm", name, version, locations });

/** A snapshot from `name@version` → advisories. */
function snapshot(affecting: Record<string, Advisory[]>): Snapshot {
  const entries = Object.entries(affecting).map(([key, advisories]) => {
    const at = key.lastIndexOf("@");
    return [`npm|${key.slice(0, at)}|${key.slice(at + 1)}`, advisories] as const;
  });
  return new Snapshot(new Map(entries), [], new Date(`${TODAY}T12:00:00Z`));
}

describe("observationsOf", () => {
  it("observes every finding of the scan, one per package and advisory group, keeping every alias", () => {
    const snap = snapshot({ "a@1.0.0": [advisory("GHSA-a")], "b@1.0.0": [advisory("GHSA-b", ["CVE-b"])] });
    expect(observationsOf([npm("b", "1.0.0"), npm("a", "1.0.0")], snap)).toEqual([
      { ecosystem: "npm", name: "a", ids: ["GHSA-a"], versions: ["1.0.0"], reviewed: true, malicious: false, severity: "HIGH" },
      { ecosystem: "npm", name: "b", ids: ["CVE-b", "GHSA-b"], versions: ["1.0.0"], reviewed: true, malicious: false, severity: "HIGH" },
    ]);
  });

  it("joins a group's versions", () => {
    const snap = snapshot({ "b@1.0.0": [advisory("GHSA-b")], "b@1.0.1": [advisory("GHSA-b")] });
    expect(observationsOf([npm("b", "1.0.0"), npm("b", "1.0.1", ["nested/node_modules/b"])], snap))
      .toMatchObject([{ name: "b", ids: ["GHSA-b"], versions: ["1.0.0", "1.0.1"] }]);
  });

  it("marks a group malicious when any of its findings is", () => {
    const snap = snapshot({ "b@1.0.0": [{ ...advisory("GHSA-b"), malicious: true }] });
    expect(observationsOf([npm("b", "1.0.0")], snap)).toMatchObject([{ name: "b", ids: ["GHSA-b"], malicious: true }]);
  });
});
