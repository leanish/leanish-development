import { brotliCompressSync, brotliDecompressSync } from "node:zlib";

/**
 * A tool's plan in its PR's body: a section for people (a heading, then the
 * tool's table) that ends with the plan itself in a hidden comment, so a later
 * run or review tick reads back exactly what was planned. The plan is base64
 * JSON (`<!-- leanish:plan … -->`), or, when that doesn't fit, base64 brotli
 * JSON (`<!-- leanish:plan:br … -->`).
 */
const RESERVED = "<!-- leanish:plan";
const BLOCK = /<!-- leanish:plan(:br)? ([A-Za-z0-9+/=]+) -->/;

/** A plan section's size limit, leaving the rest of GitHub's body limit to the agent's description. */
export const SECTION_LIMIT = 43_000;
/** GitHub's limit on a PR body. */
export const BODY_LIMIT = 65_536;
/** The largest plan, as JSON, a block carries or is read into; it bounds decompression. */
const PLAN_BYTE_LIMIT = 1024 * 1024;

/** A tool's plan section: its people's part, shortened only when the section wouldn't fit otherwise. */
export interface PlanSectionParts {
  readonly heading: string;
  /** Markdown lines for people; when they don't fit, the first ones that do are shown, with a line saying how many aren't. */
  readonly people: string;
  /** Text shown after `people` in every case. */
  readonly footer?: string;
  readonly payload: unknown;
  /** What the plan is called in an error, e.g. "bump-it's plan". */
  readonly name: string;
}

/**
 * The section for `parts`. The block is plain base64 whenever the whole section fits that way, which is exactly when
 * releases before compressed blocks could write it too, so they keep reading those PRs; otherwise it's compressed, and
 * the people's part is cut to what fits. Throws when even the compressed block with no people's part doesn't fit.
 */
export function planSection(parts: PlanSectionParts): string {
  const json = Buffer.from(JSON.stringify(parts.payload));
  if (json.length > PLAN_BYTE_LIMIT) throw new Error(`${parts.name} is too large for a PR body: ${json.length} bytes of JSON, over ${PLAN_BYTE_LIMIT}`);
  const legacy = assembled(parts, parts.people, encoded(json, false));
  if (legacy.length <= SECTION_LIMIT) return legacy;
  const block = encoded(json, true);
  const whole = assembled(parts, parts.people, block);
  if (whole.length <= SECTION_LIMIT) return whole;
  const lines = parts.people.split("\n");
  const cut = (shown: number) => {
    const hidden = lines.slice(shown).filter((line) => line.trim() !== "").length;
    return assembled(parts, `${lines.slice(0, shown).join("\n").trimEnd()}\n\n${notShown(hidden)}`.trimStart(), block);
  };
  if (cut(0).length > SECTION_LIMIT) {
    throw new Error(`${parts.name} is too large for a PR body: without its table it still takes ${cut(0).length} characters of the section's ${SECTION_LIMIT}, ${block.length} of them its compressed block`);
  }
  // The most lines that fit, by bisection: showing more lines never makes the section shorter.
  let fits = 0;
  let over = lines.length;
  while (over - fits > 1) {
    const middle = Math.floor((fits + over) / 2);
    if (cut(middle).length <= SECTION_LIMIT) fits = middle;
    else over = middle;
  }
  return cut(fits);
}

/** The hidden comment carrying `payload`, as plain base64 JSON or, when `compressed`, base64 brotli JSON. */
export function planBlock(payload: unknown, compressed = false): string {
  return encoded(Buffer.from(JSON.stringify(payload)), compressed);
}

function encoded(json: Buffer, compressed: boolean): string {
  return compressed ? `${RESERVED}:br ${brotliCompressSync(json).toString("base64")} -->` : `${RESERVED} ${json.toString("base64")} -->`;
}

function assembled(parts: PlanSectionParts, people: string, block: string): string {
  return [parts.heading, people, ...(parts.footer === undefined ? [] : [parts.footer]), block].join("\n\n");
}

const notShown = (count: number) => `_${count} more line${count === 1 ? "" : "s"} of this plan ${count === 1 ? "isn't" : "aren't"} shown here; the hidden plan below has all of it._`;

/**
 * Refuses an agent's PR description that carries a plan marker. Reads take the first marker in a body, so a copied
 * or invented plan placed before the tool's own section would replace the verified plan for every later read.
 */
export function assertNoPlanMarker(body: string): void {
  if (body.includes(RESERVED)) throw new Error("the agent returned a reserved plan marker in its PR description");
}

/**
 * The payload of `body`'s first well-formed block, as releases before compressed blocks read it: other text starting
 * with the reserved prefix is passed over. Undefined when there's none, or when that block's payload doesn't decode
 * (bad data, or a plan over the size limit); a later block never stands in for it.
 */
export function planPayload(body: string): unknown {
  const found = firstBlock(body);
  if (found === undefined) return undefined;
  try {
    const data = Buffer.from(found.data, "base64");
    // maxOutputLength stops decompression at the limit, so a small tampered block can't expand without bound.
    const json = found.compressed ? brotliDecompressSync(data, { maxOutputLength: PLAN_BYTE_LIMIT }) : data;
    if (json.length > PLAN_BYTE_LIMIT) return undefined;
    return JSON.parse(json.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/** A body's first well-formed block, of a format this release reads. */
function firstBlock(body: string): { index: number; length: number; compressed: boolean; data: string } | undefined {
  const found = BLOCK.exec(body);
  if (found === null || found[2]!.length > BODY_LIMIT) return undefined;
  return { index: found.index, length: found[0].length, compressed: found[1] !== undefined, data: found[2]! };
}

/**
 * `body` with its section (from `heading` through the hidden comment)
 * replaced by `section`, which must start with `heading` and end with its
 * block; appended when `body` has none. Any other plan block left in the body
 * goes: a reader takes the first one, and a release that can't read a
 * compressed block would take an older plain one after it. Throws when the
 * result is over GitHub's body limit.
 */
export function withPlanSection(body: string, heading: string, section: string): string {
  if (!section.startsWith(heading) || firstBlock(section) === undefined) throw new Error(`a plan section starts with '${heading}' and carries its block`);
  const start = body.indexOf(heading);
  const block = start === -1 ? null : BLOCK.exec(body.slice(start));
  const [before, after] = start === -1 || block === null
    ? [`${body.trimEnd()}\n\n`, ""]
    : [body.slice(0, start), body.slice(start + block.index + block[0].length)];
  const result = `${withoutMarkers(before)}${section}${withoutMarkers(after)}`;
  assertBodyFits(result);
  return result;
}

/**
 * `text` without any comment starting with the reserved prefix that closes on the same line, well-formed or not (a
 * plan block is always one line). One left open on its line stays, and so does everything after it up to any later
 * `-->`, which belongs to whoever wrote it. Linear: the next close and the next line end are only ever searched forward.
 */
function withoutMarkers(text: string): string {
  let result = "";
  let kept = 0;
  let close = -1;
  let lineEnd = -1;
  for (let at = text.indexOf(RESERVED); at !== -1; ) {
    if (close < at) close = text.indexOf("-->", at + RESERVED.length);
    if (close === -1) break;
    if (lineEnd < at) {
      const next = text.indexOf("\n", at);
      lineEnd = next === -1 ? text.length : next;
    }
    if (lineEnd < close) {
      at = text.indexOf(RESERVED, at + RESERVED.length);
      continue;
    }
    result += text.slice(kept, at);
    kept = close + "-->".length;
    at = text.indexOf(RESERVED, kept);
  }
  return result + text.slice(kept);
}

/** Throws when `body` is over GitHub's limit on a PR body. */
export function assertBodyFits(body: string): void {
  if (body.length > BODY_LIMIT) throw new Error(`the PR body would be ${body.length} characters, over GitHub's ${BODY_LIMIT}`);
}
