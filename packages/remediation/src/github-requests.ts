/** Counts actual attempts, below retries and caches, without retaining URLs or credentials. */
export class GitHubRequests {
  readonly #byKind = new Map<string, number>();

  wrap(fetch: typeof globalThis.fetch): typeof globalThis.fetch {
    return (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.origin === "https://api.github.com") {
        const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
        const kind = `${method} ${requestPath(url.pathname)}`;
        this.#byKind.set(kind, (this.#byKind.get(kind) ?? 0) + 1);
      }
      return fetch(input, init);
    };
  }

  summary(): { readonly total: number; readonly byKind: Readonly<Record<string, number>> } {
    return {
      total: [...this.#byKind.values()].reduce((sum, count) => sum + count, 0),
      byKind: Object.fromEntries([...this.#byKind].sort(([a], [b]) => a.localeCompare(b))),
    };
  }
}

/** Drop repository names, ref names, SHAs and IDs; pagination belongs to the same kind. */
function requestPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (path === "/graphql") return path;
  if (parts[0] === "advisories") return parts.length === 1 ? "/advisories" : "/advisories/{id}";
  if (parts[0] !== "repos" || parts.length < 3) return "/other";
  const resource = parts.slice(3);
  const normalized = resource.map((part, index) => {
    if (/^\d+$/.test(part) || /^[a-f0-9]{40}$/i.test(part)) return "{id}";
    if (index > 0 && ["pulls", "issues", "commits", "statuses", "check-runs", "check-suites"].includes(resource[index - 1]!)) return "{id}";
    return part;
  });
  if (resource[0] === "git" && ["ref", "refs"].includes(resource[1] ?? "")) normalized.splice(3, normalized.length, "{ref}");
  if (resource[0] === "releases" && resource[1] === "tags") normalized.splice(2, normalized.length, "{tag}");
  return ["/repos/{owner}/{repo}", ...normalized].join("/");
}
