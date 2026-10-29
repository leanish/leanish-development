/** Publishing must judge this repository's local gate, whose check name includes its caller. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface PublishWorkflow {
  readonly jobs: {
    readonly prepare: { readonly steps: ReadonlyArray<{ readonly id?: string; readonly run?: string }> };
  };
}

const workflow = parse(readFileSync(new URL("../../../.github/workflows/publish-agent-runtime.yml", import.meta.url), "utf8")) as PublishWorkflow;
const commit = workflow.jobs.prepare.steps.find((step) => step.id === "commit")!;

describe("the publisher's release-commit check selection", () => {
  it("requests check and gate / supply-chain as encoded query fields", () => {
    const dir = mkdtempSync(join(process.cwd(), ".publish-guard-"));
    try {
      // Shell functions intercept every external command in this step; no Git or GitHub is contacted.
      // jq's verdict is fixed here: this test covers query selection and argument boundaries, not jq itself.
      const mocks = `
        git() { if [ "$1" = "rev-parse" ]; then echo release-sha; fi; }
        gh() {
          if [ "$1" = "run" ] && [ "$2" = "list" ]; then return; fi
          printf '<%s>' "$@" >&2
          printf '\\n' >&2
          echo '{"check_runs":[{"conclusion":"success"}]}'
        }
        jq() { echo success; }
      `;
      const result = spawnSync("/bin/bash", ["-e", "-o", "pipefail", "-c", `${mocks}\n${commit.run!}`], {
        env: { REPO: "owner/repo", TAG: "v1.0.0", ACTIONS_APP_ID: "15368", GITHUB_OUTPUT: join(dir, "output") },
        encoding: "utf8",
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const request = (name: string) => `<api><--method><GET><repos/owner/repo/commits/release-sha/check-runs><-f><check_name=${name}><-f><app_id=15368><--jq><[.check_runs[].conclusion]>\n`;
      expect(result.stderr).toBe(request("check") + request("gate / supply-chain"));
      expect(readFileSync(join(dir, "output"), "utf8")).toBe("sha=release-sha\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
