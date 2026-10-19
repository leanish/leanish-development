import { parseToolConfig, type ToolRepo } from "@leanish/tool-runtime/config";

import type { SetupResult } from "./contracts.ts";
import { isCandidateTag } from "./github-release.ts";
import { object, required, string, type GitHubApi } from "./github.ts";

/**
 * The owner's fixture repositories, `leanish-development[_<tool>]_TEST_<case>` (the tool segment for a case designed
 * for one tool): what fixture-cleanup and fixture-repin may write to, and nothing else.
 */
const FIXTURE = /^[A-Za-z0-9-]+\/leanish-development(?:_(?:bump-it|secure-it))?_TEST_[A-Za-z0-9_.-]+$/;

/**
 * A release candidate is installed only to accept it before its release, so it may only touch fixture repositories:
 * never adopt a real repository's gate, run its tools there, or schedule them for an installation that has any.
 */
export function requireFixturesForCandidate(release: string, repos: ReadonlyArray<string>): void {
  if (!isCandidateTag(release)) return;
  if (repos.length === 0 || repos.some((repo) => !FIXTURE.test(repo))) {
    throw new Error(`${release} is a release candidate; it runs only on leanish-development[_<tool>]_TEST_* fixture repositories`);
  }
}

/**
 * The repository GitHub answers for a configured fixture. A renamed or transferred repository answers under its old
 * name through a redirect, so its canonical name must still be this fixture before anything is written to it.
 */
export async function fixtureRepository(api: GitHubApi, repo: string): Promise<Record<string, unknown>> {
  const metadata = object(await required(api, "GET", `repos/${repo}`));
  const canonical = string(metadata["full_name"]);
  if (canonical.toLowerCase() !== repo.toLowerCase()) throw new Error(`GitHub answers ${repo} as ${canonical} (renamed or transferred); update the fixture configs`);
  return metadata;
}

export interface FixtureScopeOptions {
  readonly bumpItConfig: string;
  readonly secureItConfig: string;
  /** One listed fixture to restrict a run to; undefined: all of them. */
  readonly repo: string | undefined;
}

export class RateLimited extends Error {
  /** Already published on the row it stopped, so the caller doesn't report it twice. */
  reported = false;
}

/** Evidence GitHub didn't return completely or readably; nothing is written on it. */
export class IncompleteEvidence extends Error {}

/** Both tools' fixture configs, which must list the same repositories and branches, all of them fixtures. */
export async function fixtureScope(options: FixtureScopeOptions, read: (path: string) => Promise<string>, home: string): Promise<ReadonlyArray<ToolRepo>> {
  const bumpIt = parseToolConfig("bump-it", await read(options.bumpItConfig), options.bumpItConfig, home).repos;
  const secureIt = parseToolConfig("secure-it", await read(options.secureItConfig), options.secureItConfig, home).repos;
  const key = (repos: ReadonlyArray<ToolRepo>) => repos.map((entry) => `${entry.repo.toLowerCase()} ${entry.branch ?? ""}`).sort().join("\n");
  if (key(bumpIt) !== key(secureIt)) throw new Error("The bump-it and secure-it fixture configs must list the same repositories and branches");
  const outside = bumpIt.find((entry) => !FIXTURE.test(entry.repo));
  if (outside !== undefined) throw new Error(`${outside.repo} isn't a leanish-development[_<tool>]_TEST_* fixture repository; refusing to touch it`);
  if (options.repo === undefined) return bumpIt;
  const selected = bumpIt.filter((entry) => entry.repo.toLowerCase() === options.repo!.toLowerCase());
  if (selected.length === 0) throw new Error("--repo must be one of the fixture configs' repositories");
  return selected;
}

/** Turns GitHub's REST rate-limit replies into RateLimited, so a run stops instead of failing every remaining call. */
export function rateLimitAware(api: GitHubApi): GitHubApi {
  return { async request(method, path, body) {
    const reply = await api.request(method, path, body);
    const headers = reply.headers ?? {};
    if ((reply.status === 403 || reply.status === 429) && (headers["x-ratelimit-remaining"] === "0" || headers["retry-after"] !== undefined)) {
      const reset = headers["x-ratelimit-reset"];
      const when = reset !== undefined && /^\d+$/.test(reset) ? `resets at ${new Date(Number(reset) * 1000).toISOString()}` : `retry after ${headers["retry-after"] ?? "?"}s`;
      throw new RateLimited(`GitHub's rate limit was reached (${when}); rerun then`);
    }
    return reply;
  } };
}

export function reasonOf(error: unknown): string {
  if (error instanceof RateLimited) return "rate-limited";
  if (error instanceof IncompleteEvidence) return "incomplete-evidence";
  return "failed";
}

/** Runs `each` per fixture; a failure blocks that fixture only, and a rate limit stops the rest, which are listed. */
export async function perFixture(
  fixtures: ReadonlyArray<ToolRepo>, publish: (entry: SetupResult) => void,
  each: (fixture: ToolRepo) => Promise<void>, blocked: (repo: string, error: unknown) => SetupResult,
): Promise<ReadonlyArray<string>> {
  for (const [index, fixture] of fixtures.entries()) {
    try {
      await each(fixture);
    } catch (error) {
      if (!(error instanceof RateLimited && error.reported)) publish(blocked(fixture.repo, error));
      if (error instanceof RateLimited) return fixtures.slice(index + 1).map((entry) => entry.repo);
    }
  }
  return [];
}
