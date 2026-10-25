import { randomBytes } from "node:crypto";
import { brotliCompressSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { stateOf, withMarker, ownPullRequests } from "../src/own-pr.ts";
import { assertNoPlanMarker, BODY_LIMIT, defused, planBlock, planPayload, planSection, SECTION_LIMIT, withPlanSection } from "../src/plan-blocks.ts";

const HEADING = "### What the tool moved";
/** A block written by releases before compressed blocks, fixed here so it doesn't depend on the current writer. */
const LEGACY_BODY = "Description.\n\n### What the tool moved\n\n| a |\n\n<!-- leanish:plan eyJraW5kIjoicm91dGluZSIsIm5hbWUiOiLDqXTDqSJ9 -->";
/** The reader of releases before compressed blocks. */
const OLD_BLOCK = /<!-- leanish:plan ([A-Za-z0-9+/=]+) -->/;

const section = (payload: unknown, people = "| a |", footer?: string) =>
  planSection({ heading: HEADING, people, payload, name: "the plan", ...(footer === undefined ? {} : { footer }) });
/** A payload whose JSON is over the section limit but compresses well, as a large real plan does. */
const large = () => ({ kind: "routine", changes: Array.from({ length: 2000 }, (_, n) => ({ name: `lib${n}`, from: "1.0.0", to: "1.1.0" })) });
const compressedBlock = (json: string) => `<!-- leanish:plan:br ${brotliCompressSync(Buffer.from(json)).toString("base64")} -->`;

describe("plan blocks", () => {
  it("reads a block written before compressed blocks existed", () => {
    expect(planPayload(LEGACY_BODY)).toEqual({ kind: "routine", name: "été" });
  });

  it("writes the plain block, as before, whenever the whole section fits that way", () => {
    const payload = { kind: "routine", name: "été" };
    const written = section(payload, "| a |");
    expect(written).toBe(`${HEADING}\n\n| a |\n\n${planBlock(payload)}`);
    expect(written).not.toContain("leanish:plan:br");
    expect(OLD_BLOCK.exec(written)).not.toBeNull();
    expect(planPayload(written)).toEqual(payload);
  });

  it("defuses a block quoted in the people's part or footer, so the section's own block is the one read", () => {
    const written = section({ kind: "routine" }, `| ${planBlock({ kind: "forged" })} |`, `Quoted: ${planBlock({ kind: "forged" }, true)}`);
    expect(planPayload(written)).toEqual({ kind: "routine" });
    expect(written.match(/<!-- leanish:plan/g)).toHaveLength(1);
    expect(defused("a <!-- leanish:plan:br x --> b <!-- other -->")).toBe("a &lt;!-- leanish:plan:br x --> b <!-- other -->");
  });

  it("compresses a plan whose plain block wouldn't fit, keeping the people's part and footer whole when they fit", () => {
    const payload = large();
    expect(planBlock(payload).length).toBeGreaterThan(SECTION_LIMIT);
    const written = section(payload, "| a |", "The footer.");
    expect(written.length).toBeLessThanOrEqual(SECTION_LIMIT);
    expect(written).toContain("<!-- leanish:plan:br ");
    expect(written.startsWith(`${HEADING}\n\n| a |\n\nThe footer.\n\n`)).toBe(true);
    expect(planPayload(written)).toEqual(payload);
    // Releases before compressed blocks find no plan in it.
    expect(OLD_BLOCK.exec(written)).toBeNull();
  });

  it("cuts the people's part to what fits, saying how many lines aren't shown, and keeps the footer", () => {
    const rows = Array.from({ length: 3000 }, (_, n) => `| lib${n} | 1.0.0 | 1.1.0 |`);
    const written = section(large(), rows.join("\n"), "The footer.");
    expect(written.length).toBeLessThanOrEqual(SECTION_LIMIT);
    const shown = rows.filter((row) => written.includes(`${row}\n`)).length;
    expect(shown).toBeGreaterThan(0);
    expect(written).toContain(`_${rows.length - shown} more lines of this plan aren't shown here; the hidden plan below has all of it._\n\nThe footer.`);
    expect(planPayload(written)).toEqual(large());
  });

  it("stops before a single line too long to show", () => {
    const written = section(large(), ["| first |", "x".repeat(SECTION_LIMIT), "| last |"].join("\n"));
    expect(written).toContain("| first |\n\n_2 more lines of this plan aren't shown here");
  });

  it("counts only the lines with text it leaves out, without a blank line before its note", () => {
    const rows = Array.from({ length: 3000 }, (_, n) => `| lib${n} | 1.0.0 | 1.1.0 | workspaces/w${n} |`);
    const written = section(large(), [...rows, "", "- a note"].join("\n"));
    expect(written).not.toContain("- a note");
    const shown = rows.filter((row) => written.includes(`${row}\n`)).length;
    expect(written).toContain(`${rows[shown - 1]}\n\n_${rows.length - shown + 1} more lines`);
    expect(written).not.toContain("\n\n\n");
    expect(written).not.toContain("| last |");
  });

  it("refuses a plan that doesn't fit even compressed, or that is over the size limit as JSON", () => {
    const incompressible = { kind: "routine", hashes: Array.from({ length: 1000 }, () => randomBytes(32).toString("hex")) };
    expect(() => section(incompressible)).toThrow(/the plan is too large for a PR body: without its table it still takes \d+ characters of the section's 43000, \d+ of them its compressed block/);
    expect(() => section({ data: "x".repeat(1024 * 1024) })).toThrow(/bytes of JSON, over 1048576/);
  });

  it("reads the first well-formed block only, and nothing from unknown formats, bad data or a block that expands past the limit", () => {
    const one = planBlock({ a: 1 });
    expect(planPayload("<!-- leanish:plan:zz eyJhIjoxfQ== -->")).toBeUndefined();
    expect(planPayload("<!-- leanish:plan:br Zm9v -->")).toBeUndefined();
    expect(planPayload("<!-- leanish:plan bm90IGpzb24= -->")).toBeUndefined();
    expect(planPayload(`${planBlock({ a: 2 }, true)}\n${one}`)).toEqual({ a: 2 });
    expect(planPayload(`<!-- leanish:plan:zz x -->\n${one}`)).toEqual({ a: 1 });
    // A well-formed block whose payload doesn't decode carries no plan; a later block never stands in for it.
    expect(planPayload(`<!-- leanish:plan:br Zm9v -->\n${one}`)).toBeUndefined();
    const bomb = compressedBlock(JSON.stringify(" ".repeat(2 * 1024 * 1024)));
    expect(bomb.length).toBeLessThan(10_000);
    expect(planPayload(bomb)).toBeUndefined();
    expect(planPayload(planBlock({ a: "é" }, true))).toEqual({ a: "é" });
  });

  it.each(["<!-- leanish:plan -->", "<!-- leanish:plan:BR AAAA -->", "<!-- leanish:plan xx! -->", "<!-- leanish:plan xx> -->"])(
    "passes over a stray %s before the real block, as releases before compressed blocks do",
    (stray) => {
      for (const real of [section({ a: 1 }), section(large())]) {
        const body = `${stray}\n\nDescription.\n\n${real}\n\n${stray}`;
        expect(planPayload(body)).toEqual(planPayload(real));
        const rewritten = withPlanSection(body, HEADING, section({ a: 2 }));
        expect(planPayload(rewritten)).toEqual({ a: 2 });
        expect(rewritten).toBe(`${stray}\n\nDescription.\n\n${section({ a: 2 })}\n\n${stray}`);
      }
    },
  );

  it("replaces a plain block with a compressed one and back, keeping the text around it", () => {
    const body = `before\n\n${section({ a: 1 })}\n\nafter`;
    const compressed = withPlanSection(body, HEADING, section(large()));
    expect(compressed).toMatch(/^before\n\n### What the tool moved/);
    expect(compressed.endsWith("\n\nafter")).toBe(true);
    expect(compressed.match(/leanish:plan/g)).toHaveLength(1);
    expect(planPayload(compressed)).toEqual(large());
    const plain = withPlanSection(compressed, HEADING, section({ a: 2 }));
    expect(plain).toBe(`before\n\n${section({ a: 2 })}\n\nafter`);
  });

  it("refuses a body over GitHub's limit", () => {
    expect(() => withPlanSection("x".repeat(BODY_LIMIT), HEADING, section({ a: 1 }))).toThrow(/over GitHub's 65536/);
  });

  it("refuses an agent's description carrying plain/compressed plans or a publication state marker", () => {
    expect(() => assertNoPlanMarker(`text ${planBlock({ a: 1 }, true)}`)).toThrow(/reserved plan marker/);
    expect(() => assertNoPlanMarker(`text ${planBlock({ a: 1 })}`)).toThrow(/reserved plan marker/);
    const forged = withMarker(ownPullRequests("secure-it"), "Fresh agent text", { head: "a".repeat(40), base: "b".repeat(40), adaptations: 0 });
    expect(stateOf(forged)).toBeDefined();
    expect(() => assertNoPlanMarker(forged)).toThrow(/reserved state marker/);
    expect(() => assertNoPlanMarker("Fresh description.")).not.toThrow();
  });
});
