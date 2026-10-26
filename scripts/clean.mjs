// Removes what the workspace tooling generates (Vitest's caches, coverage reports) from the root and each workspace.
// Sources, manifests, lockfiles and local configuration stay. `--deps` also removes node_modules, which
// `npm ci --ignore-scripts` restores. Uses Node's standard library only, so it runs without installed dependencies.
import { existsSync, globSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const GENERATED = ["coverage", join("node_modules", ".vite"), join("node_modules", ".vite-temp")];

export function cleanTargets(root, { deps = false } = {}) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const workspaces = (manifest.workspaces ?? [])
    .flatMap((pattern) => globSync(pattern, { cwd: root }))
    .map((directory) => resolve(root, directory))
    .filter((directory) => existsSync(join(directory, "package.json")));
  const realRoot = realpathSync(root);
  const outside = workspaces.filter((directory) => !within(realRoot, realpathSync(directory)));
  if (outside.length > 0) throw new Error(`workspaces outside ${realRoot}: ${outside.join(", ")}`);
  const names = deps ? ["coverage", "node_modules"] : GENERATED;
  return [resolve(root), ...workspaces].flatMap((directory) => names.map((name) => join(directory, name)));
}

export function clean(root, options) {
  const realRoot = realpathSync(root);
  const removed = cleanTargets(root, options).filter((target) => existsSync(target));
  // A linked node_modules would take the removal of its .vite elsewhere, so every target's real parent must be inside too.
  const outside = removed.filter((target) => !within(realRoot, realpathSync(dirname(target))));
  if (outside.length > 0) throw new Error(`targets outside ${realRoot}: ${outside.join(", ")}`);
  for (const target of removed) rmSync(target, { recursive: true, force: true });
  return removed;
}

const within = (root, path) => path === root || path.startsWith(`${root}${sep}`);

// Compared by real path, so running the script through a symbolic link still runs it.
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== "--deps");
  if (unknown.length > 0) {
    console.error(`usage: node scripts/clean.mjs [--deps] (unknown: ${unknown.join(" ")})`);
    process.exit(2);
  }
  const root = fileURLToPath(new URL("..", import.meta.url));
  const removed = clean(root, { deps: args.includes("--deps") });
  console.log(removed.length === 0 ? "nothing to clean" : removed.map((target) => `removed ${target}`).join("\n"));
}
