import { Document, isScalar, parseDocument, visit } from "yaml";

import { GATE_WORKFLOW } from "@leanish/tool-runtime/edit-checks";

export const WORKFLOW = ".github/workflows/supply-chain.yml";
export const GATE_SOURCE = `${GATE_WORKFLOW.name}/${GATE_WORKFLOW.path}`;
export const PR_MARKER = "<!-- leanish:gate-adoption -->";
export const ADOPTION_FILES = [WORKFLOW, ".github/dependabot.yml", ".github/dependabot.yaml"] as const;

/** Parse every uses field, including quoted and flow-style entries, before contacting GitHub. */
export function pinnedActions(source: string): ReadonlyArray<string> {
  const doc = parseDocument(source);
  if (doc.errors.length > 0) throw new Error("Unreadable release workflow");
  const actions = new Set<string>();
  visit(doc, { Pair(_key, pair) {
    if (!isScalar(pair.key) || pair.key.value !== "uses") return;
    if (!isScalar(pair.value) || typeof pair.value.value !== "string") throw new Error("Unpinned release action");
    const value = pair.value.value;
    if (value.startsWith("./")) return;
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*@[a-f0-9]{40}$/.test(value)) throw new Error("Unpinned release action");
    actions.add(value);
  } });
  return [...actions];
}

/** Existing recognized callers are patched narrowly; unrelated workflows require a person's edit. */
/** The yaml library pads flow collections (`[ main ]`) by default; keep the person's `[main]` as written. */
const WRITE = { flowCollectionPadding: false } as const;

export function gateWorkflow(existing: string | undefined, pin: { readonly tag: string; readonly sha: string }, branch: string, java?: string): string {
  const doc = existing === undefined ? new Document({ name: "supply-chain",
    on: { pull_request: { types: ["opened", "synchronize", "reopened", "edited"] }, push: { branches: [branch] }, schedule: [{ cron: "17 5 * * *" }], workflow_dispatch: {} },
    permissions: { contents: "read" }, jobs: { "supply-chain": { uses: `${GATE_SOURCE}@${pin.sha}` } },
  }) : parseDocument(existing);
  if (doc.errors.length > 0) throw new Error("Existing gate workflow is not readable YAML; edit it locally");
  const use = doc.getIn(["jobs", "supply-chain", "uses"]);
  const triggers = doc.get("on");
  if (typeof triggers === "string" || Array.isArray(doc.toJS()?.on)) {
    const names = typeof triggers === "string" ? [triggers] : doc.toJS().on as unknown[];
    if (names.some((name) => typeof name !== "string")) throw new Error("Existing gate triggers must name events");
    doc.set("on", doc.createNode(Object.fromEntries(names.map((name) => [name, {}]))));
  }
  if (typeof use !== "string" || !use.startsWith(`${GATE_SOURCE}@`) || doc.hasIn(["on", "pull_request_target"])) throw new Error("Existing workflow is not a recognized safe gate caller; prepare its adoption manually");
  doc.setIn(["jobs", "supply-chain", "uses"], `${GATE_SOURCE}@${pin.sha}`);
  const node = doc.getIn(["jobs", "supply-chain", "uses"], true);
  if (isScalar(node)) node.comment = ` ${pin.tag}`;
  if (java !== undefined) doc.setIn(["jobs", "supply-chain", "with", "java-version"], java);
  doc.set("permissions", { contents: "read" });
  for (const [event, value] of Object.entries({ pull_request: { types: ["opened", "synchronize", "reopened", "edited"] }, push: { branches: [branch] }, schedule: [{ cron: "17 5 * * *" }], workflow_dispatch: {} })) {
    if (!doc.hasIn(["on", event])) doc.setIn(["on", event], value);
  }
  return doc.toString(WRITE);
}

export function stopVersionUpdates(existing: string): string {
  const doc = parseDocument(existing);
  if (doc.errors.length > 0) throw new Error("Dependabot configuration is unreadable; disable version update PRs manually");
  const data = doc.toJS() as { updates?: unknown } | null;
  if (!Array.isArray(data?.updates)) throw new Error("Dependabot configuration is unreadable; disable version update PRs manually");
  for (const [index, update] of data.updates.entries()) {
    if (update === null || typeof update !== "object") throw new Error("Invalid Dependabot update entry");
    doc.setIn(["updates", index, "open-pull-requests-limit"], 0);
  }
  return doc.toString(WRITE);
}
