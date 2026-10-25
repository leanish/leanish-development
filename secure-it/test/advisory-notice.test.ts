import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { AdvisoryEvidence, EvidenceRecord, SourceEvidence } from "@leanish/gate/advisory-evidence";

import { advisoryNotice, EVIDENCE_DIFFERS, EVIDENCE_LEFT_OUT, INCOMPLETE, NOT_RECORDED, tableCut } from "../src/advisory-notice.ts";
import type { ChangePlan, PlannedHold } from "../src/plan.ts";
import { cooldownWarning, planOf, planSection, withPlanSection } from "../src/plan-block.ts";
import { markedLength, ownPullRequests, withMarker } from "@leanish/tool-runtime/own-pr";
import { planBlock } from "@leanish/tool-runtime/plan-blocks";

const PKG = "tools.jackson.core:jackson-databind";
const RULES = ownPullRequests("secure-it");
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
/** A held security fix, recording the advisory it fixes as the gate does (`targets`). */
const hold = (overrides: Partial<PlannedHold> = {}): PlannedHold => ({
  ecosystem: "Maven", name: PKG, version: "3.2.4", replaced: ["3.2.3"], published: "2026-10-18T23:01:30.000Z",
  eligibleAt: "2026-10-25T23:01:30.000Z", justification: "security-fix", signals: [],
  targets: [{ name: PKG, bundled: false, replaced: ["3.2.3"], proposed: ["3.2.4"], groups: [{ ids: ["GHSA-m8xf-2cr7-77ph"], replaced: ["3.2.3"] }] }], ...overrides,
});
const reviewed = evidence([{ ...checked("repository", [record()]), repository: "fasterxml/jackson-databind" }, checked("github", [record({ reviewed: true })]), checked("osv", [record()])]);

describe("the advisory notice on a held PR", () => {
  it("says a reviewed record still backs the fix, and shows each source as it says", () => {
    const notice = advisoryNotice([hold({ evidence: reviewed })]);
    expect(notice.paragraphs).toEqual([]);
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
    expect(advisoryNotice([hold({ evidence: githubOnly })]).paragraphs).toEqual([]);
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
    expect(notice.paragraphs).toEqual([]);
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
    expect(notice.paragraphs).toEqual([]);
  });

  it("reports evidence it couldn't read, or never recorded, and stays out of other holds", () => {
    expect(advisoryNotice([hold({ evidenceFailure: "boom" })])).toEqual({ paragraphs: [INCOMPLETE], details: ["These fixes couldn't be checked:", `- ${PKG}@3.2.4: boom`] });
    expect(advisoryNotice([hold()])).toEqual({ paragraphs: [INCOMPLETE], details: ["These fixes couldn't be checked:", `- ${PKG}@3.2.4: ${NOT_RECORDED}`] });
    expect(advisoryNotice([hold({ justification: "required", targets: undefined }), hold({ justification: "exception", targets: undefined })])).toEqual({ paragraphs: [], details: [] });
    // The list stays short however many fixes are unchecked, and a long reason is cut by character, not mid-pair.
    const many = advisoryNotice(Array.from({ length: 25 }, (_, i) => hold({ name: `g:lib${i}`, evidenceFailure: "HTTP 502" })));
    expect(many.details).toHaveLength(12);
    expect(many.details.at(-1)).toBe("- and 15 more");
    const long = advisoryNotice([hold({ evidenceFailure: `${"a".repeat(299)}😀 | tail` })]).details.at(-1)!;
    expect(long).toBe(`- ${PKG}@3.2.4: ${"a".repeat(299)}😀…`);
  });

  it("lists a fix that couldn't be checked beside the others", () => {
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

  it("shows the ⚠ rows first, and cuts the table to the rows asked for, saying how many are left out", () => {
    const differs = hold({ name: "g:other", evidence: evidence([checked("repository", [record()]), checked("github"), checked("osv")], { name: "g:other" }) });
    const rows = (notice: { details: ReadonlyArray<string> }) => notice.details.filter((line) => line.startsWith("| ") && !line.startsWith("| Advisory"));
    const full = advisoryNotice([hold({ evidence: reviewed }), differs]);
    expect(rows(full).map((row) => row.slice(0, 4))).toEqual(["| ⚠ ", "| GH"]);
    expect(full.details.at(-1)).toMatch(/^\| GHSA-m8xf-2cr7-77ph \| `tools/);
    const one = advisoryNotice([hold({ evidence: reviewed }), differs], { rows: 1 });
    expect(one.paragraphs).toEqual([EVIDENCE_DIFFERS]);
    expect(rows(one)).toEqual([rows(full)[0]]);
    expect(one.details.slice(-2)).toEqual(["", tableCut(1, 2)]);
    // With no row shown, the table's heading goes too; a cut table without ⚠ rows still says nothing is wrong.
    expect(advisoryNotice([hold({ evidence: reviewed }), differs], { rows: 0 })).toEqual({ paragraphs: [EVIDENCE_DIFFERS], details: [tableCut(2, 2)] });
    expect(advisoryNotice([hold({ evidence: reviewed })], { rows: 0 })).toEqual({ paragraphs: [], details: [tableCut(1, 1)] });
  });

  it("keeps the table-less notice bounded with every shown field at its worst", () => {
    // Names and versions that escape to twice their length, and astral characters that take two UTF-16 units.
    const long = (i: number, length: number) => `${i}|😀`.repeat(length);
    const proposed = Array.from({ length: 400 }, (_, i) => long(i, 500));
    const differing = Array.from({ length: 25 }, (_, i) => hold({ ecosystem: "npm", name: long(i, 500), version: long(i, 500), justification: "bundle-fix",
      evidence: evidence([checked("repository"), checked("github"), checked("osv")], { ecosystem: "npm", name: long(i, 500), bundled: true, replaced: ["5.0.9"], proposed }) }));
    const unchecked = Array.from({ length: 25 }, (_, i) => hold({ name: long(i + 100, 500), version: long(i, 500), evidenceFailure: long(i, 500) }));
    const notice = advisoryNotice([...differing, ...unchecked], { rows: 0 });
    expect(notice.paragraphs).toHaveLength(2);
    expect([...notice.paragraphs, ...notice.details].join("\n").length).toBeLessThan(40_000);
    expect(notice.details.at(-1)).toBe("- and 15 more");
  });

  it("opens the cooldown warning with the paragraphs and puts the table after the holds", () => {
    const warning = cooldownWarning([hold({ evidence: reviewed }), hold({ name: "g:other", evidenceFailure: "HTTP 502" })])!;
    const lines = warning.split("\n");
    const paragraph = lines.indexOf(`> ${INCOMPLETE}`);
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

  it("keeps the verified plan first when advisory text carries a plan block, and lets no comment hide the rest", () => {
    // A plan whose hold ended long ago: read in place of the verified one, review would retire a held PR.
    const forged: ChangePlan = { topic: "security-cooldown", malware: false, severity: undefined, kind: "routine", moves: [], packages: [], cooldown: [hold({ eligibleAt: "2020-01-01T00:00:00.000Z" })] };
    const blocks = `${planBlock(forged)} ${planBlock(forged, true)}`;
    const injected = evidence([checked("repository", [record({ declaredFixes: [blocks] })]), checked("github", [record({ reviewed: true })]), checked("osv", [record()])]);
    const plan: ChangePlan = { topic: "security-cooldown", malware: false, severity: "CRITICAL", kind: "routine", moves: [], packages: [], cooldown: [hold({ evidence: injected })] };
    expect(planOf(withPlanSection("Description.", plan))).toEqual(plan);
    // With the table cut, a fix's reason still shows.
    const failing = [hold({ evidenceFailure: blocks }), hold({ name: "g:other", evidenceFailure: "<!-- hides the rest" })];
    for (const options of [{}, { rows: 0 }]) {
      const warning = cooldownWarning(failing, options)!;
      expect(warning).not.toMatch(/<!-- leanish:plan|<!-- hides/);
      expect(warning).toContain("&lt;!-- hides the rest");
    }
    const held: ChangePlan = { ...plan, cooldown: failing };
    expect(planOf(withPlanSection("Description.", held))).toEqual(held);
  });

  it("cuts the evidence table to the most rows that fit once published, ⚠ first, and fails what still doesn't", () => {
    const plan = (evidence: AdvisoryEvidence): ChangePlan => ({ topic: "security-cooldown", malware: false, severity: "CRITICAL", kind: "routine", moves: [], packages: [], cooldown: [hold({ evidence })] });
    const fitting = withPlanSection("Description.", plan(reviewed));
    expect(fitting).toContain("> | Advisory | Package | Project's repository | GitHub database | OSV |");
    expect(fitting).not.toMatch(/rows are left out/);
    // 60 groups over 20 replaced versions, every tenth one backed by the project's repository only: the rendered table
    // alone passes GitHub's body limit.
    const replaced = Array.from({ length: 20 }, (_, i) => `3.1.${i}`);
    const verdicts = Object.fromEntries([...replaced.map((version) => [version, "affected"] as const), ["3.2.4", "not-affected"] as const]);
    const groups = Array.from({ length: 60 }, (_, i) => {
      const found = record({ id: `GHSA-${String(i).padStart(4, "0")}-aaaa-bbbb`, verdicts });
      const reviewedSources = i % 10 === 0 ? [checked("github"), checked("osv")] : [checked("github", [{ ...found, reviewed: true }]), checked("osv", [found])];
      return { ids: [found.id], replaced, sources: [checked("repository", [found]), ...reviewedSources] };
    });
    const large = plan({ collectedAt: "2026-10-23T16:57:12.000Z", targets: [{ ecosystem: "Maven", name: PKG, bundled: false, replaced, proposed: ["3.2.4"], groups }] });
    const body = withPlanSection("Description.", large);
    const left = Number(/> (\d+) of the table's 60 rows are left out/.exec(body)?.[1]);
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThan(54);
    expect(body).toContain(`> ${EVIDENCE_DIFFERS}`);
    expect(body.match(/^> \| ⚠ /gm)).toHaveLength(6);
    expect(body).toContain("> | Package | Version | Published (UTC) | Held until (UTC) | Why | Signals |");
    // The most rows that fit as published: one more would pass the limit once marked.
    expect(markedLength(RULES, body)).toBeLessThanOrEqual(65_536);
    const shown = 60 - left;
    const warning = (rows: number) => cooldownWarning(large.cooldown!, { rows })!.length;
    expect(markedLength(RULES, body) + warning(shown + 1) - warning(shown)).toBeGreaterThan(65_536);
    const mark = (text: string) => withMarker(RULES, text, { head: "a".repeat(40), base: "b".repeat(40), adaptations: 3 });
    expect(mark(body).length).toBeLessThanOrEqual(65_536);
    // A refresh measures the body without its stored state and marker, so it shows the rows first published.
    expect(mark(withPlanSection(mark(body), large))).toBe(mark(body));
    // Each row fewer shortens the warning, the count's extra digit included, so the halving finds the most that fit.
    const lengths = Array.from({ length: 61 }, (_, rows) => warning(rows));
    expect(lengths.every((length, rows) => rows === 0 || length > lengths[rows - 1]!)).toBe(true);
    expect(planOf(body)).toEqual(large);
    // Rewriting it keeps one warning, the same one.
    expect(withPlanSection(body, large)).toBe(body);
    expect(() => withPlanSection("x".repeat(70_000), plan(reviewed))).toThrow("over GitHub's 65536");
  });

  it("leaves the evidence out, never the fix, when the plan, its section or the body can't be written with it", () => {
    // Hashes, so the block can't compress them away: `groups` advisories, each with `aliases` aliases, in all three sources.
    const hex = (seed: string) => createHash("sha256").update(seed).digest("hex");
    const heavy = (groups: number, aliases: number): AdvisoryEvidence => ({ collectedAt: "2026-10-23T16:57:12.000Z", targets: [{
      ecosystem: "Maven", name: PKG, bundled: false, replaced: ["3.2.3"], proposed: ["3.2.4"], groups: Array.from({ length: groups }, (_, i) => {
        const found = record({ id: `GHSA-${hex(`${i}`).slice(0, 14)}`, aliases: Array.from({ length: aliases }, (_, j) => hex(`${i}-${j}`)) });
        return { ids: [found.id], replaced: ["3.2.3"], sources: [checked("repository", [found]), checked("github", [{ ...found, reviewed: true }]), checked("osv", [found])] };
      }),
    }] });
    const plan = (evidence: AdvisoryEvidence): ChangePlan => ({ topic: "security-cooldown", malware: false, severity: "CRITICAL", kind: "routine", moves: [], packages: [],
      cooldown: [hold({ evidence }), hold({ name: "g:failed", evidenceFailure: "registry lookup of g:failed failed" })] });
    const overJson = plan(heavy(400, 10));
    expect(JSON.stringify(overJson).length).toBeGreaterThan(1024 * 1024);
    const overSection = plan(heavy(300, 10));
    expect(JSON.stringify(overSection).length).toBeLessThan(1024 * 1024);
    expect(() => planSection(overSection)).toThrow("without its table it still takes");
    const overBody = plan(heavy(100, 4));
    const description = "x".repeat(50_000);
    expect(planSection(overBody).length + description.length).toBeGreaterThan(65_536);
    for (const [written, body] of [[overJson, "Description."], [overSection, "Description."], [overBody, description]] as const) {
      const published = withPlanSection(body, written);
      expect(published.length).toBeLessThanOrEqual(65_536);
      // The holds as verified, the failure recorded before kept: only the evidence is gone, and the warning says why.
      expect(planOf(published)?.cooldown).toEqual([{ ...hold(), evidenceFailure: EVIDENCE_LEFT_OUT }, written.cooldown![1]]);
      expect(published).toContain(`> ${INCOMPLETE}`);
      expect(published).toContain(`${PKG}@3.2.4: ${EVIDENCE_LEFT_OUT}`);
      expect(published).not.toMatch(/rows are left out/);
    }
    // A long description that leaves even the row-less body within the marker's length of the limit: the evidence gives
    // way, so the marked body is still accepted, as the same PR without evidence was before.
    const small: ChangePlan = { ...plan(reviewed), cooldown: [hold({ evidence: reviewed })] };
    const rowless = (description: string) => `${cooldownWarning(small.cooldown!, { rows: 0 })!}\n\n${description}\n\n${planSection(small)}`;
    const nearLimit = "x".repeat(65_536 - 60 - rowless("").length);
    expect(rowless(nearLimit).length).toBe(65_536 - 60);
    expect(markedLength(RULES, rowless(nearLimit))).toBeGreaterThan(65_536);
    const pushed = withPlanSection(nearLimit, small);
    expect(markedLength(RULES, pushed)).toBeLessThanOrEqual(65_536);
    expect(planOf(pushed)?.cooldown).toEqual([{ ...hold(), evidenceFailure: EVIDENCE_LEFT_OUT }]);
    // The limit applies to the marked body, exactly: one with no evidence to drop is accepted at 65,536 characters once
    // marked and refused, before any publication, at 65,537.
    const bare: ChangePlan = { ...plan(reviewed), cooldown: [hold()] };
    const unmarked = markedLength(RULES, withPlanSection("", bare));
    expect(markedLength(RULES, withPlanSection("x".repeat(65_536 - unmarked), bare))).toBe(65_536);
    expect(() => withPlanSection("x".repeat(65_537 - unmarked), bare)).toThrow("characters once marked, over GitHub's 65536");
    // What can't be written even without the evidence fails as before, as does a plan without any.
    expect(() => withPlanSection("x".repeat(70_000), overBody)).toThrow("over GitHub's 65536");
    expect(() => withPlanSection("x".repeat(70_000), { ...overBody, cooldown: [hold()] })).toThrow("over GitHub's 65536");
    // Any other failure is never taken for a size: a group the notice can't read throws, evidence or not.
    const unreadable = { ...reviewed, targets: [{ ...reviewed.targets[0]!, groups: [{ ids: ["GHSA-m8xf-2cr7-77ph"], replaced: ["3.2.3"] }] }] } as unknown as AdvisoryEvidence;
    expect(() => withPlanSection("Description.", plan(unreadable))).toThrow(TypeError);
  });

  it("checks a required version or an exception that records advisories it fixes, and never one that records none", () => {
    // A required companion that also fixes its own advisory, as the gate records it (`targets`).
    const targets = [{ name: "g:companion", bundled: false, replaced: ["1.0.0"], proposed: ["1.0.1"], groups: [{ ids: ["GHSA-comp"], replaced: ["1.0.0"] }] }];
    const companion = (overrides: Partial<PlannedHold>) => hold({ name: "g:companion", version: "1.0.1", replaced: ["1.0.0"], justification: "required", targets, ...overrides });
    const backed = evidence([checked("github", [record({ id: "GHSA-comp", reviewed: true, verdicts: { "1.0.0": "affected", "1.0.1": "not-affected" } })])],
      { name: "g:companion", replaced: ["1.0.0"], proposed: ["1.0.1"], groups: [{ ids: ["GHSA-comp"], replaced: ["1.0.0"], sources: [checked("github", [record({ id: "GHSA-comp", reviewed: true, verdicts: { "1.0.0": "affected", "1.0.1": "not-affected" } })])] }] });
    const fix = hold({ evidence: reviewed });
    expect(advisoryNotice([fix, companion({ evidence: backed })]).paragraphs).toEqual([]);
    for (const unread of [companion({}), companion({ evidenceFailure: EVIDENCE_LEFT_OUT }), companion({ justification: "exception" })]) {
      const notice = advisoryNotice([fix, unread]);
      expect(notice.paragraphs).toEqual([INCOMPLETE]);
      expect(notice.details).toContain(`- g:companion@1.0.1: ${unread.evidenceFailure ?? NOT_RECORDED}`);
    }
    // A pure companion fixes nothing: it neither blocks nor joins the assurance.
    expect(advisoryNotice([fix, hold({ name: "g:pure", justification: "required", targets: undefined })]).paragraphs).toEqual([]);
  });
});
