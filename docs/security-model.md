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
- **Fork PRs** run the workflow from the fork's own files, with a read-only token and no secrets: their check is only as trustworthy as the PR, and nothing re-runs it from the default branch's files; see the adoption guide in [`core/gate/README.md`](../core/gate/README.md).

### npm signature verification

The `supply-chain` job runs the gate's `npm-signatures` command only after comparison completes with a passing verdict; a rejected source or any other comparison failure skips npm entirely.

For each configured npm lockfile, the verifier creates a fresh temporary project containing only that lockfile and the root and workspace `package.json` files. Workspace paths and links must stay within the staged project; only the root discovers workspaces, using an explicit list of staged directories instead of globs. An adjacent `npm-shrinkwrap.json` cannot replace the selected lockfile. Repository `.npmrc` files, executables and installed modules are never copied.

The verifier runs the trusted runner's npm twice: `npm ci` followed by `npm audit signatures`. Both commands use a fixed project prefix, `--ignore-scripts`, `--bin-links=false`, `--git=/usr/bin/false`, `--userconfig=/dev/null`, a separate empty global config, and a fresh cache and home. The child environment contains only the runner's command path, locale and platform variables plus those temporary directories. Tokens, `NODE_OPTIONS`, npm configuration variables and proxy variables are not inherited. Project configuration cannot select a Git executable, inject a registry or proxy override, or enable lifecycle scripts.

Registry flags come only from the gate's `npm.registries` configuration (HTTP(S), without embedded credentials). The first allowed registry is the default; scoped packages use the allowed registry recorded in their lockfile sources. Conflicting registries for the same scope fail. Git dependencies, tarball URL dependency specifiers and external file dependencies are refused; local links are permitted only for staged workspaces. Locked registry sources are checked again before invoking npm. The fixed Git executable also refuses Git access if npm encounters a specifier not covered by those checks.

Temporary projects, homes and caches are removed on success or failure. This boundary prevents repository-selected executable execution; it is not an operating-system sandbox for npm itself. It trusts the runner's Node/npm installation and the registry archive handling and signature-verification implementation in npm. Private registry credentials and repository-specific proxy settings are deliberately unavailable to this verifier.

### Reading npm archives for bundled fixes

A young carrier's `bundle-fix` justification needs at least one reviewed bundled advisory it fixes; its own reviewed
targets join the combined choice. An own-only fix needs the ordinary young-fix proof or an explicit `releaseAge` exception.

To prove a young carrier version as a bundled fix (and for secure-it to choose one), the gate downloads registry archives itself: only from the npm registry, at the package's own tarball URL, refusing redirects. A download counts against fixed budgets (compressed and unpacked bytes, entries, manifest size, a deadline, and bytes per run), and its sha512 must match the integrity the lockfile records (or, for a candidate version, the one the registry publishes) before anything read from it is used. It is gunzipped and read as a tar stream in memory: files and directories only, one top directory, no path twice, no absolute or `..` paths; only package manifests are kept, and a bundled package whose files have no manifest makes the archive unreadable. Nothing is written to disk or executed. Whatever can't be read this way leaves the young version unjustified; it never reads as an empty bundle.

## Young versions: the cooldown

The release-age wait exists because malicious releases (a stolen publishing token, a hijacked release workflow) tend
to be noticed and pulled within days. A security fix younger than the wait is exactly what such an attacker would
ship: the advisory creates urgency, and its severity, however high, says nothing about whether the fixing release
is genuine. For GitHub Actions the age comes from the release, and only an immutable release's: an attacker who
controls an action could otherwise move an old release's tag to new code, which would arrive already "old". Proving that a version is the rule-picked fix, or the lowest version that fix requires, limits *which*
young version comes in; it doesn't make that version safe, and the build, tests and CI run it either way.

So the gate holds every young version a PR adds or changes, justified or not: the separate `cooldown` check stays
red until the last one turns old enough, and no exception clears it. secure-it keeps such fixes in draft PRs of
their own. Taking one earlier is a person's explicit decision.

The gate also reads a dependency's own repository advisories, which name a fix days before GitHub reviews them into
its database and OSV imports them. Whoever controls that repository and the package can publish an advisory and a
"fixed" version together to get a young version proposed early. So such unreviewed advisories detect and rule
versions out, but never trigger a fix nor justify a young version; one can still steer the choice by ruling a
version out, which the plan records, and whatever comes early stays held. The rules:
[how each source counts](../core/gate/README.md#how-each-source-counts). Details:
[the gate's cooldown](../core/gate/README.md#the-cooldown-young-versions-are-held-however-justified) and
[secure-it's warning](../secure-it/README.md#the-cooldown-warning).

## The gate itself

- It's pinned to one full commit SHA, and checked out from that same commit.
- OSV-Scanner is pinned by version and sha256 ([`core/gate/tools.json`](../core/gate/tools.json)).
- Its runtime dependencies (`yaml`, `semver`, `smol-toml` for Gradle version catalogs, and `fast-xml-parser` with its own seven for POMs and Maven metadata) install from this repository's lockfile, without lifecycle scripts. A smoke test installs only the CI workspace's production dependencies and loads its CLI.
- XML from repositories is read under fixed budgets: a 5 MB size cap, 100 levels of nesting, and DOCTYPE entities that are few (50), small (1,000 characters) and rarely expanded (1,000 times); none is fetched. A document over budget, using reserved names such as `__proto__`, or whose root doesn't close at its end (a truncated download) reads as nothing: for a POM, no source repository (a coverage gap); for Maven metadata, a failed check.
- A lockfile entry that keeps its name and version but changes its source, bytes or bundling (`resolved`, `integrity`, `inBundle`) fails: nothing about the version tells the new artifact from the original, so the age and identity checks a version change gets can't apply.
- npm registry lookups encode the whole package name and version as separate URL components. Names from lockfiles cannot add path separators, queries or fragments; empty and dot components are refused before fetching.
- It fails closed on what it needs to judge: an unreachable registry, OSV or GitHub API, data that doesn't parse, or a build that didn't resolve fails the check, never "clean". What it can't read but doesn't need to judge (a source repository's advisories that return 404, a range it can't parse) is a coverage gap: listed in the report, next to a verdict that can pass.
- The gate and both tools retry GET/HEAD reads only on connection timeouts or resets (`UND_ERR_CONNECT_TIMEOUT`, `UND_ERR_SOCKET`, `ECONNRESET`, `ETIMEDOUT`), at most twice, after 250–750 ms, then 500–1500 ms. No overall timeout is added; caller cancellation and fetch timeouts still apply. Bodies are buffered before parsing, so an interrupted read retries the whole request. Malformed JSON, HTTP errors, aborts and writes aren't retried. Exhaustion fails closed, naming the request and final cause. Concurrent lookups stop scheduling at the first failure, drain active work and report that failure; source-repository lookups run at most 16 packages at a time per pass, each walking up to 5 parent POMs.

## secure-it and bump-it

Both tools are in this tree: [`secure-it`](../secure-it) and [`bump-it`](../bump-it), using [`core/tool-runtime`](../core/tool-runtime).

- **Two GitHub tokens per tool**, both personal access tokens for now (PAT mode will remain an alternative when the planned GitHub App mode lands):
  - one that writes (branches, PRs, comments), only for the tool's own process;
  - one read-only, which the coding agent gets as `GH_TOKEN`.

  The tool refuses two Keychain items holding the same token. The default services and the `secrets` overrides are in the [config reference](tool-configuration.md).
- **Secrets live in the macOS Keychain.** Only the tool's own process reads them. The write token never goes into an environment variable.
- **Repository code never runs in the tool's process.** The Gradle inventory runs the build under `codex sandbox` with the agent's write profile. Under that profile, checked on macOS, the Keychain isn't reachable, the sensitive home paths (`~/.ssh`, `~/.aws`, the Codex and Claude logins, shell startup files…) can't be read, and writes land only in the working copy, the temp dirs and the build cache. Both tools compute npm changes in exported scratch copies under the same sandbox, with `--package-lock-only --ignore-scripts`, explicit release-age flags and own-scope exclusions. The tool protects exact lockfile bytes and manifest dependency fields; only major migrations may adapt other manifest fields.
- **The Codex login source stays unreadable.** When a tool reuses a file-backed login, the sandbox denies the resolved `auth.json` and its canonical target when it is a symlink, including with a custom `CODEX_HOME`.
- **npm's age exclusions do not waive verification.** secure-it excludes planned young or unreadable targets, plus young or unreadable versions already locked in the affected base lockfiles, retaining configured own-scope exclusions. This lets npm keep unrelated locked security fixes. It checks sandboxed npm >= 11.17.0 before tool-run npm uses these flags; agent check commands receive the same exclusions in every mode. Every exclusion is reported; exact target verification and `compare` still judge all induced changes, including their age and identity.
- **PR CI reads use Actions and commit statuses**, so no Checks API permission is required
  ([what review reads](../core/tool-runtime/README.md)).
- **Tool-run Gradle builds never reuse a daemon.** Every inventory and tool-run wrapper task passes `--no-daemon` (in CI, exported base and working tree), so any daemon it needs is single-use and starts inside the current build's sandbox: a reused daemon keeps the permissions of the sandbox that started it. Agent commands may still start or reuse daemons in the shared `GRADLE_USER_HOME`; tool-run commands never connect to them. The flag is explicit; `GRADLE_OPTS`, `org.gradle.jvmargs` and repository properties are left alone.
- **Gradle wrapper generation stays in the tool's sandbox.** bump-it runs the wrapper task twice under
  `runSandboxed` with `--no-daemon`, in an exported base commit; the model never generates or edits wrapper files.
  Generated scripts are protected against later agent edits, not compared with official scripts. The selection,
  generation, verification and failure rules are in [bump-it](../bump-it/README.md#gradle-wrapper).
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
- **The agent edits a clone whose git metadata it can't write.** It can't commit or push. Verification reads a snapshot of the edit, a commit of the working tree taken when the agent is done and recorded in that metadata, never the live working tree; publication commits exactly that snapshot's tree and refuses when the staged tree differs. A process the agent (or the repository's code) left running can still write the working tree, but nothing it writes after the snapshot is published. The `gh` and `git` guards on its PATH catch a mistaken GitHub write or push early, with a message saying the tool publishes; they are guard rails, not a boundary (the agent's token is read-only, and the `git` guard checks only pushes). Its git reads neither the home's nor the system's git config, and the sandbox can't read `~/Library/Keychains` or `~/.git-credentials`, so a credential helper (Homebrew's `osxkeychain`, git's `store`), even one the agent names itself with `-c credential.helper=…`, finds none of the developer's own GitHub credentials. So that a repository's own tests can run, the `git` guard lets through a push to a remote whose every push URL is on this machine, with git limited to the local transport. The tools refuse an edit that adds or changes a symbolic link or a submodule, or changes anything an existing link leads to (links in parent folders and chains followed); a link leading out of the repository fails any edit that doesn't remove it, since it could come back in anywhere, and so does one leading to a path the commit has only by another case or Unicode form, since a case-insensitive checkout (macOS's) could take it there; other links the edit leaves alone are the repository's own and are tolerated. Verification reads a commit, where a link is only the path it points to, so it can't check what's behind one.
- **Baseline Git reads are bound to the recorded metadata.** The tools name `gitDir` and the working tree explicitly for
  commit reads, diffs, exports and restoration, disable replace refs, and strip ambient Git configuration. The standalone
  CI CLI discovers its checkout's metadata once before reading commits. Both agent runners also make the working copy's
  `.git` entry unwritable, as well as the external metadata directory.
- **The tool decides versions, verifies the result with this gate, and publishes.** Every write to a PR re-reads it first and stops unless it's still the tool's, at the expected head. Nothing merges by itself.
- **Published text keeps the machine out.** A PR's title, description and commit message carry no local paths, and the
  tool's own plan block is always the first one read; this cleans what readers see, not every byte. The rules are in
  [tool-runtime](../core/tool-runtime/README.md) ([`publication-text.ts`](../core/tool-runtime/src/publication-text.ts)).
- **Floor history stays intact.** secure-it compares recorded floors and their declarations before `compare`:
  compatibility floors never change, and security floors change only at exact planned targets, or in a dedicated
  floor-removal plan ([verification](../secure-it/README.md#what-a-run-does), step 6).
- **Strict pins stay the owner's.** Gradle interprets the build and catalogs. Its inventory records each resolved
  configuration's external module declarations and constraints, including their full rich versions. Project dependencies
  are excluded. Constraints without a group or name (including ungrouped projects) are skipped; grouped project
  constraints remain in the comparison because Gradle's public constraint API exposes no project marker.
  Neither tool plans a move of a strict pin where the change acts, and the reference refuses to move one. Both tools compare that planned reference with the
  edit, configuration by configuration, including each declaration's and constraint's strict, required and preferred
  versions, rejected versions (order independent), and branch
  ([`gradle-reference.ts`](../core/tool-runtime/src/gradle-reference.ts)). Changing, adding or removing an
  interpreted pin, turning it into a plain declaration at the same version, or changing any rich-version facet
  (strict or otherwise) fails verification even when the resolved modules stay the same. The comparison
  also applies during secure-it's floor removal and covers catalog versions that Gradle uses. Declaration
  `because(...)` reasons and graph edges are exported but aren't compared here; secure-it checks floor reasons separately.
  The reference-only `moved` markers prove the plan's declaration moves rather than matching edit markers.
  There is no separate textual or parsed pin check, Java parser run, compiler download, `unzip` requirement or parser
  state directory; Gradle still uses its normal build toolchain.
  A pin Gradle doesn't resolve isn't checked, by the owner's choice ([coverage gaps](coverage-gaps.md#limits)). The
  existing limits on which files routine plans may edit still apply.
- **Floor removal requires a joint unlocked proof**, computed in sandboxed scratch copies of base
  ([how](../secure-it/README.md#removing-redundant-security-floors)); incomplete data keeps the floors.
  The tool writes exact npm/floor bytes; the agent only removes named Gradle declarations. Gradle still runs
  repository code and can misrepresent its own inventory, as noted above: this proof is not an independent Gradle
  resolver.
- **A push and its plan recover together.** Before updating a PR branch, the tool journals the intended head, base,
  title, full body (including the plan) and adaptation count, so a failed body update is restored by the next run or
  review ([tool-runtime](../core/tool-runtime/README.md), `journal.ts`).

Covered elsewhere, with the points that matter here:

- **npm resolution** (temporary exact pins, narrowed overrides, retention pins) is in the
  [secure-it](../secure-it/README.md) and [bump-it](../bump-it/README.md#run) READMEs. It runs
  sandboxed and scriptless; exempting a name from npm's window never authorizes a different explicit target, and final
  verification protects lock bytes and manifest dependency fields.
- **The npm required-dependency age exception** is the gate's own proof: it rebuilds the closure from lockfile
  placements, baseline overrides and registry manifests instead of trusting secure-it's plan or notes, and a limit hit
  grants nothing ([details](../core/gate/README.md#npm-dependencies-required-by-a-security-fix)). Ordinary bumps and
  other ecosystems get no such exemption.
- **Scheduled desktop-app tasks** run one exact launcher command that the app lets out of its sandbox without checking
  the code the command runs. So the task's folder is its own (`~/.local/share/leanish/tasks/<task>`), never the release
  checkout: the automation can write its project folder (plus temp folders, where the runtime only creates files under
  random, exclusively created names), and must not be able to change the launcher, its modules or installation state.
  A Claude task must also not run in a permission mode that approves edits outside its folder. How setup enforces
  this is in the [setup commands](../core/setup/README.md#local-app-schedules).
- **The skill answer schemas** the copied runtime accepts are in [`core/agent-runtime`](../core/agent-runtime/README.md);
  unknown fields and malformed objects still fail.
