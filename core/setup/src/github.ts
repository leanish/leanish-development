import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Commands } from "./commands.ts";

export interface GitHubReply { readonly status: number; readonly body: unknown; readonly headers?: Readonly<Record<string, string>> }
export interface GitHubApi {
  request(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<GitHubReply>;
}

export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("GitHub returned an invalid object");
  return value as Record<string, unknown>;
}

export function string(value: unknown): string {
  if (typeof value !== "string" || value === "") throw new Error("GitHub returned a missing string");
  return value;
}

export function sha(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) throw new Error("GitHub returned an invalid commit SHA");
  return value;
}

export class GitHubHttpError extends Error {
  readonly status: number;
  constructor(status: number) { super(`GitHub request failed (HTTP ${status})`); this.status = status; }
}

export async function required(api: GitHubApi, method: Parameters<GitHubApi["request"]>[0], path: string, body?: unknown): Promise<unknown> {
  const response = await api.request(method, path, body);
  if (response.status < 200 || response.status >= 300) throw new GitHubHttpError(response.status);
  return response.body;
}

/** Operator gh authentication is separate from tool PATs. Bodies contain no credentials; child diagnostics never escape. */
export function githubApi(commands = new Commands()): GitHubApi {
  return { async request(method, path, body) {
    if (!/^(?:repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?.*|user|apps\/github-actions|graphql)$/.test(path) || /[\r\n]/.test(path)) throw new Error("Invalid GitHub API path");
    let temporary: string | undefined;
    try {
      const args = ["api", "--hostname", "github.com", "--method", method, "--include", "-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2022-11-28", path];
      if (body !== undefined) {
        temporary = await mkdtemp(join(tmpdir(), "leanish-gate-"));
        const file = join(temporary, "request.json");
        await writeFile(file, JSON.stringify(body), { mode: 0o600, flag: "wx" });
        args.push("--input", file);
      }
      const response = await commands.probe("gh", args);
      const boundary = /\r?\n\r?\n/.exec(response.stdout);
      const status = /^HTTP\/[\d.]+ (\d{3})/.exec(response.stdout)?.[1];
      if (boundary === null || status === undefined) throw new Error("GitHub request failed without a readable HTTP response");
      const text = response.stdout.slice(boundary.index + boundary[0].length).trim();
      let parsed: unknown;
      try { parsed = text === "" ? undefined : JSON.parse(text); } catch { throw new Error("GitHub returned unreadable JSON"); }
      const headers: Record<string, string> = {};
      for (const line of response.stdout.slice(0, boundary.index).split(/\r?\n/).slice(1)) {
        const colon = line.indexOf(":");
        if (colon > 0) {
          const key = line.slice(0, colon).trim().toLowerCase();
          const value = line.slice(colon + 1).trim();
          headers[key] = headers[key] === undefined ? value : `${headers[key]}, ${value}`;
        }
      }
      return { status: Number(status), body: parsed, headers };
    } finally {
      if (temporary !== undefined) await rm(temporary, { recursive: true, force: true });
    }
  } };
}

export async function list(api: GitHubApi, path: string): Promise<ReadonlyArray<Record<string, unknown>>> {
  const found: Record<string, unknown>[] = [];
  for (let page = 1; page <= 100; page++) {
    const body = await required(api, "GET", `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    if (!Array.isArray(body)) throw new Error("GitHub returned an invalid list");
    found.push(...body.map(object));
    if (body.length < 100) return found;
  }
  throw new Error("GitHub pagination exceeded its bound; refusing incomplete evidence");
}
