# Validation evidence

Each section is dated with when its results were observed. The evidence supplements the automated
tests; it doesn't replace verification of a new plan or its current-head CI. It uses PAT mode (GitHub
App mode is deferred). Where an agent ran, it was Codex, except in the section on Claude Code.

## Gradle wrapper generation (E2) — 2026-10-07

bump-it opened the owner-approved wrapper fixture's PR #1, moving the official
root wrapper from **9.7.1 to 9.8.0**. The tool generated it twice under the sandbox
with `--no-daemon`, verified the distribution URL/checksum and official wrapper JAR
checksum, and recorded all four wrapper files' bytes and executable modes.
`gradlew` was unchanged; the other three files changed. The PR's `check` passed on
head `83f2850d3a3a91f3220efc10d29aa4d7410d2955`.

The run completed successfully with **zero skill calls and zero model tokens**.
This proves real wrapper generation and publication without a model, beyond the
earlier public-catalog selection checks and network-free unit tests. No fixture
source or private configuration is reproduced here. The PR was still unmerged
when this evidence was recorded.

## Joint unlocked floor removal (D2) — 2026-10-07

Real sandboxed probes and final secure-it verification ran on synthetic projects
using public packages. The Gradle probe used `--no-daemon` and disabled dependency
locking; npm resolved without its lockfile under the configured seven-day window.

| Fixture | Parent and unlocked resolution | Security floor | Compatibility floor | Result |
|---|---|---|---|---|
| Gradle | `org.apache.commons:commons-compress:1.27.1` resolves `commons-io:commons-io:2.16.1` in `:probeClasspath` | Commons IO 2.16.1 for CVE-2024-47554 / GHSA-78wr-2p64-hpwj | `commons-codec:commons-codec:1.17.1` | Security floor **REMOVED**, compatibility floor **KEPT** |
| npm | `express@4.21.2` requires `path-to-regexp@0.1.12` | path-to-regexp 0.1.12 for CVE-2024-52798 / GHSA-rhx6-c78j-4q9w | `ms@2.1.3` override | Security floor **REMOVED**, compatibility floor **KEPT** |

Both joint proofs passed. The computed removal was applied to separate copies;
final verification passed with no problems. No PR or package was published by
these probes.

The real java-conventions Guava probe also exercised the refusal path: the
security floor was **retained** because its parents still resolved vulnerable
Guava without it. A successful removal on a fixture is not permission to remove
that repository's still-needed floor.

## Real runs on the fixture repositories — 2026-10-12

supply-chain v0.4.2 ran for real on the owner's fixture repositories, private test inputs kept out of regular
passes. Heads, costs and details are in each one's `VALIDATION.md`:
[gradle](https://github.com/leanish/supply-chain_TEST_gradle/blob/main/VALIDATION.md),
[npm-actions](https://github.com/leanish/supply-chain_TEST_npm-actions/blob/main/VALIDATION.md),
[npm-bundles](https://github.com/leanish/supply-chain_TEST_npm-bundles/blob/main/VALIDATION.md),
[conventions](https://github.com/leanish/supply-chain_TEST_conventions/blob/main/VALIDATION.md) and
[bump-it-wrapper](https://github.com/leanish/supply-chain_TEST_bump-it-wrapper/blob/main/VALIDATION.md).

- **Majors that need code.** secure-it adapted code while building a security major
  (gradle case 12: SnakeYAML 1.33 → 2.0) and during review after a later break (case 17).
  bump-it adapted failing majors during review (gradle case 11: JUnit 6; npm-actions case 16:
  glob 13). Each review sequence ran `rebased` → red CI → `adapted` → green → `marked-ready`.
- **npm selection.** bump-it capped `@types/node` at 24 from `engines.node` and the CI matrix
  (npm-actions case 13), skipped the deprecated mimic-fn 5.0.0 for 4.0.0 (case 14), moved stylelint
  16.17.0 → 16.18.0 inside the stylelint-order 8.1.1 major for its peer range, and blocked a
  stylelint 17 major no installed plugin accepted (case 15). A first seed of case 15 failed
  verification on the npm publisher-identity check (`file-entry-cache`/`flat-cache` moved to
  another repository), as intended; it was re-seeded.
- **Renames.** The fixtures were renamed from `test-*`; a read-only check confirmed all 28 open
  tool PRs were still recognised, and real reviews plus a full pass found no duplicates.

## Strict pins on a new fixture — 2026-10-13

The `strictly(...)` handling ran for real, from its branch, on
[supply-chain_TEST_strict](https://github.com/leanish/supply-chain_TEST_strict/blob/main/VALIDATION.md), whose
`EXPECTED.md` lists nine cases (strict declarations, a strict constraint, a strict pin in one configuration only, a
strict vulnerable version, a strict parent, a strict security floor, and an inactive strict branch).

- **secure-it** blocked and reported the fixes of strictly pinned coordinates (snakeyaml, commons-io, guava,
  jackson-databind), floored okio and jackson-core instead of moving their strict parents (okhttp,
  jackson-databind), kept the strict commons-compress floor, and fixed the plain ones (commons-text, commons-lang3).
- **bump-it** moved only the plain declarations (commons-lang3, commons-text and the active joda-time line), left
  the inactive `strictly` line byte for byte, and noted each pin.
- **A finding:** Gradle pins its embedded Kotlin strictly on every buildscript and settings classpath; the first run
  treated that as the owner's pin and blocked fixing kotlin-stdlib on the runtime classpath. Pins now count only in
  the configurations a change touches; the second run floored kotlin-stdlib (its parent okhttp is strict).
- No PR changed a `strictly` line; CI passed on all three PRs.

## Claude Code as the agent — 2026-10-14

Both tools ran with `codingAgent: claude-code` (`claude-haiku-5-5`, effort `high`) on
[supply-chain_TEST_strict](https://github.com/leanish/supply-chain_TEST_strict), from the branch that adds it.

- **bump-it** published the routine ([#4](https://github.com/leanish/supply-chain_TEST_strict/pull/4)): the plain
  declarations and the wrapper moved, every strict pin was left alone, and the PR text named its checks with their
  results and no local paths.
- **secure-it**, first run: the agent declared the new okio, jackson-core and kotlin-stdlib floors with
  `strictly(...)`, and verification refused both units. The skills now say floors use a plain version, never `strictly`.
- **secure-it**, second run: the floor was plain, but its `because(...)` said "okhttp is strictly pinned", and the
  check refused any line containing the word. It now looks for `strictly` in a line's code only, outside strings and
  comments.
- **secure-it**, third run: published the security batch with its floors
  ([#5](https://github.com/leanish/supply-chain_TEST_strict/pull/5)) and the okio floor
  ([#6](https://github.com/leanish/supply-chain_TEST_strict/pull/6)), and blocked the four strictly pinned
  coordinates as before.
- CI passed on all three PRs.

## Release review findings, closed in 0.5.2 — 2026-10-14

The 0.5.1 release review found six ways verification or the gate could let something through; all predated 0.5.0.
Each is closed by refusing the case visibly rather than handling it in full, and each fix has a test that fails without
it (checked by removing the fix):

- **Edits published unverified.** A process left running could change the working tree after verification. Both
  tools now verify a snapshot commit and publish exactly its tree; a real-git test writes after the snapshot and
  publication refuses, pushing nothing.
- **Symbolic links.** A changed path that is a link (mode 120000 in the snapshot), a directory replaced by one
  included, fails verification in both tools.
- **Mutable GitHub Actions releases.** Only an immutable release dates an action; a mutable one fails the gate and
  bump-it notes why it skips it.
- **Gradle configurations appearing during resolution.** A real-Gradle fixture (`SUPPLY_CHAIN_GRADLE_TESTS=1`) makes
  one configuration resolvable from another's resolution; the inventory left it out before, and now fails.
- **Same-version npm artifacts.** A lockfile entry that keeps its version but changes `resolved`, `integrity` or
  bundling fails the gate.
- **`strictly` in string interpolation.** A line with a Kotlin or Groovy `${…}` that mentions `strictly`, or an
  interpolation that doesn't close on its line or holds comments, escapes or triple-quoted strings, fails the
  strict-pin check. The final review's bypasses (a comment, an escaped quote and a nested Groovy triple-quoted string
  hiding where the interpolation ends) are regression tests.

## Release-candidate review of 0.5.2-rc.1 — 2026-10-15

The candidate pass for `v0.5.2-rc.1` (`4f75b1b`) recorded 52 commands, 0 failed, running both tools on the real
adopting repositories and all six fixture repositories.

Sol reviewed the candidate unprimed; Astra then critically reviewed those findings. The second pass kept the three
blocking findings below, rightly overturned the bundle finding as already-documented scope, and found nothing new:
per the [release review rule](releasing.md), its worth this time was the overturn.

- **Shadowed npm lockfiles — blocking, fixed by refusal.** A selected `package-lock.json` with a sibling
  `npm-shrinkwrap.json` in head fails with instructions to list the effective lockfile. The selection never changes
  automatically; baseline discovery and missing-lockfile handling stay lenient.
- **`v`-prefixed compatible lines — blocking, fixed.** Configured numeric segments start after one leading `v` or
  `V`. Tests keep `v1.2.0` and `v2.2.0` in different lines and select the latter as an Actions major, not a minor.
- **Nested Kotlin block comments — blocking, fixed by refusal.** A nested `/*` in a changed Gradle build, settings
  or catalog file fails verification instead of letting comment boundaries hide a changed `strictly(...)` pin.
- **Aged bundle archive versus lockfile metadata — overturned.** This is already a documented limit in
  [what it handles](what-it-handles.md) and the [security model](security-model.md); no code change was made.
- **Two target lines of one action in one workflow — non-blocking limitation.** secure-it rejects the conflicting
  planned pins visibly. Documented for a person to update them by hand.
- **Immutable-release wording — documentation corrected.** The CI README and requirements now say that an
  action's age counts only from an immutable GitHub release, matching the existing policy.

Mutation checks failed as expected: removing shrinkwrap refusal failed five selection, comparison and signature
tests; removing prefix normalization failed three line/selection tests; removing nested-comment refusal failed
three tests. Each source was restored byte for byte. These automated checks exercise the edge cases separately
from the candidate's real-repository pass above.

## Release-candidate review of 0.5.2-rc.2 — 2026-10-15

The candidate pass for `v0.5.2-rc.2` (`f4cfd8b`) recorded 52 commands, 0 failed, running both tools on the real
adopting repositories and all six fixture repositories.

Sol's unprimed review found the Groovy slashy-string strict-pin bypass and three non-blocking findings. Astra's
critical pass kept the bypass, narrowed/downgraded two findings, and added two blockers: a shrinkwrap replacing the
default lockfile and multiline TOML strict values. Under the [release review rule](releasing.md), this second pass
added concrete coverage beyond the first review and calibrated the non-blocking findings.

- **Implicit shrinkwrap replacement — blocking, fixed by refusal.** A root `npm-shrinkwrap.json` without explicit
  `npm.lockfiles` fails compare, scan and signature discovery, with or without a package lock beside it. Explicit
  shrinkwrap selection works; baseline discovery remains lenient.
- **Strict-pin approach — real parsers chosen over hand lexing.** Astra's multiline TOML finding is fixed in 0.5.2
  by parsing `*.versions.toml` with `smol-toml` and comparing the ordered strict key paths and values. Changed pins
  and non-parsing catalogs fail; unrelated changes beside unchanged pins pass. Sol's Groovy slashy-string finding
  is documented as a known deficiency for 0.6.0: string/comment forms the hand-written Kotlin/Groovy lexer doesn't
  understand can hide strict-pin changes in inactive branches. Active pins remain checked by the inventory and
  reference. Version 0.6.0 plans to use the official parsers Gradle ships (its Groovy and Kotlin compilers).
- **Scalar YAML aliases — non-blocking limitation.** An action pin supplied through a scalar anchor cannot be
  updated automatically; verification refuses it visibly. Documented for manual updating.
- **Mixed mutable/immutable releases — non-blocking limitation.** An undated mutable release in a fixing line
  prevents selecting that line even if an immutable fix exists; the existing problem explains the skip.
- **Agent checks — documentation corrected.** Checks run whenever the agent is invoked. Mechanical bump-it
  routines with npm/wrapper moves only verify dependencies and rely on PR CI for repository tests.

Removing the implicit-shrinkwrap refusal failed three discovery, comparison and signature regression tests. The
source was restored byte for byte; explicit shrinkwrap selection and lenient baseline handling are also tested.
Removing the TOML strict-value comparison failed the multiline-value regression: the changed pin was accepted.
The source was restored byte for byte before the full automated check.

## Release-candidate review of 0.5.2-rc.3 — 2026-10-15

The candidate pass for `v0.5.2-rc.3` (`33cc96f`) recorded 52 commands, 0 failed, running both tools on the real
adopting repositories and all six fixture repositories.

Sol's unprimed review found three blockers and one non-blocking issue. Astra's critical pass overturned the bundle
finding as already-documented scope (only the CI README's wording overpromised), kept the other two, and found that
one of them was also a regression in this release: per the [release review rule](releasing.md), it added the most
important finding of the round.

- **Symlinked workflow or action metadata — blocking, fixed by refusal.** A commit records a link as its target
  path, which the gate parsed as YAML with no `uses:`, while the runner reads through the link: actions behind it
  were never checked (pre-existing in the gate). The 0.5.2 snapshot made the tools' verification read commits too,
  so an inherited link also hid an unplanned action edit there, which 0.5.1's working-tree read had caught. Reading
  that metadata now refuses symbolic links in commits and working trees alike, inherited or new.
- **secure-it's branch numbering — blocking, fixed.** The `-2`, `-3` suffix was added before the topic was cut to
  60 characters, so a long topic whose branch was taken looped forever. Both tools now share one helper that cuts
  first, as bump-it already did.
- **Bundled lock metadata — overturned; wording fixed.** The CI README now says a bundled package is scanned as the
  lockfile records it, with the archive compared only where documented.
- **Partial release tags — non-blocking limitation.** bump-it can pick `v1.1`, which verification refuses for want
  of a full tag; documented.

Removing the metadata refusal made the symlink regression test fail; restoring the old branch numbering made the
long-topic test hang until stopped. Each source was restored byte for byte.

## Release-candidate review of 0.5.2-rc.4 — 2026-10-15

The candidate pass for `v0.5.2-rc.4` (`c70fda5`) recorded 52 commands, 0 failed, running both tools on the real
adopting repositories and all six fixture repositories.

Sol's unprimed review found four blockers and one non-blocking limitation. Astra's critical pass compared each with
0.5.1 and split them: two were made worse or newly reachable by 0.5.2, three were already in 0.5.1. Every round so far
had found three or four more pre-existing findings, so the owner chose to block this release only on what is new or
worse than the deployed 0.5.1 and to document the rest as known deficiencies, fixed next. Astra's comparison against
0.5.1 is what made that decision possible: per the [release review rule](releasing.md), its worth this time.

- **Linked directory over action metadata — regression, fixed.** rc.3 refused a linked metadata file but not a linked
  directory above it: a commit has no file there, so the gate reported a missing local action (pre-existing), and the
  tools' snapshot verification missed an edit behind it that 0.5.1's working-tree read had refused. Every directory
  above the file is now checked too.
- **secure-it PR recognition — partly newly reachable, fixed.** Recognition compared branch topics, which are cut and
  made branch-safe. Two packages could share one (`@scope/foo`, `scope-foo`; pre-existing), and rc.3's numbering made
  a cut, numbered branch reachable that recognition then missed, opening another PR each run. PRs are now recognized
  by the unit their recorded plan names.
- **Carried as known deficiencies** ([coverage gaps](coverage-gaps.md)): a Gradle wrapper release a malware advisory
  also covers, deprecated transitives a bump-it major brings in, and npm aliases without a version (non-blocking).

Removing the parent-directory check failed the linked-directory test; restoring branch-topic recognition failed both
recognition tests. Each source was restored byte for byte.

## Release-candidate review of 0.5.2-rc.5 — 2026-10-15

The candidate pass for `v0.5.2-rc.5` (`287637b`) recorded 52 commands, 0 failed, running both tools on the real
adopting repositories and all six fixture repositories. The review blocked only on what is new or worse than 0.5.1.

Sol's unprimed review found one regression, from rc.4's parent-link check: asking git about a file's parents also
lists their other entries, so an unrelated linked sibling (`.github/notes-link`) failed the whole inventory, where
0.5.1 read it. Astra's critical pass confirmed it, found no other regression, and warned that comparing the paths as
written would miss `uses: ././linked`: per the [release review rule](releasing.md), it improved the fix rather than
adding a finding. Only entries that are the file or one of its parents now count, compared after dropping `.` and
empty segments; a `..` segment is refused, since a link before it decides where it leads.

Removing the exact-path filter failed the sibling test; keeping `.` segments failed the `././linked` case. Each source
was restored byte for byte.

## Release-candidate review of 0.5.2-rc.6 — 2026-10-15

The candidate pass for `v0.5.2-rc.6` (`e6229ed`) recorded 52 commands, 0 failed. Sol's unprimed review found one
regression: reading the base with the same link refusal as head made a PR that replaces inherited linked metadata
with the file fail the comparison, so the repair could never pass, where 0.5.1 compared it. The base is now read as
before (a commit gives a link's target path, with no uses), so head's uses count as changes; head stays strict. From
this candidate on, Astra's pass runs only on a candidate Sol finds clean, as the final validation. Making the base
strict again failed the repair test; the source was restored byte for byte.
## Fixture coverage

What the fixture repositories exercise, by evidence state. Case numbers refer to each fixture's `EXPECTED.md`.

- **real tool run:** the tools ran for real and the outcome is recorded.
- **real tool run, branch only:** the tool's branch is recorded, not its CI or comparison results.
- **seed/probe:** seeded and probed locally; no tool-run outcome recorded yet.
- **unit tests only:** no fixture end-to-end evidence; covered by this repository's tests.

| Behaviour | Fixture case | Evidence |
|---|---|---|
| Gate: new findings fail, inherited ones warn; finding identity | gradle 4, npm-actions 7; npm-bundles A | real tool run; npm-bundles: branch only |
| Gate: default-branch scan; PR judged when it changes | gradle, npm-actions, bump-it-wrapper (push and PR runs); npm-bundles, conventions | real tool run; npm-bundles, conventions: branch only |
| Malware fails and can't be excepted; malware repairs first | — | unit tests only (no real malware can be published) |
| Release age and cooldown hold; proven young fix | npm-bundles A (young carrier) | real tool run, branch only (held draft); retirement after 2026-10-15 pending |
| npm required young-dependency proof | — | unit tests only |
| npm publisher identity | npm-actions 7 (minimist blocker), 15 (first seed) | real tool run |
| npm signature or provenance failure | — | unit tests only |
| Actions pins: full SHA plus release tag | gradle 8, npm-actions 8; conventions 8 | real tool run; conventions: branch only |
| Gradle inventory: buildSrc, plugins, configurations | gradle 3/5; conventions 1/5 | real tool run; conventions: branch only |
| Gradle declared versus resolved | gradle 10 | seed/probe |
| npm root and nested copies of one package moving independently | npm-actions 10 | seed/probe |
| secure-it npm direct fix | npm-actions 7 (JSON5) | real tool run |
| secure-it npm parent search, override and floor | npm-actions B, 7 (glob/minimatch) | real tool run |
| secure-it bundled fix through its carrier | npm-bundles A | real tool run, branch only |
| secure-it Gradle parent search and floor | gradle 4/C (consumed seeds; re-seed steps in its EXPECTED) | real tool run |
| secure-it floor removal | gradle (#13) | real tool run (#13 ready, CI green, not merged) |
| `strictly(...)` pins left to the owner (both tools); Gradle's own Kotlin pins not counted | strict 1–9 | real tool run, from the branch before release |
| secure-it verification retry | — | unit tests only |
| Major needing code, adapted while building the PR | gradle 12 | real tool run |
| Major needing code, adapted during review | gradle 11, 17; npm-actions 16 | real tool run |
| bump-it routine and separate majors | gradle 2/3/5, npm-actions 7/10, 8 | real tool run |
| bump-it `@types/node` cap | npm-actions 13 | real tool run |
| bump-it deprecated targets skipped | npm-actions 14 | real tool run |
| bump-it peer companions; impossible set blocked | npm-actions 15 | real tool run |
| bump-it Gradle wrapper | bump-it-wrapper | real tool run |
| bump-it young locked npm copies (0.4.1) and remembered aged moves (0.4.2) | — | unit tests only (a seed stops being young after seven days) |
| bump-it major cap and deferral | — | unit tests only |
| Human pushes left alone; journal recovery; publication races | — | unit tests only |
| Local advisory cache | — | unit tests only (real passes use it) |
| Claude Code as the coding agent | TEST_strict | real tool run (see above) |
| Local paths kept out of published PR text | TEST_strict | real tool run: no local path in the three PRs; the cleanup itself is unit-tested |

## Automated checks and skips

`npm run check` runs all workspace typechecks and tests. Some suites skip unless their environment allows them;
report these skips separately from passed tests:

- **Real Gradle** (the gate's inventory coverage and reference tests, secure-it's floor-removal and parent-search
  tests): only with `SUPPLY_CHAIN_GRADLE_TESTS=1`, which CI sets.
- **Seatbelt** (`runSandboxed`): only on macOS where `codex sandbox` can apply a sandbox inside the current process.
- **macOS only:** the launchd plist checks and `run.sh`'s contract tests.

The reusable workflow also inventories base/head and runs the gate on the exact PR candidate.

## Release-candidate review of 0.5.2-rc.7 — 2026-10-15

The candidate pass for `v0.5.2-rc.7` (`39f8965`) recorded 52 commands, 0 failed. Sol's unprimed review found one
regression, again from reading commits instead of the working tree: a linked `.github/actions` (or `.github/workflows`,
or `.github`) lists as the link itself in a commit, which the inventory's filename filters dropped, so the tools'
snapshot verification stopped reading the actions behind it where 0.5.1 had. The inventory now checks each root and its
parents for links before listing, outside a baseline. Removing that check failed the linked-root test; the source was
restored byte for byte. Two pre-existing gaps are documented in [coverage gaps](coverage-gaps.md): linked folders inside
`.github/actions`, and custom conflict-marker sizes.

## Release-candidate review of 0.5.2-rc.8 — 2026-10-15

The candidate pass for `v0.5.2-rc.8` (`c1022f8`) recorded 52 commands, 0 failed. Sol's unprimed review found two more
regressions from verifying a commit instead of the working tree: a submodule's files aren't in the snapshot, and the
linked-root probe of rc.7 failed a working-tree scan where `.github/actions/action.yml` is a folder. Since rc.3, each
round had found another way a link changed what verification reads (the file, a parent folder, the base, a root).

The owner changed the rule instead of adding another check: what this PR does with links is the tools' concern; links
already in the repository that the PR leaves alone are not. The tools now refuse an edit that adds or changes a link or
a submodule, or that changes anything an existing link, in the base or the edit, leads to (links in parent folders and
chains followed, a link leading outside the repository ignored, since nothing there is published). The gate reads links
as 0.5.1 did, a pre-existing gap now documented in [coverage gaps](coverage-gaps.md), and the per-file, parent, root
and baseline link checks of rc.3 to rc.7 are gone. A pre-existing lookalike-host finding (`notgithub.com` read as
GitHub) is carried to the next release.

Dropping the behind-a-link check failed both link tests; dropping the submodule check failed the added-links test;
following only the first link of a chain failed the chained case. Each source was restored byte for byte.

## Release-candidate review of 0.5.2-rc.9 — 2026-10-15

The candidate pass for `v0.5.2-rc.9` (`99f6f7b`) recorded 52 commands, 0 failed. Sol's unprimed review found that rc.9's
link resolution could be slipped past: it compared paths case-sensitively (`../TOOLS/recipe.txt` reaches
`tools/recipe.txt` on macOS), and it ignored links leading out of the repository, which can come back in through an
absolute path or `../<repository>/…`; v0.5.1 had caught the modeled edit. Paths are now matched regardless of case and
Unicode normalization, and a link leading out of the repository fails any edit. Sol's non-blocking finding, untouched
links in a loop failing every unit, is fixed too: a loop, or more links than a checkout follows, leads nowhere it can
read, so it's ignored. Removing the folding, ignoring outside links again, or failing on a loop each failed its test;
each source was restored byte for byte.
