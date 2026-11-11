/**
 * The note a tool's PR carries about the exceptions it removed (`exception-cleanup.ts`): the entries of
 * `.github/supply-chain-exceptions.json` its base has and its verified head doesn't. The policy fence admits only
 * removals to that file, so comparing the two texts is enough; no inventory is read again. Publication writes it
 * (`publication.ts`), replacing any earlier one, and leaves it out when the body wouldn't fit with it: the PR's diff of
 * the file still shows the removal. Bodies a tool recomposes drop it first (`splitExceptionsNote`), so it never counts
 * against their budgets.
 */
import { isDeepStrictEqual } from "node:util";

import { EXCEPTIONS_PATH } from "@leanish/gate/gate";

import { literal } from "./pr-text.ts";

const START = "<!-- leanish:removed-exceptions -->";
const END = "<!-- /leanish:removed-exceptions -->";
/** The note's own size bound: entries past it are counted, not listed. */
const NOTE_LIMIT = 2_000;
const LISTS = ["vulnerabilities", "releaseAge", "identity"] as const;

/** The note for what `headText` lacks of `baseText`'s entries; undefined when nothing was removed or either isn't JSON. */
export function exceptionsNote(baseText: string | undefined, headText: string | undefined): string | undefined {
  if (baseText === undefined || headText === undefined || baseText === headText) return undefined;
  const before = parsed(baseText);
  const after = parsed(headText);
  if (before === undefined || after === undefined) return undefined;
  const labels = LISTS.flatMap((list) => entriesOf(before, list)
    .filter((entry) => !entriesOf(after, list).some((kept) => isDeepStrictEqual(kept, entry)))
    .map((entry) => labelOf(list, entry)));
  if (labels.length === 0) return undefined;
  const opening = [START, "### Exceptions this PR leaves unused", "",
    `Removed from ${literal(EXCEPTIONS_PATH)}: nothing in this PR matches them any more.`, ""];
  const lines: string[] = [];
  for (const [i, label] of labels.entries()) {
    const rest = labels.length - i - 1;
    // Room kept for the closing line counting the rest, whenever one may still be needed.
    const closing = rest === 0 ? 0 : 60;
    if ([...opening, ...lines, `- ${label}`, END].join("\n").length + closing > NOTE_LIMIT) {
      lines.push(`- and ${labels.length - i} more (the file's diff lists them)`);
      break;
    }
    lines.push(`- ${label}`);
  }
  return [...opening, ...lines, END].join("\n");
}

/**
 * `body` without its note, and the note it had. Each opening marker pairs with the first closing one after it, and the
 * note is the last such pair (it's written last, before the state marker): a stray marker of either kind, before or after
 * it (quoted in someone's text, say), neither hides the note nor takes other text away with it.
 */
export function splitExceptionsNote(body: string): { readonly body: string; readonly note: string | undefined } {
  let start = -1;
  let end = -1;
  for (let at = body.indexOf(START); at !== -1; at = body.indexOf(START, at + START.length)) {
    const closing = body.indexOf(END, at);
    if (closing !== -1) [start, end] = [at, closing];
  }
  if (start === -1) return { body, note: undefined };
  const rest = body.slice(end + END.length).trimStart();
  return { body: `${body.slice(0, start).trimEnd()}${rest === "" ? "" : `\n\n${rest}`}`, note: body.slice(start, end + END.length) };
}

/** `body` with `note` in place of any earlier one, at its end; without any when `note` is undefined. */
export function withExceptionsNote(body: string, note: string | undefined): string {
  const bare = splitExceptionsNote(body).body;
  return note === undefined ? bare : `${bare.trimEnd()}\n\n${note}`;
}

function parsed(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function entriesOf(file: Record<string, unknown>, list: string): unknown[] {
  const entries = file[list];
  return Array.isArray(entries) ? entries : [];
}

function labelOf(list: (typeof LISTS)[number], entry: unknown): string {
  const record = entry !== null && typeof entry === "object" ? entry as Record<string, unknown> : {};
  const pkg = literal(`${String(record["package"])}@${String(record["version"])}`);
  if (list === "vulnerabilities") return `${literal(String(record["id"]))} on ${pkg}`;
  if (list === "releaseAge") return `${pkg}'s release-age exception (${literal(String(record["advisory"]))})`;
  return `${pkg}'s publisher identity exception`;
}

/**
 * `compose` run on `body` without its note, so the note never counts against the composition's own budget; the note
 * goes back at the end when the result still fits within `limit`, and is dropped otherwise (publication writes it again
 * when the PR is next published).
 */
export function composedAroundNote(body: string, limit: number, compose: (bare: string) => string): string {
  const { body: bare, note } = splitExceptionsNote(body);
  const result = compose(bare);
  if (note === undefined) return result;
  const noted = withExceptionsNote(result, note);
  return noted.length <= limit ? noted : result;
}
