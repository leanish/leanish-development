import { describe, expect, it } from "vitest";

import type { AdvisoryEvidence, EvidenceRecord, SourceEvidence } from "@leanish/gate/advisory-evidence";

import { advisoryNotice, EVIDENCE_DIFFERS, NOT_RECORDED, REVIEWED } from "../src/advisory-notice.ts";
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
const reviewed = evidence([{ ...checked("repository", [record()]), repository: "fasterxml/jackson-databind" }, checked("github", [record({ reviewed: true })]), checked("osv", [record()])]);

describe("the advisory notice on a held PR", () => {
  it("says a reviewed record still backs the fix, and shows each source as it says", () => {
    const notice = advisoryNotice([hold({ evidence: reviewed })]);
    expect(notice.paragraphs).toEqual([REVIEWED]);
    const fix = "GHSA-m8xf-2cr7-77ph: declares the fix 3.2.4, 3.2.3 affected, 3.2.4 not affected";
    expect(notice.details).toEqual([
      "**Where the advisories behind these versions appear**, as read during this verification (2026-10-23 16:57 UTC), each source as it says:",
      "",
      "| Advisory | Package | Project's repository | GitHub database | OSV |",
      "|---|---|---|---|---|",
      `| GHSA-m8xf-2cr7-77ph | \`tools.jackson.core:jackson-databind\` 3.2.3 → 3.2.4 | ${fix} | ${fix} | ${fix} |`,
    ]);
  });

  it("counts either reviewed source: OSV, or a GitHub-reviewed record while OSV can't be read", () => {
    const githubOnly = evidence([checked("repository"), checked("github", [record({ reviewed: true })]), { source: "osv", lookup: "incomplete", reason: "HTTP 503", records: [] }]);
    expect(advisoryNotice([hold({ evidence: githubOnly })]).paragraphs).toEqual([REVIEWED]);
  });

  it.each([
    ["only the project's repository backs it", [checked("repository", [record()]), checked("github"), checked("osv")]],
    ["only an unreviewed GitHub record backs it", [checked("repository"), checked("github", [record({ reviewed: false })]), checked("osv")]],
    ["the reviewed record says the proposed version is still affected", [checked("repository", [record()]), checked("github"), checked("osv", [record({ verdicts: { "3.2.3": "affected", "3.2.4": "affected" } })])]],
    ["the reviewed record was withdrawn", [checked("repository"), checked("github"), checked("osv", [record({ withdrawn: true })])]],
    ["the reviewed sources couldn't be read", [checked("repository", [record()]), { source: "github", lookup: "incomplete", reason: "HTTP 502", records: [] }, { source: "osv", lookup: "incomplete", reason: "HTTP 503", records: [] }]],
  ] as Array<[string, SourceEvidence[]]>)("flags a fix no reviewed record backs now: %s", (_name, sources) => {
    const notice = advisoryNotice([hold({ evidence: evidence(sources) })]);
    expect(notice.paragraphs).toEqual([EVIDENCE_DIFFERS]);
    expect(notice.details.at(-1)).toMatch(/^\| ⚠ GHSA-m8xf-2cr7-77ph \|/);
  });

  it("says what couldn't be checked instead of calling it absent", () => {
    const unchecked = evidence([checked("repository", [record()]), { source: "github", lookup: "incomplete", reason: "GitHub advisory GHSA-m8xf-2cr7-77ph failed with HTTP 502", records: [] }, checked("osv", [record()])]);
    expect(advisoryNotice([hold({ evidence: unchecked })]).details.at(-1)).toContain("| couldn't be fully checked: GitHub advisory GHSA-m8xf-2cr7-77ph failed with HTTP 502 |");
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
    const warning = cooldownWarning([hold({ evidence: reviewed })])!;
    const lines = warning.split("\n");
    const paragraph = lines.indexOf(`> ${REVIEWED}`);
    const holds = lines.indexOf("> | Package | Version | Published (UTC) | Held until (UTC) | Why | Signals |");
    const sources = lines.indexOf("> | Advisory | Package | Project's repository | GitHub database | OSV |");
    expect(paragraph).toBeGreaterThan(1);
    expect(holds).toBeGreaterThan(paragraph);
    expect(sources).toBeGreaterThan(holds);
  });

  it("keeps the evidence in the plan, and refuses an edited one", () => {
    const plan: ChangePlan = { topic: "security-cooldown", malware: false, severity: "CRITICAL", kind: "routine", moves: [], packages: [], cooldown: [hold({ evidence: reviewed })] };
    const body = withPlanSection("Description.", plan);
    expect(planOf(body)).toEqual(plan);
    const edited = { ...plan, cooldown: [hold({ evidence: { ...reviewed, collectedAt: "later" } })] };
    expect(planOf(withPlanSection("Description.", edited))).toBeUndefined();
  });
});
