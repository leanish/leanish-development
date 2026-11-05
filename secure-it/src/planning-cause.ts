/**
 * A name that says its value is a secret, then its value: quoted (spaces included, up to the closing quote or the line's
 * end) or up to whitespace, a comma or a semicolon. The lookbehind starts it only at a name's beginning, so a long line
 * stays linear; `auth` followed by a letter is an ordinary word (`author`), and `authToken` matches through `token`.
 */
const SENSITIVE_ASSIGNMENT = /(?<![\w.-])(?=[\w.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|credential|private[_-]?key|access[_-]?key|auth(?![a-z])))([\w.-]+)(["'`]?[ \t]*[:=][ \t]*)(?:"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?|[^\s,;]+)/gi;

/**
 * A planning error's first line for a public issue, without URL credentials, queries, sensitive assignments or
 * recognizable tokens. Never empty, so a sentence built around it reads whole; a later line is never used instead, since
 * only the first is known not to be a file excerpt.
 */
export function planningCause(message: string): string {
  const cause = message.split(/[\r\n\u2028\u2029]/, 1)[0]!
    .replace(/https?:\/\/[^\s<>"'`]+/gi, publicUrl)
    .replace(/\bAuthorization[ \t]*:.*/gi, "Authorization: [redacted]")
    .replace(/\bBearer[ \t]+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(SENSITIVE_ASSIGNMENT, "$1$2[redacted]")
    .replace(/\b(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|npm_)[A-Za-z0-9_-]+/gi, "[redacted]")
    .trim();
  return cause === "" ? "the error gave no details" : cause;
}

function publicUrl(address: string): string {
  try {
    const url = new URL(address);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "[redacted URL]";
  }
}
