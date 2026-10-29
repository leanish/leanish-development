# Changelog

## Unreleased

### Added

- `ignoredVersions` in repository policy: exact npm, Maven and Actions versions with a required reason. Tools skip them across fix, bump, carrier, parent, required-dependency and peer selection, report discarded candidates, and refuse units whose resolution introduces them without automatic retries. Unchanged copies may stay; the gate validates the policy without banning manual adoption. Gradle wrapper versions remain outside this policy.

### Changed

- The release-age exemption is named `trustedPackages`, with the same npm scopes, Maven groups/plugin ID prefixes
  and GitHub Actions owners. It can include third parties as well as the repository's own packages. Trust removes
  the cooldown detection window (and Actions' immutable-release requirement); identity, advisory, malware, source
  and pin checks still apply. The stricter base/head policy preserves trust across a configuration rename.
- The gate strips a Gradle build path's trailing slash without a regular expression, clearing a CodeQL false
  positive; the results are unchanged.

### Deprecated

- `ownPackages` remains accepted as an alias for `trustedPackages`, without warnings; configuring both is an error.
  Repin older gates before migrating configuration, including this repository and the adopter fixtures. The alias
  will be removed in a later minor release after migration; see docs/releasing.md.

## 0.9.1 - 2026-10-28

### Added

- Publishing a stable GitHub release publishes `@leanish/agent-runtime` to npm through
  `publish-agent-runtime.yml`, with trusted publishing (OIDC, no stored token) and provenance. A first job checks the
  release (stable tag on main, green checks), packs the tarball and imports every export from a clean install, without
  publishing permission; a second publishes exactly that tarball in an `npm` environment the owner approves. The
  owner's one-time setup is in docs/releasing.md.
- `@leanish/agent-runtime` exports what the incubator's runtime needs from it and couldn't import:
  `./logger/correlation` (`withCorrelation`, `getCorrelation`), `./logger/redactor` (`SecretEntry`), `./skill/skill`
  (`LoadedSkill`), `./skill/stage-skills` (`writePluginDir`, `WritePluginDirArgs`), `./usage/skill-usage-record`
  (`SkillUsageRecorder`, `SkillUsageRecord`, `SkillRunStart`, `SkillUsageOutcome`, `ModelUsageSummary`),
  `./usage/usage-totals` (`totalSkillUsage`, `UsageTotals`) and `./usage/quota` (`observeQuota`, `QuotaUsage`,
  `QuotaWindowObservation`, `RateLimitSnapshot`).
- `runSkill`'s `SkillCall.credentials` may be a resolver, `() => Promise<Credentials | undefined>` (`Credentials` is
  exported from `@leanish/agent-runtime/skill/run-skill`). It's called once per call, after the call's checks pass and
  its runner is found and before the call is announced to the usage recorder, so a call rejected earlier never
  resolves credentials; a resolver that throws or rejects fails the call with its own error (logged once as
  `credentials-unresolved`, naming only the error's class), with nothing started or recorded, and `undefined` (or
  `null`) means no credentials. An object is used as before.

### Changed

- bump-it's Gradle reference comparison no longer blocks on every resolution failure in the configurations
  `gradle.ignoreConfigurations` lists. The gate skips them; like secure-it, bump-it accepts an edit that fails to
  resolve there the same way as the plan's reference, even when the planned update itself is what makes it fail (the
  check proves the edit matches the plan, not that the ignored configuration resolves). A failure the edit adds,
  removes or changes there is still reported, those configurations' declarations are still compared with the
  reference, and every planned move must still land. bump-it has no Gradle reference check besides verification's.
- `@leanish/agent-runtime`'s `@types/node` peer is optional (`peerDependenciesMeta`), so npm no longer installs it
  through this package. A JavaScript consumer goes without it; a TypeScript consumer must now declare `@types/node`
  `>=24` itself (the same range as before). With `skipLibCheck: true`, one that doesn't gets no error: the
  declarations' `NodeJS.*` references silently become `any`.
- bump-it's "What bump-it moved" table shows a package's copy changes as moves instead of up/downgrades when its
  lockfile graphs prove that no consumer changed version: every changed copy has a dependent, every dependent
  (workspaces included) resolves the same versions before and after, no path changed its package, the changed copies
  took away the versions they brought, and each participating installed identity (name and version) has only one copy
  anywhere in either graph, counting copies that resolve no edge too. Each version is a row `moved` from its old paths
  to its new ones, and copies gained or lost on the way get a row of their own (leanish-development#305 had `ajv` 8.20.0
  and 6.15.0 swap places with no consumer changing version). Anything else, a list cut short, and a package whose moved
  rows would be more numerous or longer than its per-path rows keep their per-path rows. Grouped rows are used only
  when the whole section fits without dropping any lines, with either a plain or compressed plan block; otherwise
  every package keeps its per-path rows. This is display only: the plan block, its digest and verification are unchanged,
  and the verdict is recomputed from the lockfiles each time bump-it writes a body, including an adaptation, never read
  from the PR.

### Fixed

- secure-it and bump-it no longer reject an edit whose failure in a `gradle.ignoreConfigurations` configuration differs
  from the plan's reference only by the export's directory. `gradle-inventory` (`runGradleInventory`) writes the
  repository root, as given and as its real path, as `<repository>` in each configuration's `error` and unresolved
  `failure`, nested builds included: as a path and inside `file:` URIs, percent-encoded ones too (a local Maven
  repository under the repository, for one). Only a whole root with an unambiguous ending is replaced; nothing
  else in the inventory changes, and the schema version stays 3.
- `startRunReport` writes the `start` marker's failure notice through the same guarded write as the final line: a
  stream that throws on it, or fails it and emits `error` later, no longer ends the process with exit code 1 nor
  throws out of `startRunReport`.
- `runSandboxed` and `sandboxWritable` (tool-runtime) check a hand-built `IsolationPolicy` with agent-runtime's shared
  policy validator (`assertValidPolicy`, now exported from `@leanish/agent-runtime/isolation`) before `runSandboxed`
  makes its temp dir or starts a process. An absent, empty or relative `buildCacheRoot` is refused with an error that
  names the field and the entry, and so is a `readDenied` entry that is relative or missing, which used to reach Codex
  unchecked. Valid policies behave as before.
- A carrier's read failures and a direct peer's are now reported as errors too, as 0.9.0 did for an undecided
  publisher identity. A carrier whose locked or candidate bundle can't be read, whose versions the registry can't
  list, whose candidate's publish time is unknown, or whose decision throws gets `undecided` on its fix; a direct-peer
  set gets `undecided` on its blocked entry when its locked manifests can't be read, a copy's version listing or
  candidate manifest can't be read, the version a fix requires of it can't be worked out, a candidate's identity or
  publish-time check throws, a candidate's publish time is unknown, or a chosen companion's publish time can't be read
  (which used to fail the unit when the read threw). The unit is blocked and the rest of the repository goes on, but
  both tools' runs now also list the reason under `errors`, so a batch counts the repository as failed; the command's own exit
  code is unchanged. Existing PRs are kept as for an undecided identity: a run's unit fails instead of rewriting a PR
  whose plan moves such a package, also when what can't be decided leaves the unit blocked or with nothing to move,
  and a review keeps the PR it would recompute. bump-it now computes the routine, majors with an open PR and the first
  `maxNewMajorsPerRun` new majors before any unit acts on a PR, so a direct-peer set that first pass can't decide holds
  back every unit's PR that moves it, as in secure-it. A later new major that runs because an earlier one didn't
  publish is computed in its turn: its failed sets reach `errors` and hold back subsequent units' PRs, but PRs already
  handled aren't rechecked. This keeps execution order and the cap on actual new publications. A failed read is never
  acceptance nor "nothing to do"; a move the rules judge and refuse keeps its note and isn't an error. Changed or new messages:
  - a direct-peer set (both tools, new): "<name>@<version>: the publish time is unknown" within its blocked reason,
    also reported under `errors`;
  - a run's unit (both tools, new): "npm <name>'s direct-peer set can't be decided; keeping the PR", or with every cause
    when there are several ("npm <name>'s publisher identity and direct-peer set can't be decided; keeping the PR");
  - a run's unit (secure-it, new): "npm <name>'s carrier move can't be decided; keeping the PR", also for a carrier
    whose publisher identity check failed, which read "npm <name>'s publisher identity can't be decided; keeping the
    PR";
  - a review (secure-it, changed): "publisher identity can't be decided on the new base; keeping the PR: …" now reads
    "a fix can't be decided on the new base; keeping the PR: …";
  - a review (both tools, new): "a direct-peer set can't be decided on the new base; keeping the PR: …".

## 0.9.0 - 2026-10-27

### Changed

- The gate judges young versions in one module (`young-versions.ts`) that owns the order this needs, from gathering
  the candidates into the snapshot to the required-dependency proofs; compare reuses its snapshot. Verdicts are
  unchanged. Release-age arithmetic is shared across the gate and both tools (`@leanish/gate/age`): the exact
  threshold counts as aged, and an unknown date is never aged nor an exemption.
- Whether an open PR is still the tool's, and what its effective title and body are, is decided in one module
  (`ownership.ts`): the review tick, both tools' runs and secure-it's held claims inspect it the same read-only way,
  and a PR's saved publication is written back only right before a unit or the tick uses that PR. Preparing a unit's
  branch (its reused PR's, or a fresh one) is shared too (`branches.ts`). `recoverPublication` is no longer exported.
  Each unit of a run now inspects every open PR of the tool before matching its plan, so a journal that can't be read
  (or a saved publication that doesn't match its head) fails every unit of that run, each reported on its own, instead
  of only the units whose plan the PR's stale body names; the run still goes on, and nothing is guessed from the body.
  secure-it's held claims now check a saved publication too.
- Breaking for `@leanish/agent-runtime`'s API, which is why 0.9.0 is a minor release: its isolation is agent-neutral.
  `isolationPolicy` replaces `codexIsolation` (same inputs, same checks) and returns an `IsolationPolicy` (denied
  paths, the commands' env, the build cache and an optional Codex login home) instead of Codex runner options; each
  runner gets it through its adapter, `codexRunnerOptions` or `claudeCodeRunnerOptions`, which checks it, so a host
  such as a Lambda function can write one by hand. `codexIsolation` is gone. secure-it and bump-it run both agents
  and their sandboxed commands with the same env, denied paths, build cache and confinement as before.
- `@leanish/agent-runtime`'s run report owns its lifecycle: `startRunReport` handles the signals, the wrapper's
  marker (written at start or once the final line is out, its variable removed before any child process starts), the
  lines written before the final one and the host's extras, through one path for the end and for a signal; a throwing
  `extra` or `beforeFinalLine`, or a result that can't be serialized, is left out and noted in the line's `error`,
  never keeping the line from being written. `RunReport`, `writeFinalLine` and `reportOnTerminationSignals` stay for
  hosts that compose their own, such as a Lambda function. secure-it and bump-it use it; their output, exit codes,
  run.sh's marker and signal handling are unchanged, except that a signal arriving while the final line is being
  written now waits for it (at most 2 s) instead of ending the process before it's out.
- `npm run check` now lints regular expressions (`npm run lint`): ESLint with an explicit list of
  `eslint-plugin-regexp`'s safety and correctness rules (super-linear backtracking and moves, misleading or useless
  groups, backreferences and assertions, invalid or empty patterns, control and misleading Unicode characters, strict
  syntax), no style rules; CI's check job runs it. TypeScript reaches it through a local parser
  (`eslint-typescript-parser.js`): Node's `stripTypeScriptTypes` blanks the types out, keeping every line and column,
  and espree parses the rest, so it relies on the erasable syntax every tsconfig already requires; typescript-eslint's
  parser doesn't run on TypeScript 7. The regexes it found running in quadratic or polynomial time on long input now run
  in linear time, with the same results on well-formed input: trailing slashes in the gate's config, local actions and
  npm archive directories, GitHub's `Link` header, advisory ranges' dashes and hyphen ranges, bump-it's Gradle
  `to`/`through` ranges and wrapper properties, the Claude Code runner's proxy credential scrubbing and setup's GitHub
  API path check. A wrapper property whose value holds U+2028 or U+2029 is read as Java reads it instead of failing with
  a TypeError. A `Link` header naming a next page whose URL holds a `<` (or a `rel="next"` not in a link of its own) is
  refused, instead of ending the paging early or following part of the URL; the gate's GitHub Actions paging shares that
  reading, so it now also refuses a next page off GitHub's API host.

### Fixed

- `@leanish/agent-runtime`'s final line no longer costs a command its exit code when the stream fails the write
  (EPIPE, ENOSPC): `startRunReport`'s end and signal path and `writeFinalLine` listen for the `error` a Node stream
  emits after calling the failed write back, which can come well after it, and drop it instead of the process dying
  with exit code 1. They listen only from the write until the stream's `error` or `close` (after a successful write,
  not past it), leave the host's own listeners alone, and don't wait for either: `end` resolves as before. Nothing more
  is written to the failed stream, and the `after-final-line` marker stays unwritten, so the wrapper still writes its
  own line. `writeFinalLine` now resolves on a stream that throws instead of calling back, as it does on a failed
  write, saying nothing either way. Only the stream's first `error` or `close` after the write is heard: a second one
  ends the process as before. A stream already destroyed or errored, or one without events, is written without listening, so
  writing to it again and again leaves no listener behind.
- The gate reads npm's SLSA v0.2 provenance (`invocation.configSource`: the repository from its `git+<URL>@<ref>`
  uri, the workflow from its `entryPoint`) as well as v1. Before, a package version published with it (npm's earlier
  format) made the whole run fail to complete. Both name a source the same way, so a package moving from v0.2 to v1
  with the same repository and workflow keeps its identity; another predicate type, or a v0.2 statement missing those
  fields or naming anything but `https://<host>/<owner>/<repo>`, is still refused. Also refused now: more than one
  provenance statement for a version, and a statement whose type isn't its entry's. A source's repository and workflow
  are compared apart, so two can no longer match only because they join into the same text.
- The gate no longer drops a project's repository advisory for every version once OSV has a record of it for the
  package: each version is judged on its own. Where OSV-Scanner (GitHub's database, for an action) reports the
  advisory's alias group for that version, its record stands as before; a version only the repository's wider range
  names keeps the repository's record, as an unreviewed finding. Base, head and young candidates follow the same rule.
  Adopters may see new findings for such versions: a PR adding one fails, and it vetoes candidates, but triggers no
  fix on its own. The gate no longer looks single OSV records up before scanning. Review status now qualifies
  inheritance: a reviewed finding is inherited only when base has it from a reviewed source too, so a repository-only
  base finding no longer makes a reviewed one inherited (moving from a version only the repository's wider range names
  to one OSV lists fails, as in v0.8.2, instead of passing with a warning); an unreviewed finding is inherited from
  either. The same rule applies wherever a candidate's advisory counts as already there: the fix rules of secure-it and
  the gate's young-fix and bundle proofs (bundle copies of a name counting together), secure-it's required npm versions
  and bump-it's transitive npm targets (all base copies counting together).
- Errors no longer regroup secure-it's held work: held units are grouped only by couplings and required-young
  relationships, so a transient npm planning error or a recorded Gradle reference failure fails its own unit, reported
  with its error, while the other held units keep their topics, members and PRs. A Gradle execution error in a held
  unit's preflight fails that unit alone, not every held unit of the run. Held groups that can only be planned or
  resolved together now fail apart until they age, instead of joining (v0.8's fallback could gather every held group).
  When the aged batch can't be planned it fails with its own error, without a second attempt, and if it has npm work
  the held units with npm work fail too, since which of its roots join them is unknown; held work without npm still
  runs, unless it would claim a held PR with npm moves. Runs and reviews keep every held PR with npm moves as it is
  then, including one whose fix has aged since, rather than rewrite or retire it.
- secure-it no longer plans an own package's young fix (or an own carrier's, or an own direct peer a fix moves with
  it) as held: the gate never holds an own package, so it now goes with the other fixes instead of waiting in a
  cooldown PR.
- Both tools' runs match an open PR whose body lags behind its head (a body update failed after a push) by the plan
  the journal saved for that head, not by the stale body: a unit no longer opens a second PR beside its own, nor
  takes over another unit's.
- The review tick leaves a PR whose journal records only its head (an entry from before publications were saved) alone
  for the tool's next run to recompute and republish, instead of reporting an error.
- secure-it judges a security fix's publisher identity as verification will: against every copy of the package its
  unit replaces in that lockfile, not the source version alone. Two copies moving together no longer get a move
  refused that the gate accepts; a malicious copy, leaving on its own, borrows no other copy's history. Planning
  checks no longer borrow a copy (or its integrity) from another lockfile, and a required version is judged against
  the copy it replaces at its own path, not retained ones. The remaining planners' limit is in coverage gaps.
  An identity check that fails (any error while checking: a registry or network failure, a provenance it can't read)
  now blocks the package instead of aborting the run: every move of that unit, the ones already judged too, loses its
  move with the error as its problem ("can't be decided"), a carrier move's as before, and the other packages are
  still fixed; a failed read is never taken as acceptance. A malware unit's failure still blocks all malware work and
  runs no other work in its place. bump-it's candidate discovery does the same: a dependency whose identity can't be
  decided gets no move in any line. Either way the run reports it under `errors` as well as among its waiting
  problems, so a batch counts it as a failed repository, not a gap; the command's own exit code is unchanged. This is
  the publisher identity check of a fix or a bump candidate; a direct peer's, and a carrier's other reads (its bundle,
  its versions), keep their own handling. A move lost that way is never read as one no longer needed: while any
  package's identity can't be decided on the new base, both tools' review recomputation keeps the PR it would
  recompute as it is (no retirement, replacement or rewrite from recomputing it), reporting an error; and a run's unit
  fails instead of rewriting the existing PR it would reuse (for a held unit, the one it claimed) when that PR's plan
  moves such a package. Units without an existing PR, or whose PR moves none, still go on, and malware still comes
  first. The review's other paths are unchanged: a held draft whose versions have all aged is still retired, and the
  next run opens its replacement without a package it can't decide yet, reporting that package under `errors`.
- secure-it's Gradle reference checks accept resolution failures in the configurations `gradle.ignoreConfigurations`
  lists, as the gate does: the held preflight leaves them out of the reference, and verification (floor removals'
  too) accepts an edit that fails to resolve there the same way as the plan's reference. A fix the gate would pass is
  no longer blocked by one. A failure the edit adds, removes or changes there is still reported, those configurations
  are still compared with the reference, and every planned move must still land; a parent move and a floor removal
  are still proved only where everything resolved. bump-it's reference comparison is unchanged (in coverage gaps).

## 0.8.2 - 2026-10-27

### Changed

- Documentation: four known limits are now listed with the others, a test pins the first, and 0.9.0 is to fix it:
  planning and verification read different baselines for publisher identity, so planning can refuse a move verification
  would accept. The other three were 0.8.0's known limits: held bodies keep raw length budgets, transient errors can
  regroup held work, and Gradle reference checks include `gradle.ignoreConfigurations`.
- Verification's refusal of a young carrier whose bundled fix it can't justify names the versions advisories no reviewed
  source corroborates ruled out, as planning's does since 0.8.1. A refusal shows at most three advisories per version
  and counts the rest; the recorded vetoes stay whole. A retry still attributes the refusal by its own text, never by
  the versions and advisories it names, so it leaves out the same moves.
- bump-it's agent edits and secure-it's rebase check the agent's description with its plan section the way publication
  will send it (paths cleaned, state and marker added), instead of its raw length: a body that only cleaning or the
  marker pushes over GitHub's limit is refused before verification, with publication's own message, and secure-it no
  longer refuses a held plan whose evidence publication would have trimmed to fit. Publication still checks every body
  before any push.
- A full scan words an unpinned or unverified action's gap as compare does, with the folder it uses in the action's
  repository (`owner/repo/path@ref`).
- A PR's CI is read once per review tick: the adaptation gets the failed jobs and statuses of the same snapshot that
  classified the head as failed, instead of reading the checks again.

### Fixed

- secure-it's report keeps the unreviewed-only findings noted on every copy of a blocked package, not only on the
  copies blocked themselves: also when another copy blocks it, when peers block it later (and the work tied to it), and
  for a malware unit left out whole. A finding already reported isn't repeated.
- The gate refuses to read a working-tree file that symbolic links lead outside the repository (a linked file, or a
  file under a linked folder), as it refuses `uses: ./../x`; it used to read what was outside. Links that stay inside
  are still followed, and broken ones still read as missing.
- bump-it's plan shows package names, versions, locations and notes as literal code spans, as secure-it's does, so
  a link, mention, comment or table pipe in them stays text. `literal()` moved to `@leanish/tool-runtime/pr-text`.
- bump-it keeps the branch names it takes during a run, even for a unit that fails later, so two units whose topics
  cut to the same branch name get one each (the second with a `-2` suffix) instead of the second failing.

## 0.8.1 - 2026-10-26

### Changed

- `@leanish/agent-runtime` is now the shared core that leanish-development-incubator's runtime is to consume instead of
  its copies; until it does, fixes are still made in both. Where the two differ, the host now says so explicitly: the
  run report takes the host's identity and extra fields (also on a signal) and refuses any that would replace its own;
  the agent's commit identity is optional; the GitHub client requires a `headChecks` mode (the tools keep reading
  Actions jobs, never Checks). It also gains skill compatibility validation and the shared `Effort` vocabulary.
  secure-it's and bump-it's behavior and their `run finished` line are unchanged.
- Documentation: repeated rules now live in one place each, linked from the others. Two 0.8.0 limits are now listed
  with the others: a young own-only carrier refused only by verification, and no run-level budget for evidence lookups.
- secure-it's PR text shows what registries, lockfiles and advisory sources supply (names, versions, advisory ids,
  locations, notes and failure reasons) as literal code spans, so a link, mention, comment or table pipe in them stays
  text; it replaces the per-case escaping. Path cleaning never lets a quoted path run past a backtick.

### Added

- `@leanish/agent-runtime` exports `errors`, `skill/validate-compat` and `types/effort`, which the incubator's adapters
  will need once it adopts the package, and no tool here uses.
- `@leanish/agent-runtime` can be packed for npm as compiled JavaScript with declarations
  (`npm run pack -w @leanish/agent-runtime`), versioned as the release, so other repositories can install it;
  publishing it is the owner's optional step (see [releasing](docs/releasing.md#publishing-leanishagent-runtime)). Its
  new `guardDir()` (`@leanish/agent-runtime/guard-dir`) finds the guards from the sources and from the package.
- `npm run clean` removes generated outputs (Vitest's caches and coverage) from the root and each workspace, and
  `npm run clean:deps` also removes `node_modules`; both are documented in the README's Development section.

### Fixed

- When a package's reviewed fix is blocked, secure-it's report keeps its unreviewed-only findings with the blocker's
  reason, where 0.8.0 left them out (the gate still failed on them).
- In secure-it's report, a refusal because no version fixes (or no single version fixes every fixable target) names
  the candidates that advisories no reviewed source corroborates ruled out for the targets it names (at most ten, the
  rest counted), for ordinary fixes and npm carriers alike. Verification's messages, which a PR can show, are
  unchanged.
- Repository advisories that are neither published nor withdrawn (drafts) are skipped before their optional fields are
  read, in the gate's scan as v0.7.5 did and in secure-it's evidence lookups, so a malformed draft no longer fails
  either.
- A local action or workflow whose path leaves the repository (`uses: ./../x`) fails the read from the working tree,
  as it already did from a commit, instead of being read from outside the checkout. A symbolic link pointing outside
  is still followed from the working tree (see coverage gaps).
- The Claude Code runner leaves the claude.ai account's connectors, Claude Code's bundled skills (`/loop`,
  `/schedule`, `security-review` and the rest; a real run listed 17 besides the agent's own) and its authoring plugin
  out of every run, and denies `PublishPlugin` with the other outward tools. It puts `--` before the prompt (with two
  or more working copies and no model or effort, `--add-dir` read the prompt as one more directory), and runs a call
  without a working copy in an empty directory of its own instead of the tool's (the Codex runner still uses the tool's).
- Breaking for direct constructions: the Claude Code runner takes a required `confinement`: `sandbox`, what secure-it and bump-it use, or `restricted`
  (only the read tools, no sandbox needed, write runs refused) for hosts without Claude Code's sandbox, such as the
  incubator's Lambda functions.
- bump-it's "What bump-it moved" table lists lockfile-only copy changes (an in-range npm update) as rows, next to the
  declared moves, instead of bullets under an empty table; a PR with no rows shows no table.

## 0.8.0 - 2026-10-25

### Changed

- secure-it opens one held PR per group of young fixes that can move apart (topic `security-cooldown-<package>`),
  instead of one for all: a young version, or an advisory a person doubts, no longer holds the other young fixes, and
  each can be taken when it ages. The couplings known when splitting (coupled npm peers, a carrier and what it
  carries, and what planning the aged batch finds, such as a root that needs another root's fix) stay in one PR, and
  so do aged fixes that only wait for the same young npm companion; young fixes sharing a young companion stay apart,
  so neither waits for the other. The aged batch, majors and malware are unchanged. Held units are matched to open PRs
  by their own packages (`members` in the plan), the same way in runs and reviews, so v0.7's single held PR is taken
  over by one group and the others open their own; a PR someone else pushed to, or a held one a person marked ready,
  is never claimed. Branches created in one run no longer collide when two topics cut to the same name. Held groups
  whose planning or Gradle reference resolution fails apart (npm roots keeping each other's old requirements, or
  Gradle declarations that must move together) are tried together before publication: the failing groups when there
  are several, then every held group, v0.7's single held batch, which can gather groups that would have passed alone
  (their PR then waits for its youngest version); otherwise each stays apart and reports its failure. Each preflight
  failure is logged with its unit and reason.

- A project's own repository advisories, unreviewed and published at will by whoever controls the repository, no
  longer trigger a fix nor justify a young version: they still detect (a finding, a PR adding one fails) and rule
  versions out. Only reviewed advisories (OSV, or GitHub's database for Actions) make secure-it plan a fix and make a
  young version the rule-picked fix, a bundle fix or a required npm dependency. A version affected only by unreviewed
  advisories is reported, not fixed, until a reviewed source lists it. An unreviewed advisory can still rule out the
  version the rule would take and steer it to another, even a young one (held); secure-it's plan notes the ten such
  candidates nearest the choice, on either side, carrier versions included, and counts the rest. A required npm
  dependency's version is set by its requirement, so a veto there refuses the fix, and the refusal now names each
  advisory it adds, marked when unreviewed. A `releaseAge` exception may still name one: the owner's override. The
  rules are in the gate's README ("How each source counts"). GitHub's Actions advisories that aren't `reviewed` or
  `malware` now fail the run.

- A young npm carrier's `bundle-fix` justification requires at least one reviewed bundled advisory it fixes. Its own
  reviewed targets still join the combined choice; an own-only fix must satisfy the ordinary young-fix proof or an
  explicit `releaseAge` exception.

### Added

- secure-it's cooldown warning now says where the advisories each held version fixes appear: the
  dependency's own repository advisories, GitHub's database and OSV, each read after the verification and shown as
  that source says (its declared fix, and whether its ranges put each replaced and proposed version among the affected
  ones). It reports problems only: a line opens the warning when no reviewed record (OSV, or GitHub's reviewed
  database) backs some advisory as read now, with those rows marked, and a fix it couldn't check is listed with its
  reason. A lookup that fails is shown as such, never as "not found". The table lists its ⚠ rows first; when it
  would push a held PR body's raw UTF-16 length past 61,440 for fresh text or 65,280 for text already carrying a
  publication state marker (marker included), it shows the rows that fit, with a line saying how many are left out,
  and the plan's block keeps the evidence; when the PR still can't be written with the evidence, it's left out, and
  each fix that had some is listed as unchecked. The gate's comparison report records, for each held version, the
  advisories it fixes (`targets`), whether or not anything justified it (an exception's named one, whichever source
  lists it); nothing in the evidence changes a verdict.
- When verification refuses an edit the agent wrote, bump-it and secure-it now ask the agent once more, from the base,
  with the refusal (`rejected` in the skill input). In bump-it a second refusal fails the unit as before; in secure-it
  the existing retry without the named package groups still follows, from the second refusal, or from the first when
  the second attempt never reached a verification. A review's adaptation isn't restarted this way. The run report
  lists the first refusal (`rejected`) and, when the unit still fails, why the second attempt stopped short of a
  verification. On kryptovero, the agent replaced a planned Gradle floor with a move of its parent, which the gate
  refused, and the critical fix was never proposed.

### Fixed

- Held Gradle fixes that resolve only together no longer fail in separate PRs: preflight checks the planned reference
  resolution as well as plan construction before assigning PRs, using the same regrouping in runs and base-movement
  reviews. It runs only with two or more held routine units and resolves only plans with Maven moves. Normal edit
  verification still runs before publication. For Gradle, only recorded reference problems regroup units; a thrown
  execution error or missing inventory makes grouping unknown for all held routine units, including npm-only ones.
  All fail for that run; base-movement reviews error for all held routine PRs without closing them, since any could
  have joined the failing group in the all-held fallback. Other run units and PR rebases continue. Preflight results
  (including errors) are shared by base commit and plan identity for one run/review tick;
  verification is not cached. The existing fallback for npm planning errors stays; each preflight failure is logged.

- Both tools now check the actual cleaned title (nonblank, at most 256 UTF-16 units) and marked body (at most 65,536)
  against the client's limits before a push or a text-only API update, instead of letting the client refuse them after
  the push. This final guard only refuses; it does not retry composition without evidence. The held-body raw budgets may drop rows or evidence, or
  refuse an otherwise publishable body; excessive path expansion is refused by the final guard.

- Agent PR descriptions may not carry a `<!-- leanish:state` marker, just as they may not carry a plan marker: fresh
  text cannot pretend to be already published and receive the larger held-body budget.
- The evidence in secure-it's cooldown warning now includes bundled advisories and every alias: a young carrier proved
  both as the fix for its own advisory and for its bundle's now lists both, and each advisory group carries every alias
  the package's own records name (another version's record linking a CVE to its GHSA included), so a backed fix isn't
  flagged as having no GHSA id.
- No text a tool writes in a PR body can carry a plan block of its own any more: bump-it's and secure-it's plan
  sections, secure-it's cooldown warning and every published body defuse any `<!-- leanish:plan` they quote (from an
  advisory, a name, an error or a cleaned path), and replacing a body's state markers never joins the text around
  them into a block, so the tool's own block stays the first one read. secure-it's warning and veto lines also escape
  `<` in what they quote, so a quoted HTML comment can't hide the rest. Before, an advisory's text in the new warning
  could replace a held PR's verified plan for later runs and reviews.
- secure-it matches held units to its open PRs, reading their journals, only when a unit is held, and a journal it
  can't read there fails just the held units instead of the whole run (each unit still reads its own PRs' journals,
  as before).
- A secure-it retry that leaves moves out drops the notes about them too (a floor, an override, an advisory note on the
  move or a package it carries; a note is about the package it starts with), keeping the gate's and the kept moves'
  notes; the left-out section still names each move.
  Before, the PR could still describe a floor it no longer added.
- A secure-it plan without a topic, or whose packages aren't a list of names, no longer reads: a review leaves that PR
  open with an error, and matching held PRs passes over it instead of failing the whole run.
- The gate refuses a repository advisory list's next page off GitHub's API host instead of sending the token there,
  and reads at most 20 pages (either one fails the run, as an unreadable list does); a source repository named `.` or
  `..` (in a manifest, a POM or the config) names none, and a remote action whose owner or repo is `.` or `..` can't
  be read in a job or step (`uses:`) and no longer counts as one elsewhere, so no lookup walks the API path the token
  is sent to.

## 0.7.5 - 2026-10-23

### Fixed

- A large plan no longer stops bump-it or secure-it from publishing its PR. The plan section of a PR body was limited
  to 43,000 characters, and a large routine batch went over it on leanish-development. When the plan's plain block
  doesn't fit, the tools now write it compressed (brotli, as `<!-- leanish:plan:br … -->`), and shorten the table for
  people to what fits, with a line saying how many lines aren't shown. A plan that fits is written exactly as before,
  so open PRs keep their text, and releases before this one read every PR they could have written themselves.
  A plan stays refused when even compressed it doesn't fit, or when its JSON is over 1 MiB, which also bounds what a
  block in a PR body can decompress to. Reads still take the first well-formed block.
- A body over GitHub's 65,536 characters (with secure-it's cooldown warning) now fails while it's composed. The tool's
  state and ownership markers are added later, at publication, so a body within about 160 characters of the limit can
  still exceed it and fail there, potentially after the branch was pushed, as before.

### Rolling back

Earlier releases don't read a compressed plan. After a rollback, neither tool's regular run can match a PR carrying one
to its plan, so either tool may open another PR for the same work. Review ticks still recognise ownership: with the
recorded base unchanged, bump-it may mark the PR ready on green CI, or consume failed adaptation attempts and
eventually close it when CI keeps failing. If the base moved, bump-it reports an error; secure-it's review tick reports
an error when reading the plan. Close those PRs by hand before rolling back. Where a person duplicated a plan block in a PR body, an earlier release reads the
plain duplicate instead of the compressed plan, so remove duplicate blocks too.

## 0.7.4 - 2026-10-23

### Changed

- The agent's `git` guard, in both tools, checks only pushes. A push to a remote whose every push URL is on this
  machine passes, so a repository's own tests can push to bare repositories; any other `git push`, `send-pack` or
  `http-push` command is refused with a message that the tool publishes. The guard no longer parses `git config`,
  `git remote` or `-c` settings. The agent's git metadata is read-only, and the only credential it can reach is its
  read-only GitHub token: its git reads neither the home's nor the system's config, and the sandbox can't read the
  Keychain, `~/.git-credentials` or the SSH keys. So neither a config change nor a `-c` setting such as
  `credential.helper` can write to GitHub: the read-only token is all they could use. Like any command in a write
  run, they still reach the network. The guard is a guard rail, not a boundary (see the
  [security model](docs/security-model.md#secure-it-and-bump-it)): a push under an alias, or one whose
  `-c remote.<name>.receivePack` runs another command, isn't recognised and may reach another repository on this
  machine, as an alias could in 0.7.3. A mistaken remote or config change now fails in git ("could not lock config
  file") instead of in the guard.

### Fixed

- A repository's own tests run in their normal time under the agent. The `git` guard started several processes on
  every call (`tr`, `dirname`, subshells), which doubled real-git test suites and made some hit vitest's 5 s timeout
  in the agent's sandbox. It also refused `git -c credential.helper=` and `git remote add`, which failed 23 of this
  repository's release-installer tests. On secure-it's fast-uri pass over this repository the agent spent most of its
  840 s on that and timed out once.
- `git --attr-source <tree> push …` and `git --config-env <name> push …` no longer skip the push check: their value
  was taken for the subcommand.

## 0.7.3 - 2026-10-20

### Fixed

- secure-it lands npm security fixes that its dependents' ranges already admit in projects with workspaces. Such a
  fix moves the lockfile through a temporary pin, which npm also ignores for an already-locked package
  ([npm/cli#4834](https://github.com/npm/cli/issues/4834)); 0.7.2's `npm update` covered lasting overrides only. Now
  any planned target install leaves unlanded gets the update; every copy of a planned name the update moves must
  land at its own version or one the plan gives that name. What install moves, and other packages the update moves,
  are judged as they are without an update: by verification and the gate, whose cooldown holds every version
  younger than the wait. Until then such a fix failed with "did not land exactly" (fast-uri in leanish-development).

## 0.7.2 - 2026-10-20

### Fixed

- secure-it lands npm security overrides in projects with workspaces: there `npm install` ignores a new override for
  a package the lockfile already holds ([npm/cli#4834](https://github.com/npm/cli/issues/4834)). When install leaves an
  override unlanded, secure-it runs `npm update` for those names. Each copy of them must then end at its own version
  or one the plan gives that name; a copy at a new path (npm hoisting differently) may also take a version another
  copy had in base, and verification still fails the fix if any copy keeps an advisory the plan targets. Until then
  such a fix failed with "did not land exactly".
  Known limitation: when the update also moves another copy of that name to a version that is neither its own nor
  one the plan gives that name, secure-it still fails clearly instead of landing the fix; it needs a person until npm
  fixes the bug.
- secure-it removes Gradle security floors from configurations with default dependencies, such as checkstyle's. The
  reference build that checks the removal emptied the configuration's own dependencies, so its defaults came back on
  top of the declarations it inherited from the filtered copy: the tool's dependency counted twice and verification
  failed although the edit was right. The configuration now keeps its own dependencies but the floors, so its
  defaults and dependencies the build adds later apply as they would once the floors are deleted. Removing a floor
  that is a configuration's only declaration still fails when its default dependencies then apply, as before.

## 0.7.1 - 2026-10-20

### Added

- Every `batch` and `test-run` also writes a full log for the person, `<dirs.state>/logs/batch-YYYY-MM-DD.jsonl`, with
  each tool's output and how each command ended, so a failed command's reason can be found. The scheduled agent never
  sees it or its path; its summary only says `logFailed: true` when the log couldn't be written.
- `schedule`'s command rule says what it replaces (`commandRule.replaces`): the exact form of earlier releases' Claude
  entries for that tool and owner, or the whole Codex rule file.

### Changed

- bump-it writes planned action pins itself, as it writes npm files and wrappers, and declares them to the agent as
  tool-written. A plan the tool writes entirely (a routine, or a major of the gate's own reusable workflow, whose
  caller verification already lets change only in its pin) no longer runs the agent; such a pass may change only the
  files the tool wrote, as the agent's workspace guard required. On v0.7.0's repin pass an agent
  asked to move the gate pin also rewrote a stale comment in that workflow, which verification rightly refused. A gate
  release that changes the caller's inputs still needs a person: its pin PR fails in CI, as the agent's edit failed
  verification before.

### Fixed

- Both tools read the checks the base branch's rulesets require: a draft whose reported checks all pass, but where a
  required Actions check hasn't reported, is marked ready (a workflow can start only on `ready_for_review`) with the
  outcome `ready-missing-required`, which that tick's batch lists under attention, instead of a plain `marked-ready`. When the
  rules can't be read (refused or failed), or a required check may come from an app the token can't see, readiness
  uses the reported checks as before and the review says so. Classic branch protection isn't read.
- A `HOME` ending in a slash no longer makes guided setup climb past it while reading or writing an installation.
- The task folder overlap check also refuses a case or Unicode variant of a trusted path, which a case-insensitive
  volume (APFS's default) reaches as the same folder.
- `schedule-check` no longer needs the task folder for a Claude readback without a folder, which Claude's scheduling
  tool never stores.
- The batch counts only each result's own coverage gaps, so a nested breakdown next to a total isn't counted twice.

## 0.7.0 - 2026-10-19

### Added

- A guided installer, `core/setup`, with the skills `install-bump-it`, `install-secure-it` and `add-repository` for
  Claude Code and Codex, all following `core/setup/install.md`. Its commands check the Mac (`doctor`), install a
  verified stable release (`release`), write one installation per GitHub owner (`configure`), print GitHub's pre-filled
  fine-grained PAT forms and the Keychain commands the person runs (`enroll`), check the tokens' reads
  (`verify-tokens`), open the gate adoption PR and propose its settings (`gate`), run the tools (`batch`, and `test-run`
  for one repository, reporting errors, notes and coverage gaps as counts and the PRs that need a person), and describe the desktop app's scheduled task and check its readback (`schedule`,
  `schedule-check`): tool defaults, or the time and day the person picks, plus the exact rule each app needs to run
  the launcher unattended (a Claude `Bash(...)` allow rule, or a Codex execution rule) and a private task folder of
  its own as the task's working folder, so a Codex automation can't change the launcher that rule lets out of its
  sandbox (a Claude task's boundary is its permission mode, checked by the person).
  Guided setup needs stable v0.7.0 or newer; it never creates the app task itself, never merges and never sees a token. `release --candidate vX.Y.Z-rc.N`
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

- Both tools create a missing cache directory (`dirs.cache`, private to the user) before any sandboxed command, since
  the sandbox can write inside it but can't create it: on a fresh installation npm failed there with `EPERM`.

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
