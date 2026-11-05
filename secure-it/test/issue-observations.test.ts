import { describe, expect, it } from "vitest";

import { NO_EXCEPTIONS, parseExceptions } from "@leanish/gate/exceptions";
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

const exception = (overrides: Record<string, unknown> = {}) =>
  parseExceptions({ vulnerabilities: [{ id: "GHSA-b", package: "b", version: "1.0.0", paths: ["node_modules/b"], reason: "build only", expires: "2027-01-01", ...overrides }] });

describe("observationsOf", () => {
  it("splits the scan's findings by whether a valid exception covers them, keeping every alias", () => {
    const snap = snapshot({ "a@1.0.0": [advisory("GHSA-a")], "b@1.0.0": [advisory("GHSA-b", ["CVE-b"])] });
    const { observed, excepted } = observationsOf([npm("a", "1.0.0"), npm("b", "1.0.0")], snap, exception(), TODAY);
    expect(observed).toEqual([{ ecosystem: "npm", name: "a", ids: ["GHSA-a"], versions: ["1.0.0"], reviewed: true, malicious: false, severity: "HIGH" }]);
    expect(excepted).toEqual([{ ecosystem: "npm", name: "b", ids: ["CVE-b", "GHSA-b"] }]);
  });

  it("puts a group in both when its exception covers only some of its versions", () => {
    const snap = snapshot({ "b@1.0.0": [advisory("GHSA-b")], "b@1.0.1": [advisory("GHSA-b")] });
    const { observed, excepted } = observationsOf([npm("b", "1.0.0"), npm("b", "1.0.1", ["nested/node_modules/b"])], snap, exception(), TODAY);
    expect(observed).toMatchObject([{ name: "b", ids: ["GHSA-b"], versions: ["1.0.1"] }]);
    expect(excepted).toEqual([{ ecosystem: "npm", name: "b", ids: ["GHSA-b"] }]);
  });

  it("keeps a group observed when its exception covers only some of a version's locations", () => {
    const snap = snapshot({ "b@1.0.0": [advisory("GHSA-b")] });
    const { observed, excepted } = observationsOf([npm("b", "1.0.0", ["node_modules/b", "nested/node_modules/b"])], snap, exception(), TODAY);
    expect(observed).toMatchObject([{ name: "b", ids: ["GHSA-b"], versions: ["1.0.0"] }]);
    expect(excepted).toEqual([]);
  });

  it("never excepts malware, even under an id an exception names", () => {
    // The exceptions file refuses MAL- ids itself; an advisory marked malicious under another id is the case left.
    const snap = snapshot({ "b@1.0.0": [{ ...advisory("GHSA-b"), malicious: true }] });
    const { observed, excepted } = observationsOf([npm("b", "1.0.0")], snap, exception(), TODAY);
    expect(observed).toMatchObject([{ name: "b", ids: ["GHSA-b"], malicious: true }]);
    expect(excepted).toEqual([]);
  });

  it("excepts nothing once an exception expired, or when there is none", () => {
    const snap = snapshot({ "b@1.0.0": [advisory("GHSA-b")] });
    for (const exceptions of [exception({ expires: "2026-11-04" }), NO_EXCEPTIONS]) {
      const { observed, excepted } = observationsOf([npm("b", "1.0.0")], snap, exceptions, TODAY);
      expect(observed).toMatchObject([{ name: "b", ids: ["GHSA-b"] }]);
      expect(excepted).toEqual([]);
    }
  });
});
