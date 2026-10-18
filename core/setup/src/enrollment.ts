import { KeychainStore, type SecretStore } from "@leanish/tool-runtime/secrets";

import { readInstallation, type InstallationOptions } from "./configuration.ts";
import { result, type SetupResult } from "./contracts.ts";
import { descriptor, ownerName, type PermissionLevel } from "./tools.ts";

/** The person runs these commands in their own Terminal. No password argument, shell expansion, or secret read. */
export async function enrollment(options: InstallationOptions & { readonly login: string }, home?: string): Promise<SetupResult> {
  const login = ownerName(options.login);
  const { config } = await readInstallation(options, home);
  const { descriptor: contribution } = await descriptor(options.tool);
  const commands = Object.entries(config.secrets).map(([role, service]) => ({ role,
    command: `security add-generic-password -U -s '${service}' -a '${login}' -w`,
  }));
  return result("enroll", "keychain", "needs-confirmation", "Create fine-grained PATs for only the opted-in repositories, obtain organization approval/SSO as needed, then run these prompts in your own Terminal; never paste tokens into chat", {
    repos: config.repos.map(({ repo }) => repo), permissions: contribution.permissions, commands,
  });
}

export interface PermissionResult {
  readonly role: "write" | "read";
  readonly repo: string;
  readonly permission: string;
  readonly required: PermissionLevel;
  readonly status: "pass" | "fail" | "unverified";
  readonly reason: string;
}

async function tokenRead(fetcher: typeof fetch, token: string, endpoint: string): Promise<Response | undefined> {
  try {
    return await fetcher(`https://api.github.com/${endpoint}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      redirect: "error", signal: AbortSignal.timeout(30_000),
    });
  } catch { return undefined; }
}

/** These reads prove private-repository read capabilities, never complete scopes or write/no-access permissions. */
export async function verifyTokens(
  options: InstallationOptions, home?: string,
  machine: { readonly secrets: SecretStore; readonly fetch: typeof fetch } = { secrets: new KeychainStore(), fetch },
): Promise<SetupResult> {
  const { config } = await readInstallation(options, home);
  const { descriptor: contribution } = await descriptor(options.tool);
  const invalidTokens = (step: string, message: string) => result("verify-tokens", step, "blocked", message, {
    permissions: (["write", "read"] as const).flatMap((role) => config.repos.flatMap(({ repo }) => contribution.permissions.map((permission): PermissionResult => ({
      role, repo, permission: permission.name, required: permission[role], status: "fail", reason: message,
    })))), unverified: [],
  });
  let write: string;
  let read: string;
  try {
    write = await machine.secrets.get(config.secrets.write);
    read = await machine.secrets.get(config.secrets.read);
  } catch { return invalidTokens("keychain", "Keychain lookup failed; unlock or enroll the configured items in your own Terminal"); }
  if (write === "" || read === "" || write === read) return invalidTokens("separation", "Write and read tokens must be nonempty and different");
  const permissions: PermissionResult[] = [];
  for (const role of ["write", "read"] as const) {
    const token = role === "write" ? write : read;
    const authentication = await tokenRead(machine.fetch, token, "user");
    for (const { repo } of config.repos) {
      const repository = await tokenRead(machine.fetch, token, `repos/${repo}`);
      let isPrivate = false;
      let branch: string | undefined;
      try {
        const body = await repository?.json() as { private?: unknown; default_branch?: unknown } | undefined;
        isPrivate = body?.private === true;
        if (typeof body?.default_branch === "string") branch = body.default_branch;
      } catch { /* Unknown visibility or branch cannot establish a permission. */ }
      const routes: Readonly<Record<string, string | undefined>> = {
        metadata: `repos/${repo}`, contents: `repos/${repo}/contents`, pull_requests: `repos/${repo}/pulls?per_page=1`,
        actions: `repos/${repo}/actions/runs?per_page=1`, statuses: branch === undefined ? undefined : `repos/${repo}/commits/${encodeURIComponent(branch)}/status`,
      };
      for (const permission of contribution.permissions) {
        const required = permission[role];
        let status: PermissionResult["status"] = "unverified";
        let reason = "Read-only probes cannot prove this grant or absence of extra access; the real test run covers unverified permissions";
        const route = routes[permission.name];
        if (required === "read") {
          const denied = (code: number | undefined) => code !== undefined && [401, 403, 404].includes(code);
          const probe = authentication?.status === 200 && isPrivate && repository?.status === 200 && route !== undefined
            ? permission.name === "metadata" ? repository : await tokenRead(machine.fetch, token, route) : undefined;
          if (denied(authentication?.status) || denied(repository?.status) || denied(probe?.status)) {
            status = "fail";
            reason = "A required authenticated read was denied";
          } else if (probe?.status === 200) {
            status = "pass";
            reason = "Private-repository read capability verified";
          }
        }
        permissions.push({ role, repo, permission: permission.name, required, status, reason });
      }
    }
  }
  const failed = permissions.some(({ status }) => status === "fail");
  return result("verify-tokens", "permissions", failed ? "blocked" : "already-done",
    failed ? "Required reads failed; fix token enrollment before the real test run" : "Read probes completed; the explicitly authorized real test run covers unverified permissions",
    { permissions, unverified: permissions.filter(({ status }) => status === "unverified") });
}
