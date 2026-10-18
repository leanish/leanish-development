import { result, type SetupResult } from "./contracts.ts";
import { type GitHubApi, GitHubHttpError, object, required } from "./github.ts";

export const REQUIRED_CHECKS = ["supply-chain / supply-chain", "supply-chain / cooldown"] as const;

interface SettingChange {
  readonly step: string;
  readonly method: "PUT" | "POST" | "DELETE";
  readonly path: string;
  readonly body?: unknown;
  readonly description: string;
}

/** Add a dedicated ruleset; leave every existing protection and unrelated ruleset intact. */
async function requiredChecks(api: GitHubApi, root: string, isPrivate: boolean): Promise<SettingChange | SetupResult | undefined> {
  const rules = await api.request("GET", `${root}/rulesets?per_page=100&page=1`);
  if (isPrivate && [403, 404].includes(rules.status)) return result("gate", "required-checks", "needs-confirmation", "gate running, not enforced", {
    reason: `GitHub refused ruleset access (HTTP ${rules.status}); required checks are unavailable under the current plan or policy`,
  });
  if (rules.status !== 200 || !Array.isArray(rules.body)) throw new GitHubHttpError(rules.status);
  const allRules = [...rules.body];
  let pageSize = rules.body.length;
  for (let page = 2; pageSize === 100; page++) {
    if (page > 100) throw new Error("Too many rulesets; refusing incomplete evidence");
    const next = await required(api, "GET", `${root}/rulesets?per_page=100&page=${page}`);
    if (!Array.isArray(next)) throw new GitHubHttpError(rules.status);
    allRules.push(...next);
    pageSize = next.length;
  }
  const app = await api.request("GET", "apps/github-actions");
  if (app.status !== 200 || object(app.body)["slug"] !== "github-actions" || !Number.isSafeInteger(object(app.body)["id"])) {
    return result("gate", "required-checks", "needs-confirmation", "Cannot identify the GitHub Actions app; an admin must bind required checks to it");
  }
  const id = object(app.body)["id"];
  const candidates = allRules.map(object).filter((rule) => rule["name"] === "leanish-gate" && rule["source_type"] === "Repository");
  if (candidates.length > 1) throw new Error("Multiple setup gate rulesets need an admin's review");
  const existing = candidates[0];
  if (existing !== undefined) {
    const saved = object(await required(api, "GET", `${root}/rulesets/${existing["id"]}`));
    const entries = saved["rules"];
    if (!Array.isArray(entries) || entries.length !== 1 || object(entries[0])["type"] !== "required_status_checks") throw new Error("Setup ruleset was customized; ask an admin to add required checks without replacing it");
    const parameters = object(object(entries[0])["parameters"]);
    const checks = parameters["required_status_checks"];
    const refs = object(object(saved["conditions"])["ref_name"]);
    const include = refs["include"];
    const exclude = refs["exclude"];
    const bypasses = saved["bypass_actors"];
    const defaultBranchOnly = Array.isArray(include) && include.length === 1 && include[0] === "~DEFAULT_BRANCH" && Array.isArray(exclude) && exclude.length === 0;
    if (saved["target"] === "branch" && saved["enforcement"] === "active" && defaultBranchOnly && Array.isArray(bypasses) && bypasses.length === 0
      && Array.isArray(checks) && REQUIRED_CHECKS.every((name) => checks.some((check) => object(check)["context"] === name && object(check)["integration_id"] === id))) return undefined;
    // Avoid rewriting customized rules, bypasses or conditions. A ready admin request is safer than a lossy PUT.
    return result("gate", "required-checks", "needs-confirmation", "Existing setup ruleset needs an admin to reconcile its checks, enforcement, and GitHub Actions source", { checks: REQUIRED_CHECKS });
  }
  return { step: "required-checks", method: "POST", path: `${root}/rulesets`, description: "Require both gate checks from GitHub Actions on the default branch", body: {
    name: "leanish-gate", target: "branch", enforcement: "active", bypass_actors: [], conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules: [{ type: "required_status_checks", parameters: { strict_required_status_checks_policy: false, required_status_checks: REQUIRED_CHECKS.map((context) => ({ context, integration_id: id })) } }],
  } };
}

export async function gateSettings(
  api: GitHubApi, repo: string, admin: boolean, isPrivate: boolean, patterns: ReadonlyArray<string>, confirm: boolean,
  emit: (entry: SetupResult) => void = () => {},
): Promise<ReadonlyArray<SetupResult>> {
  const root = `repos/${repo}`;
  const results: SetupResult[] = [];
  const publish = (entry: SetupResult) => { results.push(entry); emit(entry); };
  if (!admin) {
    publish(result("gate", "admin-request", "needs-confirmation", "An admin must enable the remaining gate settings", {
      request: `Please enable Actions and allow ${patterns.join(", ")}; enable dependency graph and Dependabot alerts; disable Dependabot security and version update PRs; require ${REQUIRED_CHECKS.join(" and ")} from GitHub Actions on the default branch. Merge the adoption PR only when asked.`,
      settingsUrl: `https://github.com/${repo}/settings`,
    }));
    return results;
  }
  let httpStatus: number | undefined;
  const observed: GitHubApi = { async request(method, path, body) {
    httpStatus = undefined;
    const response = await api.request(method, path, body);
    httpStatus = response.status;
    return response;
  } };
  const step = async (name: string, work: () => Promise<void>) => {
    httpStatus = undefined;
    try { await work(); } catch {
      publish(result("gate", name, "blocked", `Could not inspect or apply ${name}; retry this setting`, { httpStatus: httpStatus ?? null }));
    }
  };
  const apply = async (change: SettingChange) => {
    if (!confirm) {
      publish(result("gate", change.step, "needs-confirmation", change.description, { method: change.method, endpoint: change.path, proposed: change.body }));
      return;
    }
    const response = await observed.request(change.method, change.path, change.body);
    if (isPrivate && change.step === "required-checks" && [403, 404, 422].includes(response.status)) {
      publish(result("gate", change.step, "needs-confirmation", "gate running, not enforced", { httpStatus: response.status, reason: `GitHub refused required checks (HTTP ${response.status}); ask an admin about plan/policy support` }));
      return;
    }
    if (response.status < 200 || response.status >= 300) throw new GitHubHttpError(response.status);
    publish(result("gate", change.step, "changed", change.description, { httpStatus: response.status }));
  };
  let actions: Record<string, unknown> | undefined;
  await step("actions", async () => {
    const found = object(await required(observed, "GET", `${root}/actions/permissions`));
    if (found["enabled"] !== true || found["allowed_actions"] === "local_only") await apply({ step: "actions", method: "PUT", path: `${root}/actions/permissions`, body: { enabled: true, allowed_actions: found["allowed_actions"] === "all" ? "all" : "selected" }, description: "Enable GitHub Actions with an explicit policy that permits the gate" });
    actions = found;
  });
  await step("actions-allowlist", async () => {
    if (actions === undefined) throw new Error("Actions policy unavailable");
    if (actions["allowed_actions"] === "all") return;
    const selected = actions["allowed_actions"] === "selected" ? object(await required(observed, "GET", `${root}/actions/permissions/selected-actions`)) : { github_owned_allowed: false, verified_allowed: false, patterns_allowed: [] };
    const existing = selected["patterns_allowed"];
    if (!Array.isArray(existing) || existing.some((entry) => typeof entry !== "string")) throw new Error("Actions allowlist is unreadable");
    const missing = patterns.filter((pattern) => !existing.includes(pattern) && !(selected["github_owned_allowed"] === true && pattern.startsWith("actions/")));
    if (missing.length > 0) await apply({ step: "actions-allowlist", method: "PUT", path: `${root}/actions/permissions/selected-actions`, body: {
      github_owned_allowed: selected["github_owned_allowed"] === true, verified_allowed: selected["verified_allowed"] === true,
      patterns_allowed: [...new Set([...existing, ...missing])],
    }, description: "Add the release's pinned workflow/actions, preserving other allowed actions" });
  });
  await step("dependency-alerts", async () => {
    const alerts = await observed.request("GET", `${root}/vulnerability-alerts`);
    if (alerts.status === 404) await apply({ step: "dependency-alerts", method: "PUT", path: `${root}/vulnerability-alerts`, description: "Enable dependency graph and Dependabot alerts" });
    else if (alerts.status !== 204) throw new GitHubHttpError(alerts.status);
  });
  await step("dependabot-security-prs", async () => {
    const security = object(await required(observed, "GET", `${root}/automated-security-fixes`));
    if (security["enabled"] === true) await apply({ step: "dependabot-security-prs", method: "DELETE", path: `${root}/automated-security-fixes`, description: "Disable Dependabot security update PRs, keeping alerts enabled" });
    else if (security["enabled"] !== false) throw new Error("Cannot inspect Dependabot security updates");
  });
  await step("required-checks", async () => {
    const checks = await requiredChecks(observed, root, isPrivate);
    if (checks !== undefined) {
      if ("status" in checks) publish(checks);
      else await apply(checks);
    }
  });
  if (results.length === 0) publish(result("gate", "settings", "already-done", "Gate settings already enabled"));
  return results;
}
