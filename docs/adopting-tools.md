# Adopting secure-it and bump-it

For the guided Mac path, clone this repository and ask Claude Code or Codex desktop
to "install bump-it", "install secure-it", or "add a repository". The [guided workflow](../core/setup/install.md)
uses one local app task per tool and GitHub owner, with review→run chains and an
explicitly consented real test run. The manual path below stays the reference for
people who prefer to configure and operate the tools themselves.

The tools run on your machine and propose draft PRs; people merge them. Each has
its own config, default Keychain services and two schedules: `run` plans changes,
`review` revisits its open PRs. Either command can push or change a PR. There is
**no tool dry-run flag**: start with the candidate preview below before enabling
publication or a schedule.

Tool PRs carry the `leanish:secure-it` or `leanish:bump-it` label and a matching
body marker (`<!-- leanish:secure-it -->` or `<!-- leanish:bump-it -->`).

Adopt [the CI gate](../core/gate/README.md#adopting-the-gate) first. The tools
compute their own plans from the repository and the registries, and read their
PRs' CI (the gate's comparison included) during review. Keep the gate's scans of
the default branch (on every push and daily): they report new advisories on an
unchanged `main` between tool runs. Read [the security model](security-model.md)
and [coverage gaps](coverage-gaps.md) before giving a tool repository access.

## Prerequisites

- **macOS, currently Apple Silicon:** the secret store uses macOS Keychain,
  `run.sh` uses `lockf`, and the pinned scanner has a macOS arm64 build. Linux's
  scanner pin does not make the current Keychain launcher portable.
- **Node 24 or newer**, **git 2.42 or newer** (reviews that resolve merge conflicts read the `AUTO_MERGE` tree it records), `gh`, npm and the Codex CLI on the command path,
  whichever agent you choose: the tool runs repository code (the Gradle inventory,
  npm resolution) under `codex sandbox`, which needs no login.
- **npm 11.17.0 or newer** whenever there are trusted npm scopes, planned young
  security targets or young/unreadable locked base versions: these need
  `min-release-age-exclude`. Older npm fails the affected unit before
  publication, reporting the excluded names and the required and detected versions. Starting with 11.17+ avoids that;
  without exclusions, any npm with min-release-age support works.
- **For `codingAgent: codex`: a file-backed Codex login** for the same user that
  will run launchd. The runner reuses `auth.json` under `$CODEX_HOME` or
  `~/.codex`; a keyring-only login cannot be reused. See [Codex credential storage](https://developers.openai.com/codex/auth/#credential-storage).

  ```bash
  codex -c 'cli_auth_credentials_store="file"' login
  test -f "${CODEX_HOME:-$HOME/.codex}/auth.json"
  codex --version
  codex debug models
  ```

  Choose a listed model and a supported effort; `sol` resolves against that CLI's
  catalog. The CLI must support the sandbox/profile options this runner uses. Run
  from a normal macOS login session, not inside a sandbox that prevents Seatbelt
  from being applied. Never copy credentials into this repository or a plist.
- **For `codingAgent: claude-code`: the `claude` CLI** 2.1.312 or newer, logged in for the same user, with
  `CLAUDE_CONFIG_DIR` unset. This is the [lowest verified version for the inline per-model compaction setting](../core/agent-runtime/README.md),
  not a documented introduction version; an older CLI could silently ignore the window.
  Runs use that login's plan and usage windows, shared with any interactive use;
  a run that hits a limit fails and its logged failure says so.
- For Gradle repositories, **a suitable JDK** and their checked-in executable
  `gradlew`. Add `JAVA_HOME` to launchd's environment if your installation needs
  it. Gradle runs build code under the tool's sandbox and can access the network.
- Network access for GitHub, OSV and the repository's allowed registries; wrapper
  updates also read services.gradle.org. The pinned OSV-Scanner installs itself
  under protected tool state.

Keep a stable checkout of supply-chain, outside `/tmp`, and install its locked
dependencies without scripts:

```bash
git clone https://github.com/leanish/leanish-development.git "$HOME/dev/supply-chain"
cd "$HOME/dev/supply-chain"
# Check out the reviewed tool release/commit you intend to run.
npm ci --ignore-scripts
node --version
npm --version
```

The tools create their own working copies and never edit the adopting repo's
developer checkout. Update this launcher checkout deliberately, with checks, and
keep its path unchanged in your schedules.

## Two fine-grained PATs per tool

By default, create a separate write/read pair of fine-grained PATs for each tool
(the `secrets` overrides in the [config reference](tool-configuration.md) can share
one pair); the write and read PATs must have different values. For each PAT:

- select the resource owner and only the repositories it needs;
- set an expiry, and renew the matching Keychain item before it expires;
- make sure the token owner may push branches and create PRs; an organization may
  need to approve the token.

| Repository permission | Tool's write PAT | Agent's read PAT |
|---|---|---|
| Contents | Read and write | Read-only |
| Pull requests | Read and write | Read-only |
| Workflows | Read and write | No access |
| Actions | Read-only | Read-only |
| Commit statuses | Read-only | Read-only |
| Metadata | Read-only (automatic) | Read-only (automatic) |
| Checks | **No access** | **No access** |

Leave other permissions and account permissions unset.

- Workflows write permits pushing action-pin changes in workflow files; it does
  not grant Actions write.
- Pull requests write also covers PR labels/comments via the Issues endpoints;
  Issues permission is unnecessary.
- The tools read CI from Actions workflow runs/jobs and commit statuses, so
  checks-only results from other apps must be exposed as commit statuses to be
  seen.

This set follows [GitHub's fine-grained permission reference](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)
and the [copied client](../core/agent-runtime/src/github/github-client.ts).
Which process gets which token is in the
[security model](security-model.md#secure-it-and-bump-it). Never export the write
PAT into your shell or put either PAT's value in `agent.yaml` or a plist.
`gh auth login` is a separate operator convenience, not the tools' secret source.

## Keychain and agent.yaml

In **Keychain Access**, add a generic password item in your login keychain for
each default service below, or your configured overrides: Keychain Item Name is
the service, account is your GitHub login, password is the PAT. Use the UI so
tokens stay out of shell history and command arguments.

| Tool | Write service | Read service |
|---|---|---|
| secure-it | `leanish-secure-it-write` | `leanish-secure-it-read` |
| bump-it | `leanish-bump-it-write` | `leanish-bump-it-read` |

Omit `secrets` in `agent.yaml` to use these names; the
[config reference](tool-configuration.md) covers overrides. No Keychain item is
renamed automatically.

The tools look up each service with `security find-generic-password -s <service>
-w` and refuse identical services or values. Unlock/authorize the login keychain
in your interactive session before scheduling. Do not print passwords into
diagnostic logs.

```bash
mkdir -p "$HOME/.config/leanish/secure-it" "$HOME/.config/leanish/bump-it"
cp docs/examples/secure-it-agent.yaml "$HOME/.config/leanish/secure-it/agent.yaml"
cp docs/examples/bump-it-agent.yaml "$HOME/.config/leanish/bump-it/agent.yaml"
chmod 600 "$HOME/.config/leanish/secure-it/agent.yaml" "$HOME/.config/leanish/bump-it/agent.yaml"
```

Edit the copies: opt in each `owner/repo`, choose the base branch or omit it to
use the default, choose the coding agent and model, set the commit identity, and
add private folders to `readDeny`. Keep the default state/cache directories under
home, separate per tool. The state directory (which holds OSV-Scanner) must not be
under the build cache, a writable working copy or temp roots (including `/tmp`
and its canonical macOS path `/private/tmp`). Every field is in the
[config reference](tool-configuration.md).

## First dry run: candidate preview

This preview calls the gate's deterministic candidate rules. It reads a committed
checkout, queries registries/advisories and writes JSON; it does **not** invoke a
model, push, open a PR or run repository build code. Set `TARGET` to a clean local
checkout at the intended base commit. The scanner installer downloads the pinned
binary and verifies its hash. Use a read PAT, never the write PAT:

```bash
cd "$HOME/dev/supply-chain"
TARGET="$HOME/dev/widget"
PREVIEW="$HOME/.local/share/leanish/candidate-preview"
mkdir -p "$PREVIEW"
OSV_SCANNER="$(core/gate/scripts/install-osv-scanner.sh "$PREVIEW/tools")"
GH_TOKEN="$(security find-generic-password -s leanish-secure-it-read -w)" \
  OSV_SCANNER="$OSV_SCANNER" node core/gate/src/cli.ts candidates \
  --rule security --repo "$TARGET" --head HEAD --out "$PREVIEW/security.json"
GH_TOKEN="$(security find-generic-password -s leanish-bump-it-read -w)" \
  OSV_SCANNER="$OSV_SCANNER" node core/gate/src/cli.ts candidates \
  --rule bump --repo "$TARGET" --head HEAD --out "$PREVIEW/bump.json"
```

For a Gradle repo, add `--head-gradle /absolute/path/gradle-head.json` to both
commands, using that exact commit's inventory from a successful gate run (the
`gradle-head` artifact), for example `gh run download RUN_ID --repo acme/widget
--name gradle-head --dir "$PREVIEW/inventory"`. Its commit/build list is
validated; a missing or mismatched inventory fails closed. Do not substitute
`--head worktree`: that mode runs Gradle inline, outside the tools' sandbox.

Read `incomplete`, blockers and coverage gaps as well as candidates. Exit 2 means
the preview could not complete; an empty list then does not mean clean. This is
**not a full tool simulation**: it does not compute the final npm bytes/transitive
refresh, assemble peer-coupled units, prove floor removals, select/generate wrapper
updates or verify an agent's edits. The first actual tool run below can publish.

## First manual publication and review

Run one opted-in repository interactively before installing schedules. These
commands may open/update draft PRs; review may also mark them ready or close
them. Neither merges. secure-it holds versions younger than the release-age wait
in draft PRs with a [warning](../secure-it/README.md#the-cooldown-warning); require the gate's
`supply-chain / cooldown` check too (see the gate's
[adoption steps](../core/gate/README.md#adopting-the-gate)).

```bash
cd "$HOME/dev/supply-chain"
mkdir -p "$HOME/Library/Logs/leanish"
core/tool-runtime/run.sh secure-it run acme/widget \
  >"$HOME/Library/Logs/leanish/secure-it.widget.run.out.log" \
  2>"$HOME/Library/Logs/leanish/secure-it.widget.run.err.log"
core/tool-runtime/run.sh bump-it run acme/widget \
  >"$HOME/Library/Logs/leanish/bump-it.widget.run.out.log" \
  2>"$HOME/Library/Logs/leanish/bump-it.widget.run.err.log"
core/tool-runtime/run.sh secure-it review acme/widget
core/tool-runtime/run.sh bump-it review acme/widget
```

Check the final report, the proposed diff and CI. How each tool splits, verifies
and reviews its PRs is in [secure-it's README](../secure-it/README.md)
and [bump-it's README](../bump-it/README.md).

## launchd: run and review

Use user **LaunchAgents**, in the GUI session of the same logged-in user as the
Keychain and agent login. Copy these four examples to `~/Library/LaunchAgents`:

| Plist | Example schedule |
|---|---|
| [secure-it run](examples/leanish.secure-it.widget.run.plist) | Daily 07:17 |
| [secure-it review](examples/leanish.secure-it.widget.review.plist) | Every four hours |
| [bump-it run](examples/leanish.bump-it.widget.run.plist) | Monday 08:23 |
| [bump-it review](examples/leanish.bump-it.widget.review.plist) | Every four hours |

Replace **every** `/Users/YOUR_USER`, `acme/widget`, label/log suffix, and PATH.
launchd does not expand `~`, `$HOME` or shell commands in a plist. Its PATH must
find the same Node, npm, Codex and (for `claude-code`) `claude` you tested
interactively, including your version manager's actual bin directory if
applicable. The examples set HOME explicitly, use absolute launcher, config and
log paths, and contain no tokens. Create the log directory before loading them;
use a distinct label and logs per repo, tool and command.

```bash
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs/leanish"
cp docs/examples/leanish.*.widget.*.plist "$HOME/Library/LaunchAgents/"
# Edit those four copies before loading; shown for one, repeat for the others:
PLIST="$HOME/Library/LaunchAgents/leanish.secure-it.widget.run.plist"
plutil -lint "$PLIST"
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl print "gui/$(id -u)/leanish.secure-it.widget.run"
# Explicitly trigger a live run, only when ready to publish:
launchctl kickstart "gui/$(id -u)/leanish.secure-it.widget.run"
# Stop/unload the schedule:
launchctl bootout "gui/$(id -u)" "$PLIST"
```

- Calendar times use the machine's local timezone. A sleeping, offline or
  logged-out machine is not a dependable CI scheduler; the gate's daily scan
  stays in Actions.
- The examples omit `RunAtLoad` and `KeepAlive` to avoid an unexpected first run
  or a retry loop.
- `run.sh` serializes run/review per tool and repository; a busy lock exits 75,
  so let the next tick handle it. Different tools have separate locks.

## Logs and costs

Stdout and stderr go to the plist's log files. The final stderr JSON line has
`msg: "run finished"`: `status`/`exitCode` describe command completion, and
`result` holds each unit/PR's business outcome. **An exit 0 can still contain
blocked, failed or deferred units**, so inspect the nested result and reasons,
not only launchd's last exit code. `run.sh` writes that final line itself when
startup or locking fails. launchd does not rotate these files; keep/rotate them
under your own retention policy. They may contain repository details and model
responses.

`skills` and `totals` record model calls, measured tokens, available quota
observations, API-equivalent cost estimates and gaps. Incomplete measurements use
lower bounds, not invented zero cost. The built-in rates cover OpenAI Standard
pricing only; Claude models, and other tiers, need the optional
[price table](tool-configuration.md#optional-price-table) or show a cost gap.
Estimates are not a subscription bill.

- `maxNewMajorsPerRun` limits new-major volume, not total spend.
- Pending/green review ticks use no model; base reconciliation and failed-CI
  adaptations can.
- npm/wrapper-only bump-it routines need no model; every other call uses
  `agent.effort`.
- Failed attempts also consume usage.

## Troubleshooting real runs

| Symptom | Cause and action |
|---|---|
| `UND_ERR_CONNECT_TIMEOUT` or a connection reset during a registry/POM lookup | The gate and tools already retry these reads, and fail closed reporting the URL and final cause when every attempt fails; the retry rules and the cap of 16 concurrent source-repository lookups are in the [network behavior](security-model.md#the-gate-itself). Overlap alone does not prove concurrency caused the failure. |
| OSV-Scanner refused because sandboxed commands can write its path | `dirs.state` is under `/tmp`, the cache or a writable checkout. Move state to its default home path, outside those roots; do not bypass the check. Stop schedules while moving it so publication journals and workspace metadata move together. A symlink alias is canonicalized, not an escape. |
| Gradle `fileHashes.lock (Operation not permitted)` although plain writes work | A reused daemon kept an earlier sandbox's writable root. Inventories, floor probes and wrapper generation use `--no-daemon`, so their daemon is single-use and never one an agent started; keep that flag on any custom tool-run Gradle command. `GRADLE_OPTS` and repository JVM settings are not overwritten. |
| npm `notarget` for a young version already locked | npm's own age window can reject even a previously accepted security fix. The tools report young/unreadable locked-base exclusions (and secure-it's planned young targets); npm >=11.17 reads them, while the tool's targets and `compare` still enforce the policy. Do not turn off the window globally. Check the npm version on **launchd's** PATH. |
| A name-exempt target drifts past `to`, or a peer override exits successfully without moving it | The tools pin all targets together before npm resolves, anchor peer copies with exact root/workspace declarations, restore ranges/formatting and assert the result; older releases left this to the agent, so upgrade. Unsupported nested peer placements are reported and left unpublished. Never bypass exact-target verification. |
| Peer-coupled major reported blocked (e.g. Vitest/UI/coverage) | Compatible peer companions are planned together. A set needing coordinated cross-major moves is not supported: it is blocked with a reason. Other units continue; bump-it keeps a peer-blocked major PR on review. Migrate that set manually or wait for a compatible set; do not loosen verification. |
| Agent usage or plan limit, or cannot-apply | The affected unit reports failure and publishes nothing unverified; inspect its reason and usage/quota gaps. Wait for the quota or plan window to recover, pause/unload schedules if needed, then retry deliberately. A started CI adaptation consumes an attempt even if it fails (at most two); a tool may eventually close the PR. A lower new-major cap limits new work, not retries on existing PRs. |
| Keychain/login works interactively but launchd fails | Check service names, token expiry/repository approval, the logged-in user and the unlocked keychain; check the plist's absolute PATH/HOME, the file-backed Codex login (keyring-only is not reused) and, for `claude-code`, the same user's `claude` login. Do not add credentials to a plist as a workaround. |
| CI results unavailable or pending | Grant Actions and Commit statuses read to the write PAT; Checks permission is unnecessary. Confirm the workflow/status is on the PR head SHA. Other apps' checks-only results are outside this client's coverage. |

Before merging any wrapper PR, inspect the generated bytes, checksums and current-head CI. The real-run
[validation record](validation.md) covers floor removal and refusal and the wrapper fixture's first PR.
