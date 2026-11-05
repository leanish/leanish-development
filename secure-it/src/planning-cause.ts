/**
 * A name that looks secret, then its value: any quoted part (spaces included, up to the closing quote or the line's end)
 * and whatever follows it up to whitespace, leaving out a final comma or semicolon. It errs toward redacting: a word that
 * only contains a name (`max_tokens=4096`) loses its value, and an unquoted value's words after the first space stay.
 *
 * A colon counts only before a space or a quote, or after a closing quote or bracket: Gradle coordinates
 * (`com.password4j:password4j:1.7`) must stay whole, so `token:abc` isn't an assignment. `auth` followed by another letter
 * is an ordinary word (`author`). The lookbehind starts a match only at a name's beginning, so a long line stays linear.
 */
const SENSITIVE_ASSIGNMENT = /(?<![\w.-])(?=[\w.-]*(?:pass(?:word|wd|phrase)|pwd|secret|token|api[_-]?key|credential|private[_-]?key|access[_-]?key|session|cookie|jwt|auth(?:orization|key)?(?![a-z])))([\w.-]+)(["'`\]]{0,2}\s*(?:=|:(?=[\s"'`])|(?<=["'`\]]):)\s*)(?=\S)(?:"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)?(?:\S*[^\s,;])?/gi;

/** A URL's user and password, in a scheme `publicUrl` doesn't read (`postgres://user:password@host/db`). */
const URL_USERINFO = /\/\/[^\s/@]+@/g;

/**
 * A planning error's first line for a public issue, without URL credentials, queries, sensitive assignments or
 * recognizable tokens. Never empty, so a sentence built around it reads whole; a later line is never used instead, since
 * only the first is known not to be a file excerpt.
 */
export function planningCause(message: string): string {
  const cause = message.split(/[\r\n\u2028\u2029]/, 1)[0]!
    .replace(/https?:\/\/[^\s<>"'`]+/gi, publicUrl)
    .replace(URL_USERINFO, "//")
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
