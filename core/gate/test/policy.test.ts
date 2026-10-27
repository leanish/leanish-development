import { describe, expect, it } from "vitest";

import { NO_EXCEPTIONS, parseExceptions } from "../src/exceptions.ts";
import { compareFindings, findingsOf, type Located } from "../src/findings.ts";
import { comparisonVerdict, scanVerdict } from "../src/policy.ts";
import { type Advisory, Snapshot } from "../src/snapshot.ts";

const TODAY = "2026-10-06";

function advisory(id: string, aliases: string[] = [], options: Partial<Advisory> = {}): Advisory {
  return { id, ids: [id, ...aliases], source: "osv", malicious: false, summary: undefined, severity: undefined, ...options };
}

function npm(name: string, version: string, locations = [`node_modules/${name}`]): Located {
  return { ecosystem: "npm", name, version, locations };
}

/** A snapshot from `name@version` → advisories. */
function snapshot(affecting: Record<string, Advisory[]>): Snapshot {
  const entries = Object.entries(affecting).map(([key, advisories]) => {
    const at = key.lastIndexOf("@");
    return [`npm|${key.slice(0, at)}|${key.slice(at + 1)}`, advisories] as const;
  });
  return new Snapshot(new Map(entries), [], new Date(`${TODAY}T12:00:00Z`));
}

function verdict(base: Located[], head: Located[], snap: Snapshot, exceptions = NO_EXCEPTIONS) {
  return comparisonVerdict(compareFindings(findingsOf(base, snap), findingsOf(head, snap)), exceptions, snap, TODAY);
}

describe("comparison policy", () => {
  it("passes an upgrade that fixes A while B stays, reporting B as inherited and A as fixed", () => {
    const snap = snapshot({
      "lib@1.0.0": [advisory("GHSA-a"), advisory("GHSA-b")],
      "lib@1.1.0": [advisory("GHSA-b")],
    });
    const result = verdict([npm("lib", "1.0.0")], [npm("lib", "1.1.0")], snap);
    expect(result.failures).toEqual([]);
    expect(result.warnings).toEqual(["inherited: lib@1.1.0: GHSA-b"]);
    expect(result.notes).toEqual(["fixed: lib@1.0.0: GHSA-a"]);
  });

  it("warns on a new advisory for a dependency both sides share", () => {
    // Published after base was merged: both sides read it from the same snapshot.
    const snap = snapshot({ "lib@1.0.0": [advisory("GHSA-new")], "other@2.0.0": [] });
    const result = verdict([npm("lib", "1.0.0")], [npm("lib", "1.0.0"), npm("other", "2.0.0")], snap);
    expect(result.failures).toEqual([]);
    expect(result.warnings).toEqual(["inherited: lib@1.0.0: GHSA-new"]);
  });

  it("fails a finding the PR adds, by a new package or by a version that brings a new advisory", () => {
    const snap = snapshot({
      "lib@1.0.0": [advisory("GHSA-b")],
      "lib@2.0.0": [advisory("GHSA-b"), advisory("GHSA-c")],
      "added@1.0.0": [advisory("GHSA-d")],
    });
    const result = verdict([npm("lib", "1.0.0")], [npm("lib", "2.0.0"), npm("added", "1.0.0")], snap);
    expect(result.failures).toEqual(["new: lib@2.0.0: GHSA-c has no exception", "new: added@1.0.0: GHSA-d has no exception"]);
  });

  it.each([
    { difference: "package", ecosystem: "npm", name: "added" },
    { difference: "ecosystem", ecosystem: "Maven", name: "lib" },
  ] as const)("blocks the same advisory on an added finding with a different $difference", ({ ecosystem, name }) => {
    const existing = npm("lib", "1.0.0");
    const added: Located = { ecosystem, name, version: "1.0.0", locations: ["added"] };
    const snap = new Snapshot(new Map([existing, added].map((pkg) => [
      `${pkg.ecosystem}|${pkg.name}|${pkg.version}`, [advisory("GHSA-shared")],
    ])), [], new Date(`${TODAY}T12:00:00Z`));
    const result = verdict([existing], [existing, added], snap);
    expect(result.failures).toEqual([`new: ${name}@1.0.0: GHSA-shared has no exception`]);
    expect(result.warnings).toEqual(["inherited: lib@1.0.0: GHSA-shared"]);
  });

  it("counts a finding as the same across versions and copies of a package", () => {
    const snap = snapshot({ "lib@1.0.0": [advisory("GHSA-b")], "lib@1.0.1": [advisory("GHSA-b")] });
    const result = verdict([npm("lib", "1.0.0")], [npm("lib", "1.0.0"), npm("lib", "1.0.1", ["node_modules/x/node_modules/lib"])], snap);
    expect(result.failures).toEqual([]);
    expect(result.warnings).toHaveLength(2);
  });

  it("fails malware in head even when base already had it, bundled copies included", () => {
    const mal = advisory("MAL-2026-1", [], { malicious: true });
    const snap = snapshot({ "evil@1.0.0": [mal] });
    const bundled = npm("evil", "1.0.0", ["node_modules/cdk/node_modules/evil"]);
    const result = verdict([bundled], [bundled], snap);
    expect(result.failures).toEqual(["inherited: evil@1.0.0: MAL-2026-1 is a known-malicious package (no exception can cover it)"]);
  });

  it("passes removing malware", () => {
    const snap = snapshot({ "evil@1.0.0": [advisory("MAL-2026-1", [], { malicious: true })] });
    expect(verdict([npm("evil", "1.0.0")], [], snap).failures).toEqual([]);
  });

  it("matches findings across sources and ids through their aliases", () => {
    // Base's version is known to OSV under the CVE; head's to the repository under the GHSA.
    const snap = snapshot({
      "lib@1.0.0": [advisory("CVE-2026-1", ["GHSA-x"])],
      "lib@1.0.1": [advisory("GHSA-x", [], { source: "repository" })],
    });
    const result = verdict([npm("lib", "1.0.0")], [npm("lib", "1.0.1")], snap);
    expect(result.failures).toEqual([]);
    expect(result.warnings).toEqual(["inherited: lib@1.0.1: GHSA-x"]);
  });

  it("joins alias chains into one group with a stable canonical id", () => {
    const snap = snapshot({ "lib@1.0.0": [advisory("CVE-2026-1", ["GHSA-zz"]), advisory("PYSEC-1", ["CVE-2026-1", "GHSA-aa"])] });
    expect(snap.group("PYSEC-1")).toBe("GHSA-aa");
    expect(snap.group("GHSA-zz")).toBe("GHSA-aa");
    expect(findingsOf([npm("lib", "1.0.0")], snap).map((f) => [f.advisory, f.ids])).toEqual([
      ["GHSA-aa", ["CVE-2026-1", "GHSA-aa", "GHSA-zz", "PYSEC-1"]],
    ]);
  });

  it("lets an exception cover an added finding by any alias, only at the paths it names and until it expires", () => {
    const snap = snapshot({ "lib@1.0.0": [advisory("GHSA-v", ["CVE-2026-9"])] });
    const head = [npm("lib", "1.0.0", ["node_modules/lib", "node_modules/cdk/node_modules/lib"])];
    const excepted = (paths: string[], expires = "2026-12-31", id = "CVE-2026-9") =>
      parseExceptions({ vulnerabilities: [{ id, package: "lib", version: "1.0.0", paths, reason: "not reachable", expires }] });
    expect(verdict([], head, snap, excepted(["node_modules/lib", "node_modules/cdk/node_modules/lib"])).failures).toEqual([]);
    expect(verdict([], head, snap, excepted(["node_modules/cdk/node_modules/lib"])).failures).toEqual([
      "new: lib@1.0.0: GHSA-v at node_modules/lib isn't covered by its exception's paths",
    ]);
    expect(verdict([], head, snap, excepted(["node_modules/lib", "node_modules/cdk/node_modules/lib"], "2026-10-05")).failures).toEqual([
      "new: lib@1.0.0: GHSA-v: its exception expired on 2026-10-05",
    ]);
  });

  it("never lets an exception cover malware, even under a GHSA id tagged CWE-506", () => {
    const snap = snapshot({ "hijacked@0.7.29": [advisory("GHSA-m", [], { malicious: true })] });
    const excepted = parseExceptions({
      vulnerabilities: [{ id: "GHSA-m", package: "hijacked", version: "0.7.29", paths: ["node_modules/hijacked"], reason: "trust me", expires: "2027-01-01" }],
    });
    expect(verdict([], [npm("hijacked", "0.7.29")], snap, excepted).failures).toEqual([
      "new: hijacked@0.7.29: GHSA-m is a known-malicious package (no exception can cover it)",
    ]);
  });
});

describe("inheritance by review status", () => {
  const sourced = (id: string, source: Advisory["source"], aliases: string[] = [], malicious = false) => advisory(id, aliases, { source, malicious });
  const action = (name: string, version: string): Located => ({ ecosystem: "GitHub Actions", name, version, locations: [".github/workflows/ci.yml"] });

  it.each([
    { base: "osv", head: "osv", inherited: true },
    { base: "osv", head: "repository", inherited: true },
    { base: "repository", head: "repository", inherited: true },
    { base: "repository", head: "osv", inherited: false },
  ] as const)("a $head finding over a $base one on base is inherited: $inherited", ({ base, head, inherited }) => {
    const snap = snapshot({ "lib@1.0.0": [sourced("GHSA-x", base)], "lib@2.0.0": [sourced("GHSA-x", head)] });
    const comparison = compareFindings(findingsOf([npm("lib", "1.0.0")], snap), findingsOf([npm("lib", "2.0.0")], snap));
    expect(comparison.inherited.map((finding) => finding.version)).toEqual(inherited ? ["2.0.0"] : []);
    expect(comparison.added.map((finding) => finding.version)).toEqual(inherited ? [] : ["2.0.0"]);
    // The key stays the same: base's finding isn't fixed either way.
    expect(comparison.fixed).toEqual([]);
    const result = verdict([npm("lib", "1.0.0")], [npm("lib", "2.0.0")], snap);
    expect(result.failures).toEqual(inherited ? [] : ["new: lib@2.0.0: GHSA-x has no exception"]);
    expect(result.warnings).toEqual(inherited ? ["inherited: lib@2.0.0: GHSA-x"] : []);
  });

  it.each([["1.0.0", "1.5.0"], ["1.5.0", "1.0.0"]])("counts every base finding with the key together, in any order (%s first)", (first, second) => {
    const snap = snapshot({ "lib@1.0.0": [sourced("GHSA-x", "repository")], "lib@1.5.0": [sourced("GHSA-x", "osv")], "lib@2.0.0": [sourced("GHSA-x", "osv")] });
    const base = [npm("lib", first, [`node_modules/${first}/lib`]), npm("lib", second, [`node_modules/${second}/lib`])];
    expect(verdict(base, [npm("lib", "2.0.0")], snap)).toMatchObject({ failures: [], warnings: ["inherited: lib@2.0.0: GHSA-x"] });
    const repositoryOnly = snapshot({ "lib@1.0.0": [sourced("GHSA-x", "repository")], "lib@1.5.0": [sourced("GHSA-x", "repository")], "lib@2.0.0": [sourced("GHSA-x", "osv")] });
    expect(verdict(base, [npm("lib", "2.0.0")], repositoryOnly).failures).toEqual(["new: lib@2.0.0: GHSA-x has no exception"]);
  });

  it("judges an alias group whatever ids its records carry", () => {
    // Base's repository record and head's OSV record name the group by different ids; a reviewed base record does too.
    const repositoryBase = snapshot({ "lib@1.0.0": [sourced("GHSA-x", "repository", ["CVE-2026-1"])], "lib@2.0.0": [sourced("CVE-2026-1", "osv", ["GHSA-x"])] });
    expect(verdict([npm("lib", "1.0.0")], [npm("lib", "2.0.0")], repositoryBase).failures).toEqual(["new: lib@2.0.0: GHSA-x has no exception"]);
    const reviewedBase = snapshot({
      "lib@1.0.0": [sourced("GHSA-x", "repository", ["CVE-2026-1"]), sourced("PYSEC-2026-1", "osv", ["CVE-2026-1"])],
      "lib@2.0.0": [sourced("CVE-2026-1", "osv", ["GHSA-x"])],
    });
    expect(findingsOf([npm("lib", "1.0.0")], reviewedBase).map((finding) => [finding.advisory, finding.reviewed])).toEqual([["GHSA-x", true]]);
    expect(verdict([npm("lib", "1.0.0")], [npm("lib", "2.0.0")], reviewedBase)).toMatchObject({ failures: [], warnings: ["inherited: lib@2.0.0: GHSA-x (CVE-2026-1)"] });
  });

  it("fails malware either way: reported new over a repository-only base record, inherited over a reviewed one", () => {
    const mal = (source: Advisory["source"]) => sourced("MAL-2026-1", source, [], true);
    const problem = "lib@2.0.0: MAL-2026-1 is a known-malicious package (no exception can cover it)";
    const overRepository = snapshot({ "lib@1.0.0": [mal("repository")], "lib@2.0.0": [mal("osv")] });
    expect(verdict([npm("lib", "1.0.0")], [npm("lib", "2.0.0")], overRepository).failures).toEqual([`new: ${problem}`]);
    const overReviewed = snapshot({ "lib@1.0.0": [mal("osv")], "lib@2.0.0": [mal("repository")] });
    expect(verdict([npm("lib", "1.0.0")], [npm("lib", "2.0.0")], overReviewed).failures).toEqual([`inherited: ${problem}`]);
  });

  it("treats GitHub's advisory database as reviewed for GitHub Actions", () => {
    const actions = (base: Advisory["source"], head: Advisory["source"]) => new Snapshot(new Map([
      ["GitHub Actions|acme/tool|v1.0.0", [sourced("GHSA-act", base)]],
      ["GitHub Actions|acme/tool|v2.0.0", [sourced("GHSA-act", head)]],
    ]), [], new Date(`${TODAY}T12:00:00Z`));
    const judged = (snap: Snapshot) => verdict([action("acme/tool", "v1.0.0")], [action("acme/tool", "v2.0.0")], snap);
    expect(judged(actions("repository", "github")).failures).toEqual(["new: acme/tool@v2.0.0: GHSA-act has no exception"]);
    expect(judged(actions("github", "repository"))).toMatchObject({ failures: [], warnings: ["inherited: acme/tool@v2.0.0: GHSA-act"] });
  });
});

describe("full scan policy", () => {
  it("fails every finding without a valid exception and notes the excepted ones", () => {
    const snap = snapshot({ "a@1.0.0": [advisory("GHSA-a")], "b@1.0.0": [advisory("GHSA-b")] });
    const exceptions = parseExceptions({
      vulnerabilities: [{ id: "GHSA-b", package: "b", version: "1.0.0", paths: ["node_modules/b"], reason: "build only", expires: "2027-01-01" }],
    });
    const result = scanVerdict(findingsOf([npm("a", "1.0.0"), npm("b", "1.0.0")], snap), exceptions, snap, TODAY);
    expect(result.failures).toEqual(["a@1.0.0: GHSA-a has no exception"]);
    expect(result.notes).toEqual(["excepted: b@1.0.0: GHSA-b"]);
  });
});

describe("exceptions file", () => {
  const entry = { package: "a", version: "1.0.0", advisory: "GHSA-a", reason: "fixes GHSA-a", expires: "2027-01-01" };

  it("requires trimmed, nonempty fields and a real YYYY-MM-DD expiry", () => {
    expect(() => parseExceptions({ releaseAge: [{ ...entry, reason: "  " }] })).toThrow(/reason is required/);
    expect(() => parseExceptions({ releaseAge: [{ ...entry, reason: " padded" }] })).toThrow(/reason is required/);
    expect(() => parseExceptions({ releaseAge: [{ ...entry, ecosystem: "" }] })).toThrow(/ecosystem is required/);
    expect(() => parseExceptions({ releaseAge: [{ ...entry, expires: "soon" }] })).toThrow(/real YYYY-MM-DD/);
    expect(() => parseExceptions({ releaseAge: [{ ...entry, expires: "2027-02-30" }] })).toThrow(/real YYYY-MM-DD/);
  });

  it("rejects malware ids and duplicates", () => {
    expect(() => parseExceptions({ releaseAge: [{ ...entry, advisory: "MAL-2026-1" }] })).toThrow(/known-malicious/);
    expect(() => parseExceptions({ releaseAge: [entry, { ...entry, reason: "again" }] })).toThrow(/duplicates/);
    expect(parseExceptions({ releaseAge: [entry, { ...entry, ecosystem: "Maven" }] }).releaseAge).toHaveLength(2);
    expect(() => parseExceptions({ vulnerabilities: "nope" })).toThrow(/must be an array/);
  });

  it("requires a vulnerability exception to name the paths it covers", () => {
    const vulnerability = { id: "GHSA-v", package: "lib", version: "1.0.0", reason: "not reachable", expires: "2027-01-01" };
    expect(() => parseExceptions({ vulnerabilities: [vulnerability] })).toThrow(/paths must be a nonempty list/);
    expect(() => parseExceptions({ vulnerabilities: [{ ...vulnerability, paths: [] }] })).toThrow(/paths must be a nonempty list/);
    expect(() => parseExceptions({ vulnerabilities: [{ ...vulnerability, paths: [" node_modules/lib"] }] })).toThrow(/paths/);
    expect(() => parseExceptions({ vulnerabilities: [{ ...vulnerability, paths: ["node_modules/lib", "node_modules/lib"] }] })).toThrow(
      /distinct/,
    );
  });
});
