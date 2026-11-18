import type { Ecosystem } from "./versions.ts";

export interface PackageName {
  readonly ecosystem: Ecosystem;
  /** npm: the package name; Maven: `group:artifact`; Actions: `owner/repo[/path]`. */
  readonly name: string;
}

export interface PackageVersion extends PackageName {
  readonly version: string;
}

/** The repository that supplies an action's tags, releases and repository advisories. */
export function actionRepository(name: string): string {
  return name.split("/", 2).join("/");
}

/** GitHub repository names ignore case; paths in a repository keep it. */
export function normalizeActionName(name: string): string {
  const repo = actionRepository(name);
  return repo.toLowerCase() + name.slice(repo.length);
}

/** The names an advisory can use for this action: the whole repository and the exact action. */
export function actionAdvisoryNames(name: string): ReadonlyArray<string> {
  const action = normalizeActionName(name);
  const repo = actionRepository(action);
  return repo === action ? [repo] : [repo, action];
}

/** Matches a full package name, including the repository-wide form for GitHub Actions. */
export function matchesPackageName(name: string, pkg: PackageName): boolean {
  return pkg.ecosystem === "GitHub Actions"
    ? actionAdvisoryNames(pkg.name).includes(normalizeActionName(name))
    : name === pkg.name;
}

/** `npm|@scope/name`: identifies a package across versions. */
export function packageKey(pkg: PackageName): string {
  return `${pkg.ecosystem}|${pkg.name}`;
}

/** `npm|@scope/name|1.0.0`: identifies one version. */
export function versionKey(pkg: PackageVersion): string {
  return `${pkg.ecosystem}|${pkg.name}|${pkg.version}`;
}

export function label(pkg: PackageVersion): string {
  return `${pkg.name}@${pkg.version}`;
}

export function uniqueVersions<T extends PackageVersion>(packages: Iterable<T>): T[] {
  const unique = new Map<string, T>();
  for (const pkg of packages) if (!unique.has(versionKey(pkg))) unique.set(versionKey(pkg), pkg);
  return [...unique.values()];
}
