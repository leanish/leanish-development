/** Both tools check the actual resolution, including transitive fallout and floor removals. */
import { commentTag, occurrenceKey } from "@leanish/gate/actions-inventory";
import { ignoredVersionReason } from "@leanish/gate/config";
import { baseSources, type GradleInputs, readSettings } from "@leanish/gate/gate";
import { ignoredIntroductions, IGNORED_VERSION_REFUSAL } from "@leanish/gate/ignored-versions";
import { located, readInventory, sourcesOf } from "@leanish/gate/inventory";
import type { Tree } from "@leanish/gate/tree";

export async function ignoredVersionProblems(base: Tree, head: Tree, gradle: GradleInputs): Promise<string[]> {
  const { config } = await readSettings(base);
  if (config.ignoredVersions.length === 0) return [];
  const sources = await sourcesOf(head, config);
  const before = await readInventory(base, await baseSources(base, sources), { missingLockfilesAreEmpty: true, gradle: gradle.base });
  const after = await readInventory(head, sources, { gradle: gradle.head });
  const problems = ignoredIntroductions(config, located(before), located(after));
  // Count complete uses, including ref, subpath and comment: a second identical use is also introduced.
  // The gate subsequently verifies the comment's tag against the SHA; an invalid pin fails there independently.
  const inherited = new Map<string, number>();
  for (const use of before.actions.uses) inherited.set(occurrenceKey(use), (inherited.get(occurrenceKey(use)) ?? 0) + 1);
  for (const use of after.actions.uses) {
    const key = occurrenceKey(use);
    const count = inherited.get(key) ?? 0;
    if (count > 0) { inherited.set(key, count - 1); continue; }
    const version = commentTag(use);
    if (version === undefined) continue;
    const reason = ignoredVersionReason(config, { ecosystem: "GitHub Actions", name: use.name, version });
    if (reason !== undefined) problems.push(`${IGNORED_VERSION_REFUSAL} GitHub Actions:${use.name}@${version} at ${use.file}: ${reason}`);
  }
  return problems;
}
