/**
 * Text from elsewhere (advisory ids, package names, versions, lookup errors) shown in a PR, as a literal code span:
 * GitHub renders none of it as Markdown, links or mentions, and paths in it are still cleaned at publication.
 */

/**
 * `text` as a code span: whitespace collapsed, fenced by one more backtick than its longest backtick run (padded when an
 * end is a backtick), `<!--` broken so it can't open a comment or a marker, and in a table cell `|` escaped (GFM splits
 * cells on it even in a code span). Empty text stays empty.
 */
export function literal(text: string, options: { readonly table?: boolean } = {}): string {
  let inner = text.replace(/\s+/g, " ").trim().replaceAll("<!--", "< !--");
  if (inner === "") return "";
  if (options.table === true) inner = inner.replaceAll("|", "\\|");
  let longest = 0;
  for (const run of inner.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  const fence = "`".repeat(longest + 1);
  const pad = inner.startsWith("`") || inner.endsWith("`") ? " " : "";
  return `${fence}${pad}${inner}${pad}${fence}`;
}
