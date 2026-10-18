import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";

import { adoptGate } from "../src/gate.ts";
import { exitCode, type SetupResult } from "../src/contracts.ts";
import { gateWorkflow, GATE_SOURCE, PR_MARKER, WORKFLOW } from "../src/gate-workflow.ts";
import { FakeGateGitHub, REPO, ROOT } from "./fake-gate-github.ts";

let path: string;
const pin = { tag: "v0.7.0", sha: "f".repeat(40) };
beforeEach(async () => {
  path = await mkdtemp(join(tmpdir(), "setup-gate-"));
  await mkdir(join(path, ".github/workflows"), { recursive: true });
  await copyFile(new URL("../../../.github/workflows/supply-chain.yml", import.meta.url), join(path, ".github/workflows/supply-chain.yml"));
});
afterEach(async () => { await rm(path, { recursive: true, force: true }); });
const options = { repo: REPO, release: pin.tag, confirmSettings: false };
const machine = (api: FakeGateGitHub) => ({ api, release: async () => ({ ...pin, path }) });

describe("gate adoption", () => {
  it("opens an explicitly pinned PR with proper triggers, inputs and no settings writes until confirmation", async () => {
    const api = new FakeGateGitHub();
    const results = await adoptGate({ ...options, java: "25" }, machine(api));
    const workflow = api.files.get(`setup/gate-${pin.tag}`)!.get(WORKFLOW)!;
    expect(workflow).toContain(`${GATE_SOURCE}@${pin.sha} # ${pin.tag}`);
    const parsed = parse(workflow);
    expect(parsed.on).toMatchObject({ pull_request: { types: ["opened", "synchronize", "reopened", "edited"] }, push: { branches: ["trunk"] }, schedule: [{ cron: "17 5 * * *" }], workflow_dispatch: {} });
    expect(parsed.jobs["supply-chain"].with).toEqual({ "java-version": "25" });
    expect(parsed.permissions).toEqual({ contents: "read" });
    expect(api.prs).toHaveLength(1);
    expect(results[0]).toMatchObject({ status: "changed", data: { pendingMerge: true, pullRequest: `https://github.com/${REPO}/pull/1` } });
    expect(results.filter((entry) => entry.status === "needs-confirmation").map(({ step }) => step)).toEqual(expect.arrayContaining(["actions", "actions-allowlist", "dependency-alerts", "dependabot-security-prs", "required-checks"]));
    expect(api.calls.filter(({ method }) => method !== "GET").every(({ path }) => /\/git\/refs$|\/contents\/|\/pulls$/.test(path))).toBe(true);
    expect(api.calls.some(({ path }) => /\/merge$/.test(path))).toBe(false);
  });

  it("applies only explicitly confirmed settings, preserving other allowlist entries and protections; reruns are idempotent", async () => {
    const api = new FakeGateGitHub();
    api.rules.push({ id: 40, name: "company", source_type: "Organization", rules: [{ type: "pull_request" }] });
    api.files.get("trunk")!.set(".github/dependabot.yml", "version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule: {interval: weekly}\n");
    const results = await adoptGate({ ...options, confirmSettings: true }, machine(api));
    expect(results.some(({ step, status }) => step === "settings" && status === "needs-confirmation")).toBe(false);
    expect(api.actions.enabled).toBe(true);
    expect(api.selected.patterns_allowed).toContain("company/action@*");
    expect(api.selected.patterns_allowed).toContain(`${GATE_SOURCE}@${pin.sha}`);
    expect(api.alerts).toBe(true);
    expect(api.fixes).toBe(false);
    expect(api.rules[0]).toMatchObject({ name: "company", rules: [{ type: "pull_request" }] });
    expect(api.rules[1]).toMatchObject({ name: "leanish-gate", enforcement: "active", bypass_actors: [], rules: [{ type: "required_status_checks", parameters: {
      required_status_checks: [{ context: "supply-chain / supply-chain", integration_id: 15368 }, { context: "supply-chain / cooldown", integration_id: 15368 }],
    } }] });
    expect(parse(api.files.get(`setup/gate-${pin.tag}`)!.get(".github/dependabot.yml")!).updates[0]["open-pull-requests-limit"]).toBe(0);
    api.calls.length = 0;
    await adoptGate({ ...options, confirmSettings: true }, machine(api));
    expect(api.calls.filter(({ method }) => method !== "GET")).toEqual([]);
  });

  it("does not change Dependabot version configuration without settings confirmation", async () => {
    const api = new FakeGateGitHub();
    const original = "version: 2\nupdates: [{package-ecosystem: npm, directory: /, schedule: {interval: weekly}}]\n";
    api.files.get("trunk")!.set(".github/dependabot.yml", original);
    const results = await adoptGate(options, machine(api));
    expect(api.files.get(`setup/gate-${pin.tag}`)!.get(".github/dependabot.yml")).toBe(original);
    expect(results.some(({ step, status }) => step === "dependabot-version-prs" && status === "needs-confirmation")).toBe(true);
  });

  it("provides a ready admin request for non-admins, and a ready workflow when there is no push access", async () => {
    const api = new FakeGateGitHub();
    api.metadata.permissions.admin = false;
    const results = await adoptGate({ ...options, confirmSettings: true }, machine(api));
    expect(results.at(-1)).toMatchObject({ step: "admin-request", status: "needs-confirmation", data: { request: expect.stringContaining("supply-chain / cooldown") } });
    expect(api.calls.some(({ method, path }) => method !== "GET" && /permissions|rulesets|vulnerability|security-fixes/.test(path))).toBe(false);
    const noPush = new FakeGateGitHub();
    noPush.metadata.permissions = { push: false, admin: false };
    const requests = await adoptGate(options, machine(noPush));
    expect(requests[0]).toMatchObject({ step: "admin-request", data: { content: expect.stringContaining(pin.sha) } });
    expect(requests[1]).toMatchObject({ step: "admin-request", data: { request: expect.stringContaining("Dependabot alerts") } });
    expect(noPush.calls.every(({ method }) => method === "GET")).toBe(true);
  });

  it("reports private repositories without enforceable checks instead of aborting adoption", async () => {
    const api = new FakeGateGitHub();
    api.metadata.private = true;
    api.rulesStatus = 403;
    expect((await adoptGate({ ...options, confirmSettings: true }, machine(api))).some(({ message, data }) => message === "gate running, not enforced" && String(data?.reason).includes("403"))).toBe(true);
    expect(api.prs).toHaveLength(1);
  });

  it("refuses unrelated workflows, unowned PRs, moved branches, and different repositories", async () => {
    const unrelated = new FakeGateGitHub();
    unrelated.files.get("trunk")!.set(WORKFLOW, "jobs: {other: {runs-on: ubuntu-latest}}\n");
    await expect(adoptGate(options, machine(unrelated))).rejects.toThrow("not a recognized");
    expect(unrelated.calls.every(({ method }) => method === "GET")).toBe(true);
    const api = new FakeGateGitHub();
    await adoptGate(options, machine(api));
    api.prs[0]!["body"] = "someone else's PR";
    await expect(adoptGate(options, machine(api))).rejects.toThrow("ownership changed");
    api.prs[0]!["body"] = PR_MARKER;
    api.moveBeforeWrite = true;
    await expect(adoptGate({ ...options, java: "21" }, machine(api))).rejects.toThrow("ownership changed");
    const mismatch = new FakeGateGitHub();
    mismatch.metadata.full_name = "other/widget";
    await expect(adoptGate(options, machine(mismatch))).rejects.toThrow("different repository");
  });

  it("patches recognized callers surgically and refuses pull_request_target", () => {
    const original = `# keep note\nname: mine\non: {push: {branches: [trunk]}, pull_request: {}}\npermissions: {contents: read}\njobs:\n  supply-chain:\n    uses: ${GATE_SOURCE}@${"a".repeat(40)} # v0.6.0\n    with: {node-version: '26'}\n`;
    const rendered = gateWorkflow(original, pin, "trunk");
    expect(rendered).toContain("# keep note");
    expect(parse(rendered).jobs["supply-chain"].with["node-version"]).toBe("26");
    expect(() => gateWorkflow(original.replace("pull_request:", "pull_request_target:"), pin, "trunk")).toThrow("safe gate caller");
  });

  it.each(["", "repo", "workflow", "read:org"])("blocks classic credentials with incomplete workflow/repo scopes: %s", async (scopes) => {
    const api = new FakeGateGitHub();
    api.scopes = scopes;
    expect(await adoptGate(options, machine(api))).toEqual([expect.objectContaining({ step: "workflow-scope", status: "blocked", message: expect.stringContaining("gh auth refresh -h github.com -s workflow") })]);
    expect(api.calls.every(({ method }) => method === "GET")).toBe(true);
    expect(api.prs).toHaveLength(0);
  });

  it.each([undefined, "repo, workflow"])("accepts absent scope headers or sufficient classic scopes: %s", async (scopes) => {
    const api = new FakeGateGitHub();
    api.scopes = scopes;
    expect((await adoptGate(options, machine(api)))[0]?.status).toBe("changed");
    expect(api.prs).toHaveLength(1);
  });

  it("emits the PR before settings writes and preserves it after an allowlist 500", async () => {
    const api = new FakeGateGitHub();
    const emitted: SetupResult[] = [];
    const request = api.request.bind(api);
    vi.spyOn(api, "request").mockImplementation(async (method, path, body) => {
      if (method === "PUT" && path.endsWith("/selected-actions")) {
        expect(emitted[0]).toMatchObject({ step: "workflow", data: { pullRequest: expect.stringContaining("/pull/1") } });
        return { status: 500, body: { message: "secret-sentinel" } };
      }
      return request(method, path, body);
    });
    const results = await adoptGate({ ...options, confirmSettings: true }, machine(api), (entry) => emitted.push(entry));
    expect(results).toEqual(emitted);
    expect(results[0]).toMatchObject({ step: "workflow", status: "changed", data: { pullRequest: expect.stringContaining("/pull/1") } });
    expect(results).toContainEqual(expect.objectContaining({ step: "actions-allowlist", status: "blocked", data: { httpStatus: 500 } }));
    expect(results).toContainEqual(expect.objectContaining({ step: "dependency-alerts", status: "changed" }));
    expect(exitCode(results)).toBe(1);
    expect(JSON.stringify(results)).not.toContain("secret-sentinel");
  });

  it.each([undefined, "21"])("recovers its operator-authored adoption branch after PR creation failed, Java override: %s", async (java) => {
    const api = new FakeGateGitHub();
    const request = api.request.bind(api);
    const spy = vi.spyOn(api, "request").mockImplementation(async (method, path, body) => method === "POST" && path.endsWith("/pulls")
      ? { status: 500, body: undefined } : request(method, path, body));
    await expect(adoptGate(options, machine(api))).rejects.toThrow("HTTP 500");
    expect(api.prs).toHaveLength(0);
    spy.mockRestore();
    const results = await adoptGate({ ...options, java }, machine(api));
    expect(results[0]).toMatchObject({ status: "changed", data: { pendingMerge: true } });
    expect(api.prs).toHaveLength(1);
    if (java !== undefined) expect(parse(api.files.get(`setup/gate-${pin.tag}`)!.get(WORKFLOW)!).jobs["supply-chain"].with["java-version"]).toBe(java);
    expect(api.calls.some(({ path }) => path.includes("/compare/"))).toBe(true);
  });

  it.each(["author", "unrelated-file", "rename"])("refuses orphan branches with unverified %s changes", async (variant) => {
    const api = new FakeGateGitHub();
    await adoptGate(options, machine(api));
    api.prs.length = 0;
    const commit = [...api.commits.values()][0]!;
    if (variant === "author") commit.author.login = "someone-else";
    if (variant === "unrelated-file") commit.files.push({ filename: "README.md" });
    if (variant === "rename") commit.files[0]!.previous_filename = "README.md";
    api.calls.length = 0;
    await expect(adoptGate(options, machine(api))).rejects.toThrow("without an owned open PR");
    expect(api.calls.every(({ method }) => method === "GET")).toBe(true);
  });

  it.each(["actions/checkout@v4", `actions/checkout@${"A".repeat(40)}`, `actions/checkout@${pin.sha}extra`, "docker://alpine:latest", "${{ inputs.action }}"])("rejects an unpinned release uses before any API call: %s", async (uses) => {
    await writeFile(join(path, ".github/workflows/supply-chain.yml"), `jobs:\n  example:\n    steps:\n      - uses: '${uses}'\n`);
    const api = new FakeGateGitHub();
    expect(await adoptGate(options, machine(api))).toEqual([expect.objectContaining({ step: "release-actions", status: "blocked" })]);
    expect(api.calls).toEqual([]);
  });

  it("extracts quoted pins and flow-style uses while excluding local actions", async () => {
    const action = `company/actions/path@${pin.sha}`;
    await writeFile(join(path, ".github/workflows/supply-chain.yml"), `jobs:\n  example:\n    steps:\n      - uses: "${action}" # pinned\n      - {uses: './local'}\n`);
    const api = new FakeGateGitHub();
    await adoptGate({ ...options, confirmSettings: true }, machine(api));
    expect(api.selected.patterns_allowed).toContain(action);
    expect(api.selected.patterns_allowed).not.toContain("./local");
  });

  it.each(["on: [pull_request]", "on: push"])("normalizes existing trigger syntax: %s", (trigger) => {
    const source = `${trigger}\njobs:\n  supply-chain:\n    uses: ${GATE_SOURCE}@${pin.sha}\n`;
    expect(parse(gateWorkflow(source, pin, "trunk")).on).toEqual(expect.objectContaining({ pull_request: expect.any(Object), push: expect.any(Object), workflow_dispatch: {}, schedule: expect.any(Array) }));
  });
});
