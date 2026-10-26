import { fileURLToPath } from "node:url";

/** Absolute path of the `gh`/`git` guards; `guard/` is a sibling of both src (in this repository) and dist (installed). */
export function guardDir(): string {
  return fileURLToPath(new URL("../guard", import.meta.url));
}
