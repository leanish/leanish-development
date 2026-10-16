import type { PublicationJournal, PushedState } from "../src/journal.ts";

/** A journal in memory, for tests. */
export class MemoryJournal implements PublicationJournal {
  readonly entries = new Map<string, PushedState>();

  async pushed(repo: string, number: number, state: PushedState): Promise<void> {
    this.entries.set(`${repo.toLowerCase()}#${number}`, state);
  }

  async last(repo: string, number: number): Promise<PushedState | undefined> {
    return this.entries.get(`${repo.toLowerCase()}#${number}`);
  }
}
