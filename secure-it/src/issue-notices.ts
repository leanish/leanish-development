/** Issue comments identified by a notice marker, posted once even when GitHub's comment listing lags. */
import type { GitHubIssues } from "@leanish/tool-runtime/github-issues";

import { noticeMarker } from "./issue-text.ts";

/** The notices each client (one per run) has posted, so a listing that lags its own comment never posts one twice. */
const POSTED = new WeakMap<GitHubIssues, Set<string>>();

/** Comments `text` on issue `number` unless a comment already carries notice `id`: each notice is posted once. */
export async function postNotice(client: { readonly issues: GitHubIssues; readonly repo: string; readonly clean: (body: string) => string }, number: number, id: string, text: string): Promise<void> {
  const posted = POSTED.get(client.issues) ?? new Set<string>();
  POSTED.set(client.issues, posted);
  const key = `${client.repo}#${number}:${id}`;
  if (posted.has(key)) return;
  const marker = noticeMarker(id);
  const comments = await client.issues.listComments({ repo: client.repo, number });
  if (!comments.some((comment) => comment.body.includes(marker))) {
    await client.issues.createComment({ repo: client.repo, number, body: `${client.clean(text)}\n\n${marker}` });
  }
  posted.add(key);
}
