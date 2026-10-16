import { parseGradleInventory, type GradleInventory, type GradleVersionConstraint } from "../../ci/src/gradle.ts";

export const RICH_VERSION: GradleVersionConstraint = {
  strictVersion: "[1.0,3.0[", requiredVersion: "[1.0,3.0[", preferredVersion: "1.5", rejectedVersions: ["2.0"], branch: null,
};

export const RICH_VERSION_CHANGES = [
  { facet: "reject removed", before: { ...RICH_VERSION, preferredVersion: "" }, after: { ...RICH_VERSION, preferredVersion: "", rejectedVersions: [] } },
  { facet: "reject added", before: RICH_VERSION, after: { ...RICH_VERSION, rejectedVersions: ["2.0", "2.5"] } },
  { facet: "prefer changed", before: RICH_VERSION, after: { ...RICH_VERSION, preferredVersion: "1.6" } },
  { facet: "prefer removed", before: RICH_VERSION, after: { ...RICH_VERSION, preferredVersion: "" } },
  { facet: "require changed", before: { ...RICH_VERSION, strictVersion: "" }, after: { ...RICH_VERSION, strictVersion: "", requiredVersion: "[1.0,4.0[" } },
  { facet: "strict range changed", before: RICH_VERSION, after: { ...RICH_VERSION, strictVersion: "[1.0,4.0[", requiredVersion: "[1.0,4.0[" } },
  { facet: "branch added", before: RICH_VERSION, after: { ...RICH_VERSION, branch: "main" } },
] as const;

/** An active declaration or constraint whose resolution stays the same when its rich version changes. */
export function richVersionInventory(kind: "declaration" | "constraint", versionConstraint: GradleVersionConstraint): GradleInventory {
  // Exercise the exporter's sparse format through the same parser the tools use.
  const facets = Object.fromEntries(Object.entries(versionConstraint).filter(([, value]) =>
    value !== "" && value !== null && (!Array.isArray(value) || value.length > 0)));
  const entry = { group: "g", name: "rich", version: versionConstraint.strictVersion || versionConstraint.requiredVersion || versionConstraint.preferredVersion || undefined,
    versionConstraint: facets, ...(versionConstraint.strictVersion ? { strict: true as const } : {}) };
  return parseGradleInventory({ schemaVersion: 3, tree: "fixture", builds: [{ build: ".", configurations: [{
    id: ":runtimeClasspath", kind: "project", error: undefined, unresolved: [], edges: [],
    resolved: [{ group: "g", name: "rich", version: "1.5" }],
    declared: kind === "declaration" ? [{ ...entry, reason: undefined }] : [{ group: "g", name: "rich", version: undefined, reason: undefined }],
    constraints: kind === "constraint" ? [entry] : [],
  }] }] }, "fixture", ["."]);
}
