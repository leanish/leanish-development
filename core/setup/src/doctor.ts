import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { gte, valid } from "semver";

import { CODING_AGENTS, type CodingAgent } from "@leanish/tool-runtime/config";

import { Commands } from "./commands.ts";
import { result, type SetupResult } from "./contracts.ts";

export interface DoctorOptions {
  readonly agent?: CodingAgent;
  readonly java?: number;
}

export interface DoctorMachine {
  readonly commands: Commands;
  readonly platform: string;
  readonly arch: string;
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
  readonly exists: (path: string, kind: "file" | "directory") => Promise<boolean>;
  readonly listDirectory: (path: string) => Promise<ReadonlyArray<string>>;
}

export function doctorMachine(): DoctorMachine {
  return { commands: new Commands(), platform: process.platform, arch: process.arch, home: homedir(), env: process.env,
    exists: async (path, kind) => {
      try {
        const entry = await stat(path);
        return kind === "file" ? entry.isFile() : entry.isDirectory();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    },
    listDirectory: async (path) => {
      try { return await readdir(path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    } };
}

interface VersionCheck {
  readonly version: string | undefined;
  readonly usable: boolean;
}

async function versionAtLeast(commands: Commands, binary: string, minimum: string): Promise<VersionCheck> {
  const execution = await commands.probe(binary, ["--version"]);
  const detected = execution.stdout.match(/(?:^|\s)v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/)?.[1];
  const version = execution.code === 0 && detected !== undefined && valid(detected) !== null ? detected : undefined;
  return { version, usable: version !== undefined && gte(version, minimum) };
}

interface AgentAvailability {
  readonly agent: CodingAgent;
  readonly desktop: boolean;
  readonly appPath: string | undefined;
  readonly cli: boolean;
  readonly version: string | undefined;
  readonly login: boolean;
}

const DESKTOP_BUNDLES = new Map<string, CodingAgent>([
  ["com.openai.codex", "codex"], ["com.anthropic.claudefordesktop", "claude-code"],
]);

async function desktopApps(machine: DoctorMachine): Promise<ReadonlyMap<CodingAgent, string>> {
  const found = new Map<CodingAgent, string>();
  for (const directory of ["/Applications", join(machine.home, "Applications")]) {
    const names = (await machine.listDirectory(directory)).filter((name) => name.endsWith(".app")).sort();
    for (const name of names) {
      const appPath = join(directory, name);
      if (!await machine.exists(appPath, "directory")) continue;
      const execution = await machine.commands.probe("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", join(appPath, "Contents", "Info.plist")]);
      if (execution.code !== 0) continue;
      const agent = DESKTOP_BUNDLES.get(execution.stdout.trim());
      // Prefer system installs; choose consistently when multiple names identify the same app.
      if (agent !== undefined && !found.has(agent)) found.set(agent, appPath);
    }
  }
  return found;
}

async function agentAvailability(machine: DoctorMachine, agent: CodingAgent, codexVersion: VersionCheck, appPath: string | undefined): Promise<AgentAvailability> {
  const detected = agent === "codex" ? codexVersion : await versionAtLeast(machine.commands, "claude", "2.1.259");
  const cli = detected.usable;
  let login = false;
  if (agent === "codex" && cli) {
    const file = join(machine.env["CODEX_HOME"] ?? join(machine.home, ".codex"), "auth.json");
    if (await machine.exists(file, "file")) login = (await machine.commands.probe("codex", ["login", "status"])).code === 0;
  }
  if (agent === "claude-code" && cli && machine.env["CLAUDE_CONFIG_DIR"] === undefined) {
    const execution = await machine.commands.probe("claude", ["auth", "status", "--json"]);
    try {
      login = execution.code === 0 && JSON.parse(execution.stdout)?.loggedIn === true;
    } catch { /* Unreadable authentication status cannot establish a usable login. */ }
  }
  return { agent, desktop: appPath !== undefined, appPath, cli, version: detected.version, login };
}

function selectAgent(agents: ReadonlyArray<AgentAvailability>, requested: CodingAgent | undefined): SetupResult {
  const usable = agents.filter(({ desktop, cli, login }) => desktop && cli && login).map(({ agent }) => agent);
  const selected = requested ?? (usable.length === 1 ? usable[0] : undefined);
  const found = agents.find(({ agent }) => agent === selected);
  if (found !== undefined && usable.includes(found.agent)) {
    return result("doctor", "agent", "already-done", `Use ${selected}`, { agent: selected, version: found.version, appPath: found.appPath, agents });
  }
  const choice = usable.length > 1 && requested === undefined;
  return result("doctor", "agent", choice ? "needs-confirmation" : "blocked", choice ? "Choose codex or claude-code, then rerun with --agent"
    : "An agent needs its desktop app and CLI login: Codex requires file-backed auth; Claude requires CLI >=2.1.259 and unset CLAUDE_CONFIG_DIR",
    { usable, agents });
}

async function checkJava(machine: DoctorMachine, major: number): Promise<SetupResult> {
  const javaHome = machine.env["JAVA_HOME"];
  let java = "java";
  let javac = "javac";
  if (javaHome !== undefined && javaHome !== "" && await machine.exists(join(javaHome, "bin", "java"), "file") && await machine.exists(join(javaHome, "bin", "javac"), "file")) {
    java = join(javaHome, "bin", "java");
    javac = join(javaHome, "bin", "javac");
  }
  const execution = await machine.commands.probe(java, ["-version"]);
  const version = /version "([0-9][0-9A-Za-z._+-]*)"/.exec(`${execution.stderr}\n${execution.stdout}`)?.[1];
  const compiler = await machine.commands.probe(javac, ["-version"]);
  const compilerVersion = /javac ([0-9][0-9A-Za-z._+-]*)/.exec(`${compiler.stdout}\n${compiler.stderr}`)?.[1];
  const detectedMajor = javaMajor(version);
  const compilerMajor = javaMajor(compilerVersion);
  const ok = execution.code === 0 && compiler.code === 0 && detectedMajor === major && compilerMajor === major;
  return result("doctor", "java", ok ? "already-done" : "blocked", `JDK ${major} (java and javac) required; JAVA_HOME takes precedence over PATH`,
    { version, compilerVersion, major: detectedMajor, compilerMajor, java, javac, source: java === "java" ? "PATH" : "JAVA_HOME" });
}

function javaMajor(version: string | undefined): number | undefined {
  const parts = version?.split(".");
  const component = parts?.[0] === "1" ? parts[1] : parts?.[0];
  const major = component === undefined ? NaN : Number.parseInt(component, 10);
  return Number.isSafeInteger(major) ? major : undefined;
}

/** Only checks prerequisites: no login, install, Keychain lookup, model invocation, or repository code execution. */
export async function doctor(options: DoctorOptions, machine: DoctorMachine = doctorMachine()): Promise<ReadonlyArray<SetupResult>> {
  if (options.agent !== undefined && !CODING_AGENTS.includes(options.agent)) throw new Error("agent must be codex or claude-code");
  if (options.java !== undefined && (!Number.isSafeInteger(options.java) || options.java < 8)) throw new Error("java must be a JDK major version, at least 8");
  const results: SetupResult[] = [];
  const check = (step: string, ok: boolean, message: string, data: SetupResult["data"]) => results.push(result("doctor", step, ok ? "already-done" : "blocked", message, data));
  const supported = machine.platform === "darwin" && machine.arch === "arm64";
  check("platform", supported, supported ? "Apple Silicon macOS" : "Local tools require Apple Silicon macOS", { platform: machine.platform, arch: machine.arch });
  if (!supported) return results;

  for (const [binary, minimum, message] of [
    ["node", "24.0.0", "Node >=24 required; install or upgrade Node if blocked"],
    ["npm", "11.17.0", "npm >=11.17 required for release-age exclusions"],
    ["git", "2.42.0", "git >=2.42 required for conflict review"],
  ] as const) {
    const found = await versionAtLeast(machine.commands, binary, minimum);
    check(binary, found.usable, message, { version: found.version });
  }
  check("lockf", await machine.exists("/usr/bin/lockf", "file"), "macOS lockf required for repository locks", { path: "/usr/bin/lockf" });
  check("keychain", await machine.exists("/usr/bin/security", "file"), "macOS security command required; no Keychain items read", { path: "/usr/bin/security" });
  const github = await machine.commands.probe("gh", ["auth", "status", "--active", "--hostname", "github.com"]);
  check("github", github.code === 0, "gh must be installed and authenticated to github.com; run gh auth login if blocked", { hostname: "github.com", authenticated: github.code === 0 });

  const codexVersion = await versionAtLeast(machine.commands, "codex", "0.159.0");
  check("codex-cli", codexVersion.usable, "Codex CLI >=0.159 required even with Claude Code; install or upgrade it if blocked", { version: codexVersion.version });
  let sandbox = false;
  if (codexVersion.usable) {
    const execution = await machine.commands.probe("codex", ["sandbox", "-c", 'default_permissions="setup-check"',
      "-c", 'permissions.setup-check.filesystem={":root"="read"}', "-c", "permissions.setup-check.network.enabled=false", "--", "/usr/bin/true"]);
    sandbox = execution.code === 0;
  }
  check("sandbox", sandbox, "Codex permission-profile sandbox must run; no login needed, no unsandboxed fallback", { version: codexVersion.version });

  if (options.java !== undefined) results.push(await checkJava(machine, options.java));
  const apps = await desktopApps(machine);
  const agents: AgentAvailability[] = [];
  for (const agent of CODING_AGENTS) agents.push(await agentAvailability(machine, agent, codexVersion, apps.get(agent)));
  return [...results, selectAgent(agents, options.agent)];
}
