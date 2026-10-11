import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ActionsGitHub } from "../../ci/src/actions-github.ts";
import { DEFAULT_CONFIG } from "../../ci/src/config.ts";
import { type GateEnvironment, snapshotOptions } from "../../ci/src/gate.ts";
import { fetchRepositoryAdvisories } from "../../ci/src/repository-advisories.ts";
import { FileRepositoryAdvisoryCache } from "../src/repository-advisory-cache.ts";
import { GitHubRequests } from "../src/github-requests.ts";

const REPO = "acme/lib";
const FIRST = `https://api.github.com/repos/${REPO}/security-advisories?state=published&per_page=100`;
const SECOND = FIRST + "&page=2";
const ENTRY = { ghsa_id: "GHSA-1234", state: "published", vulnerabilities: [{ package: { ecosystem: "npm", name: "lib" }, vulnerable_version_range: "<2" }] };
const page = (entries: unknown[], next?: string) => new Response(JSON.stringify(entries), { headers: next === undefined ? {} : { link: `<${next}>; rel="next"` } });

let dir: string;
let now: number;
const cache = (token = "read-token") => new FileRepositoryAdvisoryCache(dir, token, () => now);
const entryPath = async () => join(dir, "repository-advisories-v1", (await readdir(join(dir, "repository-advisories-v1")))[0]!);

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "advisory-cache-")); now = 1_000_000; });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("repository advisory cache", () => {
  it("reuses every page across cache instances, preserving parsed findings and counting only network attempts", async () => {
    const raw = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(page([ENTRY], SECOND)).mockResolvedValueOnce(page([{ ...ENTRY, ghsa_id: "GHSA-5678" }]));
    const requests = new GitHubRequests();
    const fetch = requests.wrap(raw);
    const first = await fetchRepositoryAdvisories(REPO, { fetch, token: "read-token", cache: cache() });
    const reused = await fetchRepositoryAdvisories(REPO, { fetch, token: "read-token", cache: cache() });
    expect(reused).toEqual(first);
    expect(reused?.map((a) => a.ghsaId)).toEqual(["GHSA-1234", "GHSA-5678"]);
    expect(raw.mock.calls.map(([url]) => url)).toEqual([FIRST, SECOND]);
    expect(requests.summary().total).toBe(2);
  });

  it("expires at one hour, rejects future timestamps and isolates repositories and credentials", async () => {
    await cache().write(REPO, [ENTRY]);
    now += 3_599_999;
    expect(await cache().read("ACME/LIB")).toEqual([ENTRY]);
    expect(await cache().read("acme/other")).toBeUndefined();
    expect(await cache("other-token").read(REPO)).toBeUndefined();
    now += 1;
    const raw = vi.fn<typeof globalThis.fetch>(async () => page([]));
    expect(await fetchRepositoryAdvisories(REPO, { fetch: raw, token: "read-token", cache: cache() })).toEqual([]);
    expect(raw).toHaveBeenCalledOnce();
    now -= 1;
    expect(await cache().read(REPO)).toBeUndefined();
    expect(await readFile(await entryPath(), "utf8")).not.toContain("read-token");
  });

  it.each(["not JSON", '{"advisories":[]}', JSON.stringify({ repo: REPO, fetchedAt: 1_000_000, advisories: [{ state: "published" }] })])("treats corrupt entries as misses: %s", async (corrupt) => {
    await cache().write(REPO, [ENTRY]);
    await writeFile(await entryPath(), corrupt);
    const raw = vi.fn<typeof globalThis.fetch>(async () => page([ENTRY]));
    expect(await fetchRepositoryAdvisories(REPO, { fetch: raw, token: "read-token", cache: cache() })).toHaveLength(1);
    expect(raw).toHaveBeenCalledOnce();
    expect(await cache().read(REPO)).toEqual([ENTRY]);
  });

  it("treats missing/unreadable entries and unwritable cache directories as best-effort misses", async () => {
    expect(await cache().read(REPO)).toBeUndefined();
    const blocked = join(dir, "file");
    await writeFile(blocked, "not a directory");
    const broken = new FileRepositoryAdvisoryCache(blocked, "read-token");
    const raw = vi.fn<typeof globalThis.fetch>(async () => page([ENTRY]));
    expect(await fetchRepositoryAdvisories(REPO, { fetch: raw, token: "read-token", cache: broken })).toHaveLength(1);
    expect(await broken.read(REPO)).toBeUndefined();
  });

  it("publishes whole entries during concurrent writes, with no temporary files left behind", async () => {
    await cache().write(REPO, [ENTRY]);
    await Promise.all(Array.from({ length: 30 }, async (_, index) => {
      const entries = Array.from({ length: 100 }, () => ({ ...ENTRY, ghsa_id: `GHSA-${index}` }));
      await cache().write(REPO, entries);
      const seen = (await cache().read(REPO)) as { ghsa_id: string }[];
      expect(seen).toHaveLength(100);
      expect(new Set(seen.map((a) => a.ghsa_id)).size).toBe(1);
    }));
    expect(await readdir(join(dir, "repository-advisories-v1"))).toHaveLength(1);
  });

  it.each([403, 429, 500, 404])("never caches HTTP %s, including a later pagination failure", async (status) => {
    const raw = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(page([ENTRY], SECOND)).mockResolvedValueOnce(new Response("{}", { status }));
    const result = fetchRepositoryAdvisories(REPO, { fetch: raw, token: "read-token", cache: cache() });
    if (status === 404) await expect(result).resolves.toBeUndefined();
    else await expect(result).rejects.toThrow(`HTTP ${status}`);
    expect(await cache().read(REPO)).toBeUndefined();
    expect(await readdir(dir)).toEqual([]);
  });

  it.each([new Response("not JSON"), page([{ state: "published" }])])("doesn't cache a malformed later page", async (badPage) => {
    const raw = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(page([ENTRY], SECOND)).mockResolvedValueOnce(badPage);
    await expect(fetchRepositoryAdvisories(REPO, { fetch: raw, token: "read-token", cache: cache() })).rejects.toThrow();
    expect(await cache().read(REPO)).toBeUndefined();
  });

  it("doesn't cache a network failure after a successful first page", async () => {
    const raw = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(page([ENTRY], SECOND)).mockRejectedValueOnce(new Error("offline"));
    await expect(fetchRepositoryAdvisories(REPO, { fetch: raw, token: "read-token", cache: cache() })).rejects.toThrow("offline");
    expect(await cache().read(REPO)).toBeUndefined();
  });

  it("leaves the CI default uncached, even when a local cache entry exists", async () => {
    await cache().write(REPO, [ENTRY]);
    const raw = vi.fn<typeof globalThis.fetch>(async () => page([]));
    const env: GateEnvironment = { fetch: raw, githubToken: "read-token", run: async () => ({ code: 0, stdout: "", stderr: "" }), now: () => new Date(now), osvScanner: "osv-scanner" };
    const options = snapshotOptions(DEFAULT_CONFIG, env, new ActionsGitHub(raw, "read-token")).repositoryAdvisories;
    expect(await fetchRepositoryAdvisories(REPO, options)).toEqual([]);
    expect(await fetchRepositoryAdvisories(REPO, options)).toEqual([]);
    expect(raw).toHaveBeenCalledTimes(2);
    const local = snapshotOptions(DEFAULT_CONFIG, { ...env, repositoryAdvisoryCache: cache() }, new ActionsGitHub(raw, "read-token")).repositoryAdvisories;
    expect(await fetchRepositoryAdvisories(REPO, local)).toHaveLength(1);
    expect(raw).toHaveBeenCalledTimes(2);
  });
});
