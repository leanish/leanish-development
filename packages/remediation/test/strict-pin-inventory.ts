import type { GradleInventory } from "../../ci/src/gradle.ts";

/** Gradle's interpreted pin data: the reference comparison doesn't depend on the source file's syntax. */
export function strictPinInventory(kind: "declaration" | "constraint", version: string | undefined, strict = true): GradleInventory {
  const pin = { group: "g", name: "pinned", version: version ?? "1.0", reason: undefined };
  return { schemaVersion: 3, tree: "fixture", builds: [{ build: ".", configurations: [{
    id: ":runtimeClasspath", kind: "project", error: undefined, unresolved: [],
    resolved: [{ group: "g", name: "pinned", version: version ?? "1.0" }],
    declared: kind === "constraint" ? [{ ...pin, version: "1.0" }] : version === undefined ? [] : [{ ...pin, ...(strict ? { strict: true as const } : {}) }],
    strictConstraints: kind === "constraint" && version !== undefined && strict ? [{ group: pin.group, name: pin.name, version }] : [],
  }] }] };
}

export const STRICT_PIN_SOURCES = [
  { kind: "declaration", path: "build.gradle.kts" },
  { kind: "declaration", path: "gradle/libs.versions.toml" },
  { kind: "constraint", path: "build.gradle.kts" },
] as const;
