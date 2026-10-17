# Local setup commands

`@leanish/setup` supplies deterministic setup steps for bump-it and secure-it.
Skills will hold the conversation; these commands do not ask questions. Gate
adoption writes a PR and, only with `--confirm-settings`, repository settings.
Run with Node 24+, after `npm ci --ignore-scripts` in the
repository root:

```sh
node core/setup/src/cli.ts doctor
node core/setup/src/cli.ts doctor --agent claude-code --java 25
node core/setup/src/cli.ts release
```

- **`doctor [--agent codex|claude-code] [--java <major>]`** checks native Apple
  Silicon macOS, Node >=24, npm >=11.17, git >=2.42, macOS `lockf` and `security`,
  authenticated `gh`, and agent availability. It always requires Codex CLI
  >=0.159 (the runtime's fixture baseline) and tests its permission-profile sandbox
  with `/usr/bin/true`, without a model or repository code. Agent candidates need
  their desktop app directly under `/Applications` or `~/Applications`, identified
  by `CFBundleIdentifier` in `Contents/Info.plist`: `com.openai.codex` or
  `com.anthropic.claudefordesktop`. Names may differ (for example, `ChatGPT.app`);
  agent data includes `appPath` when found. System installs take precedence.
  Codex needs a
  file-backed login under `CODEX_HOME` or `~/.codex`; only its presence and CLI
  login status are checked, never its contents. Claude needs CLI >=2.1.259, a
  successful JSON login status, and unset `CLAUDE_CONFIG_DIR`. A sole usable agent
  is selected; two require `--agent`. `--java` checks both java and javac for the
  exact requested major, including legacy `1.8.0_392` strings for JDK 8. It uses
  `$JAVA_HOME/bin/java` and `javac` when both exist, otherwise PATH, and reports
  the executable paths and source. An existing JAVA_HOME with the wrong JDK
  blocks even when PATH has the requested version, matching Gradle's precedence.
  Successful rows include detected versions, executable paths, platform, or
  authentication state in `data`; the selected agent includes its app path and
  CLI version. A blocked check explains what to install or repair;
  prerequisites are never installed or logins changed automatically. App
  presence is checked here; scheduling availability/permissions require later
  desktop acceptance.
- **`release`** uses read-only `gh api` GETs against
  `leanish/leanish-development`. It selects the newest published stable `vX.Y.Z`
  across all pages, excluding drafts, prereleases and candidate tags. The newest
  must be immutable; a mutable release does not trigger an older fallback. It
  peels lightweight/annotated tags to a full SHA, fetches the tag, and compares
  that SHA before checkout or npm. The detached, clean checkout lives at
  `~/.local/share/leanish/releases/<tag>`; dependencies install with
  `npm ci --ignore-scripts --no-audit --no-fund`. A receipt under `.git/` records
  completion. Reuse rechecks HEAD, the local tag, cleanliness and the receipt;
  different SHAs, attached branches, symlinks and dirty checkouts are refused,
  never repaired. Missing dependencies or a missing receipt retry npm in an
  otherwise verified checkout. Before reinstalling, the old receipt is removed;
  a failed npm invocation cannot leave a valid completion receipt. Older
  releases stay available for rollback.
  This explicit command resolves the latest release on each invocation; there
  is no automatic upgrade or schedule repinning.
- **`configure <tool> --owner <owner> --repo <owner/repo> [--repo ...]`**
  reconciles opt-ins in `~/.config/leanish/installations/<owner>/<tool>/agent.yaml`.
  A new installation also needs `--agent codex|claude-code --name <commit-name>
  --email <commit-email>`; optional `--model` and `--effort` override its defaults.
  Tool-owned `bump-it/setup/` and `secure-it/setup/` files supply data only:
  documented YAML defaults, permission tables and cadence (bump-it Wednesday
  10:17, secure-it daily 09:17, local time). Existing identity, agent, services,
  paths, limits and per-repository fields win over new flags; reruns append selected
  repos without rebuilding existing YAML entries. The strict parser currently
  accepts `repo` and optional `branch` per repository; both and their comments stay.
  Restored configs use the same reconciliation and require fresh Keychain items.
  The existing strict runtime parser validates before writes; symlinks, foreign
  owner repos and concurrent edits are refused. Writes are atomic, mode 0600.
  Configuration locks atomically publish a complete PID file; a lock whose PID
  no longer exists is reclaimed. Live/unknown owners stay locked, and other
  filesystem errors retain their error code rather than being called locks.
  New state/cache directories and `leanish-<tool>-<owner>-write`/`-read` services
  are owner-specific. Results report config path and opted-in repos.
- **`enroll <tool> --owner <owner> --login <github-login>`** returns the exact
  permission table and one command per configured service:
  `security add-generic-password -U -s '<service>' -a '<login>' -w`.
  Service and login are single-quoted after validation. `-U` updates an existing
  item for re-enrollment or token rotation.
  The **person** runs these in their own Terminal; bare `-w` comes last and
  prompts privately. The agent never executes them, receives a token or puts a
  value in arguments, files, shell history or logs. The person creates two
  fine-grained PATs scoped only to selected repos and obtains any organization
  approval/SSO authorization. This command never reads Keychain.
- **`verify-tokens <tool> --owner <owner>`** reads the two configured items inside
  its own process through the runtime's Keychain store, refuses empty/identical
  tokens, then makes read-only GitHub requests with redirects disabled. Results
  contain per-permission `pass` (proven private read), `fail` (denied required read,
  including HTTP 401/403/404, or empty/identical tokens) and `unverified`
  (write/none levels, public reads or unavailable evidence), with fixed reasons,
  never credentials or HTTP diagnostics. Only authenticated private-repository
  reads prove read capabilities. Any `fail` blocks (exit 1). Otherwise the result
  is `already-done` (exit 0), with the unverified list in `data.unverified` and a
  reminder that the explicitly authorized real test run covers those permissions.
  This verifies available reads, not the whole PAT permission table.
  GitHub's [accepted-permissions header](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api)
  describes endpoint requirements, not the caller's grants. There is no override
  that turns unknown evidence into a pass; inspect scopes locally and validate
  publishing only through an explicitly authorized real run.
- **`gate --repo <owner/repo> --release <tag> [--java <major>]
  [--confirm-settings]`** verifies that already-installed release offline, then
  opens/reconciles its own adoption PR with
  `uses: leanish/leanish-development/.github/workflows/supply-chain.yml@<full-sha> # <tag>`.
  Every external `uses` in the release workflow must be `owner/repo[/path]@<40
  lowercase hex>`; quotes are accepted and local `./` actions are excluded.
  An unreadable or unpinned entry blocks before any GitHub request.
  Existing recognized callers retain inputs/comments; scalar and sequence event
  syntax is normalized to a mapping before missing triggers are added. Unrelated workflows,
  changed PR ownership, unrelated PR files or moved branches are refused.
  An existing branch without an open PR is reused only with complete compare
  evidence: every ahead commit belongs to the operator login, has a single
  parent and touches only adoption files (including rename sources). Recovery
  refuses incomplete/truncated evidence (over 100 commits or 300 files in a diff).
  It never merges. `gh` uses the operator's authentication, separate from tool
  PATs. Before writes, a present `X-OAuth-Scopes` header must include `repo` and
  `workflow`; otherwise the command blocks and gives
  `gh auth refresh -h github.com -s workflow`. An absent header (fine-grained/app
  token) proceeds. Both setup GitHub clients use API version `2022-11-28`.
  Results include the PR URL and `pendingMerge`; PR creation alone does
  not mean the gate is running on the default branch.
  Without the flag, settings are `needs-confirmation` rows with proposed API
  changes. With it, enable Actions and add pinned allowlist entries while
  preserving existing allowances; enable dependency graph/alerts, disable
  Dependabot security PRs, and propose version PR limits of zero in the PR.
  A dedicated default-branch ruleset requires `supply-chain / supply-chain` and
  `supply-chain / cooldown`, bound to the discovered GitHub Actions app, with
  no bypasses. Other protections stay intact; customized setup rulesets need
  admin reconciliation. Non-admins get a ready admin request; without push
  access they get ready workflow content. Private-repository ruleset refusals
  report **gate running, not enforced**, with the HTTP/policy reason; this
  classification remains conditional on merging and running the workflow.
  The workflow/PR result is emitted first. Each subsequent settings step reports
  its own changed/needs-confirmation/blocked result; failures have a fixed message
  and `data.httpStatus` (null without an HTTP reply). A later failure preserves
  the PR result, allows independent settings to proceed, and exits 1 if blocked.
  The [manual gate adoption](../gate/README.md#adopting-the-gate) stays the reference.
- **`batch <tool> --owner <owner> --release <tag> [--repo <owner/repo>]`**
  runs the real installation, optionally restricted to one opted-in repository.
  `core/setup/run.sh <tool> --owner ... --release ...` is the executable launcher.
  Both verify the pinned checkout/receipt, read the strict config, preflight the
  release's pinned scanner once, then execute review→run chains with concurrency
  eight through that release's `core/tool-runtime/run.sh --config <path>`.
  Review failure does not skip run; failures stay isolated across repositories.
  Existing shared per-tool/repository kernel locks remain authoritative across
  installations. The runner never reads Keychain or tokens and strips ambient
  token/launcher overrides from children; tools retain their existing secret
  separation and repository-code sandbox. **This may publish real PRs; there is
  no dry run.** The skill must obtain the person's explicit test-run approval.

Stdout is JSONL only, one versioned result per setup check:

```json
{"schemaVersion":1,"command":"doctor","step":"agent","status":"already-done","message":"Use codex","data":{"agent":"codex","agents":[]}}
```

Statuses are `changed` (performed work), `already-done` (verified existing state),
`blocked` (failed/missing prerequisite or unsafe state), and `needs-confirmation`
(the person must choose). Exit codes: **0** changed/already-done, **1** blocked,
**2** needs-confirmation, **64** usage/invalid arguments (a blocked arguments
row). Parse failures name the selected command; unknown command names use
`setup` without reflecting arbitrary input. Single-valued flags cannot repeat,
even with identical values. Only `configure --repo` is repeatable. A blocker
wins over a pending choice. Consumers
must check both exit code and results; an unavailable alternative agent is not a
blocker. Child stdout/stderr and credential values are never returned. Processes
run without a shell and with an allowlisted environment, including `USER` and
`LOGNAME` so Claude can access its Keychain login; Git ignores global and
system configuration, binds the checkout's metadata explicitly, ignores replace
objects, and disables hooks, fsmonitor and credential helpers.
Only `gh` probes additionally inherit `GH_TOKEN`, `GITHUB_TOKEN`, `GH_HOST`, and
`GH_ENTERPRISE_TOKEN`, so token-based authentication works without exposing
credentials in results or passing them to other commands.

Release writes are serialized by `releases/.setup-lock`; normal failures remove
staging and release the lock. A killed installer can leave the lock and hidden
staging directory behind. It fails closed on retry: inspect for running
installers before manually removing that lock. Once it holds the lock, the
installer removes stale `.install-XXXXXX` directories only when their directory
and regular `.leanish-setup-staging` marker belong to this user and the marker
identifies this installer. Unmarked directories (including older staging),
symlinks and unrelated paths stay untouched. The marked directory wraps a
`checkout/` child, so the marker never enters the installed checkout. Cleanup
does not replace an earlier installation failure. No checkout is published at
its final path until verification and npm succeed.

`ScheduleSpec` is a shared type only: name, prompt, folder and local cadence
(IANA time zone, hour/minute, ISO weekday 1=Monday through 7=Sunday). The skill's
agent will create the task using its own app's scheduling tool; without that
tool it will hand the person the spec and app instructions. This package has no
task-creation API or launchd fallback. App task creation and readback are
reserved for the later skills/scheduling work.

Batch JSONL uses a separate outcome contract: `schemaVersion`, `tool`, `owner`,
`repo`, `action` (`review`/`run`), `outcome`, `errors`, `notes`, `prs`, `exitCode`
and nullable `estimatedApiCostUsd`. Only bounded structured final reports are
inspected; raw child messages are discarded. The final `action: "summary"`
reports `commands`, `failed`, unique PR URLs and `completed`/`partial-failure`.
Startup failures produce an error summary with zero commands, the failed `phase`
(`configuration`, `release`, `repository-selection` or `scanner`) and a fixed
phase-specific `reason`, never raw error text. Missing final
reports and lock refusals count as failures. Batch exits 0 for complete, 1 for
failure. It does not pretend a failed or unknown run was successful.

`npm run check --workspace @leanish/setup` runs typechecking and tests. GitHub,
agent CLIs, authentication and sandbox probes are faked. Release tests use real
temporary Git repositories and an offline npm workspace to prove lifecycle
scripts stay disabled; they never operate on this checkout's Git state. Real
desktop versions, logins, macOS sandbox behavior, Keychain prompts and live
GitHub release metadata remain owner-machine acceptance checks, not CI claims.
Config tests use real temporary files and strict parsing; sentinel-secret tests
prove enrollment/verification results contain no token values. Gate API tests
use fakes exclusively (no GitHub writes). Batch tests exercise an eight-chain
pool and a real temporary shell launcher; the real macOS `run.sh` kernel-lock
test is skipped off macOS. Live token grants, organization policy, settings/PR
behavior and a real publishing batch still need the person's authorized machine.
