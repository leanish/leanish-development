import { readFile, stat } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import type { RunProcess } from "@leanish/gate/process";

import { Commands } from "../src/commands.ts";
import { githubApi, list } from "../src/github.ts";

describe("operator GitHub adapter", () => {
  it("sends JSON through a private temporary file, cleans it, and preserves HTTP errors without diagnostics", async () => {
    let temporary: string | undefined;
    const run = vi.fn<RunProcess>(async (command, args, options) => {
      expect(command).toBe("gh");
      expect(args).toContain("--hostname");
      expect(args).toContain("github.com");
      expect(args).toContain("X-GitHub-Api-Version: 2022-11-28");
      expect(options?.env?.["GH_TOKEN"]).toBe("sentinel-secret");
      temporary = args[args.indexOf("--input") + 1]!;
      expect(await readFile(temporary, "utf8")).toBe('{"enabled":true}');
      expect((await stat(temporary)).mode & 0o777).toBe(0o600);
      return { code: 1, stdout: 'HTTP/2.0 403 Forbidden\r\nContent-Type: application/json\r\nX-OAuth-Scopes: repo, workflow\r\n\r\n{"message":"denied"}', stderr: "sentinel-secret" };
    });
    const api = githubApi(new Commands(run, { GH_TOKEN: "sentinel-secret" }));
    expect(await api.request("PUT", "repos/acme/widget/actions/permissions", { enabled: true })).toEqual({ status: 403, body: { message: "denied" }, headers: { "content-type": "application/json", "x-oauth-scopes": "repo, workflow" } });
    await expect(stat(temporary!)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.stringify(run.mock.calls.map(([, args]) => args))).not.toContain("sentinel-secret");
  });

  it.each([
    { code: 1, stdout: "sentinel-secret", stderr: "sentinel-secret" },
    { code: 0, stdout: "HTTP/2.0 200 OK\n\nsentinel-secret", stderr: "" },
  ])("rejects unreadable replies without reflecting their contents", async (reply) => {
    const api = githubApi(new Commands(async () => reply, {}));
    await expect(api.request("GET", "user")).rejects.toThrow(/^GitHub (?:request failed without a readable HTTP response|returned unreadable JSON)$/);
  });

  it("accepts empty 204 replies, bounds pagination, and refuses incomplete lists", async () => {
    const api = githubApi(new Commands(async () => ({ code: 0, stdout: "HTTP/2.0 204 No Content\n\n", stderr: "" }), {}));
    expect(await api.request("GET", "repos/acme/widget/vulnerability-alerts")).toEqual({ status: 204, body: undefined, headers: {} });
    const request = vi.fn(async () => ({ status: 200, body: Array.from({ length: 100 }, () => ({ id: 1 })) }));
    await expect(list({ request }, "repos/acme/widget/pulls?state=open")).rejects.toThrow(/pagination exceeded/);
    expect(request).toHaveBeenCalledTimes(100);
    await expect(api.request("GET", "https://elsewhere.invalid/user")).rejects.toThrow("Invalid GitHub API path");
  });

  it("allows GitHub's GraphQL endpoint, and only that one outside repos/", async () => {
    const run = vi.fn<RunProcess>(async () => ({ code: 0, stdout: 'HTTP/2.0 200 OK\n\n{"data":{}}', stderr: "" }));
    const api = githubApi(new Commands(run, {}));
    expect(await api.request("POST", "graphql", { query: "{ viewer { login } }" })).toMatchObject({ status: 200, body: { data: {} } });
    expect(run.mock.calls[0]![1]).toContain("graphql");
    await expect(api.request("POST", "graphql/extra")).rejects.toThrow("Invalid GitHub API path");
  });

  it("allows the same repos/ paths as before, and refuses a long one ending in a newline in linear time", async () => {
    const run = vi.fn<RunProcess>(async () => ({ code: 0, stdout: "HTTP/2.0 204 No Content\n\n", stderr: "" }));
    const api = githubApi(new Commands(run, {}));
    for (const path of ["repos/acme/widget", "repos/acme/w", "repos/acme/widget/", "repos/acme/widget/pulls?state=open", "repos/acme/widget?x=1", "repos/a.b/c-d_e/x/y"]) {
      expect(await api.request("GET", path), path).toEqual({ status: 204, body: undefined, headers: {} });
    }
    for (const path of ["repos/acme", "repos/acme/", "repos/acme//widget", "repos/acme/!widget", "repos/ac me/widget", "repos/acme/widget\nx", "users/acme"]) {
      await expect(api.request("GET", path), path).rejects.toThrow("Invalid GitHub API path");
    }
    const started = performance.now();
    // The replaced regex let the name and the rest trade characters: polynomial backtracking, seconds at this length.
    await expect(api.request("GET", `repos/acme/${"w".repeat(100_000)}\n`)).rejects.toThrow("Invalid GitHub API path");
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(run).toHaveBeenCalledTimes(6);
  });
});
