/** Shared advisory-id lookups and parsing for snapshots and held-version evidence. */
import type { Fetch } from "./http.ts";
import { isObject } from "./json.ts";
import type { PackageName, PackageVersion } from "./package-version.ts";
import { affects, namesPackage, type RepositoryAdvisory } from "./repository-advisories.ts";
import { type Ecosystem, versionScheme } from "./versions.ts";

const GITHUB_API = "https://api.github.com";
const OSV_API = "https://api.osv.dev/v1";

/** Whether a record's ranges put a version among the affected ones; `unknown` when they can't say. */
export type RangeVerdict = "affected" | "not-affected" | "unknown";

export interface EvidenceRecord {
  readonly id: string;
  readonly aliases: ReadonlyArray<string>;
  readonly withdrawn: boolean;
  /** GitHub's database only: whether GitHub reviewed it. */
  readonly reviewed?: boolean;
  /** Whether it names the target package at all; the rest says nothing about the package when it doesn't. */
  readonly namesPackage: boolean;
  /** The fixed versions it declares for the package (patched versions, or OSV's `fixed` events). */
  readonly declaredFixes: ReadonlyArray<string>;
  /** Version → its verdict, for the replaced versions of its group and the target's proposed ones. */
  readonly verdicts: Readonly<Record<string, RangeVerdict>>;
}

/** Each id is fetched once per source, including absent records and failed requests. */
export class AdvisoryRecords {
  readonly #fetch: Fetch;
  readonly #token: string | undefined;
  readonly #github = new Map<string, Promise<unknown>>();
  readonly #osv = new Map<string, Promise<unknown>>();

  constructor(options: { readonly fetch: Fetch; readonly token: string | undefined }) {
    this.#fetch = options.fetch;
    this.#token = options.token;
  }

  async github(id: string, pkg: PackageName, versions: ReadonlyArray<string>): Promise<EvidenceRecord | undefined> {
    const raw = await this.#githubRaw(id);
    return raw === undefined ? undefined : githubRecord(raw, id, pkg, versions);
  }

  async osv(id: string, pkg: PackageName, versions: ReadonlyArray<string>): Promise<EvidenceRecord | undefined> {
    const raw = await this.#osvRaw(id);
    return raw === undefined ? undefined : osvRecord(raw, id, pkg, versions);
  }

  /**
   * The reviewed record must independently clear the version before it can override a repository finding.
   * GitHub's individual-record endpoint takes GHSA ids; OSV also accepts CVE aliases.
   */
  async reviewed(id: string, pkg: PackageVersion): Promise<EvidenceRecord | undefined> {
    const github = pkg.ecosystem === "GitHub Actions";
    if (github && !id.startsWith("GHSA-")) return undefined;
    const raw = await (github ? this.#githubRaw(id) : this.#osvRaw(id));
    if (raw === undefined) return undefined;
    if (!isObject(raw)) throw new Error(`reviewed record ${id} isn't an object`);
    validateReviewedRecord(raw, id, github);
    const databaseSpecific = raw["database_specific"];
    if (!github && (raw["id"] as string).startsWith("GHSA-")
      && isObject(databaseSpecific) && databaseSpecific["github_reviewed"] === false) return undefined;
    if (github && raw["type"] !== "reviewed") {
      if (raw["type"] === "unreviewed" || raw["type"] === "malware") return undefined;
      throw new Error(`GitHub advisory ${id} has no readable type`);
    }
    return github ? githubRecord(raw, id, pkg, [pkg.version]) : osvRecord(raw, id, pkg, [pkg.version]);
  }

  #githubRaw(id: string): Promise<unknown> {
    const headers: Record<string, string> = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
    if (this.#token !== undefined) headers["authorization"] = `Bearer ${this.#token}`;
    return this.#once(this.#github, id, `${GITHUB_API}/advisories/${encodeURIComponent(id)}`, headers, `GitHub advisory ${id}`);
  }

  #osvRaw(id: string): Promise<unknown> {
    return this.#once(this.#osv, id, `${OSV_API}/vulns/${encodeURIComponent(id)}`, {}, `OSV record ${id}`);
  }

  #once(cache: Map<string, Promise<unknown>>, id: string, url: string, headers: Record<string, string>, what: string): Promise<unknown> {
    let found = cache.get(id);
    if (found === undefined) {
      found = this.#json(url, headers, what);
      cache.set(id, found);
    }
    return found;
  }

  async #json(url: string, headers: Record<string, string>, what: string): Promise<unknown> {
    const response = await this.#fetch(url, { headers });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`${what} failed with HTTP ${response.status}`);
    return response.json();
  }
}

/** Snapshot-only validation; the informative evidence readers retain their permissive parsing. */
function validateReviewedRecord(raw: Record<string, unknown>, id: string, github: boolean): void {
  const recordId = raw[github ? "ghsa_id" : "id"];
  // Evidence tolerates empty ids as before; no snapshot drop may use one.
  if (!nonemptyString(recordId)) throw new Error(`${github ? "GitHub advisory" : "OSV record"} ${id} has no ${github ? "ghsa_id" : "id"}`);
  const aliases = github ? [] : checkedStrings(raw["aliases"], "aliases");
  if (github ? recordId !== id : recordId !== id && !aliases.includes(id)) throw new Error(`reviewed record ${recordId} doesn't identify requested ${id}`);
  optionalText(raw[github ? "withdrawn_at" : "withdrawn"], github ? "withdrawn_at" : "withdrawn");
  if (github) {
    if (raw["cve_id"] !== undefined && raw["cve_id"] !== null && !nonemptyString(raw["cve_id"])) throw new Error("reviewed record has unreadable cve_id");
    const identifiers = raw["identifiers"];
    if (identifiers !== undefined && (!Array.isArray(identifiers) || !identifiers.every((entry: unknown) => isObject(entry) && nonemptyString(entry["value"])))) throw new Error("reviewed record has unreadable identifiers");
  } else {
    const specific = raw["database_specific"];
    if (specific !== undefined && (!isObject(specific) || (specific["github_reviewed"] !== undefined && typeof specific["github_reviewed"] !== "boolean"))) throw new Error("reviewed record has unreadable github_reviewed metadata");
  }
  const entries = raw[github ? "vulnerabilities" : "affected"];
  if (!Array.isArray(entries)) throw new Error(`reviewed record ${id} has no readable package list`);
  for (const entry of entries as unknown[]) {
    if (!isObject(entry)) throw new Error(`reviewed record ${id} has no readable package list`);
    const pkg = entry["package"];
    // Source-repository entries have no package identity; their Git ranges/tags cannot decide a package version.
    if (pkg === undefined || pkg === null) continue;
    if (!isObject(pkg) || !nonemptyString(pkg["ecosystem"]) || !nonemptyString(pkg["name"])) throw new Error(`reviewed record ${id} has no readable package list`);
    if (github) validateGithubRanges(entry);
    else validateOsvRanges(entry);
  }
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

function checkedStrings(value: unknown, field: string): ReadonlyArray<string> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(nonemptyString)) throw new Error(`reviewed record has unreadable ${field}`);
  return value as string[];
}

function optionalText(value: unknown, field: string): void {
  if (value !== undefined && value !== null && typeof value !== "string") throw new Error(`reviewed record has unreadable ${field}`);
}

function validateGithubRanges(entry: Record<string, unknown>): void {
  optionalText(entry["vulnerable_version_range"], "vulnerable_version_range");
  const patched = entry["first_patched_version"];
  if (patched !== undefined && patched !== null && !nonemptyString(patched)
    && !(isObject(patched) && nonemptyString(patched["identifier"]))) throw new Error("reviewed record has unreadable first_patched_version");
}

function validateOsvRanges(entry: Record<string, unknown>): void {
  checkedStrings(entry["versions"], "versions");
  const ranges = entry["ranges"];
  if (ranges === undefined) return;
  if (!Array.isArray(ranges)) throw new Error("reviewed record has unreadable ranges");
  for (const range of ranges as unknown[]) {
    if (!isObject(range) || !["ECOSYSTEM", "SEMVER", "GIT"].includes(range["type"] as string)
      || !Array.isArray(range["events"]) || !readableEvents(range["events"])
      || !range["events"].every((event: Record<string, unknown>) => Object.values(event).every(nonemptyString))) throw new Error("reviewed record has unreadable ranges/events");
    if (range["type"] === "SEMVER") {
      for (const event of range["events"] as Record<string, string>[]) {
        if (event["introduced"] === "0") continue;
        const bound = Object.values(event)[0]!;
        try {
          versionScheme("npm").compare(bound, bound);
        } catch {
          throw new Error("reviewed record has unreadable SEMVER bounds");
        }
      }
    }
  }
}

function githubRecord(raw: unknown, id: string, pkg: PackageName, versions: ReadonlyArray<string>): EvidenceRecord {
  if (!isObject(raw) || typeof raw["ghsa_id"] !== "string") throw new Error(`GitHub advisory ${id} has no ghsa_id`);
  const identifiers = Array.isArray(raw["identifiers"]) ? raw["identifiers"] : [];
  const aliases = [
    ...(typeof raw["cve_id"] === "string" ? [raw["cve_id"]] : []),
    ...identifiers.flatMap((entry: unknown) => (isObject(entry) && typeof entry["value"] === "string" ? [entry["value"]] : [])),
  ].filter((alias) => alias !== raw["ghsa_id"]);
  const vulnerabilities = (Array.isArray(raw["vulnerabilities"]) ? raw["vulnerabilities"] : []).flatMap((entry: unknown) => {
    const found = isObject(entry) ? entry["package"] : undefined;
    if (!isObject(found) || typeof found["ecosystem"] !== "string" || typeof found["name"] !== "string") return [];
    const first = (entry as Record<string, unknown>)["first_patched_version"];
    // Older responses wrap the version as `{ identifier }`.
    const patched = typeof first === "string" ? first : isObject(first) && typeof first["identifier"] === "string" ? first["identifier"] : undefined;
    const range = (entry as Record<string, unknown>)["vulnerable_version_range"];
    return [{ ecosystem: found["ecosystem"], name: found["name"], range: typeof range === "string" ? range : undefined, patched }];
  });
  const withdrawn = typeof raw["withdrawn_at"] === "string";
  // Global databases identify Maven packages by full coordinates; bare artifactIds belong to repository records.
  const exact = vulnerabilities.filter((vulnerability) => samePackageName(vulnerability.name, pkg));
  // GitHub reviews malware records too; only `unreviewed` ones are its unchecked imports.
  return advisoryRecord(raw["ghsa_id"], [...new Set(aliases)], withdrawn, raw["type"] === "reviewed" || raw["type"] === "malware", { vulnerabilities: exact }, pkg, versions);
}

function samePackageName(name: string, pkg: PackageName): boolean {
  return name === pkg.name || (pkg.ecosystem === "GitHub Actions" && name.toLowerCase() === pkg.name);
}

export function advisoryRecord(
  id: string, aliases: ReadonlyArray<string>, withdrawn: boolean, reviewed: boolean | undefined,
  advisory: Pick<RepositoryAdvisory, "vulnerabilities">, pkg: PackageName, versions: ReadonlyArray<string>,
): EvidenceRecord {
  const mine = advisory.vulnerabilities.filter((vulnerability) => namesPackage(vulnerability, pkg));
  const verdicts: Record<string, RangeVerdict> = {};
  for (const version of versions) {
    const verdict = mine.length === 0 ? undefined : affects({ vulnerabilities: mine }, { ...pkg, version });
    verdicts[version] = verdict === undefined ? "unknown" : verdict ? "affected" : "not-affected";
  }
  return {
    id, aliases, withdrawn, ...(reviewed === undefined ? {} : { reviewed }), namesPackage: mine.length > 0,
    declaredFixes: [...new Set(mine.flatMap((vulnerability) => (vulnerability.patched === undefined ? [] : [vulnerability.patched.trim()])))],
    verdicts,
  };
}

/** OSV's ecosystem names for ours. */
const OSV_ECOSYSTEMS: Readonly<Record<Ecosystem, string>> = { npm: "npm", Maven: "Maven", "GitHub Actions": "GitHub Actions" };

function osvRecord(raw: unknown, id: string, pkg: PackageName, versions: ReadonlyArray<string>): EvidenceRecord {
  if (!isObject(raw) || typeof raw["id"] !== "string") throw new Error(`OSV record ${id} has no id`);
  const aliases = Array.isArray(raw["aliases"]) ? raw["aliases"].filter((alias): alias is string => typeof alias === "string") : [];
  const mine = (Array.isArray(raw["affected"]) ? raw["affected"] : []).filter((entry: unknown) => {
    const found = isObject(entry) ? entry["package"] : undefined;
    return isObject(found) && found["ecosystem"] === OSV_ECOSYSTEMS[pkg.ecosystem] && typeof found["name"] === "string"
      && samePackageName(found["name"], pkg);
  }) as Record<string, unknown>[];
  const verdicts: Record<string, RangeVerdict> = {};
  for (const version of versions) verdicts[version] = mine.length === 0 ? "unknown" : osvVerdict(mine, pkg.ecosystem, version);
  const fixes = mine.flatMap((entry) => rangesOf(entry).flatMap((range) => (range.events ?? []).flatMap((event) => (typeof event["fixed"] === "string" ? [event["fixed"]] : []))));
  return { id: raw["id"], aliases, withdrawn: typeof raw["withdrawn"] === "string", namesPackage: mine.length > 0, declaredFixes: [...new Set(fixes)], verdicts };
}

interface OsvRange {
  readonly type: unknown;
  /** Undefined when the range can't be read: it never counts as "not affected". */
  readonly events: ReadonlyArray<Record<string, unknown>> | undefined;
}

function rangesOf(entry: Record<string, unknown>): OsvRange[] {
  const ranges = entry["ranges"];
  if (ranges === undefined) return [];
  if (!Array.isArray(ranges)) return [{ type: undefined, events: undefined }];
  return ranges.map((range: unknown): OsvRange => {
    if (!isObject(range) || !Array.isArray(range["events"]) || !readableEvents(range["events"])) return { type: undefined, events: undefined };
    return { type: range["type"], events: range["events"] as Record<string, unknown>[] };
  });
}

const EVENT_KINDS = new Set(["introduced", "fixed", "last_affected", "limit"]);

/** Events a range can be judged by: each one bound with a string version, and at least one `introduced`. */
function readableEvents(events: ReadonlyArray<unknown>): boolean {
  const readable = events.every((event) => {
    if (!isObject(event)) return false;
    const keys = Object.keys(event);
    return keys.length === 1 && EVENT_KINDS.has(keys[0]!) && typeof event[keys[0]!] === "string";
  });
  return readable && events.some((event) => typeof (event as Record<string, unknown>)["introduced"] === "string");
}

/**
 * OSV's affected-version rule over one package's entries: an explicit `versions` list, or `ECOSYSTEM`/`SEMVER`
 * ranges, each judged on its own (`rangeVerdict`). A range of another type, one that can't be read or carries a
 * `limit`, an entry with neither ranges nor versions, or a range that can't tell makes a "not affected" answer
 * unknown.
 */
function osvVerdict(entries: ReadonlyArray<Record<string, unknown>>, ecosystem: Ecosystem, version: string): RangeVerdict {
  let unknown = false;
  for (const entry of entries) {
    const listed = entry["versions"];
    if (Array.isArray(listed) && listed.includes(version)) return "affected";
    const ranges = rangesOf(entry);
    if (ranges.length === 0 && !Array.isArray(listed)) unknown = true;
    for (const range of ranges) {
      if ((range.type !== "ECOSYSTEM" && range.type !== "SEMVER") || range.events === undefined || range.events.some((event) => event["limit"] !== undefined)) {
        unknown = true;
        continue;
      }
      const scheme = versionScheme(range.type === "SEMVER" ? "npm" : ecosystem);
      const compare = (a: string, b: string): number | undefined => {
        try {
          return scheme.compare(a, b);
        } catch {
          return undefined;
        }
      };
      const verdict = compare(version, version) === undefined ? "unknown" : rangeVerdict(compare, range.events, version);
      if (verdict === "affected") return "affected";
      if (verdict === "unknown") unknown = true;
    }
  }
  return unknown ? "unknown" : "not-affected";
}

/**
 * One range as OSV evaluates it, whatever the events' order: `introduced` makes a version affected, `fixed`
 * (exclusive) or `last_affected` (inclusive) makes it not, so the highest event the version has reached decides
 * (`introduced: "0"` is reached by every version). Reaching none means not affected. A version that doesn't compare,
 * or a start and an end at that same highest version, is unknown.
 */
function rangeVerdict(compare: (a: string, b: string) => number | undefined, events: ReadonlyArray<Record<string, unknown>>, version: string): RangeVerdict {
  let highest: { readonly at: string; readonly starts: boolean; readonly ends: boolean } | undefined;
  for (const event of events) {
    const introduced = typeof event["introduced"] === "string" ? event["introduced"] : undefined;
    const fixed = typeof event["fixed"] === "string" ? event["fixed"] : undefined;
    const last = typeof event["last_affected"] === "string" ? event["last_affected"] : undefined;
    const at = introduced ?? fixed ?? last;
    if (at === undefined) continue;
    const origin = introduced === "0";
    const past = origin ? 1 : compare(version, at);
    if (past === undefined) return "unknown";
    // A `last_affected` is reached only once the version is past it; the others at it.
    if (last !== undefined ? past <= 0 : past < 0) continue;
    const order = highest === undefined ? 1 : origin ? -1 : highest.at === "0" && highest.starts ? 1 : compare(at, highest.at);
    if (order === undefined) return "unknown";
    if (order > 0) highest = { at, starts: introduced !== undefined, ends: introduced === undefined };
    else if (order === 0) highest = { at: highest!.at, starts: highest!.starts || introduced !== undefined, ends: highest!.ends || introduced === undefined };
  }
  if (highest === undefined) return "not-affected";
  if (highest.starts && highest.ends) return "unknown";
  return highest.starts ? "affected" : "not-affected";
}
