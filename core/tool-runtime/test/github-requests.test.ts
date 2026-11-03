import { describe, expect, it, vi } from "vitest";

import { namingFailures } from "@leanish/gate/http";
import { GitHubRequests } from "../src/github-requests.ts";

const API = "https://api.github.com";

describe("GitHubRequests", () => {
  it("normalizes repository, tag, ref, ID and pagination paths, separating methods", async () => {
    const requests = new GitHubRequests();
    const raw = vi.fn<typeof globalThis.fetch>(async () => new Response("[]"));
    const fetch = requests.wrap(raw);
    for (const path of [
      "/repos/acme/lib/security-advisories?per_page=100", "/repos/other/repo/security-advisories?page=2",
      "/repos/acme/lib/git/ref/tags/v1", "/repos/acme/lib/git/ref/tags/v2%2Fbeta",
      `/repos/acme/lib/git/tags/${"a".repeat(40)}`, "/repos/acme/lib/releases",
      "/repos/acme/lib/releases/tags/v1", "/repos/acme/lib/pulls/23",
      "/repos/acme/lib/check-runs/42", "/repos/acme/lib/actions/runs/7/jobs",
      `/repos/acme/lib/commits/${"b".repeat(40)}/status`, "/advisories/GHSA-1234", "/advisories?affects=secret",
    ]) await fetch(API + path);
    await fetch(new URL(API + "/repos/acme/lib/pulls"), { method: "POST", headers: { authorization: "Bearer secret" } });
    await fetch(new Request(API + "/graphql", { method: "POST", body: "{}" }));
    await fetch(API + "/repos/acme/lib/git/refs/heads/fix/dependency", { method: "DELETE" });
    await fetch("https://registry.npmjs.org/lib");
    expect(requests.summary()).toEqual({ total: 16, byKind: {
      "GET /repos/{owner}/{repo}/security-advisories": 2,
      "GET /repos/{owner}/{repo}/git/ref/tags/{ref}": 2,
      "GET /repos/{owner}/{repo}/git/tags/{id}": 1,
      "GET /repos/{owner}/{repo}/releases": 1,
      "GET /repos/{owner}/{repo}/releases/tags/{tag}": 1,
      "GET /repos/{owner}/{repo}/pulls/{id}": 1,
      "GET /repos/{owner}/{repo}/check-runs/{id}": 1,
      "GET /repos/{owner}/{repo}/actions/runs/{id}/jobs": 1,
      "GET /repos/{owner}/{repo}/commits/{id}/status": 1,
      "GET /advisories/{id}": 1, "GET /advisories": 1,
      "POST /repos/{owner}/{repo}/pulls": 1, "POST /graphql": 1,
      "DELETE /repos/{owner}/{repo}/git/refs/heads/{ref}": 1,
    } });
    expect(raw).toHaveBeenCalledTimes(17);
    expect(JSON.stringify(requests.summary())).not.toContain("secret");
  });

  it("drops logins and label names from issue paths", async () => {
    const requests = new GitHubRequests();
    const fetch = requests.wrap(vi.fn<typeof globalThis.fetch>(async () => new Response("{}")));
    await fetch(API + "/repos/acme/lib/collaborators/some-person/permission");
    await fetch(API + "/repos/acme/lib/issues/12/labels/take-early", { method: "DELETE" });
    await fetch(API + "/repos/acme/lib/issues/12/events?per_page=100");
    await fetch(API + "/repos/acme/lib/issues/12/comments", { method: "POST" });
    await fetch(API + "/repos/acme/lib/labels/take-early");
    expect(requests.summary().byKind).toEqual({
      "GET /repos/{owner}/{repo}/collaborators/{login}/permission": 1,
      "DELETE /repos/{owner}/{repo}/issues/{id}/labels/{label}": 1,
      "GET /repos/{owner}/{repo}/issues/{id}/events": 1,
      "POST /repos/{owner}/{repo}/issues/{id}/comments": 1,
      "GET /repos/{owner}/{repo}/labels/{label}": 1,
    });
    expect(JSON.stringify(requests.summary())).not.toMatch(/some-person|take-early/);
  });

  it("counts retries, HTTP refusals and rejected attempts, and returns independent snapshots", async () => {
    const requests = new GitHubRequests();
    const raw = vi.fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(Object.assign(new Error("reset"), { code: "ECONNRESET" }))
      .mockResolvedValueOnce(new Response("[]"))
      .mockResolvedValueOnce(new Response("{}", { status: 429 }))
      .mockRejectedValueOnce(new Error("offline"));
    const fetch = namingFailures(requests.wrap(raw), { sleep: async () => undefined, random: () => 0 });
    await fetch(API + "/repos/a/b/security-advisories");
    const snapshot = requests.summary();
    expect((await fetch(API + "/repos/a/b/security-advisories")).status).toBe(429);
    await expect(fetch(API + "/repos/a/b/security-advisories")).rejects.toThrow("offline");
    expect(snapshot.total).toBe(2);
    expect(requests.summary()).toEqual({ total: 4, byKind: { "GET /repos/{owner}/{repo}/security-advisories": 4 } });
    expect(new GitHubRequests().summary()).toEqual({ total: 0, byKind: {} });
  });
});
