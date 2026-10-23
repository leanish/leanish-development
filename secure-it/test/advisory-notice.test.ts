import { describe, expect, it } from "vitest";

import type { AdvisoryEvidence, EvidenceRecord, SourceEvidence } from "@leanish/gate/advisory-evidence";

import {
  advisoryNotice, EVIDENCE_DIFFERS, NOT_RECORDED, REPOSITORY_ONLY, REPOSITORY_ONLY_UNCHECKED, REVIEWED, UNREVIEWED_GITHUB, UNREVIEWED_GITHUB_UNCHECKED,
} from "../src/advisory-notice.ts";
import type { ChangePlan, PlannedHold } from "../src/plan.ts";
import { cooldownWarning, planOf, withPlanSection } from "../src/plan-block.ts";

const PKG = "tools.jackson.core:jackson-databind";
const record = (overrides: Partial<EvidenceRecord> = {}): EvidenceRecord => ({
  id: "GHSA-m8xf-2cr7-77ph", aliases: ["CVE-2026-110879"], withdrawn: false, namesPackage: true, declaredFixes: ["3.2.4"],
  verdicts: { "3.2.3": "affected", "3.2.4": "not-affected" }, ...overrides,
});
const checked = (source: SourceEvidence["source"], records: EvidenceRecord[] = []): SourceEvidence => ({ source, lookup: "checked", records });
const evidence = (sources: SourceEvidence[], target: Partial<AdvisoryEvidence["targets"][number]> = {}): AdvisoryEvidence => {
  const replaced = target.replaced ?? ["3.2.3"];
  return {
    collectedAt: "2026-10-23T16:57:12.000Z",
    targets: [{ ecosystem: "Maven", name: PKG, bundled: false, replaced, proposed: ["3.2.4"], groups: [{ ids: ["GHSA-m8xf-2cr7-77ph"], replaced, sources }], ...target }],
  };
};
const hold = (overrides: Partial<PlannedHold> = {}): PlannedHold => ({
  ecosystem: "Maven", name: PKG, version: "3.2.4", replaced: ["3.2.3"], published: "2026-10-18T23:01:30.000Z",
  eligibleAt: "2026-10-25T23:01:30.000Z", justification: "security-fix", signals: [], ...overrides,
});
const repositoryOnly = evidence([{ ...checked("repository", [record()]), repository: "fasterxml/jackson-databind" }, checked("github"), checked("osv")]);

describe("the advisory notice on a held PR", () => {
  it("says when an advisory is only in the project's repository, GitHub's database and OSV both checked", () => {
    const notice = advisoryNotice([hold({ evidence: repositoryOnly })]);
    expect(notice.paragraphs).toEqual([REPOSITORY_ONLY]);
    expect(notice.details).toEqual([
      "**Where the advisories behind these versions appear**, as read during this verification (2026-10-23 16:57 UTC), each source as it says:",
      "",
      "| Advisory | Package | Project's repository | GitHub database | OSV |",
      "|---|---|---|---|---|",
      "| GHSA-m8xf-2cr7-77ph | `tools.jackson.core:jackson-databind` 3.2.3 → 3.2.4 | GHSA-m8xf-2cr7-77ph: declares the fix 3.2.4, 3.2.3 affected, 3.2.4 not affected | not found | not found |",
    ]);
  });

  it("calls an advisory OSV or GitHub's reviewed database lists reviewed, either one", () => {
    const inOsv = evidence([checked("repository", [record()]), checked("github"), checked("osv", [record({ declaredFixes: ["3.2.5"] })])]);
    const osvNotice = advisoryNotice([hold({ evidence: inOsv })]);
    expect(osvNotice.paragraphs).toEqual([REVIEWED]);
    expect(osvNotice.details.at(-1)).toContain("| GHSA-m8xf-2cr7-77ph: declares the fix 3.2.5, 3.2.3 affected, 3.2.4 not affected |");
    // Only GitHub so far (OSV's import lags, or couldn't be read): reviewed all the same.
    const inGithub = evidence([checked("repository", [record()]), checked("github", [record({ reviewed: true })]), { source: "osv", lookup: "incomplete", reason: "HTTP 503", records: [] }]);
    expect(advisoryNotice([hold({ evidence: inGithub })]).paragraphs).toEqual([REVIEWED]);
  });

  it("warns most about an advisory only the project's repository has, as a possible fake", () => {
    expect(REPOSITORY_ONLY).toContain("neither OSV nor GitHub's advisory database has a record that does");
    expect(REPOSITORY_ONLY).toContain("fake");
    const unreviewed = evidence([checked("repository", [record()]), checked("github", [record({ reviewed: false })]), checked("osv")]);
    const notice = advisoryNotice([hold({ evidence: unreviewed })]);
    // An unreviewed GitHub record isn't GitHub's word: still repository-only, shown as unreviewed.
    expect(notice.paragraphs).toEqual([REPOSITORY_ONLY]);
    expect(notice.details.at(-1)).toContain("| GHSA-m8xf-2cr7-77ph: unreviewed, declares the fix 3.2.4");
  });

  it("doesn't call a fix reviewed when the reviewed record says the proposed version is still affected", () => {
    const disagreeing = evidence([checked("repository", [record()]), checked("github"), checked("osv", [record({ declaredFixes: ["3.2.5"], verdicts: { "3.2.3": "affected", "3.2.4": "affected" } })])]);
    expect(advisoryNotice([hold({ evidence: disagreeing })]).paragraphs).toEqual([REPOSITORY_ONLY]);
  });

  it("names a fix backed only by an unreviewed GitHub record as unreviewed", () => {
    const unreviewed = evidence([checked("repository"), checked("github", [record({ reviewed: false })]), checked("osv")]);
    expect(advisoryNotice([hold({ evidence: unreviewed })]).paragraphs).toEqual([UNREVIEWED_GITHUB]);
    const osvDown = evidence([checked("repository"), checked("github", [record({ reviewed: false })]), { source: "osv", lookup: "incomplete", reason: "HTTP 503", records: [] }]);
    expect(advisoryNotice([hold({ evidence: osvDown })]).paragraphs).toEqual([UNREVIEWED_GITHUB_UNCHECKED]);
  });

  it("judges each advisory against the replaced versions it affects, not all of them", () => {
    const a = record({ id: "GHSA-a", verdicts: { "1.0.0": "affected", "2.0.0": "not-affected", "3.0.0": "not-affected" } });
    const b = record({ id: "GHSA-b", verdicts: { "1.0.0": "not-affected", "2.0.0": "affected", "3.0.0": "not-affected" } });
    const both: AdvisoryEvidence = { collectedAt: "2026-10-23T16:57:12.000Z", targets: [{
      ecosystem: "Maven", name: PKG, bundled: false, replaced: ["1.0.0", "2.0.0"], proposed: ["3.0.0"], groups: [
        { ids: ["GHSA-a"], replaced: ["1.0.0"], sources: [checked("repository"), checked("github"), checked("osv", [a])] },
        { ids: ["GHSA-b"], replaced: ["2.0.0"], sources: [checked("repository"), checked("github"), checked("osv", [b])] },
      ],
    }] };
    const notice = advisoryNotice([hold({ version: "3.0.0", replaced: ["1.0.0", "2.0.0"], evidence: both })]);
    expect(notice.paragraphs).toEqual([REVIEWED]);
    expect(notice.details.slice(-2)).toEqual([
      "| GHSA-a | `tools.jackson.core:jackson-databind` 1.0.0 → 3.0.0 | not found | not found | GHSA-a: declares the fix 3.2.4, 1.0.0 affected, 3.0.0 not affected |",
      "| GHSA-b | `tools.jackson.core:jackson-databind` 2.0.0 → 3.0.0 | not found | not found | GHSA-b: declares the fix 3.2.4, 2.0.0 affected, 3.0.0 not affected |",
    ]);
  });

  it("says what couldn't be checked instead of calling it absent", () => {
    const unchecked = evidence([checked("repository", [record()]), { source: "github", lookup: "incomplete", reason: "GitHub advisory GHSA-m8xf-2cr7-77ph failed with HTTP 502", records: [] }, checked("osv")]);
    const notice = advisoryNotice([hold({ evidence: unchecked })]);
    expect(notice.paragraphs).toEqual([REPOSITORY_ONLY_UNCHECKED]);
    expect(notice.details.at(-1)).toContain("| couldn't be fully checked: GitHub advisory GHSA-m8xf-2cr7-77ph failed with HTTP 502 |");
  });

  it("flags evidence that no longer backs the fix, without a repository-only explanation", () => {
    const withdrawn = evidence([checked("repository", [record({ withdrawn: true })]), checked("github"), checked("osv", [record({ verdicts: { "3.2.3": "affected", "3.2.4": "unknown" } })])]);
    const notice = advisoryNotice([hold({ evidence: withdrawn })]);
    expect(notice.paragraphs).toEqual([EVIDENCE_DIFFERS]);
    expect(notice.details.at(-1)).toBe("| ⚠ GHSA-m8xf-2cr7-77ph | `tools.jackson.core:jackson-databind` 3.2.3 → 3.2.4 | GHSA-m8xf-2cr7-77ph: withdrawn | not found | GHSA-m8xf-2cr7-77ph: declares the fix 3.2.4, 3.2.3 affected, 3.2.4 unknown |");
  });

  it("names a bundled package as bundled, and a removal as a removal", () => {
    const bundled = evidence([checked("repository"), checked("github", [record({ reviewed: true, verdicts: { "5.0.9": "affected" } })]), checked("osv")], {
      ecosystem: "npm", name: "brace", bundled: true, replaced: ["5.0.9"], proposed: [],
    });
    const notice = advisoryNotice([hold({ ecosystem: "npm", name: "carrier", version: "1.1.0", replaced: ["1.0.0"], justification: "bundle-fix", evidence: bundled })]);
    expect(notice.details.at(-1)).toContain("| `brace` 5.0.9 → removed (bundled in `carrier` 1.1.0) |");
    expect(notice.paragraphs).toEqual([REVIEWED]);
  });

  it("reports evidence it couldn't read, or never recorded, and stays out of other holds", () => {
    expect(advisoryNotice([hold({ evidenceFailure: "boom" })]).details).toEqual(["Where these advisories appear couldn't be read for:", `- ${PKG}@3.2.4: boom`]);
    expect(advisoryNotice([hold()]).details).toEqual([NOT_RECORDED]);
    expect(advisoryNotice([hold({ justification: "required" }), hold({ justification: "exception" })])).toEqual({ paragraphs: [], details: [] });
  });

  it("opens the cooldown warning with the paragraphs and puts the table after the holds", () => {
    const warning = cooldownWarning([hold({ evidence: repositoryOnly })])!;
    const lines = warning.split("\n");
    const paragraph = lines.indexOf(`> ${REPOSITORY_ONLY}`);
    const holds = lines.indexOf("> | Package | Version | Published (UTC) | Held until (UTC) | Why | Signals |");
    const sources = lines.indexOf("> | Advisory | Package | Project's repository | GitHub database | OSV |");
    expect(paragraph).toBeGreaterThan(1);
    expect(holds).toBeGreaterThan(paragraph);
    expect(sources).toBeGreaterThan(holds);
  });

  it("keeps the evidence in the plan, and refuses an edited one", () => {
    const plan: ChangePlan = { topic: "security-cooldown", malware: false, severity: "CRITICAL", kind: "routine", moves: [], packages: [], cooldown: [hold({ evidence: repositoryOnly })] };
    const body = withPlanSection("Description.", plan);
    expect(planOf(body)).toEqual(plan);
    const edited = { ...plan, cooldown: [hold({ evidence: { ...repositoryOnly, collectedAt: "later" } })] };
    expect(planOf(withPlanSection("Description.", edited))).toBeUndefined();
  });
});
