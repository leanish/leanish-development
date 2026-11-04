/** A planning error's first line for a public issue, without URL credentials, queries or recognizable tokens. */
export function planningCause(message: string): string {
  return message.split(/[\r\n\u2028\u2029]/, 1)[0]!
    .replace(/https?:\/\/[^\s<>"'`]+/gi, publicUrl)
    .replace(/\bAuthorization[ \t]*:.*/gi, "Authorization: [redacted]")
    .replace(/\bBearer[ \t]+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\b(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|npm_)[A-Za-z0-9_-]+/gi, "[redacted]");
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
