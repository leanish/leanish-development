// The signed trust the tests read and write issue records with: the same key as the tests' PR signatures.
import type { RecordTrust } from "@leanish/tool-runtime/record-signature";
import { TEST_SIGNING_KEY } from "@leanish/tool-runtime/test/fake-github";

import { type IssueSeal, type IssueWriter, issueWriter } from "../src/issue-text.ts";

export const TEST_TRUST: RecordTrust = { mode: "signed", key: TEST_SIGNING_KEY };

/** The seal for `repo`'s issue records, signed with the tests' key. */
export function sealFor(repo: string): IssueSeal {
  return { repo, trust: TEST_TRUST };
}

/** An issue writer for `repo`, signing with the tests' key; `clean` as publication would, or nothing. */
export function writerFor(repo: string, clean: (body: string) => string = (body) => body): IssueWriter {
  return issueWriter(clean, sealFor(repo));
}
