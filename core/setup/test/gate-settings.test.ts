import { describe, expect, it, vi } from "vitest";

import { gateSettings } from "../src/gate-settings.ts";
import { FakeGateGitHub, REPO, ROOT } from "./fake-gate-github.ts";

const patterns = ["actions/checkout@" + "a".repeat(40)];
const settings = (api: FakeGateGitHub, confirm = true) => gateSettings(api, REPO, true, false, patterns, confirm);

describe("gate setting evidence", () => {
  it("inspects every page before creating a ruleset", async () => {
    const api = new FakeGateGitHub();
    await settings(api);
    const owned = api.rules.pop()!;
    api.rules.push(...Array.from({ length: 100 }, (_, id) => ({ id: id + 10, name: `company-${id}`, source_type: "Organization" })), owned);
    api.calls.length = 0;
    expect(await settings(api)).toMatchObject([{ step: "settings", status: "already-done" }]);
    expect(api.calls.some(({ path }) => path === `${ROOT}/rulesets?per_page=100&page=2`)).toBe(true);
    expect(api.calls.every(({ method }) => method === "GET")).toBe(true);
  });

  it.each([
    { target: "tag" },
    { conditions: { ref_name: { include: ["refs/heads/another"], exclude: [] } } },
    { conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: ["~DEFAULT_BRANCH"] } } },
    { bypass_actors: [{ actor_id: 1, actor_type: "RepositoryRole", bypass_mode: "always" }] },
    { enforcement: "disabled" },
  ])("does not claim enforcement or rewrite customized rulesets: %j", async (customization) => {
    const api = new FakeGateGitHub();
    await settings(api);
    Object.assign(api.rules[0]!, customization);
    api.calls.length = 0;
    expect(await settings(api)).toMatchObject([{ step: "required-checks", status: "needs-confirmation" }]);
    expect(api.calls.every(({ method }) => method === "GET")).toBe(true);
  });

  it("never binds required checks to an unknown app", async () => {
    const api = new FakeGateGitHub();
    const request = api.request.bind(api);
    vi.spyOn(api, "request").mockImplementation(async (method, path, body) => path === "apps/github-actions"
      ? { status: 404, body: undefined } : request(method, path, body));
    const results = await settings(api);
    expect(results).toContainEqual(expect.objectContaining({ step: "required-checks", status: "needs-confirmation" }));
    expect(api.rules).toEqual([]);
  });

  it("proposes local-only Actions policy changes and applies them only with confirmation", async () => {
    const api = new FakeGateGitHub();
    api.actions = { enabled: true, allowed_actions: "local_only" };
    expect(await settings(api, false)).toContainEqual(expect.objectContaining({ step: "actions", status: "needs-confirmation" }));
    expect(api.calls.every(({ method }) => method === "GET")).toBe(true);
    await settings(api);
    expect(api.actions).toEqual({ enabled: true, allowed_actions: "selected" });
    expect(api.selected.patterns_allowed).toEqual(patterns);
  });
});
