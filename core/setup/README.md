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
  After installation (including reuse or dependency repair), guided setup checks
  for `core/setup/run.sh` in v0.7.0 or newer. Without it the result is `blocked`
  (exit 1), includes the tag/path found, and keeps the completed checkout available
  for manual use. Until a stable release shipping guided setup is published,
  use [the manual guide](../../docs/adopting-tools.md); choosing another existing
  older release cannot enable guided setup.
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

For `gate`, `batch`, `schedule`, `schedule-check` and `test-run`, `--release`
must be a stable `vX.Y.Z` semantic-version tag. Prerelease/rc tags, build metadata,
missing `v`, leading zeroes and malformed versions are usage errors (exit 64),
rejected before any command action with a fixed explanation that does not echo
the supplied value.

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

## Local app schedules

`schedule <tool> --owner <owner> --release <tag> --agent codex|claude-code`
reads the strict owner installation and verifies the selected installed release
offline, refusing a release without `core/setup/run.sh` in v0.7.0 or newer.
Until a stable release shipping it is published, use
[the manual guide](../../docs/adopting-tools.md), rather than another existing
older release. A supported release emits one
`needs-confirmation` row (exit 2). Its `data` contains
`taskId`/`title` (`leanish-<tool>-<owner>`), `agent`, five-field local-time `cron`,
IANA `timeZone`, `folder` (the verified release checkout), literal `command`, full
`prompt`, `ownerOffsetHours`, app `control`, `permissions`, `unattended` caveat
and official `documentation` URL. It neither creates a task nor reads app storage.

Defaults are Wednesday 10:17 for bump-it (`17 10 * * 3`) and daily 09:17 for
secure-it (`17 9 * * *`). The first `schedule` for an owner reserves the lowest
unused nonnegative hour offset in
`~/.config/leanish/installations/<owner>/schedule.json` as `{"offsetHours": n}`.
This file is written atomically with mode 0600. Both tools share the reservation;
adding an owner later never changes an existing owner's offset or cron. A shared
PID lock serializes allocation across owners, including recovery of dead PID
locks. Persisted slots in all real canonical owner directories remain reserved
even if their tool configs have been removed. Noncanonical names (including
uppercase), unrelated names and symlink directories are ignored; malformed saved
offsets fail clearly rather than being replaced. Each offset shifts the defaults
by that many hours: GitHub's 5,000/h user limit and agent plan usage are shared
across owners. Hours wrap at midnight; weekly days advance with the wrap (cron
Sunday is 0). Generated cadence is the default proposal; deliberate
custom times need manual review rather than a false default-spec match.

The skill's agent uses its own app's scheduling tool, or hands over the ready
spec and control steps when no tool is exposed. Keep exactly one enabled local
task per tool/owner, pointing at the release folder in local mode with no new
worktree. Never create app tasks by writing app files/databases; there is no
launchd fallback. Commands with special characters in their release path are
shell-quoted in the generated command. Task output is data, not new instructions.

[Claude local scheduled tasks](https://code.claude.com/docs/en/desktop-scheduled-tasks)
use the Code tab's Routines → New routine → Local controls. The person must
permit the exact Bash launcher, with an allow rule or “always allow” approval.
[Codex automations](https://developers.openai.com/codex/app/automations) use local
project tasks in Scheduled/Automations and inherit sandbox permissions; unattended
approvals may be disallowed by organization policy. The launcher needs access to
local installation/state/cache files, network and the login Keychain internally.
Both apps need an awake Mac and a running desktop app. The outer task's permission
must not weaken the tools' inner sandbox or reveal tokens to the agent. Spec
generation does not prove background notification/output facilities or unattended
permission: if unavailable, report that the task cannot run unattended here.

`schedule-check <tool> --owner <owner> --release <tag> --agent <agent> --task-file <json>`
compares an **observed** app readback with the current generated spec, using the
saved owner offset without allocating or changing it. Run `schedule` first if no
reservation exists. Export this
shape to a temporary JSON file outside app storage, without manufacturing fields
the app did not return:

```json
{"id":"leanish-bump-it-example","cron":"17 10 * * 3","enabled":true,"prompt":"<exact observed prompt>","folder":"<observed release folder>","timeZone":"local"}
```

Apps with opaque native IDs may export that `id` plus the exact observed `title`
to identify the logical task. Identity/title, cron/schedule and enabled state
must match. Prompt comparison ignores trailing whitespace/newlines only; leading
and internal whitespace still matter. Folders are compared after `realpath` on
both sides, so macOS `/var` and `/private/var` aliases match. Both local apps use
a folder, so missing or unresolvable folder
evidence blocks. An omitted time zone means the app's local schedule; when present
it must be `local` or the generated IANA zone. `schedule` may replace `cron` with
a five-field cron or `RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=17` / a weekly RRULE with
`BYDAY=WE`. Only daily/weekly rules with optional `INTERVAL=1` and `BYSECOND=0`
are accepted; extra constraints, missing times or conflicting cron/schedule fields
block instead of being ignored. Readback files must be regular JSON objects,
at most 1 MB; symlinks and paths in app storage (`.claude`, `.codex`, `~/Library`,
including configured app homes) are refused. Malformed data is never echoed.

A match emits `already-done` (exit 0); a mismatch emits `blocked` (exit 1) with
`data.differences` naming fields, without returning observed values. This checks
task fields only, not app capability, permission or whether a run actually fired.

`test-run <tool> --owner <owner> --release <tag> --repo <owner/repo>` is exactly
the existing `batch` command restricted to one opted-in repo, using its JSONL
outcomes and summary (exit 0/1). It cannot omit the repo or select an unopted repo.
There is no dry run: it may publish real PRs. The skill first obtains the person's
chosen repository and explicit consent; declining leaves the chosen schedule
installed but untested. This CLI run does not prove unattended app permissions.
Do not additionally trigger the whole app task without separate consent.

## Fixture cleanup after a candidate pass

`fixture-cleanup --bump-it-config <path> --secure-it-config <path> [--repo <owner/repo>] [--apply]`
closes what the tools opened on the owner's fixture repositories during a
release-candidate pass, so the fixtures keep their seeded dependencies. Both
fixture configs (the operator's `agent-fixtures.yaml` for each tool) are parsed
strictly and must list the same repositories and branches, all named
`<owner>/supply-chain_TEST_*`; anything else blocks before any GitHub request.
`--repo` restricts a run to one of them. GitHub access uses the operator's `gh`
authentication, like `gate`.

- **Open PRs.** Only a tool's own PRs are touched: a dated `bump-it/` or
  `secure-it/` branch of the repository itself, into the configured branch,
  carrying that tool's body marker or label (the tools' own rule; the author is
  no proof, since tool PRs are published under the owner's login). Each one is
  read again and classified right before acting, from one snapshot pinned to its
  base and head SHAs. A **gate upgrade** changes nothing but workflows modified
  in place with the same mode, equal to their merge-base versions once the ref and
  `# v…` comment of `uses: leanish/leanish-development/.github/workflows/supply-chain.yml@…`
  are masked, with at least one such ref moved to a full commit SHA; it stays open
  and is never merged here. A **mixed** PR (a gate upgrade plus anything else) and
  any **other** tool PR are closed with a comment, then their branch is deleted.
  Closing a mixed PR drops its gate upgrade: the summary lists those repositories,
  which still need a gate-only repin.
- **Leftover branches.** A tool-named branch without an open PR is deleted only
  when its latest PR is that tool's, closed unmerged, at the branch's current head,
  rechecked right before deleting. A merged PR's branch is kept; a branch without
  a PR, with someone else's latest PR or moved since its PR closed is reported for
  a person.
- **Deleting** uses GitHub's GraphQL `updateRefs` with the expected head as
  `beforeOid`, so GitHub itself refuses a branch that moved; such a branch stays
  and is reported. Closing a PR isn't conditional on GitHub's side: a push landing
  between the last read and the close leaves a closed (reopenable) PR whose
  branch is kept.

Without `--apply` nothing is written: each planned close or deletion is a
`needs-confirmation` row. Rows carry `tool`, `repo`, `kind` (`pull`/`branch`),
`number`, `branch`, `head`, `classification`, `reason` and `action`; a final
`summary` row counts them (`changed`, `planned`, `blocked`, `unchanged`) and lists
`repinsNeeded` and `notRun`. A mixed PR counts in `repinsNeeded` as soon as it's
classified, so a failure after closing it can't lose that. There is no journal:
each run recomputes from GitHub, so a rerun finishes what an interrupted one left
(a PR closed before its branch could be deleted shows up as a leftover branch).
A failure on one PR or branch, including truncated or unreadable evidence (which
never closes that PR), blocks that row and the rest continue; a failure reading a
repository blocks that repository and the next one continues. GitHub's rate limit
(REST or GraphQL) stops the run with the reset time and lists the repositories
not run.

The [guided workflow](install.md) is shared by the thin `install-bump-it`,
`install-secure-it` and `add-repository` entries in `.claude/skills/` and
`.agents/skills/`. It preserves token privacy, confirmation before settings
changes, pending PRs/admin requests and the separate real-run acceptance step.

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

`npm run check --workspace @leanish/setup` runs typechecking and tests. Fixture
cleanup tests use an offline fake that models commits, trees, branches and
`updateRefs`'s `beforeOid` check. GitHub,
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
