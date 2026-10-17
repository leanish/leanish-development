# Local setup commands

`@leanish/setup` supplies deterministic setup steps for bump-it and secure-it.
Skills will hold the conversation; these commands do not ask questions or change
repository settings. Run with Node 24+, after `npm ci --ignore-scripts` in the
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
  exact requested major, including legacy `1.8.0_392` strings for JDK 8.
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

Stdout is JSONL only, one versioned result per check (one for `release`):

```json
{"schemaVersion":1,"command":"doctor","step":"agent","status":"already-done","message":"Use codex","data":{"agent":"codex","agents":[]}}
```

Statuses are `changed` (performed work), `already-done` (verified existing state),
`blocked` (failed/missing prerequisite or unsafe state), and `needs-confirmation`
(the person must choose). Exit codes: **0** complete, **1** blocked, **2** choice
needed, **64** invalid arguments. A blocker wins over a pending choice. Consumers
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
task-creation API or launchd fallback. Token enrollment, configuration, gate
adoption, runners and scheduling commands are intentionally not implemented yet.

`npm run check --workspace @leanish/setup` runs typechecking and tests. GitHub,
agent CLIs, authentication and sandbox probes are faked. Release tests use real
temporary Git repositories and an offline npm workspace to prove lifecycle
scripts stay disabled; they never operate on this checkout's Git state. Real
desktop versions, logins, macOS sandbox behavior, Keychain prompts and live
GitHub release metadata remain owner-machine acceptance checks, not CI claims.
