/** How secure-it reads GitHub's refusal of a write to one of its issues. */
import { GitHubApiError } from "@leanish/agent-runtime/github/github-client";

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
