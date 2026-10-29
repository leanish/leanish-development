# Coverage gaps

What the gate can't see, in two kinds: **reported gaps**, which every report lists next to its verdict (a verdict can pass with them), and **limits**, which no report mentions because the gate can't detect them. For a plain-language overview of coverage, see [What supply-chain handles](what-it-handles.md).

## Reported gaps

- **Dependencies without a GitHub source repository** (npm `repository` and POM `scm` name none): OSV still covers them; their own repository advisories can't be read.
- **A known source repository whose advisories can't be read**: renamed, deleted or made private (404).
- **Repository advisory ranges the gate can't read**: free-text ranges are read as maintainers write them (`< 1.1.21, >= 2.0.0 < 2.1.7`, `6.x <6.1.2`, `4.0–33.7.1`, `≤ 3.4.1`, `4.1.91.Final =< 4.1.117.Final`), but prose such as `< 2.245.0 (on Windows, < 2.246.0)` is reported, not guessed.
- **Unpinned or unverified remote actions** a PR didn't touch (`uses: actions/checkout@v7`): their version (and advisories) can't be told. A new or changed remote action or reusable workflow must be pinned; that fails, it isn't a gap.
- **`docker://` actions**, new or not: no advisory source covers container images.
- **Local actions without an `action.yml`**, and local reusable workflows that don't exist.

## Limits

- **An action with no immutable release, newly used (gate)**: a new or additional occurrence fails unless its
  owner is listed in `trustedPackages["GitHub Actions"].owners`. Existing uses do not authorize more copies.
  The gate documents the [scope and risks of trusting an owner](../core/gate/README.md#configuration-githubsupply-chainjson).
  This repository trusts `actions` and `aws-actions`; adopters choose their own policy.
- **Publishing races the release's CI**: `publish-agent-runtime.yml` requires the tag's commit to have its `check` and
  `supply-chain` checks green, so a GitHub release created while they still run fails before packing (nothing
  publishes) and isn't retried when they pass. Create the release once they're green, or re-run the run's failed jobs.
- **A repository advisory range read too wide**: an AND range written upper bound first (`< 2.0.0, >= 1.0.0`) reads
  as every version, so versions outside it count as affected; nothing reports it.
- **GitHub source repository matching stays as in v0.5.2**: a repository URL whose host only ends in `github.com`
  (`notgithub.com/acme/lib`), or names it in a path, query or fragment, can be read as the wrong GitHub repository.
  A numeric port in a URL (`https://github.com:443/acme/lib`) can be read as the owner (`443/acme`). These limits
  only add or miss repository advisories; OSV still covers the package.
- **Operating-system packages** in container images: no scanner here reads them (Trivy or similar, later). Dockerfile CLIs are covered only through configured npm manifests and locks.
- **Code copied into a package without its own manifest**: npm bundles are read package by package (each bundled `node_modules/<name>/package.json`); JavaScript vendored into a package's own files isn't a package anywhere, so its advisories can't match.
- **Shaded Java dependencies**: classes a library copies (and usually relocates) into its own jar aren't a module in the Gradle inventory, only the jar that ships them is; an advisory on the shaded library doesn't match it, and the only fix is another version of the shading artifact.
- **What a Gradle build hides from its own inventory** (see the [security model](security-model.md)), and dependencies that aren't external modules: the inventory exports module coordinates only, so local files and JARs aren't covered.
- **Advisories behind a `strictly(...)` pin**: the tools never move the owner's strict versions, so secure-it reports a fix that needs one as blocked, and the default branch's scan keeps failing until the owner moves the pin.
- **Strict pins Gradle doesn't resolve, by deliberate choice**: verification relies on Gradle's inventory and the planned reference comparison ([what it compares](security-model.md#secure-it-and-bump-it)), and doesn't parse source files or unused catalog entries separately. A pin in an inactive branch, an unused catalog entry, any code Gradle doesn't interpret for the inventoried configuration, or a build the inventory doesn't run (left out of `gradle.builds`, or not discovered) isn't checked. The owner chose this scope: the agent's instructions still forbid moving any strict pin, and the PR diff lets the owner review the ones Gradle didn't see.
- **Gradle metadata outside the reference comparison**: declaration `because(...)` reasons and resolved graph edges are exported but not compared with the planned reference; secure-it checks floor reasons separately. Local files, artifacts, attributes and capabilities are outside the exported module/version comparison.
- **Links in workflow and action metadata (gate)**: the gate reads a symbolic link in a commit as the path it points to, so the actions behind a linked workflow, action metadata file or folder aren't read. This is pre-existing in 0.5.1. The tools refuse edits that add links or change what's behind one.
- **An unpinned action moved into a step (gate)**: the comparison counts each action's occurrences in a file, so moving `uses: acme/action@main` from an `env` map (or another non-step key read as an action) into a step of the same workflow leaves the count unchanged and isn't required to be pinned: it's only reported as an unpinned-action gap, not failed. Pre-existing in 0.5.2.
- **Gradle floor removal and parent configurations (secure-it)**: the reference build that checks a floor removal
  snapshots what the configuration inherits, after the projects are evaluated. A dependency the build adds to a
  parent configuration later is missing from it, so a correct removal fails verification and needs a person. An
  edit that also changes a shared parent goes unnoticed only when the change leaves every inventoried
  configuration's declarations and resolution as the reference has them. Both are pre-existing in 0.7.1.
- **Removing a configuration's only declared floor (secure-it)**: when the floor is the configuration's only
  dependency of its own, removing it lets its default dependencies apply (checkstyle's tool version, for instance),
  which exact declaration preservation refuses; the removal fails visibly. Pre-existing in 0.7.1.
- **A young npm carrier fixing only its own advisories is refused late (secure-it)**: when a carrier's bundle fixes nothing reviewed (its
  bundled findings are only in the project's repository advisories), secure-it may still pick a young carrier version
  for the carrier's own advisories that the ordinary young-fix rule refuses. Unless another justification applies (a
  required-dependency proof or a valid release-age exception), verification refuses it before anything is published,
  after the agent's work. Refusing it while planning would need what only verification knows (versions
  another fix requires, the whole PR's candidates), so it's left to verification. New in 0.8.0.
- **No run-level budget for advisory evidence (secure-it)**: evidence is collected separately per held version, with up
  to 16 id lookups per advisory group for each of GitHub's advisory database and OSV; repository-advisory pagination
  has a separate cap. No request budget spans the run, so many held versions can spend much of the shared GitHub API
  quota. New in 0.8.0.
- **Publisher identity before the change exists (secure-it, bump-it)**: verification judges a version's publisher
  against every copy of the package the change replaces in that lockfile. secure-it's security fixes are planned the
  same way, since a package's copies move in one unit. Other planners don't know yet which copies npm will replace
  together: secure-it's parent and direct-peer moves and bump-it's npm moves check each source version on its own,
  and a required version is checked against the copy at its own path. They can refuse a move verification would
  accept (when another copy replaced with it widens the publisher's history), and leave the rest to verification on
  the materialized change. The gate's verdict on a PR is unaffected. Narrowed in 0.9.0.
- **Held bodies keep raw length budgets (secure-it)**: a held PR's body is composed within raw UTF-16 budgets (61,440
  for fresh text, 65,280 with its marker), which can cut table rows, drop evidence or refuse a body publication
  would accept. Publication checks every body as it sends it. Kept since 0.8.0.
- **Held work that only plans together fails until it ages (secure-it)**: held groups that cannot be planned or
  resolved separately fail visibly until their versions age into the aged batch or a person moves them. An aged
  batch planning failure can also block held npm work; existing affected PRs are kept. The coupling, preflight and
  failure-propagation rules are in [secure-it](../secure-it/README.md#what-a-run-does), step 3. Narrowed in 0.9.0.
- **Ignored Gradle configurations' failures compared as text (secure-it, bump-it)**: when an ignored configuration
  resolves nothing, its failure text, declarations and constraints are all the reference can compare. A resolution
  rule that leaves those unchanged is unseen. Variable paths the inventory cannot normalize can also make equivalent
  failures differ and refuse a valid edit. See the [gate's normalization rules](../core/gate/README.md#gradle-builds).
  New in 0.9.0 (bump-it in 0.9.1); narrowed in 0.9.1.
- **Some listing failures stay quiet notes (secure-it, bump-it)**: an action with more releases than the gate reads
  has an incomplete version listing, which neither tool reports under `errors`: secure-it blocks that action's fix
  with the note "the registry doesn't list …'s versions completely, so the rule can't be applied", and bump-it gives
  it no move with "the registry doesn't list …'s versions completely" among its waiting problems. The same notes cover
  a Maven package that no configured repository lists (each answers 404). bump-it's npm resolution also leaves a
  transitive copy whose versions the registry couldn't list, or didn't list completely, where it is, with a plain
  note ("… stays at …: the registry couldn't list …'s versions: …"). Other listing failures fail the run: a Maven
  repository that answers another error, or metadata without `<versions>`, and the npm listing of a package the gate
  reads for a fix or a direct dependency. Pre-existing in 0.8.x.
- **Late-computed new majors (bump-it)**: the first pass computes the routine, majors with an open PR and the first
  `maxNewMajorsPerRun` new majors. Their failed direct-peer sets protect every unit's PR before any acts. Later new
  majors aren't computed if deferred; their failed reads become known when they run. If an earlier new major doesn't
  publish, a later one can still run in the same run and is computed in its turn. Its undecided sets block its moves
  and reach `errors`, and protect subsequent units' PRs, but PRs already handled aren't rechecked and may already have
  been rewritten. This accepted limit keeps execution order and the cap on actual new publications. New in 0.9.1.
- **npm aliases without a version** (`"compat": "npm:lib"`): the inventory reads them, but neither tool can rewrite them, so an update fails visibly and a person makes it.
- **Induced versions from npm mirrors (bump-it)**: a major's induced-version deprecation check skips copies whose lockfile `resolved` URL is outside `https://registry.npmjs.org/`, including mirrors; the gate's source rules still apply. Pre-existing.
- **Scheduled runs are best effort**: GitHub may delay or skip them, and disables them after 60 days without activity in a public repository. Nothing else watches that the scheduled scan still runs.

## Checks that fail rather than leave a gap

These apply to versions a PR adds or changes, in `compare`; unchanged versions and the full `scan` don't get them.

- **Packages from another npm registry**: age and identity are checked against the npm registry only, so they fail, or (trusted packages) need a reviewed `identity` exception.
- **Maven versions outside Maven Central and the Gradle Plugin Portal**: their release age can't be checked, so they fail unless their repository is listed in `maven.repositories`. Trusted Maven packages skip the age check.

bump-it's major computation refuses every npmjs-resolved version absent from base and not at a checked direct target
unless its registry catalog can be read and lists it as non-deprecated. Newly declared root/workspace dependencies
are included, peers or not; bundled copies are exempt.

## Automated test coverage

- **Reusable workflow required-check guards**: [gate-workflow.test.ts](../core/gate/test/gate-workflow.test.ts)
  tests the inventory and comparison guards, job conditions and cooldown report handling;
  [required-check.test.ts](../core/gate/test/required-check.test.ts) tests this repository's required-check bridge.

## Gradle wrapper updates

bump-it selects and verifies the root Gradle wrapper outside the gate's dependency inventory:

- It reads stable, non-broken releases from services.gradle.org and published repository advisories from
  gradle/gradle; it doesn't scan the distribution archive.
- Nested wrappers, mirrors, custom distributions and prerelease base wrappers are not upgraded.
- The official wrapper jar is checksummed. The generated shell/batch scripts aren't compared with official ones, but
  all four generated files are protected against agent edits, byte for byte and by executable mode.
- A missing or unreadable advisory range leaves the wrapper out with a reported reason; other moves continue.
  Verification of a planned wrapper fails closed.
