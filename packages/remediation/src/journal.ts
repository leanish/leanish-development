/**
 * The tool's own record of what it pushes to each PR, written before a
 * push and before the PR's body is updated to say so. If that update fails,
 * the PR's head is the tool's commit but its body still names the previous
 * one; the review tick then finds the exact head here, repairs the body, and
 * carries on, instead of reading its own push as someone else's. Only an exact
 * match counts: any other head is still someone else's push.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface PushedState {
  readonly head: string;
  readonly base: string;
  /** Absent in old journals: those cannot safely recover a changed plan. */
  readonly publication?: {
    readonly title: string;
    readonly body: string;
    readonly adaptations: number;
  };
}

export interface PublicationJournal {
  /** Records the intended publication before pushing; an exact remote head confirms that it landed. */
  pushed(repo: string, number: number, state: PushedState): Promise<void>;
  /** What the tool last recorded pushing to that PR. */
  last(repo: string, number: number): Promise<PushedState | undefined>;
}

/** One JSON file per repository under the tool's state directory: `journal/<owner>__<repo>.json`. */
export class FileJournal implements PublicationJournal {
  readonly #dir: string;

  constructor(stateDir: string) {
    this.#dir = join(stateDir, "journal");
  }

  async pushed(repo: string, number: number, state: PushedState): Promise<void> {
    const file = this.#file(repo);
    const entries = await this.#read(file);
    entries[String(number)] = state;
    await mkdir(dirname(file), { recursive: true });
    // Written whole and renamed into place: a crash leaves the old record, never half of one.
    await writeFile(`${file}.tmp`, `${JSON.stringify(entries, null, 2)}\n`);
    await rename(`${file}.tmp`, file);
  }

  async last(repo: string, number: number): Promise<PushedState | undefined> {
    const file = this.#file(repo);
    const entry = (await this.#read(file))[String(number)];
    return entry === undefined ? undefined : pushedState(entry, `${file}: #${number}`);
  }

  #file(repo: string): string {
    return join(this.#dir, `${repo.toLowerCase().replace("/", "__")}.json`);
  }

  async #read(file: string): Promise<Record<string, unknown>> {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw err;
    }
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${file} isn't a journal`);
    return parsed as Record<string, unknown>;
  }
}

/** A recorded entry, checked before recovery trusts it: a hand-edited or damaged one fails instead. */
function pushedState(value: unknown, where: string): PushedState {
  if (!isRecord(value)) throw new Error(`${where} isn't a pushed state`);
  const { head, base, publication } = value;
  if (!isSha(head) || !isSha(base)) throw new Error(`${where} lacks its head and base commits`);
  if (publication === undefined) return { head, base };
  if (!isRecord(publication)) throw new Error(`${where} has a malformed publication`);
  const { title, body, adaptations } = publication;
  if (typeof title !== "string" || typeof body !== "string" || typeof adaptations !== "number" || !Number.isInteger(adaptations) || adaptations < 0) {
    throw new Error(`${where} has a malformed publication`);
  }
  return { head, base, publication: { title, body, adaptations } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(value);
}
