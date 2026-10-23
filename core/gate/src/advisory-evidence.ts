/**
 * Where the advisories behind a held version appear, for the people deciding
 * whether to take it early: the package's own repository advisories, GitHub's
 * global database and OSV, each read fresh after the comparison and recorded
 * as that source says, disagreements included.
 *
 * Informative only. Nothing here feeds the snapshot or the verdict, and a
 * lookup that fails is recorded as incomplete evidence, never as "absent". An
 * id is looked up once per source; aliases a response names are followed, up
 * to a budget, so a repository advisory's CVE finds the OSV record that only
 * knows the CVE.
 */
import { githubRefusal, type Fetch } from "./http.ts";
import { isObject } from "./json.ts";
import type { PackageName, PackageVersion } from "./package-version.ts";
import type { HeldGroup, HeldTarget, HeldVersion } from "./release-age.ts";
import { affects, MAX_ADVISORY_PAGES, namesPackage, nextLink, parseRepositoryEntry, type RepositoryAdvisory } from "./repository-advisories.ts";
import { sourceRepository, type SourceRepoOptions } from "./source-repos.ts";
import { type Ecosystem, versionScheme } from "./versions.ts";

const GITHUB_API = "https://api.github.com";
const OSV_API = "https://api.osv.dev/v1";
/** Id lookups per advisory group and source, aliases included. */
const LOOKUP_BUDGET = 16;

export type EvidenceSource = "repository" | "github" | "osv";

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
  /** Version → its verdict, for every replaced and proposed version of the target. */
  readonly verdicts: Readonly<Record<string, RangeVerdict>>;
}

export interface SourceEvidence {
  readonly source: EvidenceSource;
  /** `checked`: every known id was looked up (a full list read, for the repository). */
  readonly lookup: "checked" | "incomplete" | "not-queried";
  /** Why the lookup is incomplete or wasn't made. */
  readonly reason?: string;
  /** The repository read, for repository advisories. */
  readonly repository?: string;
  readonly records: ReadonlyArray<EvidenceRecord>;
}

export interface GroupEvidence {
  /** The group's ids as the comparison's snapshot knew them. */
  readonly ids: ReadonlyArray<string>;
  /** The replaced versions the comparison found it affecting: what a record must agree on to back the fix. */
  readonly replaced: ReadonlyArray<string>;
  readonly sources: ReadonlyArray<SourceEvidence>;
}

export interface TargetEvidence {
  readonly ecosystem: Ecosystem;
  readonly name: string;
  readonly bundled: boolean;
  readonly replaced: ReadonlyArray<string>;
  readonly proposed: ReadonlyArray<string>;
  readonly groups: ReadonlyArray<GroupEvidence>;
}

export interface AdvisoryEvidence {
  /** When the lookups started. */
  readonly collectedAt: string;
  readonly targets: ReadonlyArray<TargetEvidence>;
}

export interface EvidenceOptions {
  readonly fetch: Fetch;
  readonly token: string | undefined;
  readonly sourceRepos: SourceRepoOptions;
  readonly now: () => Date;
}

/** The evidence behind a held version's targets; undefined when it has none (a hold without the fix proof). */
export async function heldEvidence(held: HeldVersion, options: EvidenceOptions): Promise<AdvisoryEvidence | undefined> {
  if (held.targets === undefined || held.targets.length === 0) return undefined;
  const collectedAt = options.now().toISOString();
  const lookups = new Lookups(options);
  const targets: TargetEvidence[] = [];
  for (const target of held.targets) targets.push(await targetEvidence(held.ecosystem, target, lookups, options));
  return { collectedAt, targets };
}

/**
 * Whether a record backs the fix as the comparison did: it names the package, puts every replaced version the
 * comparison found the group affecting among the affected ones, and none of the proposed versions.
 */
export function backsFix(record: EvidenceRecord, group: Pick<GroupEvidence, "replaced">, target: Pick<TargetEvidence, "proposed">): boolean {
  return !record.withdrawn && record.namesPackage
    && group.replaced.every((version) => record.verdicts[version] === "affected")
    && target.proposed.every((version) => record.verdicts[version] === "not-affected");
}

async function targetEvidence(ecosystem: Ecosystem, target: HeldTarget, lookups: Lookups, options: EvidenceOptions): Promise<TargetEvidence> {
  const pkg: PackageName = { ecosystem, name: target.name };
  const versions = [...target.replaced, ...target.proposed];
  const repository = await lookups.repositoryOf({ ...pkg, version: target.replaced[0] ?? target.proposed[0] ?? "" }, options.sourceRepos);
  const groups: GroupEvidence[] = [];
  for (const group of target.groups) groups.push(await groupEvidence(pkg, versions, group, repository, lookups));
  return { ecosystem, name: target.name, bundled: target.bundled, replaced: target.replaced, proposed: target.proposed, groups };
}

type RepositoryRead =
  | { readonly repo: string; readonly entries: ReadonlyArray<RepositoryEntry> }
  /** `failed`: a lookup failed (incomplete evidence), rather than there being no repository to read. */
  | { readonly repo: string | undefined; readonly reason: string; readonly failed: boolean };

interface RepositoryEntry {
  readonly advisory: RepositoryAdvisory;
  readonly withdrawn: boolean;
}

async function groupEvidence(pkg: PackageName, versions: ReadonlyArray<string>, held: HeldGroup, repository: RepositoryRead, lookups: Lookups): Promise<GroupEvidence> {
  const known = new Set(held.ids);
  const github = new SourceLookup("github");
  const osv = new SourceLookup("osv");
  const repo = new Map<string, EvidenceRecord>();
  for (;;) {
    const before = known.size;
    for (const id of [...known]) {
      if (id.startsWith("GHSA-")) await github.lookUp(id, () => lookups.github(id, pkg, versions), known);
      await osv.lookUp(id, () => lookups.osv(id, pkg, versions), known);
    }
    if ("entries" in repository) {
      for (const entry of repository.entries) {
        const ids = [entry.advisory.ghsaId, ...(entry.advisory.cveId === undefined ? [] : [entry.advisory.cveId])];
        if (!ids.some((id) => known.has(id)) || repo.has(entry.advisory.ghsaId)) continue;
        const record = repositoryRecord(entry, pkg, versions);
        repo.set(record.id, record);
        for (const id of ids) known.add(id);
      }
    }
    if (known.size === before) break;
  }
  const repositorySource: SourceEvidence = "entries" in repository
    ? { source: "repository", lookup: "checked", repository: repository.repo, records: [...repo.values()] }
    : { source: "repository", lookup: repository.failed ? "incomplete" : "not-queried", reason: repository.reason, ...(repository.repo === undefined ? {} : { repository: repository.repo }), records: [] };
  const githubSource = [...known].some((id) => id.startsWith("GHSA-")) ? github.evidence() : { source: "github" as const, lookup: "not-queried" as const, reason: "no GHSA id is known for it", records: [] };
  return { ids: [...held.ids], replaced: [...held.replaced], sources: [repositorySource, githubSource, osv.evidence()] };
}

/** One source's lookups for a group: each id once, within the budget; failures make it incomplete. */
class SourceLookup {
  readonly #source: EvidenceSource;
  readonly #seen = new Set<string>();
  readonly #records = new Map<string, EvidenceRecord>();
  readonly #problems: string[] = [];

  constructor(source: EvidenceSource) {
    this.#source = source;
  }

  async lookUp(id: string, read: () => Promise<EvidenceRecord | undefined>, known: Set<string>): Promise<void> {
    if (this.#seen.has(id)) return;
    this.#seen.add(id);
    if (this.#seen.size > LOOKUP_BUDGET) {
      if (this.#seen.size === LOOKUP_BUDGET + 1) this.#problems.push(`more than ${LOOKUP_BUDGET} ids to look up`);
      return;
    }
    try {
      const record = await read();
      if (record === undefined) return;
      this.#records.set(record.id, record);
      for (const alias of [record.id, ...record.aliases]) known.add(alias);
    } catch (error) {
      this.#problems.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  evidence(): SourceEvidence {
    const records = [...this.#records.values()];
    return this.#problems.length === 0
      ? { source: this.#source, lookup: "checked", records }
      : { source: this.#source, lookup: "incomplete", reason: this.#problems.join("; "), records };
  }
}

/** The fetches, each made once per evidence run. */
class Lookups {
  readonly #options: EvidenceOptions;
  readonly #github = new Map<string, Promise<unknown>>();
  readonly #osv = new Map<string, Promise<unknown>>();
  readonly #repositories = new Map<string, Promise<ReadonlyArray<RepositoryEntry> | undefined>>();

  constructor(options: EvidenceOptions) {
    this.#options = options;
  }

  async github(id: string, pkg: PackageName, versions: ReadonlyArray<string>): Promise<EvidenceRecord | undefined> {
    const raw = await once(this.#github, id, () => this.#json(`${GITHUB_API}/advisories/${encodeURIComponent(id)}`, this.#githubHeaders(), `GitHub advisory ${id}`));
    return raw === undefined ? undefined : githubRecord(raw, id, pkg, versions);
  }

  async osv(id: string, pkg: PackageName, versions: ReadonlyArray<string>): Promise<EvidenceRecord | undefined> {
    const raw = await once(this.#osv, id, () => this.#json(`${OSV_API}/vulns/${encodeURIComponent(id)}`, {}, `OSV record ${id}`));
    return raw === undefined ? undefined : osvRecord(raw, id, pkg, versions);
  }

  async repositoryOf(pkg: PackageVersion, options: SourceRepoOptions): Promise<RepositoryRead> {
    let repo: string | undefined;
    try {
      repo = await sourceRepository(pkg, options);
    } catch (error) {
      return { repo: undefined, reason: `its source repository can't be found: ${error instanceof Error ? error.message : String(error)}`, failed: true };
    }
    if (repo === undefined) return { repo: undefined, reason: "no GitHub source repository is named for it", failed: false };
    try {
      const entries = await once(this.#repositories, repo, () => this.#repositoryEntries(repo!));
      return entries === undefined ? { repo, reason: `${repo} isn't readable (renamed, deleted or private)`, failed: true } : { repo, entries };
    } catch (error) {
      return { repo, reason: error instanceof Error ? error.message : String(error), failed: true };
    }
  }

  async #repositoryEntries(repo: string): Promise<RepositoryEntry[] | undefined> {
    const entries: RepositoryEntry[] = [];
    // No state filter: a withdrawn advisory is evidence too.
    let url: string | undefined = `${GITHUB_API}/repos/${repo}/security-advisories?per_page=100`;
    for (let pages = 0; url !== undefined; pages++) {
      if (pages === MAX_ADVISORY_PAGES) throw new Error(`GitHub repository advisories of ${repo} run past ${MAX_ADVISORY_PAGES} pages`);
      const response = await this.#options.fetch(url, { headers: this.#githubHeaders() });
      if (response.status === 404) return undefined;
      if (!response.ok) throw new Error(`GitHub repository advisories of ${repo} failed with HTTP ${response.status}${githubRefusal(response, this.#options.token !== undefined)}`);
      const page: unknown = await response.json();
      if (!Array.isArray(page)) throw new Error(`GitHub repository advisories of ${repo} aren't a list`);
      for (const entry of page) {
        const parsed = parseRepositoryEntry(entry, repo);
        if (parsed.state === "published" || parsed.withdrawn) entries.push({ advisory: parsed.advisory, withdrawn: parsed.withdrawn });
      }
      url = nextLink(response.headers.get("link"));
    }
    return entries;
  }

  #githubHeaders(): Record<string, string> {
    const headers: Record<string, string> = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
    if (this.#options.token !== undefined) headers["authorization"] = `Bearer ${this.#options.token}`;
    return headers;
  }

  /** The JSON at `url`; undefined on 404. */
  async #json(url: string, headers: Record<string, string>, what: string): Promise<unknown> {
    const response = await this.#options.fetch(url, { headers });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`${what} failed with HTTP ${response.status}`);
    return response.json();
  }
}

function once<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  let found = cache.get(key);
  if (found === undefined) {
    found = load();
    cache.set(key, found);
  }
  return found;
}

function repositoryRecord(entry: RepositoryEntry, pkg: PackageName, versions: ReadonlyArray<string>): EvidenceRecord {
  const { advisory } = entry;
  return advisoryRecord(advisory.ghsaId, advisory.cveId === undefined ? [] : [advisory.cveId], entry.withdrawn, undefined, advisory, pkg, versions);
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
  // GitHub reviews malware records too; only `unreviewed` ones are its unchecked imports.
  return advisoryRecord(raw["ghsa_id"], [...new Set(aliases)], withdrawn, raw["type"] === "reviewed" || raw["type"] === "malware", { vulnerabilities }, pkg, versions);
}

function advisoryRecord(
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
      && (found["name"] === pkg.name || (pkg.ecosystem === "GitHub Actions" && found["name"].toLowerCase() === pkg.name));
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
 * ranges read as intervals from each `introduced` to the next `fixed` (exclusive) or `last_affected` (inclusive).
 * A range of another type, one that can't be read or carries a `limit`, an entry with neither ranges nor versions,
 * or a version that doesn't compare makes a "not affected" answer unknown.
 */
function osvVerdict(entries: ReadonlyArray<Record<string, unknown>>, ecosystem: Ecosystem, version: string): RangeVerdict {
  const scheme = versionScheme(ecosystem);
  const compare = (a: string, b: string): number | undefined => {
    try {
      return scheme.compare(a, b);
    } catch {
      return undefined;
    }
  };
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
      let start: string | undefined;
      for (const event of range.events) {
        if (typeof event["introduced"] === "string") {
          start = event["introduced"];
          continue;
        }
        const end = typeof event["fixed"] === "string" ? { at: event["fixed"], inclusive: false }
          : typeof event["last_affected"] === "string" ? { at: event["last_affected"], inclusive: true } : undefined;
        if (end === undefined || start === undefined) continue;
        const inside = within(compare, version, start, end);
        if (inside === undefined) unknown = true;
        else if (inside) return "affected";
        start = undefined;
      }
      if (start !== undefined) {
        const inside = within(compare, version, start, undefined);
        if (inside === undefined) unknown = true;
        else if (inside) return "affected";
      }
    }
  }
  return unknown ? "unknown" : "not-affected";
}

function within(
  compare: (a: string, b: string) => number | undefined,
  version: string,
  start: string,
  end: { readonly at: string; readonly inclusive: boolean } | undefined,
): boolean | undefined {
  const fromStart = start === "0" ? 1 : compare(version, start);
  if (fromStart === undefined) return undefined;
  if (fromStart < 0) return false;
  if (end === undefined) return true;
  const toEnd = compare(version, end.at);
  if (toEnd === undefined) return undefined;
  return end.inclusive ? toEnd <= 0 : toEnd < 0;
}

const SOURCES: ReadonlySet<string> = new Set<EvidenceSource>(["repository", "github", "osv"]);
const LOOKUPS: ReadonlySet<string> = new Set<SourceEvidence["lookup"]>(["checked", "incomplete", "not-queried"]);
const VERDICTS: ReadonlySet<string> = new Set<RangeVerdict>(["affected", "not-affected", "unknown"]);
const ECOSYSTEM_NAMES: ReadonlySet<string> = new Set<Ecosystem>(["npm", "Maven", "GitHub Actions"]);

/** Whether `raw` (from a PR's plan, which a person can edit) is evidence this module could have written. */
export function isAdvisoryEvidence(raw: unknown): raw is AdvisoryEvidence {
  if (!isObject(raw) || typeof raw["collectedAt"] !== "string" || Number.isNaN(Date.parse(raw["collectedAt"]))) return false;
  return Array.isArray(raw["targets"]) && raw["targets"].every(isTargetEvidence);
}

function isTargetEvidence(raw: unknown): boolean {
  if (!isObject(raw) || typeof raw["ecosystem"] !== "string" || !ECOSYSTEM_NAMES.has(raw["ecosystem"])) return false;
  if (typeof raw["name"] !== "string" || typeof raw["bundled"] !== "boolean" || !isStrings(raw["replaced"]) || !isStrings(raw["proposed"])) return false;
  return Array.isArray(raw["groups"]) && raw["groups"].every((group: unknown) =>
    isObject(group) && isStrings(group["ids"]) && isStrings(group["replaced"]) && Array.isArray(group["sources"]) && group["sources"].every(isSourceEvidence));
}

function isSourceEvidence(raw: unknown): boolean {
  if (!isObject(raw) || typeof raw["source"] !== "string" || !SOURCES.has(raw["source"])) return false;
  if (typeof raw["lookup"] !== "string" || !LOOKUPS.has(raw["lookup"])) return false;
  if (raw["reason"] !== undefined && typeof raw["reason"] !== "string") return false;
  if (raw["repository"] !== undefined && typeof raw["repository"] !== "string") return false;
  return Array.isArray(raw["records"]) && raw["records"].every(isRecord);
}

function isRecord(raw: unknown): boolean {
  if (!isObject(raw) || typeof raw["id"] !== "string" || !isStrings(raw["aliases"]) || typeof raw["withdrawn"] !== "boolean") return false;
  if (raw["reviewed"] !== undefined && typeof raw["reviewed"] !== "boolean") return false;
  if (typeof raw["namesPackage"] !== "boolean" || !isStrings(raw["declaredFixes"])) return false;
  const verdicts = raw["verdicts"];
  return isObject(verdicts) && Object.values(verdicts).every((verdict) => typeof verdict === "string" && VERDICTS.has(verdict));
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
