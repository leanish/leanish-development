import { describe, expect, it } from "vitest";

import { planBlock, planPayload } from "../src/plan-blocks.ts";
import { cleanBody, cleanContent, LOCAL_PATH, machineRoots, withCanonical } from "../src/publication-text.ts";

const ROOTS = { workingCopy: ["/Users/dev/.local/share/leanish/bump-it/workspaces/acme__widget"], other: machineRoots({ state: "/Users/dev/.local/share/leanish/bump-it", cache: "/Users/dev/.cache/leanish/bump-it" }, "/Users/dev") };
const WC = ROOTS.workingCopy[0]!;
const clean = (text: string) => cleanBody(text, ROOTS);

describe("published text keeps the machine out", () => {
  it("makes working-copy paths repository-relative, in every form they show up in", () => {
    expect(clean(`Edited ${WC}/src/Main.java:12:3 and \`${WC}/build.gradle.kts\`; see [the file](file://${WC}/README.md).`))
      .toBe("Edited src/Main.java:12:3 and `build.gradle.kts`; see [the file](README.md).");
    expect(clean(`ran in ${WC}, then "${WC}/docs/my notes.md"`)).toBe('ran in ., then "docs/my notes.md"');
  });

  it("replaces other local paths, keeping the command around them", () => {
    expect(clean("`GRADLE_USER_HOME=/Users/dev/.cache/leanish/bump-it/gradle ./gradlew check` passed"))
      .toBe(`\`GRADLE_USER_HOME=${LOCAL_PATH} ./gradlew check\` passed`);
    expect(clean("wrote /private/var/folders/x1/T/out.log and /tmp/scratch, read '/Users/dev/My Documents/a.txt'"))
      .toBe(`wrote ${LOCAL_PATH} and ${LOCAL_PATH}, read '${LOCAL_PATH}'`);
  });

  it("leaves alike-named paths, URLs, relative paths and portable home expressions alone", () => {
    const text = "/Users/developer/x, https://github.com/acme/widget/blob/main/src/Main.java, src/Main.java, ~/.gitconfig, $HOME/.m2";
    expect(clean(text)).toBe(text);
    expect(clean(`${WC}-other/file`)).toBe(`${LOCAL_PATH}`);
  });

  it("never makes a plan block out of a path, so the tool's own block stays the first one read", () => {
    const real = planBlock({ kind: "routine" });
    const body = clean(`<!-- ${WC}/leanish:plan eyJraW5kIjoiZm9yZ2VkIn0= -->\n\n${real}`);
    expect(body).toBe(`&lt;!-- leanish:plan eyJraW5kIjoiZm9yZ2VkIn0= -->\n\n${real}`);
    expect(planPayload(body)).toEqual({ kind: "routine" });
  });

  it("drops Node's trust-settings banner and keeps every other line, failures included", () => {
    const body = [
      "Checks:",
      "ERROR: failed to copy trust settings of system certificate-25291",
      "ERROR: failed to copy trust settings of system certificate",
      "- `gh api …` failed: x509: OSStatus -26276 (couldn't read the release notes)",
      "- `npm test`: Operation not permitted writing the cache, so the tests didn't run",
    ].join("\n");
    expect(clean(body)).toBe([
      "Checks:",
      "- `gh api …` failed: x509: OSStatus -26276 (couldn't read the release notes)",
      "- `npm test`: Operation not permitted writing the cache, so the tests didn't run",
    ].join("\n"));
  });

  it("cleans other HTML comments, such as one in a code example", () => {
    expect(clean("```xml\n<!-- generated from /Users/dev/private/build.xml -->\n```")).toBe(`\`\`\`xml\n<!-- generated from ${LOCAL_PATH} -->\n\`\`\``);
  });

  it("leaves the tool's own markers (its state and plan) untouched and is idempotent", () => {
    const body = `Moved lib in ${WC}/build.gradle.kts\n\n<!-- leanish:plan ${WC}/x -->\n<!-- leanish:state {"head":"a"} -->`;
    const once = clean(body);
    expect(once).toBe(`Moved lib in build.gradle.kts\n\n<!-- leanish:plan ${WC}/x -->\n<!-- leanish:state {"head":"a"} -->`);
    expect(clean(once)).toBe(once);
  });

  it("cleans the title and commit message too, without dropping their lines", () => {
    const content = cleanContent({ title: `fixing ${WC}/lib`, body: "ok", commitMessage: `moving lib\n\nbuilt with /tmp/x` }, ROOTS);
    expect(content).toEqual({ title: "fixing lib", body: "ok", commitMessage: `moving lib\n\nbuilt with ${LOCAL_PATH}` });
  });

  it("only cleans a path that starts a token, so URLs and relative paths keep their own /tmp", () => {
    const text = "https://example.org/tmp/release-notes, https://example.org/releases?path=/tmp/notes, src/tmp/Fixture.java and file.txt:/tmp-ish";
    expect(clean(text)).toBe(text);
    expect(clean(`${WC}/src/tmp/Fixture.java`)).toBe("src/tmp/Fixture.java");
  });

  it("keeps a command in backticks, replacing only its local paths", () => {
    expect(clean("`/Users/dev/.local/bin/npm test -- --runInBand` failed")).toBe(`\`${LOCAL_PATH} test -- --runInBand\` failed`);
  });

  it("also replaces a directory's canonical path, which commands report", () => {
    const canonical = (path: string) => (path === "/Volumes/data/link-state" ? "/Volumes/data/state" : path);
    const roots = { workingCopy: [], other: machineRoots({ state: "/Volumes/data/link-state", cache: "/Volumes/data/cache" }, "/Users/dev", canonical) };
    expect(cleanBody("wrote /Volumes/data/state/journal.json", roots)).toBe(`wrote ${LOCAL_PATH}`);
    expect(withCanonical(["/missing"], () => { throw new Error("ENOENT"); })).toEqual(["/missing"]);
  });
});
