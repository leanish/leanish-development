import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configure } from "../src/configuration.ts";
import { enrollment, verifyTokens } from "../src/enrollment.ts";

let home: string;
const options = { tool: "bump-it" as const, owner: "acme" };
const WRITE = "secret-sentinel-write";
const READ = "secret-sentinel-read";
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "setup-secrets-"));
  await configure({ ...options, repos: ["acme/one"], agent: "codex", name: "Dev", email: "dev@example.com" }, home);
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

function machine(isPrivate = true) {
  const secrets = { get: vi.fn(async (name: string): Promise<string> => name.endsWith("-write") ? WRITE : READ) };
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    expect(init?.method).toBeUndefined();
    expect(init?.redirect).toBe("error");
    const headers = init?.headers as Record<string, string>;
    expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
    expect([`Bearer ${WRITE}`, `Bearer ${READ}`]).toContain(headers["Authorization"]);
    const route = String(url);
    if (route.endsWith("/repos/acme/one")) return new Response(JSON.stringify({ private: isPrivate, default_branch: "main" }));
    return new Response("{}");
  });
  return { secrets, fetch: fetcher };
}

describe("human-only secret enrollment", () => {
  it("prints exact commands with a prompting -w last, and the documented permission table", async () => {
    const value = await enrollment({ ...options, login: "Dev" }, home);
    expect(value.status).toBe("needs-confirmation");
    expect(value.data?.commands).toEqual([
      { role: "write", command: "security add-generic-password -U -s 'leanish-bump-it-acme-write' -a 'dev' -w" },
      { role: "read", command: "security add-generic-password -U -s 'leanish-bump-it-acme-read' -a 'dev' -w" },
    ]);
    expect(value.data?.permissions).toHaveLength(7);
    expect(JSON.stringify(value)).not.toMatch(/secret-sentinel/);
    await expect(enrollment({ ...options, login: "x; echo bad" }, home)).rejects.toThrow("Invalid GitHub");
  });

  it("refuses identical tokens before any GitHub request", async () => {
    const fake = machine();
    fake.secrets.get.mockResolvedValue(WRITE);
    const value = await verifyTokens(options, home, fake);
    expect(value).toMatchObject({ status: "blocked", step: "separation" });
    expect(fake.fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(value)).not.toContain(WRITE);
  });

  it("reports proven private read capabilities, but never infers write/no-access scopes from reads", async () => {
    const value = await verifyTokens(options, home, machine());
    expect(value.status).toBe("already-done");
    const permissions = value.data?.permissions as Array<{ role: string; permission: string; required: string; status: string }>;
    expect(permissions).toHaveLength(14);
    expect(permissions.find((entry) => entry.role === "read" && entry.permission === "contents")?.status).toBe("pass");
    expect(permissions.filter((entry) => entry.required !== "read").every((entry) => entry.status === "unverified")).toBe(true);
    expect(value.data?.unverified).toEqual(permissions.filter(({ status }) => status === "unverified"));
    expect(value.message).toContain("real test run");
    expect(JSON.stringify(value)).not.toMatch(/secret-sentinel/);
  });

  it("never treats unauthenticated/public access or a required-permission header as proof of grants", async () => {
    const value = await verifyTokens(options, home, machine(false));
    const permissions = value.data?.permissions as Array<{ status: string }>;
    expect(value.status).toBe("already-done");
    expect(permissions.every((entry) => entry.status === "unverified")).toBe(true);
  });

  it("sanitizes Keychain and HTTP failures, including exceptions containing sentinel tokens", async () => {
    const first = machine();
    first.secrets.get.mockRejectedValue(new Error(WRITE));
    const keychain = await verifyTokens(options, home, first);
    expect(keychain.status).toBe("blocked");
    expect(first.fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(keychain)).not.toContain(WRITE);
    const second = machine();
    second.fetch.mockRejectedValue(new Error(READ));
    const result = await verifyTokens(options, home, second);
    expect(result.status).toBe("already-done");
    expect(result.data?.unverified).toHaveLength(14);
    expect(JSON.stringify(result)).not.toContain(READ);
    second.fetch.mockResolvedValue(new Response(JSON.stringify({ message: WRITE }), { status: 403, headers: { "X-Accepted-GitHub-Permissions": "contents=write" } }));
    const denied = await verifyTokens(options, home, second);
    expect(denied.status).toBe("blocked");
    expect(JSON.stringify(denied)).not.toContain(WRITE);
  });

  it.each([401, 403, 404])("blocks a denied required private read (HTTP %i)", async (status) => {
    const fake = machine();
    const fetcher = fake.fetch.getMockImplementation()!;
    fake.fetch.mockImplementation(async (url, init) => String(url).endsWith("/contents")
      ? new Response(WRITE, { status }) : fetcher(url, init));
    const value = await verifyTokens(options, home, fake);
    expect(value.status).toBe("blocked");
    expect(value.data?.permissions).toContainEqual(expect.objectContaining({ permission: "contents", required: "read", status: "fail" }));
    expect(JSON.stringify(value)).not.toContain(WRITE);
  });

  it("marks empty tokens as failed permissions and does not contact GitHub", async () => {
    const fake = machine();
    fake.secrets.get.mockResolvedValue("");
    const value = await verifyTokens(options, home, fake);
    expect(value.status).toBe("blocked");
    expect(value.data?.permissions).toEqual(expect.arrayContaining([expect.objectContaining({ status: "fail" })]));
    expect(fake.fetch).not.toHaveBeenCalled();
  });
});
