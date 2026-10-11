# What supply-chain handles

This guide describes supply-chain 0.3.0. The [changelog](../CHANGELOG.md) lists what changed in each release.

- **The gate** checks a pull request (PR). It also scans the default branch and
  checks open PRs again each day with current advisories.
- **secure-it** proposes security fixes. It can also remove security version
  restrictions that are no longer needed.
- **bump-it** proposes routine updates and separate major upgrades.

The tools select versions and verify their changes before publishing a PR.
They open drafts and can mark checked PRs ready. **They never merge them.**
A coding agent edits Gradle and Actions files and adapts code for major upgrades.
The tool writes npm dependency files.

## What a passing gate means

A PR must not introduce a vulnerability the base branch did not have.
Existing vulnerabilities are warnings on that PR. The default-branch scan fails
on all vulnerabilities without a valid, reviewed exception.

The comparison counts a package and an advisory together. A CVE and GHSA for the same
advisory count once. Another vulnerable copy of that package is not a new finding.
A different affected package is.

Malware listed by the advisory sources always fails, even if it was already
present. Exceptions cannot allow malware. This is advisory-based detection,
not a scan of package contents for unknown malicious code.

New or changed versions normally need to be **at least seven days old**.
The wait is configurable. Packages explicitly configured as your own skip the
wait, but keep the other checks. Their dependencies do not inherit that exemption.
A PR cannot shorten its own wait or declare its new dependencies exempt.

A proven security fix can pass the version rule before seven days. Its separate
**cooldown check still stays red** until the wait ends. An exception does not
clear that hold. Missing data needed for a decision fails the check.
Some missing coverage is instead reported as a gap: **a passing PR can have gaps**.

secure-it keeps all malware repairs in one PR, before other work. It seeks the nearest
clean version past the wait: newer in the current line, then older, then a newer line.
Own packages skip the wait. A blocked repair postpones other fixes.

## npm

### What the gate checks

The gate reads configured `package-lock.json` files, including workspace
dependencies and transitive dependencies. A transitive dependency is one another
package brings in. Recorded bundles are included. Configure lockfiles outside the root too.

It checks advisories, release age, allowed registry sources and recorded version
restrictions. CI also checks npm signatures and provenance attestations.
When a version replaces another, it checks publisher continuity. Lost provenance,
a changed provenance repository or workflow, or an unfamiliar publisher can block
the update. A new package has no previous version to compare its publisher with.

### What secure-it fixes

For an ordinary fix, it tries the current compatible version line first.
For npm this normally means versions allowed by a caret range. It chooses the
lowest fixing version past the wait. If none has aged, it chooses the lowest
fixing version and holds the PR. It tries a higher line only when the earlier
line has no fix. A move outside the line gets a separate major PR.
The candidate must fix the targeted advisories without adding new ones or malware.
Advisories with no available fix remain reported; other fixes can still proceed.

- A direct dependency gets a new declared range and lockfile version.
- If every package using a transitive copy already allows the fix, only the
  locked copy moves.
- Otherwise, secure-it tries updating the packages that exclude the fix.
  These parent packages must move within their current line, pass identity and
  advisory checks, and be movable without an override themselves.
- A parent can move even if its new ranges allow only some of the needed fixes.
  It chooses the eligible version allowing **the most locked copies**, counting
  each copy and target separately. Ties go to the lowest version. It must keep
  allowing the fixes its ranges already allowed. Normally these parent versions
  must have aged; a parent with its own security fix keeps that selected version.
- A copy moves without an override only when every parent blocking it allows
  the fix after the selected moves. Other copies keep an override and a recorded
  security floor. The PR explains why.

For example, lint-staged 15.2.5 can allow the micromatch fix while still excluding
the yaml fix. secure-it can update lint-staged, lock micromatch 4.0.8, and keep
the override and floor for yaml 2.8.3.

Some packages ship dependencies **inside their own npm archive**. These are
bundled copies. Changing just the child's lockfile version cannot replace them.
For example, aws-cdk-lib bundles brace-expansion. secure-it updates aws-cdk-lib
to a version shipping a fixed brace-expansion, using the security selection rule
above. One selected version must fix all targeted bundled copies and any targets
on aws-cdk-lib itself. It must add no new bundled findings or malware.
The tool reads authenticated npm archives and checks that the lockfile describes
the bundle they actually ship. A young bundled fix needs the gate's own proof too.

Required peer updates are planned together. A peer is a package that another
package expects the project to provide. Some security fixes also need young
dependencies: the gate can prove the lowest required npm version when there is
no aged alternative. These versions remain held by cooldown.

### What bump-it updates

bump-it chooses the highest eligible version past the wait.
It groups direct minor and patch updates and refreshes
transitive copies within allowed ranges and existing overrides.
Major upgrades get separate PRs. Candidates must pass identity checks and add no
new advisories or malware. Existing vulnerabilities can remain.

It avoids deprecated targets. It keeps `@types/node` within the project's lowest
known supported Node major. Without readable runtime evidence, it stays in the
current type major; an existing type version that is too high needs a manual fix.

## Gradle and Maven packages

### What the gate checks

The gate runs Gradle to find what the build really resolves. This covers external
Maven modules in runtime, compile and test dependencies, annotation processors,
build tools, plugins, and buildscript and settings classpaths.
It also covers `buildSrc` and included builds configured by the root build.
Missing output or unresolved configurations fail. Explicitly ignored ones are not covered.

Resolved modules get advisory and release-age checks. Release dates come from
configured Maven repositories, by default Maven Central and the Plugin Portal.
There is no npm-style publisher continuity check for Maven modules.
**Standalone Maven builds using `pom.xml` are not supported.** Maven here names
the packages Gradle resolves, not a separate Maven build inventory.

### What secure-it fixes

It uses the same lowest-fix rule as npm. A compatible line normally shares the
first version number, such as OkHttp 4.x; configuration can narrow it.
It changes versions it can identify in repository declarations. For a transitive,
it first tries a declared parent bringing it into every affected configuration.
Candidates are tried lowest first within that parent's line, past the wait.
Gradle resolves each proposed change to prove the fix. A parent with its own
advisories must fix those too. There are **at most six such probes per vulnerable
module**, shared across its possible parents.

If no parent is proved, secure-it adds a security floor: an explicit minimum
dependency, an advisory-bearing reason and a record in
`.github/dependency-floors.json`. The gate checks both declaration and resolution.

- Updating OkHttp 4.9.1 to 4.12.0 can fix both OkHttp's own advisory and the Okio
  it brings. OkHttp 4.9.3 can move for Okio alone.
- A newer Digester that brings fixed BeanUtils may be unavailable in its line.
  BeanUtils then gets a floor, rather than a forced Digester major upgrade.
- Updating grgit can bring a fixed JGit. The selected grgit version must prove
  that JGit's targeted advisories disappear.

Declared plugins can move too. Dependencies only a plugin declares can get a
parent fix or a floor. Verification runs the planned plugin version through
Gradle, so its dependency changes are checked alongside any floors in the plan.
It requires the edited build to declare and resolve the same dependencies as
the base build with those planned changes applied by Gradle.

### What bump-it updates

bump-it updates dependencies and plugins whose versioned declarations it can
identify in repository sources. It chooses the highest eligible aged version.
It does not explicitly bump Gradle transitives or raise floors. A parent or
plugin update can change transitives; the gate checks those resulting versions.

It also updates the root Gradle wrapper. It selects official, stable releases,
checks published Gradle advisories and checksums, and generates the wrapper twice
in a sandbox. Minor and patch updates join the routine PR; a major is separate.

## GitHub Actions

The gate reads workflow `uses:` entries, composite actions and local reusable
workflows. Every new or changed remote use needs a full commit SHA and a comment
naming the full release tag that points to it. Duplicate steps and YAML aliases
count too. Advisory and release-age checks use the GitHub release, not the tag's
date. Own Actions can skip the age wait, but still need valid pins.

secure-it selects the lowest eligible security fix and pins its tag's commit.
bump-it selects the highest eligible aged release, with routine updates together
and majors separate. Neither rewrites unrelated workflow policy.
There are no dependency floors or npm publisher checks for Actions.

## Removing floors later

A **floor** records a minimum version and why it is needed. A security floor names
the advisories it prevents. A compatibility floor protects a non-security need.
secure-it can raise security floors for fixes or remove redundant ones.
Compatibility floors stay. bump-it neither raises nor removes floors.

secure-it first tests removals individually. It then tests the proposed set
**together, without relying on dependency locks**. All recorded advisories must
stay absent. Failed or incomplete proofs keep the relevant floors, with reasons.
Removal gets a separate PR, not a PR mixed with version fixes.

For example, the BeanUtils floor stays while Digester still brings vulnerable
BeanUtils. It can go after that dependency is removed or naturally resolves safely.

## Known limitations

### What may go unseen or produce an incomplete answer

- No OS-package or container-image scan. Dockerfile CLIs are covered only through
  configured npm manifests and locks. Yarn and pnpm lockfiles are not read.
- Vendored JavaScript without a separate package manifest is not detected as a
  dependency. Shaded Java classes are not separate modules. Their advisories do not
  match; someone must identify and update the package that ships them.
- Gradle local files and JARs are not external modules. A build or plugin can hide
  dependencies from its own inventory. Job isolation protects credentials, not
  the truth of that inventory. Review build and workflow changes, especially on forks.
- A missing GitHub source repository, a private/deleted/renamed repository, or an
  unreadable advisory range leaves a reported gap in repository advisories.
  OSV coverage still applies. One known range-reading defect can over-report:
  an AND range written `< 2.0.0, >= 1.0.0` is read as affecting every version.
- Unchanged unpinned Actions, `docker://` actions, missing local action descriptors
  and missing local reusable workflows leave reported gaps. A new or changed
  unpinned remote use fails instead.
- Signatures, provenance and a seven-day wait do not prove an archive harmless.
  Wrapper checks do not scan the distribution's contents or separately compare
  generated scripts with official scripts.

### What may need a manual update

- Ordinary npm parent search does not move bundled parents. A bundled fix is not
  automated if updating the package shipping it would require an override.
  A proven young bundled fix also cannot justify its
  own young, non-bundled dependencies. Such a change fails comparison and is reported.
- Bundle proofs have size, time and search budgets. An unreadable or incomplete
  archive (including one with global tar headers, which `npm pack` never writes) is never treated as clean. Archive authentication covers these proofs
  and secure-it's bundled moves; it is not a general check of every changed bundle.
  Bundled children follow their archive, without separate release-age checks.
- npm peers, recursive young-dependency proofs and exact lockfile updates have
  bounds. Unsupported nested placements or conflicts can block a PR. Complex
  overrides and exact pins can prevent bump-it refreshes. It reports skipped copies.
- npm identity and age checks use the public npm registry. Other allowed registries
  need the documented own-package/identity exception route. CI signature checking
  does not use private registry credentials or repository proxy settings.
  Git dependencies, URL dependencies and external file dependencies are refused;
  validated internal workspace links are supported.
- Gradle parent search handles one vulnerable module at a time. Later choices must
  preserve earlier fixes. It does not maximize fixes across modules. Six probes can
  miss a later fix. Several parents each covering
  only part of the affected build cannot replace the floor through this search.
- Gradle source recognition is text-based. It misses `kotlin("stdlib")`, escaped
  names and files outside the repository. Comments or names in another build can
  cause an attempted update that verification rejects.
- Several declared versions, shared catalog versions that move unplanned packages,
  replaced declarations, or a plugin major that stops the base build configuring
  can block verification. Routine edits cannot change convention code or catalogs
  outside `gradle/libs.versions.toml`; those may need a manual change.
- Strict plugin versions can reject a floor. Adding a floor can replace a plugin's
  defaults and lose other dependencies. Removing one can restore those defaults.
  These changes can fail verification. Floors already used during resolution may
  also be retained because the removal probe cannot safely remove them.
- Wrapper regeneration must configure the build inside the sandbox, including any
  Kotlin `buildSrc`. If that work is blocked, there is no special fallback: bump-it
  reports the generation failure, skips the wrapper, and continues other updates.
  Nested wrappers, mirrors, custom distributions and prerelease base wrappers are
  not upgraded.
- Direct bumps check only the ten newest aged versions per line and can miss older
  eligible updates. More than 2,000 Actions releases prevents a complete young-fix
  proof. Coordinated major migrations are not automated. bump-it caps new major PRs
  at three per run by default; deferred ones get priority later.
- Maven versions absent from configured repositories cannot establish release age,
  except for configured own packages. Missing dates are not guessed.

### Operating limits

- Local tools use macOS Apple Silicon, Keychain, PATs and Codex. GitHub App mode and
  Linux/Windows launchers are deferred. Node 24 is required; npm 11.17+ is needed
  for the tools' age exclusions.
- Candidate preview is read-only, but is not a full dry run. `run` and `review`
  can publish changes. The tools read Actions jobs and commit statuses, not another
  app's Checks-only results or GitHub's list of required checks.
- Schedules can be delayed, skipped or disabled after 60 days of public-repository
  inactivity. There is no separate watchdog.
- Open PRs aren't rescanned daily. An advisory published after a PR's last check
  shows up when it's pushed to again, or in the default branch's daily scan after
  merging. A person's PR held by the cooldown stays red until it's pushed to or its
  whole workflow is re-run after the date the hold gives.
- Verification is about dependencies and policy, not whether a migration behaves
  correctly. Agent retries are bounded. Human pushes are left alone. Publication
  guards reduce races, but GitHub writes cannot be made atomic with a head check.

## What a person still does

Install and pin the gate, and require **both the supply-chain and cooldown checks**.
Check scan health, read gaps and omissions, and review exceptions before they expire.
Review migrations and run application tests. Compatibility floors need manual review.
For fork PRs, check them against the default branch yourself before merging.

Young fixes stay draft, with a warning and the date the wait ends. To take one
early, make every other check green, write the reason on the PR, and make an admin
merge past cooldown. Without an enforcing ruleset, still record the decision.
Young routine fixes and their required companion updates go apart from aged fixes.
Major repairs stay together even when some of their versions are young.
The build and tests can already execute a young release while its PR is held.
Once its held versions age, secure-it retires the draft and plans a fresh PR.
A human PR needs the whole workflow rerun on its current revision.
Rerunning cooldown alone uses the old report.

For details: [scenario rules](requirements.md), [coverage gaps](coverage-gaps.md),
[security boundaries](security-model.md),
[gate](../packages/ci/README.md), [secure-it](../packages/secure-it/README.md) and
[bump-it](../packages/bump-it/README.md) guides.
