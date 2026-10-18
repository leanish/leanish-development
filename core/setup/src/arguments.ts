import { parseArgs } from "node:util";

import { CODING_AGENTS, type CodingAgent } from "@leanish/tool-runtime/config";

import type { BatchOptions } from "./batch.ts";
import type { ConfigureOptions, InstallationOptions } from "./configuration.ts";
import type { DoctorOptions } from "./doctor.ts";
import type { FixtureCleanupOptions } from "./fixture-cleanup.ts";
import type { GateOptions } from "./gate.ts";
import type { ScheduleOptions } from "./schedule.ts";
import { ownerName, repositoryName, toolName } from "./tools.ts";
import { isStableReleaseTag } from "./github-release.ts";

export class InvalidReleaseTag extends Error {
  constructor() { super("--release must be a stable vX.Y.Z tag; prerelease/rc tags and build metadata are not accepted"); }
}

export type SetupCommand =
  | { readonly command: "doctor"; readonly options: DoctorOptions }
  | { readonly command: "release" }
  | { readonly command: "configure"; readonly options: ConfigureOptions }
  | { readonly command: "enroll"; readonly options: InstallationOptions & { readonly login: string } }
  | { readonly command: "verify-tokens"; readonly options: InstallationOptions }
  | { readonly command: "gate"; readonly options: GateOptions }
  | { readonly command: "batch"; readonly options: BatchOptions }
  | { readonly command: "test-run"; readonly options: BatchOptions & { readonly repo: string } }
  | { readonly command: "schedule"; readonly options: ScheduleOptions }
  | { readonly command: "schedule-check"; readonly options: ScheduleOptions & { readonly taskFile: string } }
  | { readonly command: "fixture-cleanup"; readonly options: FixtureCleanupOptions };

export const USAGE = `usage: node core/setup/src/cli.ts
  doctor [--agent codex|claude-code] [--java <major>]
  release
  configure <tool> --owner <owner> --repo <owner/repo> [--repo ...] [--agent ... --name ... --email ... --model ... --effort ...]
  enroll <tool> --owner <owner> --login <github-login>
  verify-tokens <tool> --owner <owner>
  gate --repo <owner/repo> --release <tag> [--java <major>] [--confirm-settings]
  batch <tool> --owner <owner> --release <tag> [--repo <owner/repo>]
  schedule <tool> --owner <owner> --release <tag> --agent codex|claude-code
  schedule-check <tool> --owner <owner> --release <tag> --agent codex|claude-code --task-file <json>
  test-run <tool> --owner <owner> --release <tag> --repo <owner/repo>
  fixture-cleanup --bump-it-config <path> --secure-it-config <path> [--repo <owner/repo>] [--apply]`;

export function setupArguments(argv: ReadonlyArray<string>): SetupCommand {
  const [command, ...args] = argv;
  const flags: Record<string, { type: "string" | "boolean"; multiple?: boolean }> = {};
  const scheduling = command === "schedule" || command === "schedule-check";
  if (["doctor", "configure"].includes(command ?? "") || scheduling) flags["agent"] = { type: "string" };
  if (["doctor", "gate"].includes(command ?? "")) flags["java"] = { type: "string" };
  if (["configure", "enroll", "verify-tokens", "batch", "test-run"].includes(command ?? "") || scheduling) flags["owner"] = { type: "string" };
  if (["configure", "gate", "batch", "test-run", "fixture-cleanup"].includes(command ?? "")) flags["repo"] = { type: "string", multiple: command === "configure" };
  if (command === "configure") for (const name of ["name", "email", "model", "effort"]) flags[name] = { type: "string" };
  if (command === "enroll") flags["login"] = { type: "string" };
  if (["gate", "batch", "test-run"].includes(command ?? "") || scheduling) flags["release"] = { type: "string" };
  if (command === "gate") flags["confirm-settings"] = { type: "boolean" };
  if (command === "schedule-check") flags["task-file"] = { type: "string" };
  if (command === "fixture-cleanup") {
    flags["bump-it-config"] = { type: "string" };
    flags["secure-it-config"] = { type: "string" };
    flags["apply"] = { type: "boolean" };
  }
  const parsed = parseArgs({ args, options: flags, allowPositionals: true, strict: true, tokens: true });
  const seen = new Set<string>();
  for (const token of parsed.tokens) {
    if (token.kind !== "option" || flags[token.name]?.multiple === true) continue;
    if (seen.has(token.name)) throw new Error();
    seen.add(token.name);
  }
  const text = (name: string): string | undefined => typeof parsed.values[name] === "string" ? parsed.values[name] as string : undefined;
  const need = (name: string): string => { const value = text(name); if (value === undefined || value === "") throw new Error(); return value; };
  const release = text("release");
  if (release !== undefined && !isStableReleaseTag(release)) throw new InvalidReleaseTag();
  const agent = text("agent") as CodingAgent | undefined;
  if (agent !== undefined && !CODING_AGENTS.includes(agent)) throw new Error();
  const java = text("java");
  if (java !== undefined && (!/^\d+$/.test(java) || !Number.isSafeInteger(Number(java)) || Number(java) < 8)) throw new Error();
  const hasTool = ["configure", "enroll", "verify-tokens", "batch", "test-run"].includes(command ?? "") || scheduling;
  if (parsed.positionals.length !== (hasTool ? 1 : 0)) throw new Error();
  if (command === "doctor") return { command, options: { ...(agent === undefined ? {} : { agent }), ...(java === undefined ? {} : { java: Number(java) }) } };
  if (command === "release") return { command };
  if (command === "fixture-cleanup") {
    return { command, options: {
      bumpItConfig: need("bump-it-config"), secureItConfig: need("secure-it-config"),
      repo: text("repo") === undefined ? undefined : repositoryName(need("repo")), apply: parsed.values["apply"] === true,
    } };
  }
  if (command === "gate") return { command, options: { repo: repositoryName(need("repo")), release: need("release"), java, confirmSettings: parsed.values["confirm-settings"] === true } };
  if (!hasTool) throw new Error();
  const installation = { tool: toolName(parsed.positionals[0]!), owner: ownerName(need("owner")) };
  if (scheduling) {
    if (agent === undefined) throw new Error();
    const options = { ...installation, release: need("release"), agent };
    return command === "schedule" ? { command, options } : { command: "schedule-check", options: { ...options, taskFile: need("task-file") } };
  }
  if (command === "enroll") return { command, options: { ...installation, login: ownerName(need("login")) } };
  if (command === "verify-tokens") return { command, options: installation };
  if (command === "batch") return { command, options: { ...installation, release: need("release"), repo: text("repo") === undefined ? undefined : repositoryName(need("repo"), installation.owner) } };
  if (command === "test-run") return { command, options: { ...installation, release: need("release"), repo: repositoryName(need("repo"), installation.owner) } };
  const repos = parsed.values["repo"];
  if (!Array.isArray(repos) || repos.length === 0 || repos.some((repo) => typeof repo !== "string")) throw new Error();
  const selected = repos as string[];
  for (const repo of selected) repositoryName(repo, installation.owner);
  return { command: "configure", options: { ...installation, repos: selected, agent, name: text("name"), email: text("email"), model: text("model"), effort: text("effort") } };
}
