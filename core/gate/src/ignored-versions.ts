/** Tool policy checks on exact versions and their copy counts; CI deliberately does not call these. */
import { type Config, ignoredVersionReason } from "./config.ts";
import type { Located } from "./findings.ts";
import { versionKey } from "./package-version.ts";

export const IGNORED_VERSION_REFUSAL = "ignored version introduced:";

/** Recognize a tool refusal, never a marker quoted inside a policy reason or another diagnostic. */
export function hasIgnoredVersionRefusal(problems: ReadonlyArray<string>): boolean {
  return problems.some((problem) => problem.startsWith(IGNORED_VERSION_REFUSAL));
}

/** Count versions across locations: hoisting may move copies, but cannot add another ignored copy. */
export function ignoredIntroductions(config: Config, before: ReadonlyArray<Located>, after: ReadonlyArray<Located>): string[] {
  const inherited = new Map<string, number>();
  for (const pkg of before) inherited.set(versionKey(pkg), (inherited.get(versionKey(pkg)) ?? 0) + pkg.locations.length);
  return after.flatMap((pkg) => {
    const reason = ignoredVersionReason(config, pkg);
    if (reason === undefined) return [];
    const key = versionKey(pkg);
    const count = inherited.get(key) ?? 0;
    inherited.set(key, Math.max(0, count - pkg.locations.length));
    return pkg.locations.slice(count).map((location) => `${IGNORED_VERSION_REFUSAL} ${pkg.ecosystem}:${pkg.name}@${pkg.version} at ${location}: ${reason}`);
  });
}
