import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";
import { withoutCredentials } from "@leanish/gate/process";

it("loads an exported TypeScript module through the workspace link in Vitest", () => {
  expect(withoutCredentials({ GITHUB_TOKEN: "secret", KEEP: "yes" })).toEqual({ KEEP: "yes" });
  expect(realpathSync(fileURLToPath(import.meta.resolve("@leanish/gate/process")))).not.toContain("/node_modules/");
});

it("loads the same workspace export with Node's type stripping", () => {
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { strict as assert } from "node:assert";
    import { realpathSync } from "node:fs";
    import { fileURLToPath } from "node:url";
    import { withoutCredentials } from "@leanish/gate/process";
    const path = realpathSync(fileURLToPath(import.meta.resolve("@leanish/gate/process")));
    assert(!path.includes("/node_modules/"), path);
    assert.deepEqual(withoutCredentials({ GITHUB_TOKEN: "secret", KEEP: "yes" }), { KEEP: "yes" });
    console.log("workspace type stripping passed");
  `], { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8" });
  expect(output.trim()).toBe("workspace type stripping passed");
});
