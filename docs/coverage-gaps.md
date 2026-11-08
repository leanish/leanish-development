# Coverage gaps

What the gate can't see, in two kinds: **reported gaps**, which every report lists next to its verdict (a verdict can pass with them), and **limits**, which no report mentions because the gate can't detect them. For a plain-language overview of coverage, see [What supply-chain handles](what-it-handles.md).

## Reported gaps

- **Dependencies without a GitHub source repository** (npm `repository` and POM `scm` name none): OSV still covers them; their own repository advisories can't be read.
- **A known source repository whose advisories can't be read**: renamed, deleted or made private (404).
- **Reviewed advisory lookups that fail**: when a repository-only finding's GHSA id or CVE alias can't be checked
  in OSV (GitHub's reviewed global database for Actions), the repository finding stays and the failure is reported.
  Failures are reported per package and advisory group, even when the request was shared. Successful drops are
  separate notes: every known and discovered alias is checked, including those known from other versions of the
  same package in the snapshot, and every reviewed record naming the same full
  package and ecosystem must independently clear the version without being withdrawn. Invalid response identity,
  malformed decision fields and the 16-id lookup budget also keep the finding with a gap. Entries whose `package`
  is absent or null describe source repositories and neither authorize nor block a package drop; a present but
  malformed package remains a gap. Affected, unknown and
  withdrawn records keep the finding; scan disagreements and withdrawals are notes too. Reconciliation notes
  propagate to secure-it and bump-it planning results, even when no security fix remains. Auxiliary carrier and
  bundle-fix scans preserve notes for dependencies discovered only inside candidate archives too.
- **Repository advisory ranges the gate can't read**: free-text ranges are read as maintainers write them (`< 1.1.21, >= 2.0.0 < 2.1.7`, `6.x <6.1.2`, `4.0–33.7.1`, `≤ 3.4.1`, `4.1.91.Final =< 4.1.117.Final`), but prose such as `< 2.245.0 (on Windows, < 2.246.0)` is reported, not guessed.
- **Unpinned or unverified remote actions** a PR didn't touch (`uses: actions/checkout@v7`): their version (and advisories) can't be told. A new or changed remote action or reusable workflow must be pinned; that fails, it isn't a gap.
- **`docker://` actions**, new or not: no advisory source covers container images.
- **Local actions without an `action.yml`**, and local reusable workflows that don't exist.

## Limits

- **Young versions a run finds while executing (secure-it)**: issues defer the young versions planning chose
  before a unit executes, including what a Gradle parent search's chosen probe resolved beyond the base. The probe
  itself runs before any issue decides, so a young version it brings in has already been resolved by then; only what
  follows waits. A floor removal isn't gated by an issue (only deferred, with the rest, when a run's issues couldn't be
  synced): its unlocked resolution can settle on a different
  version of a parent whose own dependencies include a recently published one (a parent's age doesn't bound its
  dependencies'), and nothing dates those before the removal is applied and verified. A young version only verification finds (a transitive
  move, say) stops that unit at once, with no retry, and is named on the issue, but the agent runs again on every run
  until that version ages. Gradle dynamic versions (ranges, `latest`) can bring one in the same way, as can a young
  version already in the repository. A Maven version already resolved anywhere on the base isn't new to the
  comparison at all, so an aged update that brings it into another configuration (a young X runtime didn't have but
  another configuration did) is neither held nor refused: it publishes without a grant, as in v0.10.1. A version a
  Gradle parent probe brings into a configuration is the exception: the assessment counts it there, so its decision
  still waits for it, even when the comparison sees it elsewhere on the base. secure-it doesn't guarantee refusing every
  young version before build code loads it: keeping young direct dependencies out is the repository's responsibility,
  and young transitive ones are a known limit.
- **One young version a parent probe brings holds its whole batch (secure-it)**: splitting fixes by age looks only at
  the targets the rule chose, so a young version a Gradle parent probe resolved makes the whole routine decision wait,
  unrelated fixes included, until it ages. A parent past the wait doesn't bound every version Gradle resolves after its
  move: dynamic selections, constraints or resolution rules can bring in a younger one even with exact declarations. A
  publication date that can't be read also keeps the decision waiting.
- **`take-early` doesn't reach an existing ordinary PR (secure-it)**: when an open PR's recorded plan stays the same but
  a Gradle parent probe newly finds a young version, a run keeps that PR before any issue decides, so a valid label isn't
  used. On a moved base review then leaves the PR until the version ages; on an unchanged base it goes by the recorded
  plan and CI, so it can mark the PR ready while its issue still waits.
- **How much of its issues a run reads (secure-it)**: 5,000 entries of its labelled listing, closed issues and any
  labelled PR included, and 1,000 comments or events per issue. Past either, the read fails and the run says so: it never
  goes on with part of a history.
- **Removing an issue's label (secure-it)**: a run lists only labelled issues, so it opens another for what an open one
  tracked, leaving that one open and unmanaged, and a closed one's dismissal stops holding back its findings. Review still reads an issue a PR names by its
  number, but a run's retirement goes by the listing: a PR taken early under such an issue stays open past its wait, and
  a regrouped fix opens beside it.
- **A run whose planning fails changes no issue (secure-it)**: when candidate planning throws or the inventory is
  incomplete, the run executes nothing and leaves the issues as they are. While that persists (on a repository's first
  run, say), a finding the scan sees has no issue yet.
- **A `take-early` attempt ends on any failure (secure-it)**: an agent that couldn't apply it, a failed verification
  or a crash ends it, a transient one included; only a new reason and label start another.
- **A fix that only breaks once its versions aged has no deadline (secure-it)**: a waiting decision's PR opens only
  then, and may still need adapting.
- **A dismissal holds back only what it fully covers (secure-it)**: a subject that also has a finding not dismissed
  opens an issue showing them all, and a decision's PR fixes the dismissed ones too. Closing an issue leaves an open
  ordinary PR for it to review, which may adapt it or mark it ready; close that PR by hand
  ([dismissing findings](../secure-it/README.md#dismissing-findings)).
- **A closing reference can look like a dismissal (secure-it)**: a PR or commit that names a tracked issue after a
  closing keyword (`Fixes #12`) can make GitHub close it once it reaches the default branch, and secure-it takes a
  closing it didn't record for a dismissal, so findings still there can get no new issue or fix. Reopen the issue if
  they should stay tracked. The gate's findings aren't affected. secure-it defuses the references it recognizes in what
  it publishes, as best effort: that doesn't prove GitHub reads no other form as one, and it can't cover what people write.
- **Version-fix PRs from before issues (secure-it)**: review leaves a version-fix PR without a `Tracks` line to its
  owner for good, and nothing closes it. A run still matches one to a fix it plans by its kind and topic alone: it
  keeps it, refreshing only its plan notes, when the plan is unchanged, or redoes it, then with a `Tracks` line, when the plan changed. The
  owner closes such PRs by hand before upgrading (see the upgrade note in the CHANGELOG).
- **GitHub's lagging issue listing (secure-it)**: the filtered listing a run reads its issues from shows a write only
  seconds later. A run reads back by number every issue it wrote, and every issue before executing through it, but a
  run starting within seconds of another's writes can open a duplicate; the next run closes it as superseded (on an
  incomplete scan, only when the issue kept covers every finding the duplicate was opened for). A duplicate a person
  labelled `take-early`, or one running an early attempt, stays open, and the decision runs through neither until a
  person closes one. A notice is posted once
  per run even if the comment listing lags; whether label events and comments can lag the same way, which grants read,
  isn't established.
- **An issue's record is only as trusted as whoever can edit issues (secure-it)**: secure-it reads its decisions back
  from a hidden record in its own issue's description and trusts it, whoever edited it last. GitHub lets anyone with
  the Triage role edit issues (the description included), though not other people's comments, and a `take-early`
  label they add doesn't authorize (secure-it takes it only from write access). So in an organization's repository a
  Triage member can edit a record into authorizing more than a writer did, while that writer's current label and
  unedited reason still stand: another early attempt after one ended, or young versions the label didn't cover. That
  attempt runs before its versions are past the wait: it can execute the young versions in the agent's sandboxed
  repository checks and in Gradle inventory and reference builds before any PR is published, even when it then
  publishes nothing, and what it publishes is a draft PR, which still takes write access to merge. With no label at all,
  an edited record can make secure-it retire one of its own tracked draft PRs too early: review closes it and deletes
  its branch, under the usual ownership and head checks. And an edited record can make an issue close as
  resolved while its advisories are still there, or make a dismissal hide a finding that returned. On a personal
  account's repository, which has no Triage role, everyone who can edit secure-it's issues can push anyway.
  secure-it keeps trusting a record someone else edited, so give Triage only to people you'd trust with a `take-early`
  label. A PR's `Tracks` line is read from the PR's description the same way: review reads its last recognized
  `Tracks` line and keeps that issue number when it publishes an update, even when it names an unrelated issue (it
  posts no notice there); a regular run that redoes the PR replaces it with the current decision's issue.
- **A person using the token's account can look like secure-it closing an issue (secure-it)**: secure-it tells its
  own closing from a person's by the token's login and the event boundary it recorded with the closing (or, for a
  closing recorded before boundaries were kept, its notice's time). A person using that same account who closes and
  reopens the issue after that boundary can be mistaken for reopening it after secure-it closed it. That can retire
  the issue while it's open, or make it count as dismissed once secure-it closes it, so no new issue opens for its
  findings while they're still there. The boundary survives an interrupted run, so the window lasts until a later run
  finishes that closing.
- **Issues track one base branch per repository (secure-it)**: a repository's issues carry no base branch, so secure-it
  reads every tracked issue its write PAT's login opened there (its label and record) as the current base's. A configuration lists a repository
  once, with one `branch`, but runs on different bases with the same login share those issues: other configurations
  or runners, an entry whose `branch` changed, or one without `branch` after the repository's default branch changed.
  A clean assessment of one base can then close the other's still-vulnerable issue as resolved and record its findings
  as absent, and a base switch can reuse the other's dismissals and `take-early` authorizations, or close and
  supersede its issues. Run secure-it on one stable base per repository across all its configurations and runners.
- **A recovered early PR isn't retired in the same run (secure-it)**: after an interruption leaves a published early
  PR unattached to its attempt, recovery attaches it, but that run's retirement still reads the earlier snapshot. If
  its granted versions have aged and the fixes regroup, the run can open an overlapping PR before a later run or
  review retires the old draft.
- **An early attempt whose PR the listing doesn't show yet (secure-it)**: when publication fails after its PR was
  created, the attempt ends as failed if the PR listing doesn't show that PR yet, and review then leaves the PR alone
  as not taken early (with a notice).
- **A lasting gap keeps a fixed finding's issue open (secure-it)**: only a complete scan can conclude that findings
  are gone and record a resolution (a later run finishes that recorded closing even with gaps), so on a repository the gate always reports a gap for (an advisory range it can't read, say), an issue whose
  findings are gone stays open until that gap goes or a person closes it. It says meanwhile that the run couldn't assess
  it, naming what it tracks, rather than its last status.
- **A different token login (secure-it)**: issues are found by their creator, so a write PAT from another account
  starts over: it opens new issues, and the old ones' dismissals and attempts no longer count.

- **A push that lands without the tool knowing (secure-it, bump-it)**: if the process dies right after a push, or
  `git push` reports a failure GitHub didn't have, the PR's body still names the previous head. Runs read that as
  someone else's push and leave the PR alone. Review reports it and says to close the PR if nobody took it over, after
  which a later run recomputes it.
- **An action with no immutable release, newly used (gate)**: a new or additional occurrence fails unless its
  owner is listed in `trustedPackages["GitHub Actions"].owners`. Existing uses do not authorize more copies.
  The gate documents the [scope and risks of trusting an owner](../core/gate/README.md#configuration-githubsupply-chainjson).
  This repository trusts `actions` and `aws-actions`; adopters choose their own policy.
- **Publishing waits for the release's CI only so long**: `publish-agent-runtime.yml` requires the tag's commit to have
  its `check` and `gate / supply-chain` checks green, watching main's `ci` runs still in progress on it for up to 20 minutes.
  A run that outlasts that, or one that doesn't exist yet when the publish lists them, fails it before packing (nothing
  publishes), and it isn't retried when they pass: re-run the publish run's failed jobs once they're green.
- **A repository advisory range read too wide**: a lone upper bound followed by a closed interval
  (`< 3.0.0, >= 1.0.0 < 2.0.0`) reads as either of them, as maintainers' comma-as-OR lists mean, so an AND range
  written that way counts versions outside it as affected when no reviewed record names the same package and
  ecosystem. A non-withdrawn reviewed record that independently clears the version takes precedence; the drop is
  reported as a note. The two-bound form (`< 2.0.0, >= 1.0.0`) reads as its interval.
- **GitHub source repository matching stays as in v0.5.2**: a repository URL whose host only ends in `github.com`
  (`notgithub.com/acme/lib`), or names it in a path, query or fragment, can be read as the wrong GitHub repository.
  A numeric port in a URL (`https://github.com:443/acme/lib`) can be read as the owner (`443/acme`). These limits
  only add or miss repository advisories; OSV still covers the package.
- **Operating-system packages** in container images: no scanner here reads them (Trivy or similar, later). Dockerfile CLIs are covered only through configured npm manifests and locks.
- **Code copied into a package without its own manifest**: npm bundles are read package by package (each bundled `node_modules/<name>/package.json`); JavaScript vendored into a package's own files isn't a package anywhere, so its advisories can't match.
- **Shaded Java dependencies**: classes a library copies (and usually relocates) into its own jar aren't a module in the Gradle inventory, only the jar that ships them is; an advisory on the shaded library doesn't match it, and the only fix is another version of the shading artifact.
- **What a Gradle build hides or changes in either inventory** in the shared inventory job (see the [security model](security-model.md)), and dependencies that aren't external modules: the inventory exports module coordinates only, so local files and JARs aren't covered.
- **Advisories behind a `strictly(...)` pin**: the tools never move the owner's strict versions, so secure-it reports a fix that needs one as blocked, and the default branch's scan keeps failing until the owner moves the pin.
- **Strict pins Gradle doesn't resolve, by deliberate choice**: verification relies on Gradle's inventory and the planned reference comparison ([what it compares](security-model.md#secure-it-and-bump-it)), and doesn't parse source files or unused catalog entries separately. A pin in an inactive branch, an unused catalog entry, any code Gradle doesn't interpret for the inventoried configuration, or a build the inventory doesn't run (left out of `gradle.builds`, or not discovered) isn't checked. The owner chose this scope: the agent's instructions still forbid moving any strict pin, and the PR diff lets the owner review the ones Gradle didn't see.
- **Gradle metadata outside the reference comparison**: declaration `because(...)` reasons and resolved graph edges are exported but not compared with the planned reference; secure-it checks floor reasons separately. Local files, artifacts, attributes and capabilities are outside the exported module/version comparison.
- **A local action behind a link (gate)**: the gate reads a symbolic link in a commit as the path it points to, so a local action behind a linked `action.yml` or a linked parent folder isn't read. GitHub does run such an action, so a PR can place a remote `uses:` behind one, and the gate can miss it without reporting any gap (a linked folder can instead report a misleading gap about a missing `action.yml`). A real run shows GitHub refuses a workflow or reusable workflow behind a link as invalid, and starts no run from a linked `.github`. This is pre-existing in 0.5.1. The tools refuse edits that add links or change what's behind one.
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
  batch planning failure can also block young npm work; existing affected PRs are kept. References run only in final
  verification after authorization. The coupling and failure-propagation rules are in [secure-it](../secure-it/README.md#what-a-run-does), step 3. Narrowed in 0.9.0.
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
  executes both jobs' event/ref validator and the inventory/comparison failure guards; it checks sequential inventory
  wiring, required-job conditions, cooldown report handling and this repository's downstream `check` condition.
  [publish-workflow.test.ts](../core/gate/test/publish-workflow.test.ts) executes the publisher's check-selection step
  with mocked commands, checking the `check` and `gate / supply-chain` query arguments. These tests do not emulate
  Actions scheduling or run both Gradle inventories together on a runner; candidate-pinned PR and default-branch
  scan runs provide that evidence.

## Gradle wrapper updates

bump-it selects and verifies the root Gradle wrapper outside the gate's dependency inventory:

- It reads stable, non-broken releases from services.gradle.org and published repository advisories from
  gradle/gradle; it doesn't scan the distribution archive.
- Nested wrappers, mirrors, custom distributions and prerelease base wrappers are not upgraded.
- The official wrapper jar is checksummed. The generated shell/batch scripts aren't compared with official ones, but
  all four generated files are protected against agent edits, byte for byte and by executable mode.
- A missing or unreadable advisory range leaves the wrapper out with a reported reason; other moves continue.
  Verification of a planned wrapper fails closed.
