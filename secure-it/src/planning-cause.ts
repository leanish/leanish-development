/**
 * A word containing a name that looks secret. It errs toward redacting: `max_tokens=4096` and a package name followed by
 * a colon (`@fastify/cookie: no version`) lose what comes next. `auth` followed by another letter is an ordinary word
 * (`author`). The lookbehind starts a match only at a word's beginning, so a long line stays linear.
 */
const SECRET_NAME = /(?<![\w.-])(?=[\w.-]*(?:pass(?:word|wd|phrase)|pwd|secret|token|api[_-]?key|credential|private[_-]?key|access[_-]?key|session|cookie|jwt|auth(?:orization|key)?(?![a-z])))([\w.-]+)/;

/**
 * An equals sign, or a colon before a space or a quote or after a closing quote or bracket: Gradle coordinates
 * (`com.password4j:password4j:1.7`) must stay whole, so `token:abc` isn't an assignment.
 */
const ASSIGNS = /(["'`\]]{0,2}\s*(?:=|:(?=[\s"'`])|(?<=["'`\]]):)\s*)/;

/**
 * Up to whitespace, or from a quote to its closing one and on to whitespace (spaces inside the quotes included, up to the
 * line's end when there's no closing one), leaving out a final comma or semicolon. What it can't tell stays: an unquoted
 * value's words after the first space.
 */
const ASSIGNED_VALUE = /(?:"(?:[^"\\]|\\.)*(?:"(?:\S*[^\s,;])?)?|'(?:[^'\\]|\\.)*(?:'(?:\S*[^\s,;])?)?|`(?:[^`\\]|\\.)*(?:`(?:\S*[^\s,;])?)?|(?!["'`])\S*[^\s,;])/;

const SENSITIVE_ASSIGNMENT = new RegExp(`${SECRET_NAME.source}${ASSIGNS.source}${ASSIGNED_VALUE.source}`, "gi");

/**
 * A URL's user and password, in a scheme `publicUrl` doesn't read (`postgres://user:password@host/db`): up to the
 * authority's last `@`, since a password can contain one.
 */
const URL_USERINFO = /\/\/[^\s/?#]+@/g;

/**
 * A planning error's first line for a public issue, with URL credentials, queries, sensitive assignments and recognizable
 * tokens redacted on a best-effort basis. Never empty, so a sentence built around it reads whole; a later line is never
 * used instead, since only the first is known not to be a file excerpt.
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
