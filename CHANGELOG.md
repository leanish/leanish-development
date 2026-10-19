# Changelog

## Unreleased

### Added

- A guided installer, `core/setup`, with the skills `install-bump-it`, `install-secure-it` and `add-repository` for
  Claude Code and Codex, all following `core/setup/install.md`. Its commands check the Mac (`doctor`), install a
  verified stable release (`release`), write one installation per GitHub owner (`configure`), print GitHub's pre-filled
  fine-grained PAT forms and the Keychain commands the person runs (`enroll`), check the tokens' reads
  (`verify-tokens`), open the gate adoption PR and propose its settings (`gate`), run the tools (`batch`, `test-run`
  for one repository), and describe the desktop app's scheduled task and check its readback (`schedule`,
  `schedule-check`): tool defaults, or the time and day the person picks. Guided setup needs stable v0.7.0 or
  newer; it never creates the app task itself, never merges and never sees a token. `release --candidate vX.Y.Z-rc.N`
  installs a candidate published as an immutable GitHub prerelease, so guided setup is accepted before its release; a
  candidate runs only on the fixture repositories.
- `fixture-cleanup` in `core/setup` deletes every `bump-it/` and `secure-it/` branch on the fixture repositories
  before a candidate's fixture runs (their PRs close with them), each only while it's unchanged; `fixture-repin` opens
  one PR per fixture moving only its gate caller to a new stable release. Both dry-run by default.

### Changed

- The repository is now `leanish/leanish-development` (formerly `leanish/supply-chain`). GitHub's redirect doesn't
  cover reusable workflows, so a caller's `uses:` must name `leanish/leanish-development`.
- The fixture repositories are renamed from `supply-chain_TEST_<case>` to `leanish-development_TEST_<case>`, or
  `leanish-development_<tool>_TEST_<case>` for a case designed for one tool; both commands accept only these names.
- When bump-it or secure-it redoes one of its open PRs from the default branch, the agent now starts from the exact
  base, like a new PR, and the published commit keeps the PR's history as its parent. Before every agent call a guard
  refuses changes the input doesn't declare. This needs git 2.42 or newer.
- `core/setup`'s `release` picks the highest stable version, not the latest publication, so a maintenance release
  published after a newer line isn't installed.
- Shared packages now live in `core/agent-runtime` (`@leanish/agent-runtime`), `core/tool-runtime`
  (`@leanish/tool-runtime`) and `core/gate` (`@leanish/gate`); `bump-it` and `secure-it` live at the root.
  Cross-package imports use explicit package exports, with workspace and dependency boundaries checked at the root.

### Fixed

- Both tools create their cache directory (`dirs.cache`, private to the user) before starting the sandbox, which can
  write inside it but can't create it: on a fresh installation npm failed there with `EPERM`.

## 0.6.1 - 2026-10-18

### Fixed

- Both tools accept Maven security floor declarations added by a planned plugin update, including identical duplicates,
  while preserving every base declaration and checking resolution stays at or above the recorded floor.
  secure-it also preserves declaration reasons. Compatibility floors retain exact declaration comparison in both tools.
  Added declarations must match the independent Gradle reference built from base plus the plan, even when a plugin
  move is planned. Losing a base resolution fails verification. npm overrides are unchanged.

## 0.6.0 - 2026-10-16

### Changed

- Strict pins are protected through what Gradle resolves: verification compares declared strict versions and strict
  constraints in the planned reference with the edit, including pins supplied by catalogs. The separate script and
  catalog parser check is removed, with no parser-specific Java run, compiler downloads or `unzip` requirement.
  By the owner's decision, pins Gradle doesn't resolve (an inactive branch, an unused catalog entry, a build the
  inventory doesn't run) aren't checked; the agent's instructions and the PR diff cover them.

### Fixed

- Both tools compare every rich-version facet of Gradle declarations and dependency constraints with the planned
  reference: strict, required and preferred versions, rejected versions and branch. Removing a reject from an active
  strict range now fails verification even when resolution stays the same; non-strict external constraints are covered too.
  Plain-version declarations keep their previous output; rich versions emit only set facets, defaulted to empty on read.
  Constraints without a group or name are skipped using Gradle's public API, so constraining a root project without
  a group no longer aborts the inventory. Grouped project constraints remain in the comparison.
- A path the edit adds behind an existing link is matched regardless of case, as a case-insensitive checkout places
  `FOO/x` in a linked `foo/`.
- An npm `integrity` filled in for a same-version entry that had none no longer fails the gate: it only pins the bytes
  the same URL serves. Removing or changing one still fails.
- An edit that removes a link leading out of the repository, or to a case or Unicode variant, is no longer refused for
  it; only the links the edit's own tree has are. A variant is now found on the way through a link too, not only at its
  end.
- Link targets are read in one `git cat-file --batch`: 2,000 links take about half a second instead of 50.
- A submodule moved to another commit is reported as moved, not as added.
- bump-it never moves the Gradle wrapper to a release a malware advisory (CWE-506) covers, even one the installed
  wrapper shares, and reports an installed wrapper such an advisory covers.
- A bump-it major fails visibly when it brings a new transitive version from the npm registry that is deprecated, or
  whose catalog can't be read to rule that out.
- A `uses` key written as a YAML alias is read like any other.
- Maven versions compare a sub-list against a missing component item by item, as Maven does: `1.0-0.1` is above
  `1.0`, so an advisory covering `>1.0` matches it.
- An action's versions are its full release tags only: a partial tag (`v1.1`), which a pin's comment can't name, is
  no longer picked over a full one (`v1.0.1`) and then refused at verification.
- Publication recognizes conflict markers at the size the staged `.gitattributes` give a file (shorter or longer than
  seven) as well as seven or more whatever it says; a separator counts only alone on its line at that size, so a
  Markdown heading's underline (a longer run of `=`, or one followed by text) isn't one.
- A damaged or hand-edited entry of a tool's publication journal fails the review that reads it, instead of being
  trusted to recover a PR's body.
- A conflicted file only named like a Gradle catalog (`xgradle/libs.versions.toml`) is no longer taken from the base
  side as a dependency file when reviewing a PR: conflicts resolve mechanically for exactly the files a move may touch.
- A key named `uses` outside a job or step (`env: { uses: production }`, an action input) no longer fails the Actions
  inventory: it counts when it reads as an action and is otherwise left alone; a job's or step's `uses:` stays strict.

## 0.5.2 - 2026-10-15

### Changed

- An action's release age is trusted only from an immutable GitHub release: a mutable one's tag can be moved to
  newer code that would inherit its age. A changed action without an immutable release fails the gate, and the tools
  don't pick such a version (bump-it says so in a note). Updates to actions whose releases are mutable, among them
  `actions/checkout`, `actions/upload-artifact` and `actions/download-artifact` in October 2026, are a person's.

### Fixed

- The tools refuse an edit that adds or changes a symbolic link or a submodule, or changes anything an existing link
  leads to (links in parent folders and chains followed): verification reads a commit, where a link is only the path
  it points to. A link leading out of the repository, or to a path the commit has only by another case or Unicode
  form (where a macOS checkout could take it), fails too; other links the edit leaves alone are the repository's own.
  The gate reads links as 0.5.1 did (a documented gap).
- A catalog's strict version is compared with the whole entry it belongs to (module, group, name), and with the entries
  whose `version.ref` names it, so an edit can't move a pin to another dependency.
- Documented: a case variant reached through an intermediate link isn't refused yet (planned for 0.6.0).
- Documented as pre-existing: Maven versions that differ only in a trailing `-0.…` part (`1.0-0.1`) compare as equal
  when matching repository advisories.
- Documented as pre-existing: a lookalike host (`notgithub.com/acme/lib`) is read as a GitHub repository when looking
  up a package's repository advisories.

The 0.5.2-rc.7 review's finding:

- Documented as pre-existing: custom conflict-marker sizes.

The 0.5.2-rc.4 review's findings:

- secure-it recognizes its PRs by the unit their recorded plan names, not by the branch topic: two packages whose
  names make the same branch-safe topic (`@scope/foo`, `scope-foo`) no longer share a PR, and a numbered branch cut
  to fit a long topic is recognized instead of opening another.
- Documented as known deficiencies, to fix next: bump-it could move the Gradle wrapper to a release a malware
  advisory also covers, and doesn't check transitives a major brings in for deprecation; npm aliases without a
  version can't be updated automatically.

The 0.5.2-rc.3 review's findings:

- secure-it numbers an occupied branch after cutting its topic to length, as bump-it does, so a long topic whose
  branch is taken no longer loops forever.
- Documented: the gate scans a bundled package as the lockfile records it (the archive is compared only for bundle
  proofs and secure-it's bundled moves), and bump-it's choice of a partial tag (`v1.1`) fails verification visibly.

The 0.5.2-rc.2 review's findings:

- Implicit npm lockfile discovery refuses a root `npm-shrinkwrap.json`, even after `package-lock.json` is removed.
  The owner must list it in `npm.lockfiles`; compare, scan and signatures enforce the same selection rule.
- TOML catalog strict pins are compared as parsed key paths and values with `smol-toml`, including multiline
  values, dotted keys and inline tables. Changed pins and non-parsing catalogs fail verification.
- Documented: the hand-written Kotlin/Groovy lexer can miss changed strict pins in inactive branches when strings
  or comments are not understood (including Groovy slashy/dollar-slashy strings). Active pins remain checked by the
  inventory; replacing the lexer with Gradle's official Groovy/Kotlin parsers is planned for 0.6.0.
- Documented: scalar YAML action aliases cannot be updated automatically and fail verification visibly; a mutable
  release in a fixing line blocks its selection even if an immutable fix exists.
- Clarified: agent checks run whenever the agent is invoked. Mechanical npm/wrapper-only bump-it routines verify
  dependencies and rely on the PR's CI for repository tests.

The 0.5.2-rc.1 review's findings:

- A selected `package-lock.json` with an `npm-shrinkwrap.json` beside it in head fails the gate, since npm installs
  from the shrinkwrap; the owner lists the effective lockfile.
- A `compatibleLines` override counts segments after a leading `v`, so an action's `v1` → `v2` is a major, not a
  routine update.
- A nested block comment in a changed Gradle build, settings or catalog file fails the strict-pin check, since its
  boundaries could hide a pin.
- Documented: secure-it can't move one action to two version lines in one workflow (verification refuses it
  visibly), and an action's age counts only from an immutable release.

The 0.5.1 release review's six findings, each refusing the case visibly:

- Both tools verify a snapshot commit of the agent's edit and publish exactly its tree, so nothing written to the
  working tree after verification (by a process left running) is published.
- An edit that adds a symbolic link fails verification (the final rule for links is the first entry above).
- A same-version npm lockfile entry whose source, integrity or bundling changed fails the gate.
- The Gradle inventory fails when a configuration becomes resolvable while others resolve, instead of leaving it out.
- A line with a Kotlin or Groovy string interpolation that mentions `strictly`, or an interpolation that spans lines
  or holds comments, escapes or triple-quoted strings, fails the strict-pin check.
- A merge's conflicted paths are checked for markers in what is staged, not in the working file, and a refused
  publication leaves their conflicts in place, so a retry checks them again.

## 0.5.1 - 2026-10-14

### Changed

- The gate workflow uses `actions/download-artifact` v8.0.2 and `actions/upload-artifact` v7.0.2.
  Adopters get them by repinning `supply-chain.yml` to this release's commit; updating the tools'
  checkout alone doesn't change the workflow they run.

### Fixed

- Verification's check that no edit changes a Gradle `strictly(...)` pin reads triple-quoted
  strings (Kotlin raw strings, Groovy's `"""` and `'''`, TOML multiline strings) as strings.
  Before, a quote inside one could hide a change to a later pin in an inactive branch.

- The agent's git commands ignore the system's git config (`GIT_CONFIG_NOSYSTEM`), as the
  tool's own already did: a system credential helper, such as Homebrew's `osxkeychain`, could
  otherwise hand them the developer's own GitHub credentials.

- A repository's own tests now run under the agent: the `git` guard lets through
  `-c core.hooksPath=/dev/null` and a push to a remote whose every push URL is on this machine
  (the bare repositories tests create), with git limited to the local transport for that push.
  Only the push options the tests and workspaces use pass, wherever they appear on the command line.
  Tests no longer depend on the machine's Codex login, git askpass or package directory.

## 0.5.0 - 2026-10-14

### Added

- Claude Code as the tools' coding agent: `agent.codingAgent: claude-code` with a Claude model (for
  example `claude-haiku-5-5`). The agent edits only inside Claude Code's sandbox, with the same
  denied paths as Codex. Every command runs in the sandbox, git metadata is out of reach, and no MCP
  servers, outward tools (publishing, messaging, scheduling, web, sub-agents) or hooks beyond an
  administrator's managed policy are available. The PR text carries no attribution. Write runs reach
  macOS's certificate trust service, so `gh` can verify TLS. Usage, the CLI's own cost estimate and
  the reason a run failed (such as a plan limit) come from its stream-json output. Codex is still
  required for the tool's own sandboxed commands.

- `packages/ci/dependency-floors.schema.json`, the JSON Schema of `.github/dependency-floors.json`,
  tested to agree with the gate's parser. secure-it's skill embeds it with how a `gradle-floor`
  move maps to a record, so the agent no longer guesses the format (missing `purpose`, `name`
  instead of `package`) when a repository has no floors file yet.

### Changed

- Published PR text keeps the local machine out. In the title, description and commit message, a path inside the
  working copy becomes repository-relative, and one under the home directory, the temp dirs or the tool's state and
  cache becomes `<local path>`. Node's sandbox trust-settings banner lines are dropped. The tool's state marker and
  encoded plan are left as they are. The journal records the cleaned text, so a recovery restores it.

- The skills ask for the repository's checks in every mode, and for a major's release notes or changelog, linked in
  its verdict (or a note saying they couldn't be read). secure-it creates the floors file only when a change adds a
  floor, and a floor removal leaves the owner's plain declaration of the same coordinate in place.

- **Breaking:** `agent.majorEffort` is gone; remove it from `agent.yaml`. `agent.effort` applies
  to every agent call, majors included, as in leanish-development's runtime.

- The planners leave Gradle `strictly(...)` pins alone too. The Gradle inventory (schema 3)
  marks strict declarations and records strict dependency constraints, and rejects output from
  an older inventory script. bump-it never moves a coordinate pinned strictly in a configuration that
  declares it, and notes the pin; secure-it reports a fix as blocked when its coordinate is
  pinned strictly where the fix would act (where it's vulnerable, and
  every configuration declaring it), never takes such a coordinate as a parent that
  carries a fix, and keeps a floor declared strictly. Only the configurations a change touches
  count: Gradle pins its embedded Kotlin strictly on every buildscript and settings classpath,
  which doesn't block fixing a Kotlin library on the project's classpaths. The reference refuses to
  move a strict version and compares strictness with the edit.

- bump-it and secure-it never change a Gradle `strictly(...)` pin: their skills say so (the agent
  answers cannot-apply when a plan needs it), and verification refuses an edit that changes a
  `strictly` statement, including its balanced continuation lines, in a build, settings or catalog
  file.

- The skills ask for better agent output: only the needed changes, in the file's style;
  comments and docs the edit makes false fixed without losing their context; code kept only for
  an unsupported old major removed; and PR text that maps advisories to packages, gives
  `from → to`, states each major's adaptation verdict and the checks run, without repeating the
  tool's table, narrating the process or carrying sandbox noise. secure-it's skill also says
  the floors file holds only `floors`, never the schema's keywords.

- secure-it's skill says to floor a configuration a plugin fills with defaults (`checkstyle`)
  in a declarations-only parent configuration (`isCanBeResolved = false`,
  `isCanBeConsumed = false`), and not to add configurations Gradle can resolve, which
  verification rejects.

- The tools' PR body marker is `<!-- leanish:<tool> -->`, named like their label; a PR is theirs
  when it carries either.

### Fixed

- Both tools bind baseline reads, diffs and exports to their recorded git metadata and disable
  replace refs, so a redirected working-copy `.git` cannot change verification. Both coding-agent
  runners also protect the `.git` entry.
- Strict-pin verification captures balanced multiline `strictly(...)` statements, including
  inactive branches, rather than only their first line; unreadable or over-budget statements fail
  verification.
- CI adaptations publish the agent's new title, verdict and check results with the verified plan,
  instead of keeping the initial PR description.

- bump-it no longer fails a routine when a refreshed parent's range stops admitting a young
  locked copy it was keeping: the copy's current version is checked like any unpinned
  replacement (aged and not deprecated) instead of being pinned back to the old version pass
  after pass.

- Installing OSV-Scanner is safe when several tool commands sharing a state directory install
  it at the same time (the first pass with a fresh state directory, or after a version bump):
  each download gets its own temporary name before the atomic rename, instead of one fixed name
  that a concurrent install could move away mid-check.
### Known limits

- The `strictly` text check reads Kotlin triple-quoted strings as ordinary quotes; one containing
  quotes earlier in a build file can hide a change to a later, inactive strict pin.
- PRs are recognised by the current tool label and markers only. A PR opened by v0.4.2 whose label
  couldn't be added is no longer reviewed; close it, and the next run opens a fresh one.

## 0.4.2 - 2026-10-12

### Fixed

- bump-it's routine keeps an accepted aged replacement of an unpinnable locked copy when a
  later pass makes that copy pinnable, instead of pinning it back to its young locked version
  and failing the unit. When a later pass changes what its dependents or the repository's
  overrides ask for so they no longer admit the remembered version, or to something bump-it
  can't judge (a spec that isn't a version range, a scoped or complex override), the copy's
  current version is checked again (aged and not deprecated) instead of being pinned back to
  the stale one.

## 0.4.1 - 2026-10-12

### Added

- secure-it and bump-it emit one JSON GitHub API request summary per command on
  stderr, grouped by method and normalized endpoint, including retries and failures.
- Local tools cache complete repository security advisory listings for one hour
  under `dirs.state` (out of the sandbox's reach, so a build or agent can't hide an
  advisory; a state directory resolving into a sandbox-writable one is refused),
  across snapshots and processes. Writes are atomic; corrupt
  or unavailable cache entries are misses and failed/partial responses are never
  cached. The CI gate continues fetching fresh advisories.

### Fixed

- bump-it's routine protects non-bundled locked transitive versions when npm's age window
  excludes their package name to preserve a young or unreadable locked version.
  Temporary pins prevent drift where supported, narrowing compatible plain overrides and
  restoring them afterwards. Unsupported placements, including shared overrides
  whose copies need different targets, are checked after resolution:
  replacements must be aged and not deprecated; another young, deprecated or
  unreadable version fails the unit.
  Bundled copies follow their carrier's aged update. This avoids
  failures on a newer release's young dependencies. Unused copies can be removed.

## 0.4.0 - 2026-10-11

### Changed

- The gate's scheduled (and manually dispatched) run scans only the default
  branch. Open PRs are no longer rescanned daily: a PR is judged when it's
  opened, pushed to, reopened or retargeted. That drops the three rescan jobs
  every PR showed as skipped and the commit statuses the rescan posted.
  - An advisory published after a PR's last check shows up on its next push, or
    in the default branch's scan once merged.
  - A person's PR held by the cooldown stays red until it's pushed to or its
    whole workflow is re-run after the hold's date. secure-it and bump-it retire
    their own held PRs as before.
  - Fork PRs no longer get a trusted daily status: check them yourself.
- **When repinning**, drop from the calling workflow the `required-check` and
  `required-cooldown-check` inputs (an unknown input makes the call invalid),
  the `pull-requests: read` and `statuses: write` grants, and the
  `workflow_dispatch` `pr` input. Statuses an older gate already posted stay on
  a PR's head until it's pushed to; the tools still read a failing cooldown
  status as a hold.

### Fixed

- A read GitHub refuses says why: which rate limit is spent and until when (from
  GitHub's headers), a secondary limit's wait, or that the token may lack access.
  Before, every 403 suggested setting `GITHUB_TOKEN`, even with a token set.

### Removed

- secure-it's check that the daily scan still runs, and its `staleScanHours`
  option (now an unknown field: delete it from `agent.yaml`). It warned on every
  repository whose scheduled scan failed for a real finding, already visible as a
  failed run; in the owner's repositories it never flagged a scan that had
  stopped running.
- The CLI's `rescan-plan` and `rescan` commands, `prepare-pr.sh`, and the
  report's `prHeadSha`.

## 0.3.0 - 2026-10-11

### Added

- secure-it fixes a vulnerable copy an npm package bundles in its tarball
  (`inBundle`, e.g. brace-expansion inside aws-cdk-lib) by moving that
  carrier: to the version the security rule picks for the advisories its
  bundle drops (and its own, if it has failing ones), reading each carrier
  version's bundle from its registry archive, authenticated against its
  sha512. Before, a bundled copy couldn't be fixed at all. The PR's table
  says which bundled packages change and to what; a carrier that would need an
  npm override is reported instead.
- The gate accepts a young carrier version as a `bundle-fix` (still held by the
  cooldown): every head copy must replace the old version in place, both
  archives must authenticate and match what each lockfile records, and it must
  be the version the rule picks. Before, a young carrier failed the release-age
  rule, since the advisory isn't on the carrier itself. Required dependencies
  of such a carrier aren't proved (a young one fails the comparison).
- When a parent's range excludes a transitive npm copy's security target,
  secure-it first looks for a version of that parent in its own line, past
  the release-age wait, whose ranges admit the targets (no new advisory, same
  publisher, movable without an override itself), and moves both, the copy
  locked inside the parent's new range. When the parent must admit several
  copies, it takes the version admitting the most (the lowest of those that
  tie); the copies it can't admit keep the override and floor, with the reason
  in the PR's notes, as does every copy when no parent can move.
- In Gradle, before flooring a vulnerable transitive (or plugin-declared)
  module, secure-it looks for a dependency the sources declare that brings it
  in every affected configuration, and that dependency's lowest version in its
  own line past the wait which, applied by Gradle in a reference resolution,
  brings a version without the advisories (okhttp 4.9.3 → 4.12.0 for okio's,
  say). That declaration then moves wherever it's declared, and verification
  checks the module's advisories are gone. At most 6 reference runs per
  module; a failed or spent search falls back to the floor, with a note.

### Changed

- The Gradle inventory (schema 2) records each configuration's resolved
  edges, who brought what, so secure-it can find the declaration behind a
  transitive. Inventory jobs and the comparison must run the same release, as
  they do through the reusable workflow.

### Fixed

- secure-it rewrites the notes of its open PR when a later run finds the same
  plan with different reasons (a floor kept for another cause, say). Before,
  the PR kept the first run's reasons, since notes don't change the plan.
- Removing a Gradle security floor declared on a buildscript or settings
  classpath no longer fails on Gradle 9 ("Cannot mutate the hierarchy of
  configuration 'classpath' after the configuration was resolved"), which
  kept such floors with that error as the reason. Nor does removing one in a
  nested build such as buildSrc report its configuration missing (its location
  never matched the plan's). The plan's Gradle reference
  likewise declares a floor on such a classpath directly, which Gradle 9
  requires.
- The gate counts each unpinned (or unverified) action use: a use of another
  action in the same repository (`acme/actions/unsafe@main` next to
  `acme/actions/safe@main`), a second copy of an existing use, or a step
  repeated through a YAML alias is new and must be pinned, while the unchanged
  ones stay reported gaps. Before, the subdirectory was ignored, copies were
  merged, and an aliased step was read once. Occurrences are also told apart
  structurally, so a ref or comment holding a separator (`sha|reviewed`) can't
  pass for an unchanged one.
- The daily rescan re-judges the cooldown under the base's current policy and
  posts it as a status named like the required cooldown check (new
  `required-cooldown-check` input, default `supply-chain / cooldown`; bridge
  callers such as this repository's own CI pass `gate / cooldown`). Before, a
  PR that went green under a 7-day wait stayed green when the base raised it.
  A PR that conflicts with its base (compared with its merge base instead)
  gets an `error` cooldown status rather than a verdict under old policy.
- The Gradle inventory reads each configuration's declarations only once every
  configuration of the build has resolved. Resolving adds some (a plugin's
  `defaultDependencies`: Checkstyle's, JaCoCo's and PITest's tools, Kotlin's
  build tools), so they were missing, or present on one side only, depending on
  what had resolved first; verification then saw them appear "from nothing".
  What resolves is unchanged, so are the gate's findings; the tools see more
  declarations, and those plugins add go to bump-it's notes.
- The gate requires every locked npm package's tarball to be its own: on the
  npm registry exactly `<name>/-/<unscoped name>-<version>.tgz` (elsewhere the
  full scoped name followed by that tarball or the exact version, as GitHub
  Packages serves it). Before, a lockfile could keep
  `safe@1.0.0` while fetching another package's tarball with that archive's
  integrity, and neither the comparison nor the signature audit noticed.
- Both tools verify a Gradle edit against a reference: the base with the plan
  applied by Gradle itself (each planned declaration moved in place, a strict
  version staying strict and its rejects kept; each floor added through a
  parent next to the configuration's own dependencies; for a floor removal, the
  floors removed), in one more sandboxed inventory run. The plan must have
  landed in the reference, and the edit must resolve and declare exactly what
  the reference does, configuration by configuration, every declaration
  counted, versionless ones included. Before, verification compared
  declarations with the base, so an edit outside the plan that changed what
  resolves without changing a declaration (a `constraints` block, a forced
  version, a resolution rule or substitution) passed, as did adding or removing
  a declaration without a version. A planned plugin update's fallout is in the
  reference, because the reference runs the new plugin: a plugin a
  `buildSrc`/`build-logic` build adds as an ordinary dependency, or a plugin
  fix next to a floor in the same secure-it batch, no longer fails on what the
  plugin adds, and the version-swap proof (with its file-mode check) is gone. A
  change that alters neither what resolves nor what's declared isn't seen.
- secure-it fixes a vulnerable dependency a Gradle plugin declares (java-conventions'
  Guava, Commons Lang or Plexus Utils in a consumer) with a floor, as it does a
  transitive one: an explicit dependency with `because(...)` next to the
  plugin's, plus its record. Before, it planned to edit a declaration no file of
  the repository holds. The gate accepts a floor next to the plugin's own
  declaration of the same version too.

## 0.2.2 - 2026-10-09

### Fixed

- bump-it no longer plans Gradle dependencies a plugin adds (the Kotlin DSL
  plugin's embedded Kotlin, for one): it moves a Gradle dependency only when
  the repository's Gradle sources name it, and lists the rest as not moved
  automatically. Gradle reports plugin-added dependencies as declared, so
  bump-it asked its agent, on every run, to move declarations that don't
  exist. The evidence is deliberately coarse and errs toward "named": build
  scripts, catalogs and `buildSrc`/`build-logic` code anywhere in the
  repository, comments included (see `packages/ci/README.md` for its known
  limitations). When a planned plugin update moves the dependencies that plugin
  adds (the Kotlin plugin's stdlib), verification lets their version change:
  only in a build whose plugin the plan moves, never an addition or removal,
  and only when every file the update changed differs from the base by the
  planned version swaps alone, so no other edit can be behind it. Everything
  else must still change only as planned, and the gate judges every version
  that changes.

### Changed

- The `ci` package depends on `smol-toml` (1.9.0, zero dependencies) to read
  Gradle version catalogs, and on `fast-xml-parser` (5.11.2, with seven
  dependencies of its own, all from its author) to read POMs and Maven
  metadata, under size, nesting and entity budgets. Both run in the gate and
  the tools only.
- POMs and `maven-metadata.xml` are read as XML, not with patterns: only the
  project's own `<scm>`, `<url>`, `<properties>` and `<parent>` count (not a
  profile's or a plugin's), CDATA and entities are decoded, and a commented-out
  `<version>` no longer counts as a published version.

## 0.2.1 - 2026-10-09

### Fixed

- A security fix whose required dependency is another security fix in the same
  batch keeps that fix's own version when it satisfies the requirement: the
  requirement proof chooses it instead of re-picking a lower (possibly still
  vulnerable) young version and rejecting the right one. A fix that needs the
  other fix's young version, directly or through it, stays with it in
  secure-it's retries and cooldown split.
- secure-it updates an object-form security override (`{ ".": "1.0.0", "child": … }`)
  by its own `.` version, keeping its child rules and their floor records.

## 0.2.0 - 2026-10-09

### Changed

- **Young versions are held.** Passing the release-age rule (the rule-picked
  security fix, a version it requires, a `releaseAge` exception) no longer makes
  a young version mergeable on green: whoever controls a publisher can ship
  malware inside a real fix, whatever the advisory's severity. The reusable
  workflow's new `cooldown` job stays red while a PR adds or changes a version
  younger than the wait, and whenever it can't tell. Adopters should require
  `supply-chain / cooldown` next to `supply-chain / supply-chain`. Taking a held
  version earlier is a person's decision: the reason written on the PR, then an
  admin merge. Exceptions don't clear a hold.
- The release-age wait and own packages that judge a PR are the stricter of
  base's and head's settings, so a PR can't loosen them for itself.
- The gate's report is schema 2: comparisons record the held versions.
- secure-it puts young fixes (and fixes whose required npm dependency is young)
  in a draft PR of their own, topic `security-cooldown`, so the aged fixes go out
  as usual. A held PR opens with a warning listing what came early, why, and npm
  provenance, publisher and install-script signals. Review never marks it ready;
  once everything aged it closes the draft, and the next run opens a freshly
  verified PR. bump-it refuses any version the cooldown holds.

### Added

- `supply-chain cooldown --report <file> --head <sha>`, the `cooldown` job, and
  the workflow outputs `comparison-passed` and `cooldown-held`.
- secure-it proves and pins npm dependencies required by a rule-picked security
  fix. When no aged version satisfies a requirement, only its lowest stable,
  non-deprecated version gets the age exemption. The gate reconstructs the proof
  from registry metadata, jointly for independently verified security roots and
  reciprocal direct peers at their resolved locations, preserving complete
  assignments even when their versions are crossed. Optional dependencies
  replace same-key ordinary requirements. Missing data or proof/search bounds
  block it explicitly. Ordinary bumps, Maven and Actions receive no new age exemption.

### Fixed

- This repository's tests run on a held PR too: the `check` job no longer skips
  when only `gate / cooldown` failed.
- bump-it's CLI is committed executable, like the other `bin` targets. npm marks
  it executable on install, which showed up as a change in secure-it's own
  working copy of this repository and failed its verification.
- The gate, secure-it and bump-it retry transient GET/HEAD connection failures
  twice with bounded backoff and jitter, including interrupted response bodies.
  No overall timeout is added; caller cancellation and fetch timeouts still apply.
  Exhausted retries still fail closed; HTTP error responses and write requests
  are not retried.
- Concurrent metadata lookups stop scheduling after the first failure and wait
  for active requests to finish before reporting it. The POM limit stays at 16.
- Temporary exact npm declarations also align object-form self-overrides, keeping
  their child rules and restoring the repository's original overrides afterwards.
- secure-it refreshes computed npm files before verifying a clean same-plan rebase,
  preserving matching security-floor history and merged non-npm floor records.
- Both tools constrain npm targets with simultaneous temporary exact declarations
  before resolving, restore planned ranges and formatting, reinstall, and assert
  exact landing. Peer-resolved copies use root/workspace declarations instead of
  overrides npm can ignore; unsupported placements are reported without publication.
- secure-it writes and protects npm files mechanically before agent work, including
  peer companions and recorded security overrides; compare still judges induced transitives.
- `cannot-apply` skill answers may omit publication or return null. Applied answers
  still require complete, strictly validated publication text in both tools.
- secure-it and bump-it no longer fail to fetch or push a branch when their
  cached clone still tracks a deleted branch on a conflicting path (for example
  `bump-it` left behind while `bump-it/2026-10-08-routine` is fetched); the stale
  ref is dropped first.
- A failed git call's error quotes git's own stderr, bounded and with
  credentials masked, instead of only its exit code.

## 0.1.1 - 2026-10-08

### Fixed

- Built-in OpenAI model prices provide API-equivalent usage estimates, including
  cached input and per-request long-context rates; configured price overrides
  remain supported.
- Deprecated npm releases are excluded from direct and transitive target
  candidates, including accidental major releases.
- `@types/node` targets respect the lowest supported Node runtime across engines,
  version files, Volta and CI. The cap covers direct/peer targets, routine
  transitives and major-induced copies, with exact pinning and final checks.
- Scheduled-scan detection recognizes callers of the reusable supply-chain
  workflow, rather than requiring the caller's workflow name to match it.
- npm registry lookup URLs encode package/version path segments explicitly,
  addressing the CodeQL sanitization findings without changing package identity.

## 0.1.0 - 2026-10-08

### Added

- A CI gate for npm lockfiles, resolved Gradle modules and GitHub Actions, using
  one advisory snapshot for base/head. PRs fail on new findings and malware;
  default-branch daily scans and open-PR rescans keep verdicts current.
- Release-age, publisher/source identity, repository-advisory, exception and
  dependency-floor checks, including proof of eligible young security fixes.
- Standalone secure-it: non-major security batches, separate majors, peer-coupled
  direct fixes, and jointly verified unlocked removal of redundant security
  floors. Compatibility floors remain unchanged.
- Standalone bump-it: routine refreshes, separate capped/deferred majors,
  tool-computed exact npm files and checksummed Gradle wrapper generation.
  Peer-blocked major PRs are retained and reported during review.
- Shared sandboxed repository commands, isolated credentials, PR race checks,
  publication journal recovery, deterministic reconciliation and bounded CI
  adaptation. CI reads Actions and commit statuses without Checks permission.
- Per-tool PAT/Keychain defaults, strict configuration, per-tool PR label
  recognition, candidate preview, launchd examples, logs and cost reporting.
- Provenance for copied agent basics, an adoption/configuration guide, security
  model, coverage gaps and a real-run validation record for wrapper generation
  and Gradle/npm floor removal.

### Scope

- Packages are private and consumed by pinned Git commit; no npm publication.
- Local tools currently run on macOS. GitHub App mode is future work; PAT mode
  remains supported. Unsupported ecosystems and other limits are documented in
  `docs/coverage-gaps.md`.
