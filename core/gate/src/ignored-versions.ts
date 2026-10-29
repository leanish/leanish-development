/** Tool policy checks on exact copies; CI deliberately does not call these. */
import { type Config, ignoredVersionReason } from "./config.ts";
import type { Located } from "./findings.ts";
import { versionKey } from "./package-version.ts";

export const IGNORED_VERSION_REFUSAL = "ignored version introduced:";

/** A refusal is final for the unit: neither an agent retry nor a reduced batch may bypass it. */
export function hasIgnoredVersionRefusal(problems: ReadonlyArray<string>): boolean {
  return problems.some((problem) => problem.includes(IGNORED_VERSION_REFUSAL));
}

/** Existing copies may stay; a new location counts even when another location already has that version. */
export function ignoredIntroductions(config: Config, before: ReadonlyArray<Located>, after: ReadonlyArray<Located>): string[] {
  const inherited = new Set(before.flatMap((pkg) => pkg.locations.map((location) => JSON.stringify([versionKey(pkg), location]))));
  return after.flatMap((pkg) => {
    const reason = ignoredVersionReason(config, pkg);
    if (reason === undefined) return [];
    return pkg.locations.filter((location) => !inherited.has(JSON.stringify([versionKey(pkg), location])))
      .map((location) => `${IGNORED_VERSION_REFUSAL} ${pkg.ecosystem}:${pkg.name}@${pkg.version} at ${location}: ${reason}`);
  });
}
