/** How secure-it reads what GitHub answers about one of its issues: one that's gone, and a write it refuses. */
import { GitHubApiError } from "@leanish/agent-runtime/github/github-client";

/**
 * `access`'s result, or undefined when its issue is gone: transferred to a repository the token reads (301) or to one it
 * can't (404), or deleted (410). What that means is the caller's: execution defers, bookkeeping has nothing to write. Any
 * other failure (a rate limit, a server error, the network) goes through, so nothing is taken for gone unread.
 */
export async function unlessGone<T>(access: () => Promise<T>): Promise<T | undefined> {
  try {
    return await access();
  } catch (error) {
    if (error instanceof GitHubApiError && (error.status === 301 || error.status === 404 || error.status === 410)) return undefined;
    throw error;
  }
}

/** Runs a write, turning GitHub's plain refusal into what to check; a rate limit or anything else goes through as it is. */
export async function issueWrite<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 403 && error.reason === "forbidden") {
      throw new Error(`GitHub refused secure-it's issue write (${error.operation}): check that the write PAT has Issues: read and write (docs/adopting-tools.md)`);
    }
    // Only a create says it: listing a repository's issues with the feature off answers an empty list, so the first
    // create is where it shows, while a 410 on an issue that exists means that issue was deleted.
    if (error instanceof GitHubApiError && error.status === 410 && error.operation === "createIssue") {
      throw new Error(`GitHub refused secure-it's issue write (${error.operation}): Issues are disabled on this repository, and secure-it needs them enabled (docs/adopting-tools.md)`);
    }
    throw error;
  }
}
