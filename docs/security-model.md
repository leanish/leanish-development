# Security model

What can run where, and which credential it can reach.

## The CI gate

| Job | Runs code from the checked repository | Token | Writes |
|---|---|---|---|
| `plan` | no | `contents: read` | which mode and sides this run has |
| `inventory` (every run: base and head on PRs, head otherwise) | yes: Gradle runs the build to learn what it resolves | `contents: read` (fork PRs: read-only regardless) | the inventory file, as an artifact |
| `supply-chain` (the verdict) | no: lockfiles and workflows are read from git objects, the Gradle inventory as data | `contents: read` | its report |
| `cooldown` (PRs) | no: it reads the verdict's report | `contents: read` | nothing; red while young versions are held |

No job writes anything to the repository or its PRs: the gate needs only `contents: read`.

- **No checkout keeps credentials** (`persist-credentials: false`), so the build can't find a token in `.git/config`.
- **Repository build commands get no token.** The Gradle wrapper runs with `GITHUB_TOKEN`, `GH_TOKEN` and the Actions runtime tokens removed from its environment. npm signature verification instead uses the clean projects and fixed configuration described below. git only reads the checkout (`show`, `ls-tree`).
- **The verdict never leaves the job that computes it.** The job's result is the check, so no artifact another job uploads can stand in for a verdict.
- **What a build can still do:** Gradle runs the build's own code, so a malicious build script or plugin can alter its own inventory (hide a dependency from it). The job split keeps it from touching the comparison and the publishing credentials, not from lying about itself; review build changes.
- **Fork PRs** run the workflow from the fork's own files, with a read-only token and no secrets: their check is only as trustworthy as the PR, and nothing re-runs it from the default branch's files; see the adoption guide in [`packages/ci/README.md`](../packages/ci/README.md).

### npm signature verification

The `supply-chain` job runs the gate's `npm-signatures` command only after comparison completes with a passing verdict; a rejected source or any other comparison failure skips npm entirely.

For each configured npm lockfile, the verifier creates a fresh temporary project containing only that lockfile and the root and workspace `package.json` files. Workspace paths and links must stay within the staged project; only the root discovers workspaces, using an explicit list of staged directories instead of globs. An adjacent `npm-shrinkwrap.json` cannot replace the selected lockfile. Repository `.npmrc` files, executables and installed modules are never copied.

The verifier runs the trusted runner's npm twice: `npm ci` followed by `npm audit signatures`. Both commands use a fixed project prefix, `--ignore-scripts`, `--bin-links=false`, `--git=/usr/bin/false`, `--userconfig=/dev/null`, a separate empty global config, and a fresh cache and home. The child environment contains only the runner's command path, locale and platform variables plus those temporary directories. Tokens, `NODE_OPTIONS`, npm configuration variables and proxy variables are not inherited. Project configuration cannot select a Git executable, inject a registry or proxy override, or enable lifecycle scripts.

Registry flags come only from the gate's `npm.registries` configuration (HTTP(S), without embedded credentials). The first allowed registry is the default; scoped packages use the allowed registry recorded in their lockfile sources. Conflicting registries for the same scope fail. Git dependencies, tarball URL dependency specifiers and external file dependencies are refused; local links are permitted only for staged workspaces. Locked registry sources are checked again before invoking npm. The fixed Git executable also refuses Git access if npm encounters a specifier not covered by those checks.

Temporary projects, homes and caches are removed on success or failure. This boundary prevents repository-selected executable execution; it is not an operating-system sandbox for npm itself. It trusts the runner's Node/npm installation and the registry archive handling and signature-verification implementation in npm. Private registry credentials and repository-specific proxy settings are deliberately unavailable to this verifier.

### Reading npm archives for bundled fixes

To prove a young carrier version as a bundled fix (and for secure-it to choose one), the gate downloads registry archives itself: only from the npm registry, at the package's own tarball URL, refusing redirects. A download counts against fixed budgets (compressed and unpacked bytes, entries, manifest size, a deadline, and bytes per run), and its sha512 must match the integrity the lockfile records (or, for a candidate version, the one the registry publishes) before anything read from it is used. It is gunzipped and read as a tar stream in memory: files and directories only, one top directory, no path twice, no absolute or `..` paths; only package manifests are kept, and a bundled package whose files have no manifest makes the archive unreadable. Nothing is written to disk or executed. Whatever can't be read this way leaves the young version unjustified; it never reads as an empty bundle.

## Young versions: the cooldown

The release-age wait exists because malicious releases (a stolen publishing token, a hijacked release workflow) tend
to be noticed and pulled within days. A security fix younger than the wait is exactly what such an attacker would
ship: the advisory creates urgency, and its severity, however high, says nothing about whether the fixing release
is genuine. Proving that a version is the rule-picked fix, or the lowest version that fix requires, limits *which*
young version comes in; it doesn't make that version safe, and the build, tests and CI run it either way.

So the gate holds every young version a PR adds or changes, justified or not: the separate `cooldown` check stays
red until the last one turns old enough, and no exception clears it. secure-it keeps such fixes in a draft PR of
their own, opened with a warning, and retires it once everything aged. Taking it earlier is a person's explicit
decision: every other check green, the reason written on the PR, an admin merge. Details:
[the gate's cooldown](../packages/ci/README.md#the-cooldown-young-versions-are-held-however-justified) and
[secure-it's warning](../packages/secure-it/README.md#the-cooldown-warning).

## The gate itself

- It's pinned to one full commit SHA, and checked out from that same commit.
- OSV-Scanner is pinned by version and sha256 ([`packages/ci/tools.json`](../packages/ci/tools.json)).
- Its runtime dependencies (`yaml`, `semver`, `smol-toml` for Gradle version catalogs, and `fast-xml-parser` with its own seven for POMs and Maven metadata) install from this repository's lockfile, without lifecycle scripts. A smoke test installs only the CI workspace's production dependencies and loads its CLI.
- XML from repositories is read under fixed budgets: a 5 MB size cap, 100 levels of nesting, and DOCTYPE entities that are few (50), small (1,000 characters) and rarely expanded (1,000 times); none is fetched. A document over budget, using reserved names such as `__proto__`, or whose root doesn't close at its end (a truncated download) reads as nothing: for a POM, no source repository (a coverage gap); for Maven metadata, a failed check.
- npm registry lookups encode the whole package name and version as separate URL components. Names from lockfiles cannot add path separators, queries or fragments; empty and dot components are refused before fetching.
- It fails closed on what it needs to judge: an unreachable registry, OSV or GitHub API, data that doesn't parse, or a build that didn't resolve fails the check, never "clean". What it can't read but doesn't need to judge (a source repository's advisories that return 404, a range it can't parse) is a coverage gap: listed in the report, next to a verdict that can pass.
- The gate and both tools retry GET/HEAD reads only on connection timeouts or resets (`UND_ERR_CONNECT_TIMEOUT`, `UND_ERR_SOCKET`, `ECONNRESET`, `ETIMEDOUT`), at most twice, after 250–750 ms, then 500–1500 ms. No overall timeout is added; caller cancellation and fetch timeouts still apply. Bodies are buffered before parsing, so an interrupted read retries the whole request. Malformed JSON, HTTP errors, aborts and writes aren't retried. Exhaustion fails closed, naming the request and final cause. Concurrent lookups stop scheduling at the first failure, drain active work and report that failure; POM lookups stay limited to 16 per process.

## secure-it and bump-it

Both tools are in this tree: [`secure-it`](../packages/secure-it) and [`bump-it`](../packages/bump-it), using [`packages/remediation`](../packages/remediation).

- **Two GitHub tokens per tool**, both personal access tokens for now (PAT mode will remain an alternative when the planned GitHub App mode lands):
  - one that writes (branches, PRs, comments), only for the tool's own process;
  - one read-only, which the coding agent gets as `GH_TOKEN`.

  The tool refuses two Keychain items holding the same token. The default services are `leanish-<tool>-write` and `leanish-<tool>-read`; optional `secrets` overrides may point both tools to the same pair. Every opted-in repository uses that pair, with no per-repository secrets.
- **Secrets live in the macOS Keychain.** Only the tool's own process reads them. The write token never goes into an environment variable.
- **Repository code never runs in the tool's process.** The Gradle inventory runs the build under `codex sandbox` with the agent's write profile. Under that profile, checked on macOS, the Keychain isn't reachable, the sensitive home paths (`~/.ssh`, `~/.aws`, the Codex and Claude logins, shell startup files…) can't be read, and writes land only in the working copy, the temp dirs and the build cache. Both tools compute npm changes in exported scratch copies under the same sandbox, with `--package-lock-only --ignore-scripts`, explicit release-age flags and own-scope exclusions. The tool protects exact lockfile bytes and manifest dependency fields; only major migrations may adapt other manifest fields.
- **The Codex login source stays unreadable.** When a tool reuses a file-backed login, the sandbox denies the resolved `auth.json` and its canonical target when it is a symlink, including with a custom `CODEX_HOME`.
- **npm's age exclusions do not waive verification.** secure-it excludes planned young or unreadable targets, plus young or unreadable versions already locked in the affected base lockfiles, retaining configured own-scope exclusions. This lets npm keep unrelated locked security fixes. It checks sandboxed npm >= 11.17.0 before tool-run npm uses these flags; agent check commands receive the same exclusions in every mode. Every exclusion is reported; exact target verification and `compare` still judge all induced changes, including their age and identity.
- **PR CI reads use Actions and commit statuses.** The tools read workflow runs/jobs for the head SHA and the combined commit status, including their failure names for adaptation. No Checks API permission is required. Results from other apps must be published as commit statuses to be visible.
- **Tool-run Gradle builds never reuse a daemon.** Every inventory and tool-run wrapper task passes `--no-daemon` (in CI, exported base and working tree), so any daemon it needs is single-use and starts inside the current build's sandbox: a reused daemon keeps the permissions of the sandbox that started it. Agent commands may still start or reuse daemons in the shared `GRADLE_USER_HOME`; tool-run commands never connect to them. The flag is explicit; `GRADLE_OPTS`, `org.gradle.jvmargs` and repository properties are left alone.
- **Gradle wrapper generation stays in the tool's sandbox.** bump-it reads services.gradle.org's release metadata
  and checksums and one snapshot of gradle/gradle's published advisories, then runs the wrapper task twice under
  `runSandboxed` with `--no-daemon`, in an exported base commit; the model never generates or edits wrapper files.
  - Any change outside the four wrapper files (tracked or non-ignored) rejects generation; ignored cache and build
    output goes with the scratch copy.
  - The tool copies the generated bytes into the working tree and records all four hashes and executable modes in the
    plan. Verification, after the sandboxed inventory, checks those bytes and modes plus the official distribution
    URL/checksum and jar SHA-256; missing recorded hashes fail closed.
  - Planning errors are reported omissions; verification errors block publication.
  - Generated scripts are protected against later agent edits, not compared with official scripts.
- **Either coding agent runs in its CLI's sandbox, with the same denials.** `codex` runs under the write profile
  above. `claude-code` gets the equivalent through Claude Code's own settings, passed inline with no user, project
  or local settings loaded:
  - every Bash command runs in the sandbox, with no unsandboxed fallback;
  - the same denied paths, Keychain included, apply to Bash and, as `Read` rules, to the file tools;
  - edits stay inside the working copy, and its git metadata is denied to both;
  - no MCP servers or CLAUDE.md, no hooks except those an administrator's managed policy enforces, and no tools that
    publish, message, schedule, browse the web or start sub-agents;
  - no attribution in the PR text the agent writes.

  Write runs reach any host through the sandbox's proxy, as Codex's do. They also reach macOS's certificate trust
  service (`enableWeakerNetworkIsolation`): without it `gh` can't verify TLS and Node floods its output with
  trust-settings errors. That service is a possible exfiltration path, which upstream documents. Claude runs use the
  `claude` CLI's logged-in account and count against its plan windows; a run that hits a limit fails, and the logged
  failure says why. `codex` is still required either way: the tool's own sandboxed commands (`runSandboxed`) run
  under `codex sandbox`.
- **The agent edits a clone whose git metadata it can't write.** It can't commit or push. The `gh` and `git` guards on its PATH stop writes before they reach GitHub; they are guard rails, not a boundary. Its git reads neither the home's nor the system's git config, so a system credential helper (Homebrew's `osxkeychain`) can't hand it the developer's own GitHub credentials. So that a repository's own tests can run, the `git` guard lets through `-c core.hooksPath=/dev/null` and a push to a remote whose every push URL is on this machine, with git limited to the local transport.
- **Baseline Git reads are bound to the recorded metadata.** The tools name `gitDir` and the working tree explicitly for
  commit reads, diffs, exports and restoration, disable replace refs, and strip ambient Git configuration. The standalone
  CI CLI discovers its checkout's metadata once before reading commits. Both agent runners also make the working copy's
  `.git` entry unwritable, as well as the external metadata directory.
- **CI adaptation updates the published verdict.** After verification, both tools publish the agent's new title,
  description and commit message with the current plan and state markers, so the PR reports the latest adaptation and checks.
- **The tool decides versions, verifies the result with this gate, and publishes.** Every write to a PR re-reads it first and stops unless it's still the tool's, at the expected head. Nothing merges by itself.
- **Published text keeps the machine out.** In a PR's title, description and commit message, absolute paths inside the working copy become repository-relative, and paths under the home, temp, state and cache directories become `<local path>` ([`publication-text.ts`](../packages/remediation/src/publication-text.ts)). The tool's own `<!-- leanish:… -->` markers (its state and encoded plan) pass through: this cleans what readers see, not every byte.
- **Floor history stays intact.** secure-it compares recorded floors and their declarations before `compare`: compatibility floors never change, and security floors change only at exact planned targets with their scope and history preserved. New floors must be planned security additions, and only a dedicated floor-removal plan may remove security floors. Remaining target advisories are checked against compare's head findings from the same snapshot.
- **Strict pins stay the owner's.** The Gradle inventory marks strict declarations and records strict dependency constraints. Neither tool plans a change that would move a strict version where the change acts; the reference refuses to move one and compares strictness with the edit; and verification refuses, before compare, an edit that changes a `strictly` statement in a Gradle build, settings or catalog file, including balanced continuation lines (128 lines and 64 KiB maximum). Strings and comments do not affect balancing; an unbalanced or over-budget statement fails verification. A `strictly` inside a Kotlin or Groovy string interpolation (`${…}`) is code the check doesn't read, so it fails verification too. This textual backstop covers inactive branches too. A changed variable outside the statement remains a limit: the reference sees it only when that pin is active in the inventoried build.
- **Floor removal requires a joint unlocked proof**, computed in sandboxed scratch copies of base
  ([how](../packages/secure-it/README.md#removing-redundant-security-floors)). npm resolves without lifecycle scripts;
  Gradle runs with a trusted init script, `--no-daemon` and no configuration cache. Incomplete data keeps the floors.
  The tool writes exact npm/floor bytes; the agent only removes named Gradle declarations. Gradle still runs
  repository code and can misrepresent its own inventory, as noted above: this proof is not an independent Gradle
  resolver.
- **A push and its plan recover together.** Before updating a PR branch, the tool journals the intended head/base, title, full body (including the plan), and adaptation count. If the body update fails after the push, the next run or review restores that exact content with a guarded re-read. A legacy head/base-only recovery forces recomputation and verified republication in a run; review refuses readiness or adaptation until then.

Covered elsewhere, with the points that matter here:

- **npm resolution** (temporary exact pins, narrowed overrides, retention pins) is in the
  [secure-it](../packages/secure-it/README.md) and [bump-it](../packages/bump-it/README.md#run) READMEs. It runs
  sandboxed and scriptless; exempting a name from npm's window never authorizes a different explicit target, and final
  verification protects lock bytes and manifest dependency fields.
- **The npm required-dependency age exception** is the gate's own proof: it rebuilds the closure from lockfile
  placements, baseline overrides and registry manifests instead of trusting secure-it's plan or notes, and a limit hit
  grants nothing ([details](../packages/ci/README.md#npm-dependencies-required-by-a-security-fix)). Ordinary bumps and
  other ecosystems get no such exemption.
- **The skill answer schemas** the copied runtime accepts are in [`packages/agent-basics`](../packages/agent-basics/README.md);
  unknown fields and malformed objects still fail.
