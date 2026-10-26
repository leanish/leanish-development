# Provenance

This package is the shared core of the coding-agent runtime. secure-it and bump-it use it here, and
[leanish/leanish-development-incubator](https://github.com/leanish/leanish-development-incubator)'s `core/runtime`
(`@leanish/runtime`, private) is to consume it instead of its own copies, keeping only its framework and adapters on top.
**That adoption is planned, not done:** the incubator still has its copies, so until they are removed, **a fix in one
copy is replicated by hand in the other**; the incubator's README lists the copied files from its side. Where the two sides' needs
differ, the shared module takes an explicit option instead of picking one side (`createGitHubClient`'s `headChecks`,
an optional `commitIdentity` in `codexIsolation`, the run report's host fields).

**Where it comes from:** most files are copied from the incubator at commit `c6282df` ("installing the coding-agent
CLIs from their own lockfile", the tip of its runtime stack), mostly from `core/runtime`; that commit is tagged
`agent-basics-source` there. The incubator was named `leanish/leanish-development` then, before this repository took
the name, so a file header citing "leanish/leanish-development … at c6282df" means the incubator. Files reconciled
with it later cite `leanish/leanish-development-incubator` and the commit they match (`17883e3`).

**In every copied file:** relative imports end in `.ts` instead of `.js` (this repository runs TypeScript directly with
Node's type stripping, so non-erasable syntax such as parameter properties is written out as fields). Comments that cite
ADRs, the agent descriptor or `AGENT_RUNTIME_*` variables refer to the incubator; here the tools pass those values
from their own config.

**In every copied test:** imports go to `../src/` (one directory up instead of two), fixtures to `./fixtures/`; the
headers name any other change.

**Not copied:** the framework (descriptors, `needs`, the catalog, dispatch, envelopes, self-publish, idempotency, AWS and
Lambda), and the target-credentials resolver (the tools pass the agent's read-only token themselves).

| File | Source | How | Local changes |
|---|---|---|---|
| `guard/gh` | `agents/bump-it/local/guard/gh` | adapted | messages say "agent guard" (secure-it and bump-it share these); "the handler" is "the tool"; lib.sh is sourced and the real gh found without starting processes |
| `guard/git` | `agents/bump-it/local/guard/git` | adapted | messages say "agent guard" (secure-it and bump-it share these); "the handler" is "the tool"; only pushes are checked (remotes, config and `-c` settings are left to the read-only token and git metadata); pushes to all-local remotes pass, so repositories' own tests run; `--attr-source <tree>` and `--config-env <name>` are skipped as separate-value global options; lib.sh and the real git are found without starting processes |
| `guard/lib.sh` | `agents/bump-it/local/guard/lib.sh` | adapted | messages say "agent guard" (secure-it and bump-it share these); "the handler" is "the tool"; `real_bin` sets `real` without a subshell and skips the guard's own shim by inode |
| `scripts/pack.mjs` | — | new | — |
| `src/errors.ts` | `core/runtime/src/errors.ts` | copied | only the base `RuntimeError` and the entry-point errors every host shares (the incubator's own errors are to extend this `RuntimeError`, so `instanceof` keeps working); parameter properties written as fields |
| `src/github/github-client.ts` | `core/runtime/src/needs/github-client.ts` | copied | `GitHubApiError`'s parameter properties written as fields; the body and title caps exported; the required `headChecks` option, refused at runtime when missing or unknown: `check-runs-then-jobs` keeps the source's reads (the latest check runs, and the Actions jobs only on a Checks 403), `actions-jobs` reads only the Actions jobs (the tools' token has no Checks read); on the Actions path, a jobless run counts only when no newer run in its workflow/event group supersedes it, and each job keeps its steps |
| `src/guard-dir.ts` | — | new | — |
| `src/isolation.ts` | `core/runtime/src/runtime/run-local-cli.ts` (`localCodexOptions`, `SENSITIVE_HOME_PATHS`) | derived | inputs from the host's config instead of `AGENT_RUNTIME_*` variables (the incubator's `localCodexOptions` is to become an adapter that reads them and calls `codexIsolation`); the given commit identity, and none when there is none, instead of reading the developer's global one; the repository's release age, its own npm scopes exempt (`min-release-age-exclude`); deny the resolved login `auth.json` and its canonical path when present, including custom `CODEX_HOME` |
| `src/logger/console-logger.ts` | `core/runtime/src/logger/console-logger.ts` | copied | — |
| `src/logger/correlation.ts` | `core/runtime/src/logger/correlation.ts` | copied | — |
| `src/logger/redactor.ts` | `core/runtime/src/logger/redactor.ts` | copied | — |
| `src/report/run-report.ts` | `core/runtime/src/runtime/run-report.ts` | copied | only the fields every host shares; the host names the run with `identified` (the tools' `tool` and `repo`, the incubator's `agent`) and adds its own fields with `extra` (the incubator's dispatch, delayed-message and self-publish counts), also on a signal through `reportOnTerminationSignals`' callback, and neither may replace a shared field; the command's `result` comes with its end |
| `src/secret-store.ts` | — | new | — |
| `src/skill/claude-code-runner.ts` | `core/runtime/src/skill/claude-code-runner.ts` | copied | a required `confinement`: `restricted` is the source's read-only runs (`--restricted`, the read tools only), `sandbox` adds write access inside Claude Code's sandbox (edits only in the working copies, git metadata, the working-copy `.git` pointer and denied paths out of reach, trust service reachable on write runs, no hooks, outward tools denied, no attribution); usage, cost and failure reasons from stream-json; the answer's schema in the prompt; the JVM proxy shim; proxy credentials scrubbed; a relocated `CLAUDE_CONFIG_DIR` refused |
| `src/skill/claude-code-stream.ts` | — | new | — |
| `src/skill/codex-command-env.ts` | `core/runtime/src/skill/codex-command-env.ts` | copied | — |
| `src/skill/codex-login.ts` | `core/runtime/src/skill/codex-login.ts` | copied | — |
| `src/skill/codex-model.ts` | `core/runtime/src/skill/codex-model.ts` | copied | — |
| `src/skill/codex-permissions.ts` | `core/runtime/src/skill/codex-permissions.ts` | copied | `Access` from `types/access.ts` instead of the agent descriptor; working-copy `.git` pointer files read-only |
| `src/skill/codex-quota-baseline.ts` | `core/runtime/src/skill/codex-quota-baseline.ts` | copied | — |
| `src/skill/codex-rollouts.ts` | `core/runtime/src/skill/codex-rollouts.ts` | copied | — |
| `src/skill/codex-runner.ts` | `core/runtime/src/skill/codex-runner.ts` | copied | the access comment says write agents can't write git metadata (they never could here); `writeMountGitDirs` and `shellIsolationEnv` exported for the Claude Code runner |
| `src/skill/codex-usage-meter.ts` | `core/runtime/src/skill/codex-usage-meter.ts` | copied | — |
| `src/skill/fake-runner.ts` | `core/runtime/src/skill/fake-runner.ts` | copied | — |
| `src/skill/input-render.ts` | `core/runtime/src/skill/input-render.ts` | copied | — |
| `src/skill/output-parse.ts` | `core/runtime/src/skill/output-parse.ts` | copied | — |
| `src/skill/run-skill.ts` | `core/runtime/src/skill/run-skill.ts` | copied | the agent descriptor, `needs` and the target-credentials resolver are replaced by `SkillContext` (the tool's entrypoints and support skills) and `SkillCall` (coding agent, model, effort, access and the credential env, all from the tool's config) |
| `src/skill/runner.ts` | `core/runtime/src/skill/runner.ts` | copied | `Access` from `types/access.ts` instead of the agent descriptor |
| `src/skill/schema-subset.ts` | `core/runtime/src/skill/schema-subset.ts` at `17883e3` | copied | — |
| `src/skill/skill-loader.ts` | `core/runtime/src/skill/skill-loader.ts` | copied | — |
| `src/skill/skill.ts` | `core/runtime/src/skill/skill.ts` | copied | — |
| `src/skill/slash-command-prompt.ts` | `core/runtime/src/skill/slash-command-prompt.ts` | copied | — |
| `src/skill/spawn-capture.ts` | `core/runtime/src/skill/spawn-capture.ts` | copied | an optional per-line stdout callback, decoded across chunks, each line bounded |
| `src/skill/stage-skills.ts` | `core/runtime/src/skill/stage-skills.ts` | copied | — |
| `src/skill/synthesize-fixture.ts` | `core/runtime/src/skill/synthesize-fixture.ts` at `17883e3` | copied | — |
| `src/skill/tail.ts` | `core/runtime/src/skill/tail.ts` | copied | — |
| `src/skill/validate-compat.ts` | `core/runtime/src/skill/validate-compat.ts` at `17883e3` | adapted | the coding agent, entrypoints and support skills come as arguments instead of the agent descriptor, still apart (an entrypoint loads with its schemas required, a support skill only loads); the issues, in the same categories, come as a `SkillCompatibilityError` instead of a `DescriptorValidationError` |
| `src/skill/validator.ts` | `core/runtime/src/skill/validator.ts` | copied | — |
| `src/skill/wc-mount.ts` | `core/runtime/src/skill/wc-mount.ts` | copied | — |
| `src/types/access.ts` | — | new | — |
| `src/types/clients.ts` | `core/runtime/src/types/clients.ts` | copied | only the GitHub client's types; a job's steps |
| `src/types/effort.ts` | `core/runtime/src/types/execution-override.ts` at `17883e3` | derived | only `Effort` and `EFFORTS`; `ExecutionOverride` stays in the incubator |
| `src/types/logger.ts` | `core/runtime/src/types/logger.ts` | copied | — |
| `src/types/repo-source.ts` | — | new | — |
| `src/types/working-copy.ts` | `core/runtime/src/types/working-copy.ts` | copied | the `remote-merging` start and its `conflicted` result; `PublishBranchArgs.beforePush` |
| `src/usage/api-cost.ts` | `core/runtime/src/usage/api-cost.ts` | copied | — |
| `src/usage/model-prices.ts` | `core/runtime/src/usage/model-prices.ts` | copied | — |
| `src/usage/quota.ts` | `core/runtime/src/usage/quota.ts` | copied | — |
| `src/usage/skill-usage-record.ts` | `core/runtime/src/usage/skill-usage-record.ts` | copied | carries `providerCostUsd` |
| `src/usage/skill-usage.ts` | `core/runtime/src/usage/skill-usage.ts` | copied | `providerCostUsd`, the coding agent's own list-price estimate when it reports one |
| `src/usage/usage-totals.ts` | `core/runtime/src/usage/usage-totals.ts` | copied | — |
| `src/working-copy/git-clone-auth.ts` | `core/runtime/src/working-copy/git-clone-auth.ts` | copied | `gitCloneAuth(token, host)` replaces `resolveGitCloneAuth(needs, env)`; the tool passes its token |
| `src/working-copy/in-memory-workspace.ts` | `core/runtime/src/working-copy/in-memory-workspace.ts` | copied | `RepoSource` instead of catalog-it's `Project`; `remote-merging` (a scheduled conflict lists package-lock.json); calls `beforePush`; a test double the tools' tests use |
| `src/working-copy/git-failure.ts` | — | new | — (the incubator copied it to `core/runtime/src/working-copy/git-failure.ts`) |
| `src/working-copy/local-git-workspace.ts` | `core/runtime/src/working-copy/local-git-workspace.ts` | copied | `RepoSource` instead of catalog-it's `Project`, its id checked before the workspace touches any directory; the `remote-merging` start (a conflicting merge left in progress) and publishing that merge once resolved; `beforePush`, called with the commit before it's pushed; replace refs disabled; stale remote-tracking refs that conflict with a fetched or pushed branch's path are deleted first; a failed git call's error quotes its stderr (bounded, credentials masked) instead of inheriting or dropping it |
| `src/working-copy/workspace.ts` | `core/runtime/src/working-copy/workspace.ts` | copied | `RepoSource` instead of catalog-it's `Project` |
| `test/api-cost.test.ts` | `core/runtime/test/unit/api-cost.test.ts` | copied | imports this package's modules from `../src/` instead of `../../src/` |
| `test/claude-code-runner.test.ts` | `core/runtime/test/unit/claude-code-runner.test.ts` | copied | imports this package's modules from `../src/` instead of `../../src/`; stub binaries speak stream-json; both confinements, write access, usage and failure reasons covered |
| `test/claude-code-stream.test.ts` | — | new | — |
| `test/codex-model.test.ts` | `core/runtime/test/unit/codex-model.test.ts` | copied | imports this package's modules from `../src/` instead of `../../src/` |
| `test/codex-permissions.test.ts` | `core/runtime/test/unit/codex-permissions.test.ts` | copied | imports this package's modules from `../src/` instead of `../../src/` |
| `test/codex-rollouts.test.ts` | `core/runtime/test/unit/codex-rollouts.test.ts` | copied | imports this package's modules from `../src/` instead of `../../src/`, its fixtures from `./fixtures/` |
| `test/codex-runner-access.test.ts` | `core/runtime/test/unit/codex-runner-access.test.ts` | copied | imports this package's modules from `../src/` instead of `../../src/` |
| `test/codex-runner-usage.test.ts` | `core/runtime/test/unit/codex-runner-usage.test.ts` | copied | imports this package's modules from `../src/` instead of `../../src/`, its fixtures from `./fixtures/` |
| `test/codex-runner.test.ts` | `core/runtime/test/unit/codex-runner.test.ts` | copied | imports this package's modules from `../src/` instead of `../../src/` |
| `test/correlation-and-redaction.test.ts` | `core/runtime/test/unit/correlation-and-redaction.test.ts` | copied | imports this package's modules from `../src/` instead of `../../src/` |
| `test/errors.test.ts` | — | new | — |
| `test/fixtures/codex-rollout.ts` | `core/runtime/test/fixtures/codex-rollout.ts` | copied | — |
| `test/fixtures/report-on-signal.ts` | — | new | — |
| `test/git-clone-auth.test.ts` | `core/runtime/test/unit/git-clone-auth.test.ts` | copied | `gitCloneAuth` tests replace the `resolveGitCloneAuth` ones; imports this package's modules from `../src/` instead of `../../src/` |
| `test/git-failure.test.ts` | — | new | — (the incubator copied it to `core/runtime/test/unit/git-failure.test.ts`) |
| `test/github-client.test.ts` | `core/runtime/test/unit/github-client.test.ts` | copied | imports this package's modules from `../src/` instead of `../../src/`, the GitHub client from its module instead of the runtime's package barrel; both `headChecks` modes: Actions runs/jobs and commit statuses without Checks, including pagination, reruns, separate workflow/event groups, pending/jobless runs (with older jobless failures superseded by newer runs in the same group), skipped jobs and continue-on-error failures, and job steps; check runs, with the Actions-jobs fallback only on a Checks 403; the mode refused when missing or unknown |
| `test/guard.test.ts` | `agents/bump-it/test/local-guard.test.ts` | adapted | the guards' directory, and their messages say "agent guard"; only pushes are checked, with separate-value global options, and against real git and repositories (`-c` rewrites of a remote's push URL included) |
| `test/input-render.test.ts` | `core/runtime/test/unit/input-render.test.ts` | copied | imports this package's modules from `../src/` instead of `../../src/` |
| `test/in-memory-workspace.test.ts` | `core/runtime/test/unit/in-memory-workspace.test.ts` | copied | `RepoSource` instead of catalog-it's `Project`; imports this package's modules from `../src/` instead of `../../src/` |
| `test/isolation.test.ts` | — | new | — |
| `test/local-git-workspace.test.ts` | `core/runtime/test/unit/local-git-workspace.test.ts` | copied | `RepoSource` instead of catalog-it's `Project`; a new id-validation regression test; new `remote-merging` (markers refused, the resolved merge published), `beforePush`, stale-tracking-ref and git-stderr tests; imports this package's modules from `../src/` instead of `../../src/` |
| `test/model-prices.test.ts` | `core/runtime/test/unit/model-prices.test.ts` | copied | imports this package's modules from `../src/` instead of `../../src/` |
| `test/output-parse.test.ts` | `core/runtime/test/unit/output-parse.test.ts` | copied | imports this package's modules from `../src/` instead of `../../src/` |
| `test/packed-package.test.ts` | — | new | — |
| `test/quota.test.ts` | `core/runtime/test/unit/quota.test.ts` | copied | imports this package's modules from `../src/` instead of `../../src/` |
| `test/run-report.test.ts` | signal cases from `core/runtime/test/unit/run-local-cli.test.ts` | new | on a bare command instead of run-local; the tools' line pinned byte for byte; host identity and extras, on a normal end and on a signal |
| `test/run-skill.test.ts` | `core/runtime/test/unit/run-skill-usage.test.ts`, `run-skill-invocation.test.ts` | adapted | the same cases against `SkillContext`/`SkillCall` |
| `test/schema-subset.test.ts` | `core/runtime/test/unit/schema-subset.test.ts` at `17883e3` | copied | imports this package's modules from `../src/` instead of `../../src/` |
| `test/skill-loader.test.ts` | `core/runtime/test/unit/skill-loader.test.ts` | copied | imports this package's modules from `../src/` instead of `../../src/` |
| `test/spawn-capture-env.test.ts` | `core/runtime/test/unit/spawn-capture-env.test.ts` | copied | imports this package's modules from `../src/` instead of `../../src/`; the per-line stdout callback covered; timeout tests synchronize startup and assert process state |
| `test/stage-skills.test.ts` | `core/runtime/test/unit/stage-skills.test.ts` | copied | imports this package's modules from `../src/` instead of `../../src/` |
| `test/synthesize-fixture.test.ts` | `core/runtime/test/unit/synthesize-fixture.test.ts` at `17883e3` | copied | imports this package's modules from `../src/` instead of `../../src/` |
| `test/usage-totals.test.ts` | `core/runtime/test/unit/usage-totals.test.ts` | copied | imports this package's modules from `../src/` instead of `../../src/` |
| `test/validate-compat.test.ts` | `core/runtime/test/unit/validate-compat.test.ts` at `17883e3` | adapted | imports this package's modules from `../src/` instead of `../../src/`; the skills as arguments instead of a descriptor, and the `buildRuntime` cases left in the incubator; support skills, schema and load failures, and every issue reported |
| `test/wc-mount.test.ts` | `core/runtime/test/unit/wc-mount.test.ts` | copied | imports this package's modules from `../src/` instead of `../../src/` |
