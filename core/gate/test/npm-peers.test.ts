import { describe, expect, it, vi } from "vitest";

import { prepareNpmPeers, type PeerSources } from "../src/npm-peers.ts";
import { versionKey } from "../src/package-version.ts";
import { Snapshot, type Advisory } from "../src/snapshot.ts";

const NOW = new Date("2026-10-07T12:00:00Z");
const OLD = new Date("2026-09-01T00:00:00Z");
const YOUNG = new Date("2026-10-06T00:00:00Z");
const UI = "@vitest/ui";
const COVERAGE = "@vitest/coverage-v8";
const move = { name: "vitest", from: "4.1.7", to: "4.1.11", locations: ["node_modules/vitest"] };
const seed = { ecosystem: "npm" as const, name: "vitest", version: "4.1.11" };

function fixture(options: { outward?: boolean; future?: boolean } = {}) {
  const versions = ["4.1.7", "4.1.8", "4.1.11", ...(options.future ? ["4.1.12"] : [])];
  const manifests = new Map<string, object>();
  for (const version of versions) {
    manifests.set(`vitest@${version}`, options.outward ? { peerDependencies: { [UI]: version, [COVERAGE]: version } } : {});
    for (const name of [UI, COVERAGE]) {
      manifests.set(`${name}@${version}`, { peerDependencies: { vitest: version } });
    }
  }
  const lock = { lockfileVersion: 3, packages: {
    "": { devDependencies: { vitest: "^4.1.7", [UI]: "^4.1.7", [COVERAGE]: "^4.1.7" } },
    "node_modules/vitest": { version: "4.1.7", ...manifests.get("vitest@4.1.7") },
    [`node_modules/${UI}`]: { version: "4.1.7", ...manifests.get(`${UI}@4.1.7`) },
    [`node_modules/${COVERAGE}`]: { version: "4.1.7", ...manifests.get(`${COVERAGE}@4.1.7`) },
  } };
  const sources: PeerSources = {
    versions: vi.fn(async () => versions),
    manifest: vi.fn(async (name, version) => manifests.get(`${name}@${version}`)),
    published: vi.fn(async () => OLD),
    identity: vi.fn(async () => []),
    line: (_name, version) => version.split(".")[0]!,
    isOwn: () => false,
    now: NOW,
    releaseAgeDays: 7,
  };
  return { locks: new Map([["package-lock.json", lock]]), sources, manifests };
}

function snapshot(peers: Awaited<ReturnType<typeof prepareNpmPeers>>, affected: Record<string, Advisory[]> = {}) {
  const entries = [...peers.bases, ...peers.candidates].map((pkg) => [versionKey(pkg), affected[`${pkg.name}@${pkg.version}`] ?? []] as const);
  return new Snapshot(new Map(entries), [], NOW);
}

describe("direct npm peer sets", () => {
  it("plans dtv's UI and coverage directs at the same exact version as the fixed vitest target", async () => {
    const h = fixture({ outward: true, future: true });
    const peers = await prepareNpmPeers(h.locks, [seed], h.sources);
    const result = await peers.resolve([move], snapshot(peers));
    expect(result.blocked).toEqual([]);
    expect(result.additions.map((addition) => [addition.name, addition.to])).toEqual([[COVERAGE, "4.1.11"], [UI, "4.1.11"]]);
    expect(result.additions[0]?.declarations).toMatchObject([{ lockfile: "package-lock.json", workspace: "", declaredAs: COVERAGE, spec: "^4.1.7" }]);
    expect(result.sets).toEqual([[COVERAGE, UI, "vitest"]]);
    expect(peers.candidates).toContainEqual({ ecosystem: "npm", name: UI, version: "4.1.11" });
  });

  it("also sees incoming peer constraints when the moved package declares no peers itself", async () => {
    const h = fixture();
    const peers = await prepareNpmPeers(h.locks, [seed], h.sources);
    expect((await peers.resolve([move], snapshot(peers))).additions.map((addition) => addition.to)).toEqual(["4.1.11", "4.1.11"]);
  });

  it("takes the lowest compatible consistent version, rejecting new advisories, malware, identity breaks and young versions", async () => {
    const h = fixture({ future: true });
    for (const name of [UI, COVERAGE]) {
      for (const version of ["4.1.8", "4.1.11", "4.1.12"]) h.manifests.set(`${name}@${version}`, { peerDependencies: { vitest: "^4.1.11" } });
    }
    const peers = await prepareNpmPeers(h.locks, [seed], h.sources);
    const advisory: Advisory = { id: "GHSA-new", ids: ["GHSA-new"], source: "osv", malicious: false, severity: undefined, summary: undefined };
    const affected = { [`${UI}@4.1.8`]: [advisory], [`${COVERAGE}@4.1.8`]: [{ ...advisory, malicious: true }] };
    const judged = snapshot(peers, affected);
    expect((await peers.resolve([move], judged)).additions.map((addition) => addition.to)).toEqual(["4.1.11", "4.1.11"]);
    h.sources.identity = vi.fn(async (name, _from, to) => name !== "vitest" && to === "4.1.11" ? ["publisher changed"] : []);
    expect((await peers.resolve([move], judged)).additions.map((addition) => addition.to)).toEqual(["4.1.12", "4.1.12"]);
    h.sources.published = vi.fn(async (_name, version) => version === "4.1.12" ? YOUNG : OLD);
    expect((await peers.resolve([move], judged)).blocked).toHaveLength(1);
  });

  it("judges a planned move's identity with every copy the planned moves replace, and a companion's on its own", async () => {
    const h = fixture({ outward: true });
    // Another copy of vitest the same unit moves, outside the peer group: it must join the move's baseline.
    const nested = { name: "vitest", from: "4.1.0", to: "4.1.11", locations: ["node_modules/x/node_modules/vitest"] };
    const identity = vi.fn(async (_name: string, _from: string, _to: string, replaced?: ReadonlyArray<string>) =>
      replaced?.includes(nested.locations[0]!) === false ? ["no history without the nested copy"] : []);
    h.sources.identity = identity;
    const peers = await prepareNpmPeers(h.locks, [seed], h.sources);
    const result = await peers.resolve([move, nested], snapshot(peers));
    expect(result.blocked).toEqual([]);
    expect(identity).toHaveBeenCalledWith("vitest", "4.1.7", "4.1.11", ["node_modules/vitest", "node_modules/x/node_modules/vitest"]);
    expect(identity).toHaveBeenCalledWith(UI, "4.1.7", "4.1.11", undefined);
  });

  it("blocks a set whose candidate's identity check fails as undecided, and one whose identity breaks as refused", async () => {
    const h = fixture();
    const peers = await prepareNpmPeers(h.locks, [seed], h.sources);
    const other = { name: "other", from: "1.0.0", to: "1.0.1", locations: ["node_modules/other"] };
    h.sources.identity = vi.fn(async (name, _from, to) => {
      if (name === UI && to === "4.1.11") throw new Error("attestation lookup failed with HTTP 503");
      return [];
    });
    const failed = await peers.resolve([move, other], snapshot(peers));
    // Never taken as acceptance: the set is blocked, marked as one that can't be decided; the unrelated move isn't.
    expect(failed.blocked).toEqual([{ moves: [move], reason: expect.stringContaining(`${UI}@4.1.11: attestation lookup failed with HTTP 503`), undecided: true }]);
    h.sources.identity = vi.fn(async (name) => (name === UI ? ["publisher changed"] : []));
    const refused = await peers.resolve([move, other], snapshot(peers));
    expect(refused.blocked).toEqual([{ moves: [move], reason: expect.stringContaining(`${UI}@4.1.7 requires peer vitest 4.1.7, not 4.1.11`) }]);
  });

  it("lets only own packages skip the companion age requirement, and does not give young companions the security exemption", async () => {
    const h = fixture();
    h.sources.published = vi.fn(async () => YOUNG);
    const peers = await prepareNpmPeers(h.locks, [seed], h.sources);
    expect((await peers.resolve([move], snapshot(peers))).blocked[0]?.reason).toContain("no safe aged compatible direct-peer set");
    h.sources.isOwn = (name) => name.startsWith("@vitest/");
    const result = await peers.resolve([move], snapshot(peers));
    expect(result.blocked).toEqual([]);
    // Young, but own: the gate never holds them, so neither does planning.
    expect(result.additions.length).toBeGreaterThan(0);
    expect(result.additions.every((addition) => addition.aged)).toBe(true);
  });

  it("blocks the whole connected set when fixed targets disagree, without blocking an unrelated move", async () => {
    const h = fixture();
    const peers = await prepareNpmPeers(h.locks, [seed], h.sources);
    const other = { name: "other", from: "1.0.0", to: "1.0.1", locations: ["node_modules/other"] };
    const pinnedUi = { name: UI, from: "4.1.7", to: "4.1.8", locations: [`node_modules/${UI}`] };
    const result = await peers.resolve([move, pinnedUi, other], snapshot(peers));
    expect(result.additions).toEqual([]);
    expect(result.blocked[0]?.moves).toEqual([move, pinnedUi]);
  });

  it("keeps unchanged peers at base and ignores unrelated pre-existing peer problems", async () => {
    const h = fixture();
    for (const version of ["4.1.8", "4.1.11"]) h.manifests.set(`vitest@${version}`, { peerDependencies: { absent: "^1" }, peerDependenciesMeta: { absent: { optional: true } } });
    h.manifests.set(`${UI}@4.1.7`, { peerDependencies: { vitest: "^4" } });
    const peers = await prepareNpmPeers(h.locks, [seed], h.sources);
    expect((await peers.resolve([move], snapshot(peers))).additions.map((addition) => addition.name)).toEqual([COVERAGE]);
  });

  it("may align a companion downward within its compatible line when that is the only consistent set", async () => {
    const h = fixture({ future: true });
    Object.assign(h.locks.get("package-lock.json")!.packages[`node_modules/${UI}`], { version: "4.1.12" });
    const peers = await prepareNpmPeers(h.locks, [seed], h.sources);
    expect((await peers.resolve([move], snapshot(peers))).additions.find((addition) => addition.name === UI)).toMatchObject({ from: "4.1.12", to: "4.1.11" });
  });

  it("finds incoming peers omitted from the lockfile and leaves new indirect peers to npm", async () => {
    const h = fixture();
    delete (h.locks.get("package-lock.json")!.packages[`node_modules/${UI}`] as { peerDependencies?: object }).peerDependencies;
    h.manifests.set("vitest@4.1.11", { peerDependencies: { newIndirectPeer: "^1" } });
    const peers = await prepareNpmPeers(h.locks, [seed], h.sources);
    const result = await peers.resolve([move], snapshot(peers));
    expect(result.blocked).toEqual([]);
    expect(result.additions).toHaveLength(2);
  });

  it("reports unreadable locked peer metadata rather than inferring consistency from an incomplete lockfile", async () => {
    const h = fixture();
    h.manifests.delete(`${UI}@4.1.7`);
    const peers = await prepareNpmPeers(h.locks, [seed], h.sources);
    expect((await peers.resolve([move], snapshot(peers))).blocked[0]?.reason).toContain("cannot read locked direct-peer metadata");
  });

  it.each<{ which: string; reason: string; broken: (h: ReturnType<typeof fixture>) => void }>([
    { which: "a locked manifest", reason: `cannot read locked direct-peer metadata: ${UI}@4.1.7: no manifest for ${UI}@4.1.7`, broken: (h) => h.manifests.delete(`${UI}@4.1.7`) },
    { which: "an incomplete listing", reason: `the registry doesn't list ${UI}'s versions completely`, broken: (h) => {
      const original = h.sources.versions;
      h.sources.versions = async (name) => (name === UI ? undefined : original(name));
    } },
    { which: "a listing that fails", reason: `registry lookup of ${UI} failed with HTTP 503`, broken: (h) => {
      const original = h.sources.versions;
      h.sources.versions = async (name) => {
        if (name === UI) throw new Error(`registry lookup of ${UI} failed with HTTP 503`);
        return original(name);
      };
    } },
    { which: "a candidate manifest", reason: `invalid peer ranges in ${UI}@4.1.11`, broken: (h) => h.manifests.set(`${UI}@4.1.11`, { peerDependencies: { vitest: 42 } }) },
    { which: "the version a fix requires", reason: `${UI}: required peer lookup failed with HTTP 503`, broken: (h) => {
      h.sources = { ...h.sources, requiredYoung: async () => { throw new Error("required peer lookup failed with HTTP 503"); } };
    } },
  ])("blocks a set as undecided when $which can't be read, never as refused nor accepted", async ({ reason, broken }) => {
    const h = fixture();
    broken(h);
    const peers = await prepareNpmPeers(h.locks, [seed], h.sources);
    const result = await peers.resolve([move], snapshot(peers));
    expect(result.additions).toEqual([]);
    expect(result.blocked).toEqual([{ moves: [move], reason: expect.stringContaining(reason), undecided: true }]);
  });

  it("distinguishes an unknown candidate publish time from a known-too-young one", async () => {
    const h = fixture();
    h.sources.published = vi.fn(async (name, version) => name === UI && version === "4.1.11" ? undefined : OLD);
    const peers = await prepareNpmPeers(h.locks, [seed], h.sources);
    const judged = snapshot(peers);
    const unknown = await peers.resolve([move], judged);
    expect(unknown.additions).toEqual([]);
    expect(unknown.blocked).toEqual([{ moves: [move], reason: expect.stringContaining(`${UI}@4.1.11: the publish time is unknown`), undecided: true }]);

    h.sources.published = vi.fn(async (name, version) => name === UI && version === "4.1.11" ? YOUNG : OLD);
    const young = await peers.resolve([move], judged);
    expect(young.additions).toEqual([]);
    expect(young.blocked).toEqual([{ moves: [move], reason: expect.stringContaining(`${UI}@4.1.7 requires peer vitest 4.1.7, not 4.1.11`) }]);

    h.sources.published = vi.fn(async (name, version) => {
      if (name === UI && version === "4.1.11") throw new Error("publish-time lookup failed with HTTP 503");
      return OLD;
    });
    const failed = await peers.resolve([move], judged);
    expect(failed.additions).toEqual([]);
    expect(failed.blocked).toEqual([{ moves: [move], reason: expect.stringContaining(`${UI}@4.1.11: publish-time lookup failed with HTTP 503`), undecided: true }]);
  });

  it("blocks a solved set as undecided when a chosen companion's publish time is unknown on re-read", async () => {
    const h = fixture();
    const reads = new Map<string, number>();
    h.sources.published = vi.fn(async (name, version) => {
      const key = `${name}@${version}`;
      reads.set(key, (reads.get(key) ?? 0) + 1);
      return name === UI && reads.get(key)! > 1 ? undefined : OLD;
    });
    const peers = await prepareNpmPeers(h.locks, [seed], h.sources);
    const result = await peers.resolve([move], snapshot(peers));
    expect(result.additions).toEqual([]);
    expect(result.blocked).toEqual([{ moves: [move], reason: expect.stringContaining(`${UI}@4.1.11: the publish time is unknown`), undecided: true }]);
  });

  it("blocks a solved set as undecided when a chosen companion's publish time can't be read again", async () => {
    const h = fixture();
    // Judging the candidates reads each publish time once; the second read, for the chosen companion's `aged`, fails.
    const reads = new Map<string, number>();
    h.sources.published = vi.fn(async (name, version) => {
      const key = `${name}@${version}`;
      reads.set(key, (reads.get(key) ?? 0) + 1);
      if (name === UI && reads.get(key)! > 1) throw new Error("registry lookup of @vitest/ui failed with HTTP 503");
      return OLD;
    });
    const peers = await prepareNpmPeers(h.locks, [seed], h.sources);
    const result = await peers.resolve([move], snapshot(peers));
    expect(result.additions).toEqual([]);
    expect(result.blocked).toEqual([{ moves: [move], reason: expect.stringContaining(`${UI}@4.1.11: registry lookup of @vitest/ui failed with HTTP 503`), undecided: true }]);
  });

  it("leaves a set no peer ranges satisfy unmarked: a refusal, not a failed read", async () => {
    const h = fixture();
    const peers = await prepareNpmPeers(h.locks, [seed], h.sources);
    const pinnedUi = { name: UI, from: "4.1.7", to: "4.1.8", locations: [`node_modules/${UI}`] };
    const result = await peers.resolve([move, pinnedUi], snapshot(peers));
    expect(result.blocked).toEqual([{ moves: [move, pinnedUi], reason: expect.stringContaining(`${UI}@4.1.8 requires peer vitest 4.1.8, not 4.1.11`) }]);
  });

  it("closes a chain of direct peers introduced by a companion's candidate manifest", async () => {
    const h = fixture();
    const original = h.sources.versions;
    h.sources.versions = async (name) => name === "adapter" ? ["1.0.0", "1.1.0", "1.2.0"] : original(name);
    h.manifests.set("adapter@1.0.0", {});
    h.manifests.set("adapter@1.1.0", {});
    h.manifests.set("adapter@1.2.0", {});
    h.manifests.set(`${UI}@4.1.11`, { peerDependencies: { vitest: "4.1.11", adapter: "^1.1.0" } });
    const lock = h.locks.get("package-lock.json")!;
    Object.assign(lock.packages[""].devDependencies, { adapter: "^1.0.0" });
    Object.assign(lock.packages, { "node_modules/adapter": { version: "1.0.0" } });
    const peers = await prepareNpmPeers(h.locks, [seed], h.sources);
    const result = await peers.resolve([move], snapshot(peers));
    expect(result.blocked).toEqual([]);
    expect(result.additions.find((addition) => addition.name === "adapter")?.to).toBe("1.1.0");
  });

  it("keeps root and workspace peer sets separate and carries an alias's declaring key", async () => {
    const h = fixture();
    const lock = h.locks.get("package-lock.json")!;
    Object.assign(lock.packages, {
      client: { devDependencies: { vitest: "^4.1.7", compat: "npm:@vitest/ui@^4.1.7" } },
      "client/node_modules/vitest": { version: "4.1.7" },
      "client/node_modules/compat": { name: UI, version: "4.1.7", peerDependencies: { vitest: "4.1.7" } },
    });
    const peers = await prepareNpmPeers(h.locks, [seed], h.sources);
    const result = await peers.resolve([{ ...move, locations: ["client/node_modules/vitest"] }], snapshot(peers));
    expect(result.additions).toHaveLength(1);
    expect(result.additions[0]).toMatchObject({ name: UI, locations: ["client/node_modules/compat"], declarations: [{ workspace: "client", declaredAs: "compat", spec: "npm:@vitest/ui@^4.1.7" }] });
  });
});
