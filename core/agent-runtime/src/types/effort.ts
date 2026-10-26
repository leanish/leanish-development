// Copied from leanish/leanish-development-incubator core/runtime/src/types/execution-override.ts at 17883e3; see
// PROVENANCE.md.
// Local changes: only the effort vocabulary, not the execution override that carries it.

/** How hard a coding agent reasons on a skill call, in Codex's terms; Claude Code has no `minimal` and takes `low`. */
export type Effort = "minimal" | "low" | "medium" | "high" | "xhigh";

export const EFFORTS: ReadonlyArray<Effort> = ["minimal", "low", "medium", "high", "xhigh"];
