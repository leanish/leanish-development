import { describe, expect, it, vi } from "vitest";
import { versionKey } from "@leanish/gate/package-version";
import { NpmCatalog } from "@leanish/gate/catalogs";
import { NpmRegistry } from "@leanish/gate/npm-registry";
import { type Advisory, Snapshot } from "@leanish/gate/snapshot";
import { fakeFetch } from "@leanish/gate/test/fake-fetch";
import { NpmGraph } from "../src/npm-graph.ts";
import { repositoryOverrides } from "../src/npm-overrides.ts";
import { decideTargets, type TargetInputs, type TargetSources } from "../src/npm-targets.ts";

const NOW = new Date("2026-10-07T06:00:00Z");
const graph = (version: string, spec = "^1") => new NpmGraph({ packages: { "": { dependencies: { parent: "1" } }, "node_modules/parent": { version: "1.0.0", dependencies: { child: spec } }, "node_modules/child": { version } } });
function inputs(spec = "^1", overrides: unknown = {}): TargetInputs {
  return { nodeRuntime: { major: undefined, sources: [] }, graph: graph("1.2.0", spec), base: graph("1.0.0"), baseVersions: new Map([["child", ["1.0.0"]], ["parent", ["1.0.0"]]]), overrides: repositoryOverrides(overrides), direct: new Map([["node_modules/parent", "1.0.0"]]) };
}
function sources(findings: Record<string, Advisory[]> = {}): TargetSources {
  return { now: NOW, releaseAgeDays: 7, isOwn: () => false, versions: async () => ["1.0.0", "1.1.0", "1.2.0", "1.3.0"], published: async () => new Date("2026-09-01"), identity: async () => [], snapshot: async (base, candidates) => new Snapshot(new Map([...base, ...candidates].map((pkg) => [versionKey(pkg), findings[pkg.version] ?? []])), [], NOW) };
}
const advisory = (id: string, malicious = false): Advisory => ({ id, ids: [id], malicious, source: "osv", summary: undefined, severity: undefined });
/** `id` as only the project's own repository advisories publish it. */
const repository = (id: string): Advisory => ({ ...advisory(id), source: "repository" });
const child = (result: Awaited<ReturnType<typeof decideTargets>>) => result.find((decision) => decision.copy.name === "child");

describe("code-decided transitive targets", () => {
  it("replaces npm's deprecated transitive pick with the highest nondeprecated eligible candidate", async () => {
    const catalog = new NpmCatalog(new NpmRegistry(fakeFetch({
      "https://registry.npmjs.org/child": { body: {
        time: { "1.0.0": "2026-09-01T00:00:00Z", "1.2.0": "2026-09-01T00:00:00Z", "1.3.0": "2026-09-01T00:00:00Z" },
        versions: { "1.0.0": {}, "1.2.0": {}, "1.3.0": { deprecated: "Accidental release" } },
      } },
    })));
    const found = await decideTargets({ ...inputs(), graph: graph("1.3.0") }, {
      ...sources(),
      versions: (name) => catalog.versions({ ecosystem: "npm", name }),
      published: (name, version) => catalog.published({ ecosystem: "npm", name, version }),
    });
    expect(child(found)).toMatchObject({ kind: "target", target: "1.2.0" });
  });

  it("chooses the highest eligible in all parents' ranges on one snapshot, regardless of npm's pick", async () => {
    const snapshot = vi.fn(sources().snapshot);
    const found = await decideTargets(inputs(), { ...sources(), snapshot });
    expect(child(found)).toMatchObject({ kind: "target", target: "1.3.0" });
    expect(found.find((decision) => decision.copy.name === "parent")).toMatchObject({ direct: true, target: "1.0.0" });
    expect(snapshot).toHaveBeenCalledOnce();
    expect(snapshot.mock.calls[0]?.[1].map((pkg) => pkg.version)).toEqual(["1.3.0", "1.2.0", "1.1.0", "1.0.0"]);
  });
  it("rejects malware, new advisory groups and identity breaks, but allows inherited groups", async () => {
    const inherited = advisory("GHSA-inherited");
    const s = { ...sources({ "1.0.0": [inherited], "1.1.0": [inherited], "1.2.0": [advisory("new")], "1.3.0": [advisory("MAL-1", true)] }), identity: async () => [] };
    expect(child(await decideTargets(inputs(), s))).toMatchObject({ target: "1.1.0" });
    expect(child(await decideTargets(inputs(), { ...sources(), identity: async () => ["break"] }))).toMatchObject({ target: "1.0.0" });
  });
  it("own packages skip age alone, not malware", async () => {
    const young = { ...sources({ "1.3.0": [advisory("MAL-1", true)] }), published: async () => NOW };
    expect(child(await decideTargets(inputs(), young))).toMatchObject({ target: "1.0.0" });
    expect(child(await decideTargets(inputs(), { ...young, isOwn: () => true }))).toMatchObject({ target: "1.2.0" });
  });
  it("has no ten-version cap", async () => {
    const versions = Array.from({ length: 15 }, (_, minor) => `1.${minor}.0`);
    const findings = Object.fromEntries(versions.filter((version) => !["1.0.0", "1.1.0"].includes(version)).map((version) => [version, [advisory("bad")]]));
    expect(child(await decideTargets(inputs(), { ...sources(findings), versions: async () => versions }))).toMatchObject({ target: "1.1.0" });
  });
  it.each(["listing", "publish", "advisories", "identity", "tag"]) ("keeps the base unresolved on %s failure", async (failure) => {
    let s = sources();
    if (failure === "listing") s = { ...s, versions: async () => undefined };
    if (failure === "publish") s = { ...s, published: async () => { throw new Error("offline"); } };
    if (failure === "advisories") s = { ...s, snapshot: async () => { throw new Error("offline"); } };
    if (failure === "identity") s = { ...s, identity: async () => { throw new Error("offline"); } };
    expect(child(await decideTargets(inputs(failure === "tag" ? "latest" : "^1"), s))).toMatchObject({ kind: "unresolved", target: "1.0.0" });
  });
  it("marks an incomplete snapshot unresolved even when its first candidate is clean", async () => {
    const s = { ...sources(), snapshot: async () => new Snapshot(new Map(), [], NOW) };
    expect(child(await decideTargets(inputs(), s))).toMatchObject({ kind: "unresolved", target: "1.0.0" });
  });
  it("keeps repository pins and reports complex override constraints without claiming R3", async () => {
    expect(child(await decideTargets(inputs("^1", { overrides: { child: "1.1.0" } }), sources()))).toMatchObject({ target: "1.1.0", kind: "pinned" });
    expect(child(await decideTargets(inputs("^1", { overrides: { parent: { child: "1.0.0" } } }), sources()))).toMatchObject({ target: "1.0.0", kind: "unresolved" });
  });
  it("inherits a reviewed group only from reviewed evidence on the base copies", async () => {
    // Base 1.0.0 has GHSA-x only from the repository's advisories; OSV reports it on 1.3.0 alone, the repository on 1.2.0.
    const s = sources({ "1.0.0": [repository("GHSA-x")], "1.1.0": [repository("GHSA-x")], "1.2.0": [repository("GHSA-x")], "1.3.0": [advisory("GHSA-x")] });
    expect(child(await decideTargets(inputs(), s))).toMatchObject({ kind: "target", target: "1.2.0" });
    // A reviewed base copy lets it stay, and a repository-only one is inherited from either.
    expect(child(await decideTargets(inputs(), sources({ "1.0.0": [advisory("GHSA-x")], "1.2.0": [repository("GHSA-x")], "1.3.0": [advisory("GHSA-x")] })))).toMatchObject({ target: "1.3.0" });
  });
  it.each([[["1.0.0", "1.1.0"]], [["1.1.0", "1.0.0"]]])("counts every base copy together, a reviewed one among them in any order (%j)", async (baseVersions) => {
    const withBase = { ...inputs(), baseVersions: new Map([["child", baseVersions], ["parent", ["1.0.0"]]]) };
    const s = sources({ "1.0.0": [repository("GHSA-x")], "1.1.0": [advisory("GHSA-x")], "1.2.0": [repository("GHSA-x")], "1.3.0": [advisory("GHSA-x")] });
    expect(child(await decideTargets(withBase, s))).toMatchObject({ target: "1.3.0" });
    const repositoryOnly = sources({ "1.0.0": [repository("GHSA-x")], "1.1.0": [repository("GHSA-x")], "1.2.0": [repository("GHSA-x")], "1.3.0": [advisory("GHSA-x")] });
    expect(child(await decideTargets(withBase, repositoryOnly))).toMatchObject({ target: "1.2.0" });
  });
  it("uses any base copy for inherited findings, and all incoming ranges for the target", async () => {
    const i = inputs();
    const merged = new NpmGraph({ packages: { ...i.graph.packages, "node_modules/other": { version: "1.0.0", dependencies: { child: "~1.1.0" } } } });
    const s = sources({ "1.1.0": [advisory("inherited")], "1.5.0": [advisory("inherited")] });
    expect(child(await decideTargets({ ...i, graph: merged, baseVersions: new Map([["child", ["1.0.0", "1.5.0"]], ["other", ["1.0.0"]]]) }, s))).toMatchObject({ target: "1.1.0" });
  });
});
