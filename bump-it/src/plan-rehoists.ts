/** The display-only re-hoist verdict of a plan read back from a PR: never trusted from its body, recomputed from the lockfiles. */
import type { Tree } from "@leanish/gate/tree";

import { changesBetween, type CopyChange } from "./npm-compute.ts";
import { NpmGraph } from "./npm-graph.ts";
import type { BumpPlan } from "./plan.ts";
import { provenRehoists } from "./rehoists.ts";

const LOCKFILES = /(?:^|\/)(?:package-lock|npm-shrinkwrap)\.json$/;

/**
 * `plan` with the packages the lockfiles of `base` and `head` prove re-hoisted, so that a body rewritten from a recorded
 * plan shows the same table as one written from a fresh computation. Nothing is added when a lockfile can't be read as
 * a graph, or when the changes between the two trees aren't the changes the plan recorded (the base moved, say):
 * the table then keeps its per-path rows.
 */
export async function withRehoists(plan: BumpPlan, base: Tree, head: Tree): Promise<BumpPlan> {
  const rehoisted = await rehoistsOf(plan, base, head);
  return rehoisted.length === 0 ? plan : { ...plan, rehoisted };
}

async function rehoistsOf(plan: BumpPlan, base: Tree, head: Tree): Promise<ReadonlyArray<string>> {
  const graphs: Array<{ lockfile: string; base: NpmGraph; head: NpmGraph }> = [];
  for (const lockfile of plan.npmFiles.map((file) => file.path).filter((path) => LOCKFILES.test(path)).sort()) {
    const [before, after] = [await base.read(lockfile), await head.read(lockfile)];
    if (before === undefined || after === undefined) {
      return [];
    }
    try {
      graphs.push({ lockfile, base: new NpmGraph(JSON.parse(before)), head: new NpmGraph(JSON.parse(after)) });
    } catch {
      return [];
    }
  }
  const changes = graphs.flatMap((graph) => changesBetween(graph.lockfile, graph.base, graph.head));
  if (!sameChanges(changes, plan)) {
    return [];
  }
  return graphs.flatMap((graph) => provenRehoists(graph.lockfile, graph.base, graph.head));
}

/** The plan records the first changes of the lockfiles' changes, in the order they were computed, and how many there are. */
function sameChanges(changes: ReadonlyArray<CopyChange>, plan: BumpPlan): boolean {
  return changes.length === plan.changeCount && plan.changes.every((recorded, index) => {
    const found = changes[index];
    return found !== undefined && found.lockfile === recorded.lockfile && found.path === recorded.path && found.name === recorded.name && found.from === recorded.from && found.to === recorded.to;
  });
}
