/**
 * What secure-it tracks as GitHub issues, without any I/O: the subjects (an exact fix decision, or a package with
 * findings and no decision), the findings each issue was opened for, and the record an issue carries in its hidden
 * block. An issue is an instance of a subject: its subject never changes (a changed decision is a new subject, so a new
 * issue), and a subject can have several instances over time (A → B → A opens a third issue, inheriting nothing).
 * Issues are output only: nothing here chooses a version; the run's assessment does, from the registries and advisory
 * sources.
 */
import { createHash } from "node:crypto";

import { isObject } from "@leanish/gate/json";
import type { Ecosystem } from "@leanish/gate/versions";

/** One move of a decision: exactly what the fix changes. */
export interface DecisionMove {
  readonly ecosystem: Ecosystem;
  readonly name: string;
  readonly from: string;
  readonly to: string;
}

/**
 * What an issue is about: an exact coupled fix decision (targets and companions, whatever their age), or a package
 * with findings and no decision (repository-only advisories, a blocked fix). Never changes for an issue.
 */
export type Subject =
  | { readonly kind: "decision"; readonly moves: ReadonlyArray<DecisionMove> }
  | { readonly kind: "package"; readonly ecosystem: Ecosystem; readonly name: string };

/**
 * One advisory alias group on one package, identified by its package and any of its ids: the gate's canonical group id
 * can change when a snapshot learns an alias, so two keys are the same finding when their ids overlap.
 */
export interface FindingKey {
  readonly ecosystem: Ecosystem;
  readonly name: string;
  /** Every id the group has, sorted. */
  readonly ids: ReadonlyArray<string>;
}

/** A finding as a run observed it. */
export interface ObservedFinding extends FindingKey {
  /** The installed versions it affects, sorted. */
  readonly versions: ReadonlyArray<string>;
  /** Some record comes from a reviewed source (GitHub's database or OSV), not only the package's own repository. */
  readonly reviewed: boolean;
  readonly malicious: boolean;
  readonly severity: string | undefined;
}

/** A package version, for the young versions a decision takes. */
export interface PackageVersion {
  readonly ecosystem: Ecosystem;
  readonly name: string;
  readonly version: string;
}

/** A young version of a decision and when it's past the wait (UTC, ISO). */
export interface YoungVersion extends PackageVersion {
  readonly eligibleAt: string;
}

/** Where a subject stands this run. */
export type SubjectStatus =
  /** A package whose findings only the package's own repository publishes: reported, never acted on. */
  | { readonly kind: "informational" }
  /**
   * A package without a decision: no fix published (`no-fix`), no fix the run can take (`not-taken`: the rule refused
   * every candidate, or couldn't be applied, as its reasons say), or a check or the planning failed for it (`unassessed`).
   */
  | { readonly kind: "blocked"; readonly reason: "no-fix" | "not-taken" | "unassessed"; readonly detail: string }
  /** A decision taking versions selected before their wait ended: deferred, `take-early` can authorize it. */
  | { readonly kind: "waiting"; readonly young: ReadonlyArray<YoungVersion> }
  /**
   * A decision secure-it may carry out: everything past the wait, or a trusted package's ordinary fix (`trusted`), with
   * its PR once there is one.
   */
  | { readonly kind: "eligible"; readonly trusted: ReadonlyArray<PackageVersion>; readonly pr?: { readonly number: number; readonly url: string } };

export interface SubjectAssessment {
  readonly subject: Subject;
  /** The findings of the subject's packages: for a decision, also those its moves leave (membership isn't remediation). */
  readonly findings: ReadonlyArray<ObservedFinding>;
  readonly status: SubjectStatus;
}

/** What one run established about the default branch. */
export interface Assessment {
  /** The commit assessed. */
  readonly sha: string;
  /**
   * When a young version shown pending is confirmed as shown (UTC ISO, `Shown.since`): `syncIssues` sets it for each
   * round to that round's clock, taken after it read the issues back, plus a skew margin.
   */
  readonly at: string;
  /** Whether the inventory and every advisory lookup completed: only a complete one may conclude that a finding is gone. */
  readonly complete: boolean;
  readonly subjects: ReadonlyArray<SubjectAssessment>;
  /**
   * The findings a valid exception covers (`issue-observations.ts`): in no subject and no work, but still present, so
   * an issue's record learns their aliases and never takes their absence.
   */
  readonly excepted: ReadonlyArray<FindingKey>;
}

/** The `take-early` authorization an issue received: the label event, its reason comment and who did both. */
export interface Grant {
  readonly labelEventId: number;
  readonly reasonCommentId: number;
  readonly actor: string;
  /** The label event's time. */
  readonly at: string;
  /** The young versions the decision took when it was authorized: it covers those, or fewer as they age, never more. */
  readonly young: ReadonlyArray<PackageVersion>;
}

/** One execution under a grant, recorded before the agent starts so a crash can't silently start another. */
export interface Attempt {
  readonly id: string;
  readonly grantEventId: number;
  /** The branch the attempt publishes to, decided before execution. */
  readonly branch: string;
  readonly startedAt: string;
  readonly pr?: number;
  /**
   * Terminal outcomes: its PR merged or closed, the agent couldn't apply it, verification found something young it
   * didn't plan, it failed, or a run found it started without a recoverable publication.
   */
  readonly outcome?: "pr-merged" | "pr-closed" | "agent-refused" | "deferred" | "failed" | "interrupted";
}

/**
 * A closing the tool intends, written before it closes the issue: a closed issue without one is a person's
 * dismissal. A person may close as the PAT's login too, so the record tells them apart first; within a recorded
 * closing, only a closing by the token's login after `afterEvent` is taken for the tool's (a person using that same
 * account can still be mistaken for it: a documented limit).
 */
export interface PendingClose {
  readonly id: string;
  readonly reason: "superseded" | "resolved";
  /** The issues carrying on the work, for a superseded one: one decision may split in two, or two merge in one. */
  readonly successors: ReadonlyArray<number>;
  /** The commit whose assessment decided it. */
  readonly at: string;
  /**
   * The id of the issue's last event when the tool recorded this closing (0 with none): its own closing is the first
   * `closed` event by the token's login after it, so a person's earlier closing and reopening never read as coming
   * after the tool's, nor does another account's closing and reopening after it.
   */
  readonly afterEvent?: number;
}

/** A finding seen absent by a complete assessment while this issue tracked it: its episode ended. */
export interface Absence {
  readonly finding: FindingKey;
  readonly at: string;
}

/** What an issue's hidden block records. */
export interface IssueRecord {
  readonly version: 1;
  readonly subject: Subject;
  /** The assessed commit the issue was opened at. */
  readonly openedAt: string;
  /** The findings it was opened for, and each one that joined while it was current: what a person's closing dismisses. */
  readonly findings: ReadonlyArray<FindingKey>;
  readonly absences: ReadonlyArray<Absence>;
  readonly grant?: Grant;
  readonly attempts: ReadonlyArray<Attempt>;
  readonly pendingClose?: PendingClose;
  /** For a waiting decision: the young versions its issue shows, and since when it has shown them all (`Shown`). */
  readonly shown?: Shown;
}

/**
 * What a waiting decision's issue showed a person: its young versions, and since when every one of them has been
 * shown. `since` moves only when a version joins, never when one ages out: a label added before it can't have seen
 * the newcomer, so it doesn't authorize it. It's `SHOWN_PENDING` from the write that adds a version until a later read
 * confirms that write was published (`withShown`): no label authorizes anything meanwhile.
 */
export interface Shown {
  readonly young: ReadonlyArray<PackageVersion>;
  /** A UTC ISO time, or `SHOWN_PENDING`. */
  readonly since: string;
}

export const SHOWN_PENDING = "pending";

export const RECORD_VERSION = 1;

/** A subject's stable identity: its kind and exact moves (sorted), or its package. Never the advisories or the dates. */
export function subjectId(subject: Subject): string {
  if (subject.kind === "package") return `package:${subject.ecosystem}|${subject.name}`;
  const moves = [...subject.moves].map((move) => `${move.ecosystem}|${move.name}|${move.from}|${move.to}`).sort();
  return `decision:${createHash("sha256").update(JSON.stringify(moves)).digest("hex").slice(0, 32)}`;
}

/** Whether two keys are the same finding: same package, overlapping ids. */
export function sameFinding(a: FindingKey, b: FindingKey): boolean {
  return a.ecosystem === b.ecosystem && a.name === b.name && a.ids.some((id) => b.ids.includes(id));
}

/** The packages a subject is about. */
export function subjectPackages(subject: Subject): ReadonlyArray<{ readonly ecosystem: Ecosystem; readonly name: string }> {
  if (subject.kind === "package") return [{ ecosystem: subject.ecosystem, name: subject.name }];
  const seen = new Map<string, { ecosystem: Ecosystem; name: string }>();
  for (const move of subject.moves) seen.set(`${move.ecosystem}|${move.name}`, { ecosystem: move.ecosystem, name: move.name });
  return [...seen.values()];
}

/** The key of a finding, as records keep it: ids sorted and unique. */
export function keyOf(finding: FindingKey): FindingKey {
  return { ecosystem: finding.ecosystem, name: finding.name, ids: [...new Set(finding.ids)].sort() };
}

const ECOSYSTEMS: ReadonlySet<string> = new Set<Ecosystem>(["npm", "Maven", "GitHub Actions"]);

/**
 * The record a hidden block decoded to, or undefined when it isn't one this release reads: a malformed or foreign
 * payload is never half-read. The block is the tool's own, but a person with write access can edit an issue body.
 */
export function parseRecord(payload: unknown): IssueRecord | undefined {
  if (!isObject(payload) || payload["version"] !== RECORD_VERSION) return undefined;
  const subject = parseSubject(payload["subject"]);
  const findings = arrayOf(payload["findings"], parseFindingKey);
  const absences = arrayOf(payload["absences"], (value) => {
    if (!isObject(value) || !isText(value["at"])) return undefined;
    const finding = parseFindingKey(value["finding"]);
    return finding === undefined ? undefined : { finding, at: value["at"] };
  });
  const attempts = arrayOf(payload["attempts"], parseAttempt);
  if (subject === undefined || findings === undefined || absences === undefined || attempts === undefined || !isText(payload["openedAt"])) return undefined;
  const grant = payload["grant"] === undefined ? undefined : parseGrant(payload["grant"]);
  const pendingClose = payload["pendingClose"] === undefined ? undefined : parsePendingClose(payload["pendingClose"]);
  const shown = payload["shown"] === undefined ? undefined : parseShown(payload["shown"]);
  if ((payload["grant"] !== undefined && grant === undefined) || (payload["pendingClose"] !== undefined && pendingClose === undefined)
    || (payload["shown"] !== undefined && shown === undefined)) return undefined;
  return {
    version: RECORD_VERSION, subject, openedAt: payload["openedAt"], findings, absences, attempts,
    ...(grant === undefined ? {} : { grant }),
    ...(pendingClose === undefined ? {} : { pendingClose }),
    ...(shown === undefined ? {} : { shown }),
  };
}

function parseSubject(value: unknown): Subject | undefined {
  if (!isObject(value)) return undefined;
  if (value["kind"] === "package") {
    return isEcosystem(value["ecosystem"]) && isText(value["name"]) ? { kind: "package", ecosystem: value["ecosystem"], name: value["name"] } : undefined;
  }
  if (value["kind"] !== "decision") return undefined;
  const moves = arrayOf(value["moves"], (move) => (
    isObject(move) && isEcosystem(move["ecosystem"]) && isText(move["name"]) && isText(move["from"]) && isText(move["to"])
      ? { ecosystem: move["ecosystem"], name: move["name"], from: move["from"], to: move["to"] }
      : undefined
  ));
  return moves === undefined || moves.length === 0 ? undefined : { kind: "decision", moves };
}

function parseFindingKey(value: unknown): FindingKey | undefined {
  if (!isObject(value) || !isEcosystem(value["ecosystem"]) || !isText(value["name"])) return undefined;
  const ids = arrayOf(value["ids"], (id) => (isText(id) ? id : undefined));
  return ids === undefined || ids.length === 0 ? undefined : { ecosystem: value["ecosystem"], name: value["name"], ids };
}

function parsePackageVersion(value: unknown): PackageVersion | undefined {
  return isObject(value) && isEcosystem(value["ecosystem"]) && isText(value["name"]) && isText(value["version"])
    ? { ecosystem: value["ecosystem"], name: value["name"], version: value["version"] }
    : undefined;
}

function parseShown(value: unknown): Shown | undefined {
  if (!isObject(value) || !isText(value["since"])) return undefined;
  const young = arrayOf(value["young"], parsePackageVersion);
  return young === undefined ? undefined : { young, since: value["since"] };
}

function parseGrant(value: unknown): Grant | undefined {
  if (!isObject(value)) return undefined;
  const young = arrayOf(value["young"], parsePackageVersion);
  if (young === undefined || !isId(value["labelEventId"]) || !isId(value["reasonCommentId"]) || !isText(value["actor"]) || !isText(value["at"])) return undefined;
  return { labelEventId: value["labelEventId"], reasonCommentId: value["reasonCommentId"], actor: value["actor"], at: value["at"], young };
}

const OUTCOMES: ReadonlySet<string> = new Set(["pr-merged", "pr-closed", "agent-refused", "deferred", "failed", "interrupted"]);

function parseAttempt(value: unknown): Attempt | undefined {
  if (!isObject(value) || !isText(value["id"]) || !isId(value["grantEventId"]) || !isText(value["branch"]) || !isText(value["startedAt"])) return undefined;
  if (value["pr"] !== undefined && !isId(value["pr"])) return undefined;
  if (value["outcome"] !== undefined && !(typeof value["outcome"] === "string" && OUTCOMES.has(value["outcome"]))) return undefined;
  return {
    id: value["id"], grantEventId: value["grantEventId"], branch: value["branch"], startedAt: value["startedAt"],
    ...(value["pr"] === undefined ? {} : { pr: value["pr"] as number }),
    ...(value["outcome"] === undefined ? {} : { outcome: value["outcome"] as NonNullable<Attempt["outcome"]> }),
  };
}

function parsePendingClose(value: unknown): PendingClose | undefined {
  if (!isObject(value) || !isText(value["id"]) || !isText(value["at"])) return undefined;
  if (value["reason"] !== "superseded" && value["reason"] !== "resolved") return undefined;
  const successors = arrayOf(value["successors"], (number) => (isId(number) ? number : undefined));
  // A resolved issue has no successors; claiming some is a record no release writes.
  if (successors === undefined || (value["reason"] === "resolved" && successors.length > 0)) return undefined;
  const afterEvent = value["afterEvent"];
  if (afterEvent !== undefined && !(typeof afterEvent === "number" && Number.isSafeInteger(afterEvent) && afterEvent >= 0)) return undefined;
  return { id: value["id"], reason: value["reason"], successors, at: value["at"], ...(afterEvent === undefined ? {} : { afterEvent }) };
}

/** Every element parsed, or undefined when the value isn't an array or any element doesn't parse. */
function arrayOf<T>(value: unknown, parse: (element: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parsed: T[] = [];
  for (const element of value) {
    const item = parse(element);
    if (item === undefined) return undefined;
    parsed.push(item);
  }
  return parsed;
}

const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const isEcosystem = (value: unknown): value is Ecosystem => typeof value === "string" && ECOSYSTEMS.has(value);
