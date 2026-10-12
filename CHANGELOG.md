# Changelog

## Unreleased

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
- Per-tool PAT/Keychain defaults, strict configuration, current/legacy label
  recognition, candidate preview, launchd examples, logs and cost reporting.
- Provenance for copied agent basics, an adoption/configuration guide, security
  model, coverage gaps and a real-run validation record for wrapper generation
  and Gradle/npm floor removal.

### Scope

- Packages are private and consumed by pinned Git commit; no npm publication.
- Local tools currently run on macOS. GitHub App mode is future work; PAT mode
  remains supported. Unsupported ecosystems and other limits are documented in
  `docs/coverage-gaps.md`.
