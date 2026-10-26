# bump-it

Keeps dependencies fresh with the supply-chain gate's version rule: the highest eligible version at least seven days
old (or the repository's `releaseAgeDays`), adding no advisory group or malware. Packages in the repository's own npm
scopes skip the wait (their dependencies don't).
Actions pins and Dockerfile CLIs represented by configured npm manifest/lockfiles use the same rule.
The tool decides versions, computes npm files and verifies every edit before opening a draft PR. The coding agent
(Codex or Claude Code) handles Gradle declarations, Actions pins and major migrations. When verification refuses what
the agent wrote, the agent is asked once more, from the base, with the refusal (`rejected`); a second refusal fails the
unit. A pass the tool wrote alone isn't retried.

```bash
core/tool-runtime/run.sh bump-it run leanish/widget      # weekly
core/tool-runtime/run.sh bump-it review leanish/widget   # every few hours
```

## Run

- Inventory the default branch, with Gradle builds in the sandbox. An incomplete inventory stops the run.
- One routine PR contains all selected direct minor/patch moves and the npm transitive refresh. Each major gets its own
  PR, including every declaration of that package with a selected major move. Each unit starts from the default branch,
  and a unit's failure does not stop others. Gradle transitives are never explicitly moved; induced changes are judged
  by `compare`. Recorded security and compatibility floors stay untouched.
- Deprecated npm releases are never selected as direct or transitive targets, accidental majors included. A deprecated
  version already in the base can stay when no eligible replacement exists. A major keeps the graph npm induces, but
  fails when it brings a transitive version that is deprecated or whose catalog can't be read.
- A Gradle coordinate pinned with `strictly(...)` (declared or as a dependency constraint) in a configuration that
  declares it is never moved, in any configuration: the pin is the owner's. The run's notes list each such pin. Pins
  only elsewhere (Gradle's own strict constraints on its embedded Kotlin, on buildscript and settings classpaths) don't
  count. The agent is told never to change a `strictly` version, and verification refuses an edit that changes a
  line with `strictly` in its code (not in a string or a comment).
- `@types/node` targets never exceed the lowest supported Node major found in `engines.node`, `.nvmrc`,
  `.node-version`, `volta.node`, or static `actions/setup-node` CI versions (including matrices).
  - Root, lockfile-root and declaring-workspace constraints are combined by taking the minimum; a newer development or
    CI runtime never raises an older support floor. Floating aliases and unresolved CI expressions don't count.
  - This applies to direct peer companions, the routine transitive refresh, and copies induced by major updates.
    npm-selected incompatible copies are re-locked to eligible versions within their parents' ranges; if no safe
    resolution exists, the unit fails before publication.
  - If no constraint is readable, only updates within the current type major are allowed and the run reports why majors
    were withheld. A newly introduced type copy also requires readable runtime evidence.
  - An existing type major above the runtime is left for a manual correction; bump-it neither raises it further nor
    silently downgrades it.
- The root Gradle wrapper joins the routine within its current major; the highest eligible newer major gets its own
  `gradle-gradle-major` PR, subject to the same new-major cap and deferred priority. See
  [the Gradle wrapper](#gradle-wrapper) below.
- Before npm resolves a routine or major, code checks incoming and outgoing peer constraints against existing directs.
  - Rule-picked bump targets stay fixed. Required companions are added explicitly at the lowest safe version in their
    own compatible line that makes the set consistent: aged (own scopes: any age), with no new advisory group, malware
    or rejected publisher identity. Compatible peers stay at base; a needed companion may move downward within its line.
  - One peer snapshot judges the fixed targets and all companions together. Impossible sets or repository constraints
    that exclude a companion are reported and left out, while unrelated routine moves continue.
  - Unreadable locked peer metadata blocks npm moves because incoming constraints cannot be ruled out. New or purely
    transitive peers stay with npm resolution and `compare`.
  - A major's PR still belongs to its primary package and counts as one new major. A major whose direct-peer set can't
    coexist within the companions' compatible lines is reported as `blocked` with its reason; bump-it does not
    coordinate several major migrations into one PR.
- npm resolution runs in an exported scratch copy, under `codex sandbox`, with `--package-lock-only --ignore-scripts`,
  the release-age window and own-scope exclusions on every install/update.
  - A package with a young locked base version in any lockfile this unit computes also gets a named npm age exclusion,
    so npm can keep the version already locked; unreadable publish times count as young. Each exclusion is reported.
    Publish-time lookups are cached and shared with target selection: bump-it's targets still require the age.
  - In a routine, non-bundled locked transitive copies of an automatically excluded name get temporary pins to their
    base versions, aged copies of that name included, before install/update and in later target passes where
    supported. Plain overrides are temporarily narrowed to exact versions when compatible with every governed copy,
    then restored.
  - Unsupported placements, including shared overrides whose copies need different targets, are left unpinned and
    checked after resolution: they may stay locked, be removed, or move to an aged version that is not deprecated. A
    move to another young, deprecated or unreadable version fails the unit. An accepted aged move is kept when that
    copy becomes pinnable in a later pass, while its dependents' ranges and the repository's plain overrides still
    admit it. Otherwise, or when a constraint can't be judged (a spec that isn't a version range, a scoped or complex
    override), the copy's current version is checked again like any unpinned replacement. The same goes for a pinned
    base version once an updated dependent's range no longer admits it (a refreshed parent asking for a new major).
  - Bundled copies follow their carrier and may change when it moves to an aged target. Young locked directs outside
    the plan stay at base too. Own packages keep their age exemption, and a configured exclusion alone does not freeze
    transitives.
  - The routine resolves after direct updates, then code weighs all transitive candidates within the dependents' ranges
    and existing override constraints on one advisory snapshot. Direct targets and frozen directs are constrained with
    simultaneous temporary exact declarations before the first install/update. Peer copies at a root/workspace are
    anchored with exact declarations, not ignored overrides; unsupported nested/conflicting placements block that unit
    with a reason. Temporary pins lock targets, and planned manifest bytes are restored before a second install. The
    final graph must keep every target (at most four pin passes).
  - Majors install their own move, plus any explicit peer companions, without a routine refresh, and keep their induced
    graph for `compare` to judge. Direct declarations outside the plan remain at base.
- Unjudgeable copies stay at their base version, with an unresolved note. Complex scoped override rules are treated
  conservatively: their copies stay at base rather than claiming an R3 selection. If a new copy has no provable eligible
  target, or npm cannot retain a required target, that unit fails. Exact repository pins are reported separately as pins.
- The agent never changes npm dependency fields or lockfiles. The tool-written graph already includes refreshed or
  induced transitives, even when those versions are absent from the explicit move list; the agent preserves them.
  It may adapt code and manifest scripts/config only for a major. The [skill](skills/bump-it/SKILL.md) defines the
  boundary and asks for:
  - focused edits in each file's style, fixing any comment the edit made false without losing its context, and
    removing code kept only for an old major the repository no longer supports;
  - the repository's relevant checks in every mode, and, for each major, the release notes or changelog of the versions
    it crosses, read and linked;
  - PR text that gives `from → to`, each major's adaptation verdict and the checks run. The published text keeps local
    paths out (see [tool-runtime](../core/tool-runtime)).
- Verification fences off policy changes first, then requires exact planned lockfiles and dependency fields, exact
  planned Gradle declarations, unchanged unplanned declarations and floors, interpreted strict declarations and strict
  constraints matching the Gradle reference, correct action pins, and all generated wrapper bytes/modes plus official checksums. Only after every local check passes does it run
  `compare`, which must also pass. A report of local problems means `compare` has not run. Floor declarations are
  checked as in [secure-it's verification](../secure-it/README.md#what-a-run-does) (step 6).
- Open PRs count only when the head matches their body state or the exact tool journal entry. Same plan: leave it to
  review. Changed plan: redo on a clean base checkout, apply the new plan, verify and append a normal commit to the
  existing PR history. Earlier major adaptations are redone for the new target.
  A human push is left alone; a separate PR is opened. Other tools' overlapping PRs never suppress work.
- `maxNewMajorsPerRun` (default 3) caps only new major PRs. Updates are uncapped. Deferred packages are saved under
  `<state>/deferred/` and get priority next run. Reports include every failed/deferred unit and unresolved copy.

Plans carry moves and npm file hashes, with a bounded copy-change summary, never file contents. Major manifests also
carry a hash of their dependency fields, allowing later review to protect them while retaining script adaptations.
A routine with only npm and wrapper moves needs no agent.

### Gradle wrapper

- **Selection:** stable, non-broken services.gradle.org releases at least `releaseAgeDays` old by `buildTime`. Release
  timestamps include their signed UTC offset; an invalid timestamp skips only that release, with a reason in run
  results and plan notes. A rejected newer release does not veto an older eligible one.
- **Advisories:** gradle/gradle's published repository advisories, read once per run/tick. Inherited advisories don't
  veto a candidate; any newly affecting advisory does. Reading supports inclusive `to`/`through` ranges, bracketed
  intervals, wildcard upper lines and lists of maintenance-line fixes. An unknown range omits the entire wrapper
  selection: without readable bounds, code cannot prove which versions it might affect.
- **Generation:** the tool runs `./gradlew wrapper --gradle-version X --gradle-distribution-sha256-sum SUM
  --distribution-type bin|all --no-daemon` twice, sequentially, under `runSandboxed` in an exported base commit. The
  first call selects the target; the second regenerates its jar and scripts. The tool preserves bin/all, rejects other
  changes to tracked or non-ignored repository files, and copies all four generated files into the working copy before
  any agent work. Ignored build/cache output stays in the scratch copy. The plan records each file's SHA-256 and
  executable mode; verification requires those exact bytes and modes, plus the official distribution URL/checksum and
  jar checksum. The agent never generates or edits wrapper files.
- **Failures:** missing metadata, unreadable advisory ranges, and selection or generation failures leave the wrapper
  out with a reason in the run report and plan notes; other moves continue. Verification of a planned wrapper fails
  closed. A wrapper major whose recomputation is unavailable keeps its existing PR for a later review. Only the root
  wrapper is supported; mirrors, custom distribution URLs and prerelease base wrappers are reported as unsupported
  rather than guessed.

## Review

The [shared tick](../core/tool-runtime) leaves human pushes alone, recomputes on any base movement before reading CI, then
handles pending/green checks without a model. A routine recomputes the whole routine; a major recomputes its package.

- Nothing remains: close. Changed routine plan or major target: reconcile by revert.
- Otherwise merge, resolve dependency conflicts from base (wrapper jars restored as binary) and re-apply (major code
  conflicts go to the agent's `resolve` mode), verify, publish normally. Clean same-target major merges preserve
  existing script/config adaptations.
- If recomputation blocks a major's direct-peer set, the tick reports an `error` with the reason and retains the PR and
  branch for a later tick; it does not treat the blocked move as completed work.
- Failed major CI gets at most two adaptations, with the attempt counted before the agent starts. Routine CI failures
  are reported without an agent; after the shared two-attempt budget the PR closes. One PR's problem does not stop the
  tick.

The review reads each PR's own CI. The gate's daily scan of the default branch stays CI's job; the tick doesn't replace
it.

## Setup and isolation

Use `~/.config/leanish/bump-it/agent.yaml`, with explicit repository opt-in; the
[config reference](../docs/tool-configuration.md) covers every field.
[Adopting the tools](../docs/adopting-tools.md) covers prerequisites, Keychain permissions, the read-only candidate
preview, the first live run, and four complete launchd examples (a run and a review for each tool). Nothing
merges itself.

**npm 11.17.0 or later is required whenever the final age-exclusion list is non-empty**
([prerequisites](../docs/adopting-tools.md#prerequisites)): with older npm, the run reports the affected unit as failed
before editing npm files or publishing. The unit tests need no npm installation or registry requests.

The default Keychain services are `leanish-bump-it-write` and `leanish-bump-it-read`. Which process gets which token,
what the sandboxes allow and how the pinned OSV-Scanner is protected are in
[the security model](../docs/security-model.md#secure-it-and-bump-it).
