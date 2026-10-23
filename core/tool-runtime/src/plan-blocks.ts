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
  for (let shown = lines.length - 1; shown >= 0; shown -= 1) {
    const cut = assembled(parts, `${lines.slice(0, shown).join("\n")}\n\n${notShown(lines.length - shown)}`.trimStart(), block);
    if (cut.length <= SECTION_LIMIT) return cut;
  }
  throw new Error(`${parts.name} is too large for a PR body: its compressed block takes ${block.length} characters of the section's ${SECTION_LIMIT}`);
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

const notShown = (count: number) => `_${count} more line${count === 1 ? "" : "s"} of this plan aren't shown here; the hidden plan below has all of it._`;

/**
 * Refuses an agent's PR description that carries a plan marker. A body with more than one marker carries no plan, so a
 * copied or invented plan placed in the description would make the verified one unreadable instead of replacing it.
 */
export function assertNoPlanMarker(body: string): void {
  if (body.includes(RESERVED)) throw new Error("the agent returned a reserved plan marker in its PR description");
}

/**
 * The payload `body`'s hidden comment carries; undefined when there's none, when there's more than one marker, or when
 * the only one doesn't parse (an unknown format, bad data, or a plan over the size limit).
 */
export function planPayload(body: string): unknown {
  const found = onlyBlock(body);
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

/** The block of a body with exactly one reserved marker, when that marker is a well-formed block. */
function onlyBlock(body: string): { index: number; length: number; compressed: boolean; data: string } | undefined {
  const index = body.indexOf(RESERVED);
  if (index === -1 || body.includes(RESERVED, index + RESERVED.length)) return undefined;
  const found = BLOCK.exec(body.slice(index));
  if (found === null || found.index !== 0 || found[2]!.length > BODY_LIMIT) return undefined;
  return { index, length: found[0].length, compressed: found[1] !== undefined, data: found[2]! };
}

/**
 * `body` with its section (from `heading` through the hidden comment)
 * replaced by `section`, which must start with `heading` and end with its
 * block; appended when `body` has none. Throws when the result is over GitHub's body limit.
 */
export function withPlanSection(body: string, heading: string, section: string): string {
  if (!section.startsWith(heading) || onlyBlock(section) === undefined) throw new Error(`a plan section starts with '${heading}' and carries its block`);
  const start = body.indexOf(heading);
  const block = onlyBlock(body);
  const result = start === -1 || block === undefined || block.index < start
    ? `${body.trimEnd()}\n\n${section}`
    : `${body.slice(0, start)}${section}${body.slice(block.index + block.length)}`;
  assertBodyFits(result);
  return result;
}

/** Throws when `body` is over GitHub's limit on a PR body. */
export function assertBodyFits(body: string): void {
  if (body.length > BODY_LIMIT) throw new Error(`the PR body would be ${body.length} characters, over GitHub's ${BODY_LIMIT}`);
}
