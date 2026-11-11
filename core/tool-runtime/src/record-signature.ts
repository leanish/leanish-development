/**
 * How the tools trust the records they keep in GitHub (a PR's state, an issue's record), and the one signer both use.
 *
 * `signed` (the default): each record carries an HMAC-SHA-256 with a key only the tool's process holds, so editing the
 * record, or writing one, gets nothing. `trusted-editors`: nothing is signed or read from the Keychain, and whoever
 * can edit the tools' PRs and issues is trusted to (collaborators and integrations with that access).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export type RecordTrust = { readonly mode: "signed"; readonly key: Uint8Array } | { readonly mode: "trusted-editors" };

export const RECORD_MODES = ["signed", "trusted-editors"] as const;
export type RecordMode = (typeof RECORD_MODES)[number];

/** What a signature is over: a PR's state or an issue's record, so one can never stand in for the other. */
export type SignedRecord = "pr-state" | "issue-record";

/**
 * `value` as JSON with every object's keys sorted (by UTF-16 code units, at any depth) and arrays in their order: the
 * same data always gives the same text. Keys holding `undefined` are left out, as JSON.stringify does.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error(`a signed record can't hold ${typeof value}`);
  return json;
}

/** The base64url HMAC-SHA-256 (43 characters) of `payload` as a `kind` record. */
export function recordSignature(key: Uint8Array, kind: SignedRecord, payload: unknown): string {
  return createHmac("sha256", key).update(canonicalJson([kind, payload])).digest("base64url");
}

/** Whether `signature` is `payload`'s as a `kind` record, compared in constant time. */
export function signatureMatches(key: Uint8Array, kind: SignedRecord, payload: unknown, signature: string): boolean {
  const expected = Buffer.from(recordSignature(key, kind, payload));
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(expected, given);
}
