import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { CodingAgent } from "@leanish/tool-runtime/config";

export const TOOLS = ["bump-it", "secure-it"] as const;
export type Tool = typeof TOOLS[number];
export type PermissionLevel = "read" | "write" | "none";
export interface ToolDescriptor {
  readonly tool: Tool;
  readonly agentDefaults: Readonly<Record<CodingAgent, { readonly model: string; readonly effort: string }>>;
  readonly schedule: { readonly frequency: "daily" | "weekly"; readonly day?: number; readonly hour: number; readonly minute: number };
  readonly permissions: ReadonlyArray<{ readonly name: string; readonly label: string; readonly read: PermissionLevel; readonly write: PermissionLevel }>;
}

export function toolName(value: string): Tool {
  if (!(TOOLS as ReadonlyArray<string>).includes(value)) throw new Error("Tool must be bump-it or secure-it");
  return value as Tool;
}

export function ownerName(value: string): string {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(value)) throw new Error("Invalid GitHub owner or login");
  return value.toLowerCase();
}

export function repositoryName(value: string, owner?: string): string {
  const [name, slug, extra] = value.split("/");
  if (name === undefined || slug === undefined || extra !== undefined || !/^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/.test(slug)) throw new Error("Expected an explicit owner/repository");
  const normalized = ownerName(name);
  if (owner !== undefined && normalized !== ownerName(owner)) throw new Error("Repository belongs to another installation owner");
  return value;
}

const LEVELS: ReadonlySet<unknown> = new Set<PermissionLevel>(["read", "write", "none"]);
/** The token form's own parameters, which a permission name must not overwrite. */
const FORM_PARAMETERS: ReadonlySet<unknown> = new Set(["name", "description", "target_name", "expires_in"]);

/** A tool's permission table: at least one entry, each named once, with a label and a level for each token role. */
export function validPermissions(permissions: unknown): boolean {
  if (!Array.isArray(permissions) || permissions.length === 0) return false;
  const names = new Set<unknown>();
  return permissions.every((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return false;
    const { name, label, read, write } = entry as Record<string, unknown>;
    if (typeof name !== "string" || !/^[a-z_]+$/.test(name) || names.has(name) || FORM_PARAMETERS.has(name) || typeof label !== "string" || label === "") return false;
    names.add(name);
    return LEVELS.has(read) && LEVELS.has(write);
  });
}

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
/** Tool contributions are data files, never tool code imports. */
export async function descriptor(tool: Tool): Promise<{ descriptor: ToolDescriptor; template: string }> {
  const directory = join(ROOT, toolName(tool), "setup");
  const data = JSON.parse(await readFile(join(directory, "descriptor.json"), "utf8")) as ToolDescriptor;
  if (data.tool !== tool || !validPermissions(data.permissions)) throw new Error("Invalid tool setup descriptor");
  return { descriptor: data, template: await readFile(join(directory, "agent.yaml"), "utf8") };
}
