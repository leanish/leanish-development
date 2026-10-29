/** Registry decisions in the tool; npm resolution in an exported, sandboxed scratch tree. */
import { ActionsGitHub } from "@leanish/gate/actions-github";
import { IdentityCheck } from "@leanish/gate/candidates";
import { type GateEnvironment, type GradleInputs, readSettings, snapshotOptions, treeSources, versionCatalogs } from "@leanish/gate/gate";
import { readInventory } from "@leanish/gate/inventory";
import { NpmRegistry } from "@leanish/gate/npm-registry";
import { ignoredVersionReason, isTrustedPackage, selectableVersions } from "@leanish/gate/config";
import { takeSnapshot } from "@leanish/gate/take-snapshot";
import type { Tree } from "@leanish/gate/tree";
import type { ToolRunContext } from "@leanish/tool-runtime/command";
import { exportCommit } from "@leanish/tool-runtime/git-copies";
import { lockfilesOf } from "@leanish/tool-runtime/inventories";
import { runSandboxed } from "@leanish/tool-runtime/sandboxed";

import { computeNpm, type NpmCommand, type NpmResult } from "./npm-compute.ts";
import type { TargetSources } from "./npm-targets.ts";
import type { Unit } from "./units.ts";

export { requireNpmExcludes } from "./npm-window.ts";

export async function targetSources(base: Tree, env: GateEnvironment, gradle: GradleInputs["head"], onIgnored?: (note: string) => void): Promise<TargetSources> {
  const { config, exceptions } = await readSettings(base);
  const inventory = await readInventory(base, await treeSources(base), { gradle });
  const actions = new ActionsGitHub(env.fetch, env.githubToken);
  const registry = new NpmRegistry(env.fetch);
  const catalog = versionCatalogs(config, env, actions, registry).npm;
  const now = env.now();
  const identity = new IdentityCheck(registry, inventory.npm, exceptions, now.toISOString().slice(0, 10));
  return {
    versions: async (name) => {
      const pkg = { ecosystem: "npm" as const, name };
      const listed = await catalog.versions(pkg);
      for (const version of listed ?? []) {
        const reason = ignoredVersionReason(config, { ...pkg, version });
        if (reason !== undefined) onIgnored?.(`${name}@${version}: ignored candidate by policy: ${reason}`);
      }
      return selectableVersions(config, pkg, listed);
    },
    published: (name, version) => catalog.published({ ecosystem: "npm", name, version }),
    snapshot: (packages, candidates) => takeSnapshot(packages, snapshotOptions(config, env, actions), candidates),
    identity: (name, from, to) => identity.problems({ ecosystem: "npm", name, version: from }, to),
    isTrusted: (name) => isTrustedPackage(config.trustedPackages, { ecosystem: "npm", name }),
    releaseAgeDays: config.releaseAgeDays,
    now,
  };
}

export async function computeOnBase(context: ToolRunContext, unit: Unit, base: Tree, env: GateEnvironment, gradle: GradleInputs["head"]): Promise<NpmResult> {
  const locks = await lockfilesOf(base);
  if (locks.size === 0 || unit.kind === "major" && !unit.moves.some((move) => move.ecosystem === "npm")) {
    return { files: new Map(), changes: [], notes: [] };
  }
  const scratch = await exportCommit(context.workingCopy, base.id);
  try {
    const npm: NpmCommand = (cwd, args) => runSandboxed(context.isolation, { workingCopy: { ...context.workingCopy, path: cwd }, command: ["npm", ...args] });
    const ignored = new Set<string>();
    const sources = await targetSources(base, env, gradle, (note) => ignored.add(note));
    const moves = unit.moves.flatMap((move) => move.declarations.map((declaration) => ({ ...declaration, name: move.name, to: move.to })));
    const result = await computeNpm({
      kind: unit.kind,
      dir: scratch.dir,
      baseLocks: locks,
      moves,
      npm,
      window: { days: context.releaseAgeDays, exclude: context.releaseAgeExclude },
      sources,
    });
    return { ...result, notes: [...new Set([...result.notes, ...ignored])] };
  } finally {
    await scratch.remove();
  }
}
