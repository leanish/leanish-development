import { Commands } from "./commands.ts";

export const RELEASE_REPOSITORY = "leanish/leanish-development";
const SHA = /^[0-9a-f]{40}$/;
const STABLE_TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

export interface VerifiedRelease {
  readonly tag: string;
  readonly sha: string;
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("GitHub returned invalid release metadata");
  return value as Record<string, unknown>;
}

function json(text: string): unknown {
  try { return JSON.parse(text); } catch { throw new Error("GitHub returned invalid JSON"); }
}

/** Pagination is explicit; ignore rc tags even if a publisher forgot to set prerelease. */
export async function latestRelease(commands: Commands): Promise<VerifiedRelease> {
  const pages: unknown = json(await commands.checked("gh", ["api", "--hostname", "github.com", "--method", "GET", "--paginate", "--slurp",
    `repos/${RELEASE_REPOSITORY}/releases?per_page=100`], "Could not read GitHub releases; check gh login and network"));
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) throw new Error("GitHub returned invalid release pages");
  const releases = pages.flat().map(object).filter((entry) => {
    if (typeof entry["draft"] !== "boolean" || typeof entry["prerelease"] !== "boolean" || typeof entry["tag_name"] !== "string") {
      throw new Error("GitHub returned incomplete release metadata");
    }
    return entry["draft"] === false && entry["prerelease"] === false && STABLE_TAG.test(entry["tag_name"]);
  }).map((entry) => {
    const published = typeof entry["published_at"] === "string" ? Date.parse(entry["published_at"]) : NaN;
    if (!Number.isFinite(published)) throw new Error("GitHub returned an invalid release publication date");
    return { tag: entry["tag_name"] as string, immutable: entry["immutable"], published };
  }).sort((a, b) => b.published - a.published || b.tag.localeCompare(a.tag));
  const latest = releases[0];
  if (latest === undefined) throw new Error("No stable GitHub release is published");
  if (latest.immutable !== true) throw new Error("The newest stable release is not immutable; refusing an older fallback");

  let reference = object(json(await commands.checked("gh", ["api", "--hostname", "github.com", "--method", "GET",
    `repos/${RELEASE_REPOSITORY}/git/ref/tags/${latest.tag}`], "Could not resolve the release tag")));
  if (reference["ref"] !== `refs/tags/${latest.tag}`) throw new Error("GitHub returned a different release tag");
  const seen = new Set<string>();
  for (let depth = 0; depth < 10; depth++) {
    const target = object(reference["object"]);
    const sha = target["sha"];
    if (typeof sha !== "string" || !SHA.test(sha) || seen.has(sha)) throw new Error("Release tag has an invalid or cyclic target");
    if (target["type"] === "commit") return { tag: latest.tag, sha };
    if (target["type"] !== "tag") throw new Error("Release tag does not resolve to a commit");
    seen.add(sha);
    reference = object(json(await commands.checked("gh", ["api", "--hostname", "github.com", "--method", "GET",
      `repos/${RELEASE_REPOSITORY}/git/tags/${sha}`], "Could not peel the release tag")));
    if (reference["sha"] !== sha) throw new Error("GitHub returned a different annotated tag");
  }
  throw new Error("Release tag exceeds the annotation depth limit");
}
