/** Read Java properties without interpreting an escaped URL or duplicate key differently from Gradle. */
export function wrapperProperties(text: string): ReadonlyMap<string, string> {
  const properties = new Map<string, string>();
  const lines = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  for (let index = 0; index < lines.length; index++) {
    let line = lines[index]!.trimStart();
    if (line === "" || /^[#!]/.test(line)) continue;
    while (continued(line)) {
      if (++index >= lines.length) throw new Error("unfinished wrapper property continuation");
      line = line.slice(0, -1) + lines[index]!.trimStart();
    }
    // The key, then the separator and value: as one regex ending in `(.*)$`, a value holding U+2028 or U+2029 made it
    // backtrack polynomially before failing.
    const rawKey = /^(?:\\.|[^\\=:\s])*/.exec(line)![0];
    const key = unescapeProperty(rawKey);
    if (properties.has(key)) throw new Error(`duplicate wrapper property ${key}`);
    properties.set(key, unescapeProperty(line.slice(rawKey.length).replace(/^\s*(?:[=:]\s*)?/, "")));
  }
  return properties;
}

function continued(line: string): boolean {
  // Starting only at the run's first backslash, a long run is scanned once instead of again from each backslash.
  return (/(?<!\\)(\\+)$/.exec(line)?.[1]?.length ?? 0) % 2 === 1;
}

function unescapeProperty(value: string): string {
  return value.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_match, escaped: string) => {
    if (escaped.startsWith("u")) {
      if (!/^u[0-9a-fA-F]{4}$/.test(escaped)) throw new Error("invalid wrapper property unicode escape");
      return String.fromCharCode(parseInt(escaped.slice(1), 16));
    }
    return ({ t: "\t", n: "\n", r: "\r", f: "\f" } as Record<string, string>)[escaped] ?? escaped;
  });
}
