/** Issue comments identified by a notice marker, posted once even when GitHub's comment listing lags. */
import type { GitHubIssues } from "@leanish/tool-runtime/github-issues";

import { issueWrite } from "./issue-access.ts";
import { noticeMarker } from "./issue-text.ts";

/** The notices each client (one per run) has posted, so a listing that lags its own comment never posts one twice. */
const POSTED = new WeakMap<GitHubIssues, Set<string>>();

/**
 * Comments `text` on issue `number` unless a comment of the token's login already carries notice `id`: each notice is
 * posted once. A marker in anyone else's comment is no notice of the tool's, so it never keeps one from being posted.
 */
export async function postNotice(client: { readonly issues: GitHubIssues; readonly repo: string; readonly clean: (body: string) => string }, number: number, id: string, text: string): Promise<void> {
  const posted = POSTED.get(client.issues) ?? new Set<string>();
  POSTED.set(client.issues, posted);
  const key = `${client.repo}#${number}:${id}`;
  if (posted.has(key)) return;
  const marker = noticeMarker(id);
  const marked = (await client.issues.listComments({ repo: client.repo, number })).filter((comment) => comment.body.includes(marker));
  // The login is read only when some comment carries the marker: a notice nobody posted yet costs no extra request.
  const login = marked.length === 0 ? undefined : await client.issues.login();
  if (!marked.some((comment) => comment.author === login)) {
    await issueWrite(() => client.issues.createComment({ repo: client.repo, number, body: `${client.clean(text)}\n\n${marker}` }));
  }
  posted.add(key);
}
