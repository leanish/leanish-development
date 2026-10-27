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
- **Repository advisories OSV also lists (gate)**: a project's repository advisory that isn't malware is
  dropped for a version when OSV has a record with the same id for the package, whatever its ranges. So a repository
  range wider than OSV's is ignored for the versions only the repository names. Pre-existing in 0.7.5; not fixed in 0.8.0.
- **Gradle floor removal and parent configurations (secure-it)**: the reference build that checks a floor removal
  snapshots what the configuration inherits, after the projects are evaluated. A dependency the build adds to a
  parent configuration later is missing from it, so a correct removal fails verification and needs a person. An
  edit that also changes a shared parent goes unnoticed only when the change leaves every inventoried
  configuration's declarations and resolution as the reference has them. Both are pre-existing in 0.7.1.
- **Removing a configuration's only declared floor (secure-it)**: when the floor is the configuration's only
  dependency of its own, removing it lets its default dependencies apply (checkstyle's tool version, for instance),
  which exact declaration preservation refuses; the removal fails visibly. Pre-existing in 0.7.1.
- **A young own-only npm carrier is refused late (secure-it)**: when a carrier's bundle fixes nothing reviewed (its
  bundled findings are only in the project's repository advisories), secure-it may still pick a young carrier version
  for the carrier's own advisories that the ordinary young-fix rule refuses. Unless another justification applies (a
  required-dependency proof or a valid release-age exception), verification refuses it before anything is published,
  after the agent's work. Refusing it while planning would need what only verification knows (versions
  another fix requires, the whole PR's candidates), so it's left to verification. New in 0.8.0.
- **No run-level budget for advisory evidence (secure-it)**: evidence is collected separately per held version, with up
  to 16 id lookups per advisory group for each of GitHub's advisory database and OSV; repository-advisory pagination
  has a separate cap. No request budget spans the run, so many held versions can spend much of the shared GitHub API
  quota. New in 0.8.0.
- **Publisher identity: planning and verification read different baselines (gate, secure-it)**: when neither the
  candidate nor the replaced registry versions has provenance, verification checks the publisher against the registry's
  publication history up to the latest publication time among the versions replaced in that lockfile; planning checks
  each source version separately. When two copies (`lib@1.0.0` by one publisher, `lib@2.0.0` the first by another)
  both move to a version the second publisher released, planning refuses the move for the first copy while
  verification would accept it, so secure-it doesn't propose it. The gate's verdict on a PR is unaffected.
  Pre-existing. In 0.9.0, planning is to use verification's replacement baseline, preserving its provenance checks.
- **Held bodies keep raw length budgets (secure-it)**: a held PR's body is composed within raw UTF-16 budgets (61,440
  for fresh text, 65,280 with its marker), which can cut table rows, drop evidence or refuse a body publication
  would accept. Publication checks every body as it sends it. Kept since 0.8.0.
- **Transient errors can regroup held work (secure-it)**: a transient npm planning error or a recorded Gradle reference
  failure can split or merge held units differently from one run to the next (PR churn, and waiting for the youngest
  version). An error running Gradle itself fails every held routine unit of that run instead, while other units
  continue. Each failure is logged. New in 0.8.0.
- **`gradle.ignoreConfigurations` in reference checks (secure-it)**: the Gradle reference checks in preflight and
  verification include the configurations the gate is told to ignore, so a failure there can block a fix the gate
  wouldn't. Pre-existing in 0.7.x.
- **Optional root peers and the npm deprecation check (bump-it)**: a transitive version a major brings is exempt when the root declares the package, including as an optional peer it never installed, so a deprecated or unreadable version of it isn't refused. Pre-existing in 0.6.0; not fixed in 0.8.0.
- **npm aliases without a version** (`"compat": "npm:lib"`): the inventory reads them, but neither tool can rewrite them, so an update fails visibly and a person makes it.
- **Scheduled runs are best effort**: GitHub may delay or skip them, and disables them after 60 days without activity in a public repository. Nothing else watches that the scheduled scan still runs.

## Checks that fail rather than leave a gap

These apply to versions a PR adds or changes, in `compare`; unchanged versions and the full `scan` don't get them.

- **Packages from another npm registry**: age and identity are checked against the npm registry only, so they fail, or (own packages) need a reviewed `identity` exception.
- **Maven versions outside Maven Central and the Gradle Plugin Portal**: their release age can't be checked, so they fail unless their repository is listed in `maven.repositories`. Own Maven packages skip the age check.

## Automated test coverage

- **Reusable workflow required-check guards**: the guards that keep a failed Gradle inventory from skipping the required comparison, and keep cooldown red when comparison fails, have no automated test (see [Adopting the gate](../core/gate/README.md#adopting-the-gate) and the `supply-chain` and `cooldown` job conditions in [supply-chain.yml](../.github/workflows/supply-chain.yml)); only this repository's own bridge to its required check has one (`core/gate/test/required-check.test.ts`).

## Gradle wrapper updates

bump-it selects and verifies the root Gradle wrapper outside the gate's dependency inventory:

- It reads stable, non-broken releases from services.gradle.org and published repository advisories from
  gradle/gradle; it doesn't scan the distribution archive.
- Nested wrappers, mirrors, custom distributions and prerelease base wrappers are not upgraded.
- The official wrapper jar is checksummed. The generated shell/batch scripts aren't compared with official ones, but
  all four generated files are protected against agent edits, byte for byte and by executable mode.
- A missing or unreadable advisory range leaves the wrapper out with a reported reason; other moves continue.
  Verification of a planned wrapper fails closed.
