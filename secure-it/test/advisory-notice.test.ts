import { describe, expect, it } from "vitest";

import type { AdvisoryEvidence, EvidenceRecord, SourceEvidence } from "@leanish/gate/advisory-evidence";

import { advisoryNotice, EVIDENCE_DIFFERS, INCOMPLETE, NOT_RECORDED, REVIEWED, TABLE_LEFT_OUT } from "../src/advisory-notice.ts";
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
    expect(advisoryNotice([hold({ evidenceFailure: "boom" })])).toEqual({ paragraphs: [INCOMPLETE], details: ["These fixes couldn't be checked:", `- ${PKG}@3.2.4: boom`] });
    expect(advisoryNotice([hold()])).toEqual({ paragraphs: [INCOMPLETE], details: ["These fixes couldn't be checked:", `- ${PKG}@3.2.4: ${NOT_RECORDED}`] });
    expect(advisoryNotice([hold({ justification: "required" }), hold({ justification: "exception" })])).toEqual({ paragraphs: [], details: [] });
    // The list stays short however many fixes are unchecked, and a long reason is cut by character, not mid-pair.
    const many = advisoryNotice(Array.from({ length: 25 }, (_, i) => hold({ name: `g:lib${i}`, evidenceFailure: "HTTP 502" })));
    expect(many.details).toHaveLength(12);
    expect(many.details.at(-1)).toBe("- and 15 more");
    const long = advisoryNotice([hold({ evidenceFailure: `${"a".repeat(299)}😀 | tail` })]).details.at(-1)!;
    expect(long).toBe(`- ${PKG}@3.2.4: ${"a".repeat(299)}😀…`);
  });

  it("never says every advisory is backed while some fix couldn't be checked", () => {
    const other = (overrides: Partial<PlannedHold>) => hold({ name: "g:other", version: "2.0.0", ...overrides });
    const noGroups = evidence([], { name: "g:other", groups: [] });
    for (const unchecked of [other({ evidenceFailure: "HTTP 502" }), other({}), other({ evidence: noGroups }), other({ evidence: { ...reviewed, targets: [] } })]) {
      const notice = advisoryNotice([hold({ evidence: reviewed }), unchecked]);
      expect(notice.paragraphs).toEqual([INCOMPLETE]);
      expect(notice.details.at(-1)).toMatch(/^- g:other@2\.0\.0: /);
    }
    // A bundle's other target with no advisory group isn't covered by the first target's rows.
    const bundle: AdvisoryEvidence = { ...reviewed, targets: [reviewed.targets[0]!, { ...reviewed.targets[0]!, name: "brace", bundled: true, groups: [] }] };
    expect(advisoryNotice([hold({ evidence: bundle })]).details.at(-1)).toBe(`- ${PKG}@3.2.4: no advisory recorded for \`brace\``);
    // Both warnings together, when a row differs and another fix is unchecked.
    const differs = evidence([checked("repository", [record()]), checked("github"), checked("osv")]);
    expect(advisoryNotice([hold({ evidence: differs }), other({ evidenceFailure: "HTTP 502" })]).paragraphs).toEqual([EVIDENCE_DIFFERS, INCOMPLETE]);
  });

  it("leaves the table out on request, naming the ⚠ packages instead of pointing at rows", () => {
    const differs = evidence([checked("repository", [record()]), checked("github"), checked("osv")]);
    const notice = advisoryNotice([hold({ evidence: differs })], { table: false });
    expect(notice.paragraphs).toHaveLength(1);
    expect(notice.paragraphs[0]).toContain("for `tools.jackson.core:jackson-databind` → 3.2.4:");
    expect(notice.paragraphs[0]).not.toMatch(/below|the table/);
    expect(notice.details).toEqual([TABLE_LEFT_OUT]);
    // Many ⚠ groups of one move, each over hundreds of versions, still name it once and stay short.
    const replaced = Array.from({ length: 400 }, (_, i) => `3.1.${i}`);
    const groups = Array.from({ length: 20 }, (_, i) => ({ ids: [`GHSA-${i}`], replaced: replaced.filter((_, j) => j !== i), sources: [checked("repository", [record()]), checked("github"), checked("osv")] }));
    const wide = advisoryNotice([hold({ evidence: evidence([], { replaced, groups }) })], { table: false }).paragraphs[0]!;
    expect(wide).toContain("for `tools.jackson.core:jackson-databind` → 3.2.4:");
    expect(wide.length).toBeLessThan(600);
    const bundled = evidence([checked("repository"), checked("github"), checked("osv")], { ecosystem: "npm", name: "brace", bundled: true, replaced: ["5.0.9"], proposed: [] });
    expect(advisoryNotice([hold({ ecosystem: "npm", name: "carrier", version: "1.1.0", justification: "bundle-fix", evidence: bundled })], { table: false }).paragraphs[0])
      .toContain("for `brace` → removed (bundled in `carrier` 1.1.0):");
    // A carrier move proposing hundreds of bundled versions shows the newest few and counts the rest, so 20 of them stay
    // short. The plan stores them sorted as text, where 5.1.10 comes before 5.1.9.
    const proposed = Array.from({ length: 400 }, (_, i) => `5.1.${i}`).sort();
    const carriers = Array.from({ length: 20 }, (_, i) => hold({ ecosystem: "npm", name: `carrier${i}`, version: "1.1.0", justification: "bundle-fix",
      evidence: evidence([checked("repository"), checked("github"), checked("osv")], { ecosystem: "npm", name: "brace", bundled: true, replaced: ["5.0.9"], proposed }) }));
    const compact = advisoryNotice(carriers, { table: false }).paragraphs[0]!;
    expect(compact).toContain("`brace` → 5.1.399, 5.1.398, 5.1.397 (+397 older) (bundled in `carrier0` 1.1.0)");
    expect(compact.length).toBeLessThan(3_000);
    // Past 20 moves the rest are counted, not named.
    const many = Array.from({ length: 23 }, (_, i) => hold({ name: `g:lib${i}`, evidence: evidence([checked("repository", [record()]), checked("github"), checked("osv")], { name: `g:lib${i}` }) }));
    const counted = advisoryNotice(many, { table: false }).paragraphs[0]!;
    expect(counted).toContain("`g:lib19` → 3.2.4 and 3 more:");
    expect(counted).not.toContain("g:lib20");
    expect(advisoryNotice([hold({ evidence: reviewed })], { table: false })).toEqual({ paragraphs: [REVIEWED], details: [TABLE_LEFT_OUT] });
  });

  it("keeps the table-less notice bounded with every shown field at its worst", () => {
    // Names and versions that escape to twice their length, and astral characters that take two UTF-16 units.
    const long = (i: number, length: number) => `${i}|😀`.repeat(length);
    const proposed = Array.from({ length: 400 }, (_, i) => long(i, 500));
    const differing = Array.from({ length: 25 }, (_, i) => hold({ ecosystem: "npm", name: long(i, 500), version: long(i, 500), justification: "bundle-fix",
      evidence: evidence([checked("repository"), checked("github"), checked("osv")], { ecosystem: "npm", name: long(i, 500), bundled: true, replaced: ["5.0.9"], proposed }) }));
    const unchecked = Array.from({ length: 25 }, (_, i) => hold({ name: long(i + 100, 500), version: long(i, 500), evidenceFailure: long(i, 500) }));
    const notice = advisoryNotice([...differing, ...unchecked], { table: false });
    expect(notice.paragraphs).toHaveLength(2);
    expect([...notice.paragraphs, ...notice.details].join("\n").length).toBeLessThan(40_000);
    expect(notice.details.at(-1)).toBe("- and 15 more");
  });

  it("tells moves apart by their whole names, though it shows them cut", () => {
    const prefix = "g:".padEnd(130, "x");
    const alike = [`${prefix}a`, `${prefix}b`].map((name) => hold({ name, evidence: evidence([checked("repository", [record()]), checked("github"), checked("osv")], { name }) }));
    const paragraph = advisoryNotice(alike, { table: false }).paragraphs[0]!;
    const shown = `\`${prefix.slice(0, 120)}…\` → 3.2.4`;
    expect(paragraph).toContain(`for ${shown}; ${shown}:`);
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

  it("leaves only the evidence table out when the body wouldn't fit, and fails what still doesn't", () => {
    const plan = (evidence: AdvisoryEvidence): ChangePlan => ({ topic: "security-cooldown", malware: false, severity: "CRITICAL", kind: "routine", moves: [], packages: [], cooldown: [hold({ evidence })] });
    const fitting = withPlanSection("Description.", plan(reviewed));
    expect(fitting).toContain("> | Advisory | Package | Project's repository | GitHub database | OSV |");
    // 60 groups over 20 replaced versions: the rendered table alone passes GitHub's body limit.
    const replaced = Array.from({ length: 20 }, (_, i) => `3.1.${i}`);
    const verdicts = Object.fromEntries([...replaced.map((version) => [version, "affected"] as const), ["3.2.4", "not-affected"] as const]);
    const groups = Array.from({ length: 60 }, (_, i) => {
      const found = record({ id: `GHSA-${String(i).padStart(4, "0")}-aaaa-bbbb`, verdicts });
      return { ids: [found.id], replaced, sources: [checked("repository", [found]), checked("github", [{ ...found, reviewed: true }]), checked("osv", [found])] };
    });
    const large = plan({ collectedAt: "2026-10-23T16:57:12.000Z", targets: [{ ecosystem: "Maven", name: PKG, bundled: false, replaced, proposed: ["3.2.4"], groups }] });
    const body = withPlanSection("Description.", large);
    expect(body.length).toBeLessThanOrEqual(65_536);
    expect(body).toContain(`> ${REVIEWED}`);
    expect(body).toContain(`> ${TABLE_LEFT_OUT}`);
    expect(body).not.toContain("| Advisory | Package |");
    expect(body).toContain("> | Package | Version | Published (UTC) | Held until (UTC) | Why | Signals |");
    expect(planOf(body)).toEqual(large);
    // Rewriting it keeps one warning, the same one.
    expect(withPlanSection(body, large)).toBe(body);
    expect(() => withPlanSection("x".repeat(70_000), plan(reviewed))).toThrow("over GitHub's 65536");
  });
});
