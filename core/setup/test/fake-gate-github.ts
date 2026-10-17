import { createHash } from "node:crypto";

import type { GitHubApi, GitHubReply } from "../src/github.ts";
import { object } from "../src/github.ts";

export const REPO = "acme/widget";
export const ROOT = `repos/${REPO}`;
export const blobSha = (value: string) => createHash("sha1").update(value).digest("hex");

/** No network. Mutations model file CAS and branch movement, so reruns exercise real reconciliation. */
export class FakeGateGitHub implements GitHubApi {
  calls: Array<{ method: string; path: string; body?: unknown }> = [];
  metadata = { full_name: REPO, private: false, default_branch: "trunk", permissions: { push: true, admin: true } };
  heads = new Map([["trunk", "a".repeat(40)]]);
  files = new Map<string, Map<string, string>>([["trunk", new Map()]]);
  prs: Record<string, unknown>[] = [];
  actions = { enabled: false, allowed_actions: "selected" };
  selected = { github_owned_allowed: false, verified_allowed: false, patterns_allowed: ["company/action@*"] };
  alerts = false;
  fixes = true;
  rules: Record<string, unknown>[] = [];
  rulesStatus = 200;
  moveBeforeWrite = false;
  scopes: string | undefined;
  commits = new Map<string, { sha: string; author: { login: string }; parents: Array<{ sha: string }>; files: Array<{ filename: string; previous_filename?: string }> }>();
  #next = 1;

  async request(method: string, path: string, payload?: unknown): Promise<GitHubReply> {
    this.calls.push({ method, path, body: payload });
    const [route, query] = path.split("?");
    const params = new URLSearchParams(query);
    const body = payload === undefined ? {} : object(payload);
    const ok = (data?: unknown, status = 200) => ({ status, body: data });
    if (method === "GET" && path === ROOT) return { ...ok(this.metadata), headers: this.scopes === undefined ? {} : { "x-oauth-scopes": this.scopes } };
    if (method === "GET" && route?.startsWith(`${ROOT}/compare/`)) {
      const [base, head] = route.slice(`${ROOT}/compare/`.length).split("...");
      const commits = [];
      let current = head!;
      while (current !== base && this.commits.has(current)) {
        const commit = this.commits.get(current)!;
        commits.unshift(commit);
        current = commit.parents[0]!.sha;
      }
      return ok({ commits, total_commits: commits.length, ahead_by: commits.length, files: commits.flatMap(({ files }) => files) });
    }
    if (method === "GET" && path === "user") return ok({ login: "dev" });
    if (path === "apps/github-actions") return ok({ slug: "github-actions", id: 15368 });
    if (route === `${ROOT}/pulls`) {
      if (method === "GET") return ok(this.prs.filter((pr) => pr["state"] === "open"));
      const branch = String(body["head"]);
      const pr = { number: this.prs.length + 1, state: "open", body: body["body"], user: { login: "dev" },
        head: { sha: this.heads.get(branch), ref: branch, repo: { full_name: REPO } }, base: { repo: { full_name: REPO } }, html_url: `https://github.com/${REPO}/pull/${this.prs.length + 1}` };
      this.prs.push(pr);
      return ok(pr, 201);
    }
    if (method === "GET" && route?.match(/\/pulls\/\d+\/files$/)) {
      const branch = String(object(this.prs[0]!["head"])["ref"]);
      return ok([...this.files.get(branch)!.entries()].filter(([name, value]) => this.files.get("trunk")?.get(name) !== value).map(([filename]) => ({ filename })));
    }
    if (method === "GET" && route?.startsWith(`${ROOT}/git/ref/heads/`)) {
      const branch = decodeURIComponent(route.slice(`${ROOT}/git/ref/heads/`.length));
      const sha = this.heads.get(branch);
      if (this.moveBeforeWrite && branch.startsWith("setup/") && this.prs.length > 0) return ok({ object: { sha: "e".repeat(40) } });
      return sha === undefined ? ok(undefined, 404) : ok({ object: { sha } });
    }
    if (method === "POST" && route === `${ROOT}/git/refs`) {
      const branch = String(body["ref"]).replace(/^refs\/heads\//, "");
      if (this.heads.has(branch)) return ok(undefined, 422);
      this.heads.set(branch, String(body["sha"]));
      this.files.set(branch, new Map(this.files.get("trunk")));
      return ok({ object: { sha: body["sha"] } }, 201);
    }
    if (route?.startsWith(`${ROOT}/contents/`)) {
      const name = route.slice(`${ROOT}/contents/`.length);
      const branch = method === "GET" ? params.get("ref")! : String(body["branch"]);
      const files = this.files.get(branch);
      const text = files?.get(name);
      if (method === "GET") return text === undefined ? ok(undefined, 404) : ok({ type: "file", encoding: "base64", sha: blobSha(text), content: Buffer.from(text).toString("base64") });
      if (files === undefined || (text !== undefined && body["sha"] !== blobSha(text))) return ok(undefined, 409);
      files.set(name, Buffer.from(String(body["content"]), "base64").toString("utf8"));
      const sha = String(this.#next++).padStart(40, "0");
      this.commits.set(sha, { sha, author: { login: "dev" }, parents: [{ sha: this.heads.get(branch)! }], files: [{ filename: name }] });
      this.heads.set(branch, sha);
      for (const pr of this.prs) if (object(pr["head"])["ref"] === branch) object(pr["head"])["sha"] = sha;
      return ok({ commit: { sha } }, 201);
    }
    if (route === `${ROOT}/actions/permissions`) {
      if (method === "PUT") this.actions = { ...this.actions, ...body };
      return ok(this.actions);
    }
    if (route === `${ROOT}/actions/permissions/selected-actions`) {
      if (method === "PUT") this.selected = body as typeof this.selected;
      return ok(this.selected);
    }
    if (route === `${ROOT}/vulnerability-alerts`) {
      if (method === "PUT") this.alerts = true;
      return ok(undefined, this.alerts ? 204 : 404);
    }
    if (route === `${ROOT}/automated-security-fixes`) {
      if (method === "DELETE") this.fixes = false;
      return ok({ enabled: this.fixes });
    }
    if (route === `${ROOT}/rulesets`) {
      if (this.rulesStatus !== 200) return ok(undefined, this.rulesStatus);
      if (method === "POST") {
        const rule = { id: this.rules.length + 1, source_type: "Repository", ...body };
        this.rules.push(rule);
        return ok(rule, 201);
      }
      const page = Number(params.get("page") ?? 1);
      const size = Number(params.get("per_page") ?? 30);
      return ok(this.rules.slice((page - 1) * size, page * size));
    }
    if (method === "GET" && route?.startsWith(`${ROOT}/rulesets/`)) return ok(this.rules.find((rule) => String(rule["id"]) === route.split("/").at(-1)));
    throw new Error(`Unexpected fake request ${method} ${path}`);
  }
}
