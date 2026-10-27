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
  reference. At this review, version 0.6.0 planned to use the official parsers Gradle ships (its Groovy and Kotlin
  compilers). That plan was later superseded by the owner's decision to use Gradle's interpreted inventory and
  reference comparison only; see the [deliberate inactive-pin limit](coverage-gaps.md).
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

## Release-candidate review of 0.5.2-rc.10 — 2026-10-15

The candidate pass for `v0.5.2-rc.10` (`8cd14d4`) recorded 52 commands, 0 failed. Sol's unprimed review found that
rc.10's case folding still let a link through: lowercasing gives a final sigma (`AΣ` → `aς`) where the repository has
a medial one (`aσ`), which a case-insensitive checkout matches. Rather than fold names the way some filesystem might,
the rule now resolves links by exact name, and a link leading to a path the commit has only by another case or
Unicode form (compared with a folding looser than any filesystem's, so that no variant is missed) fails any edit;
a link whose target is missing under every name leads nowhere and is ignored. Replacing the loose folding with plain
lowercasing failed the sigma case, and disabling the variant refusal failed the case test; each source was restored
byte for byte. Sol also found a pre-existing Maven comparison gap (`1.0-0.1` equal to `1.0`), documented in
[coverage gaps](coverage-gaps.md).

## Release-candidate review of 0.5.2-rc.11 — 2026-10-15

The candidate pass for `v0.5.2-rc.11` (`ee0b3f9`) recorded 52 commands, 0 failed. Sol's unprimed review was clean, so
Astra ran the final validation, and found one regression: the TOML strict-pin check of rc.2 compared only each
`strictly` value and its key path, so changing the `module` beside it moved the owner's pin to another dependency,
which 0.5.1's line comparison had caught. Catalogs now compare every entry a strict version belongs to, whole, and the
entries whose `version.ref` names one. Dropping the `version.ref` part, or comparing only the values again, each failed
its test; the source was restored byte for byte. Astra also found that the link rule checks case variants only at the
final target, not through an intermediate link: new protection that is incomplete rather than a regression, planned
for 0.6.0 and listed in [coverage gaps](coverage-gaps.md). Per the [release review rule](releasing.md), the final
validation earned its cost this time.

## Release candidates of 0.6.0 — 2026-10-16

Each candidate ran a real pass with the fixture repositories (52 commands, 0 failed, apart from npm registry 502s on
rc.6 that passed on rerun), then two Haiku reviews, Sol unprimed and, on the clean candidate, Astra. Findings blocked
only when new or worse than v0.5.2.

- **rc.1 and rc.2 (`d1c5f11`, `0fd5e9b`)**: Sol found the Kotlin/Groovy strict-pin parsers could be bypassed or misled
  (rc.1: parser jars read from a cache the agent's sandbox can write, Groovy parameter defaults, inputs under `/tmp`;
  rc.2: columns counted in UTF-16 rather than code points, and calls enclosing a pin dropped). The owner chose to stop
  parsing build scripts: `supply-chain` interprets what Gradle resolves rather than parsing files. rc.3 (`70e1ccd`)
  was superseded before review.
- **rc.4 (`f41cefb`)**: strict pins through Gradle's inventory only. Sol found that the inventory didn't export
  dependency constraints, and that declarations without a version were dropped unnoticed.
- **rc.5 (`8096ff3`)**: Sol found that a rich strict range lost its `reject` without verification noticing, since the
  inventory didn't export rejected versions. Every rich-version facet is now compared.
- **rc.6 (`4499a1e`)**: Sol found two regressions: tightening the GitHub repository matcher lost scp-style SCM URLs
  without a user, and a project constraint on a root without a group aborted the inventory.
- **rc.7 and rc.8 (`84c536a`, `a77bdea`)**: further matcher forms v0.5.2 read (`git+ssh` with a colon, surrounding
  whitespace, numeric scp owners, `ssh.github.com`) were lost by each tightening. The owner kept v0.5.2's matcher
  instead; its host and port limits are in [coverage gaps](coverage-gaps.md).
- **rc.9 (`8ed5a32`)**: the matcher is v0.5.2's byte for byte, pinned by a 201-case fixture. Both Haiku reviews were
  clean; the gap-hunter ran v0.5.2 and rc.9 on 56 repository-lookup inputs with identical results. Sol found no
  blocker, and two defects v0.5.2 also has, for the next release: an unpinned action moved from an `env` map into a
  step of the same workflow isn't required to be pinned (the occurrence count is unchanged), and an optional root peer
  can skip the new npm deprecation check on a bump-it major. Astra, as final validation, confirmed both and their
  classification by running both versions and found nothing more: this time it confirmed rather than added.

v0.6.0 (`738ec35`) is rc.9 plus its release metadata.

## Release candidates of 0.7.0 — 2026-10-19

0.7.0 adds guided setup, so each candidate was accepted by installing it for real with `release --candidate` on the
fixture repositories: configure, enroll (existing tokens), verify-tokens, gate adoption (the fixture gate PR), test
runs, the app's scheduled task with its readback, and unattended runs from a Claude scheduled task (bump-it) and a
Codex automation (secure-it). Reviews followed the three steps; findings blocked only when new or worse than v0.6.1.

- **rc.1 (`c2739ec`)**: acceptance found that a fresh installation's sandboxed npm failed with `EPERM` (the cache
  directory didn't exist yet, and the sandbox can write inside it but not create it), and that `gate` rewrote the
  workflow's flow collections with extra padding. Fixed in #177.
- **rc.2 (`83131e5`)**: the Claude task ran unattended (12 commands, 0 failed, 18 PRs on GitHub). The Codex
  automation refused the prompt's completion-notification step, which Codex doesn't have: the prompt now says how
  each app waits for one long command (#178).
- **rc.3 (`467101c`)**: both Haiku reviews found nothing blocking. Sol, unprimed, found two blockers: fixture cleanup
  trusted a redirected repository (a renamed fixture could have had another repository's tool branches deleted),
  and batch summaries dropped review outcomes a person must see (closed after failing CI, held, no checks). Fixed in
  #179.
- **rc.4 (`ed6e0a3`)**: the Codex automation couldn't run the launcher: its sandbox blocks it (macOS sandboxes don't
  nest, and the launcher sandboxes repository code itself). `schedule` now prints each app's exact command rule (#180,
  #181). The Haiku reviews raised one point a real run overturned: a repeated `--owner` is already refused.
- **rc.5 (`f9a2cde`)**: both apps ran unattended (Claude 11 of 12, one transient failure that passed when rerun;
  Codex 12 of 12). Astra, as the final step, found what every earlier review missed: the task's folder was the
  release checkout, which a Codex automation can write, while the command rule runs that launcher outside its
  sandbox. Confirmed with `codex sandbox -P :workspace`. The fix (#182) gives each task its own private folder; on
  its PR the Haiku reviews added the creation race and the launcher reading its configuration from the caller's
  folder, and Sol added overlap with configured state paths and `link/..` paths resolved lexically.
- **rc.6 (`b2b934e`)**: the same sandbox probe denied every write to the release, its modules, the installation
  state and config. Haiku found nothing blocking; Sol, unprimed on a fresh thread, found that batch summaries hid
  coverage gaps that v0.6.1's reports showed. Fixed in #183.
- **rc.7 (`1d0da9e`)**: both apps ran unattended (12 of 12 each) and reported coverage gaps (31 and 30, matching the
  tools' reports); the Codex task folder stayed empty and the release checkout clean. Astra found no blocker and
  corrected one classification: a `HOME` with a trailing slash hanging guided setup is new in 0.7.0, not older.

Known limitations, for 0.7.1: that trailing-slash `HOME`; the task-folder overlap check doesn't catch a case variant
on case-insensitive APFS (in a config the person writes); a raw `ENOTDIR` when a task folder's parent is a file;
`core/setup` tests that assume a umask of 022; a batch error reaches the scheduled agent without its reason, by design.

What each step added: Haiku, cheap and fast, caught local defects in each fix (creation race, launcher cwd, a
contradiction in install.md, `CODEX_HOME`) and once was rightly overturned. Sol, unprimed, found the three
correctness blockers (rc.3's two, rc.6's gaps) and, on the fix PRs, the overlap and `..` cases. Astra was decisive
once: on rc.5 it found the sandbox escalation the others missed, by looking at the folder and the command rule
together; on rc.7 it confirmed.

v0.7.0 (`ec5d884`) is rc.7 plus its release metadata.

## Release reviews and candidate of 0.7.1 — 2026-10-20

0.7.1 ran the review steps on `main` before tagging a candidate, so that review fixes wouldn't each cost one. Each
round reviewed `v0.7.0..main`: two Haiku reviews, Sol unprimed on a fresh thread, then Astra on that thread. A
blocker was fixed on `main` through its own PR and the next round started over; findings blocked only when new or
worse than v0.7.0.

- **Round 1 (`5ae5ba2`)**: Haiku and Sol found nothing blocking. Astra found that keeping a green draft as
  `waiting-required` deadlocks a required check whose workflow starts only on `ready_for_review`, confirmed by
  running v0.7.0's and the candidate's review side by side. Fixed in #191: the draft is marked ready, with the
  outcome `ready-missing-required`.
- **Round 2 (`0227fa0`)**: Sol found that the gate's own major, now written by the tool without the agent, skipped
  the agent's workspace guard, while verification let a major change any file. Fixed in #192: a pass the tool writes
  alone may change only the files it wrote. On that PR, Haiku caught a first version that also tightened agent passes,
  and Sol a remaining manifest-field gap.
- **Round 3 (`a72cb49`)**: Astra found the same gap on conflict resolution of a routine pin PR, which also skips the
  agent but dropped what the tool wrote. Fixed in #193.
- **Round 4 (`e78dae2`, then `5331a85`)**: every Haiku round had flagged that a failed read of the required checks
  (a 5xx, a rate limit) kept a green draft as `error`, where v0.7.0 marked it ready. Fixed in #194: such a read counts
  as unknown, with a note and a warning. Sol and Astra found nothing blocking.
- **rc.1 (`5331a85`)**: both tools ran unattended from Claude scheduled tasks on the fixture repositories. secure-it
  ran 12 of 12. bump-it's first run failed on one repository; the new batch log named the cause, an HTTP 502 from
  `plugins.gradle.org`, and the rerun ran 12 of 12. Coverage gaps (30) matched the tools' reports, every PR they
  opened was green, the task folders stayed empty and the release checkout clean.

Known limitations, for 0.7.2: classic branch protection isn't read at readiness; `ready-missing-required` is listed
only on the tick that marks the PR ready; the batch log keeps raw tool output unredacted (private, 30 days).

What each step added: Haiku, in every round, raised the failed-read inconsistency that became #194, and on the fix
PRs caught a first fix's overreach and its documentation gaps; it was rightly overturned on calling the bypass-actor
exposure of a ready PR a blocker (v0.7.0 has it too). Sol, unprimed, found round 2's blocker and, on its PR, the
manifest-field gap that led to the exact tool-written boundary. Astra was decisive twice (rounds 1 and 3), both times
by comparing v0.7.0 and the candidate in memory.

v0.7.1 (`3f3a08d`) is rc.1 plus its release metadata.

## Release reviews and candidate of 0.7.2 — 2026-10-20

0.7.2 followed 0.7.1's order: reviews of `v0.7.1..main` on `main` first (two Haiku reviews, Sol unprimed on a fresh
thread, then Astra on that thread), then one candidate. It carries two secure-it fixes that the daily passes needed:
npm overrides in projects with workspaces ([npm/cli#4834](https://github.com/npm/cli/issues/4834), #199) and Gradle
floor removal beside default dependencies (#200).

- **Fix PRs**: on #200, Haiku's gap-hunter found that a first version, which cleared whatever the configuration
  gained at resolution, also dropped the defaults it inherits beside a parent's dependencies; Sol found it also
  dropped dependencies the build adds later. Both were checked with real Gradle against `main` and the fix.
- **Round 1 (`b223b11`, then `540c212`)**: Haiku found nothing blocking. Its note that materialization accepts a new
  copy at a vulnerable base version led to #201, an end-to-end test that verification still refuses it. Sol, unprimed,
  raised the late-addition case again; it fails visibly, so it was a known limitation. Astra found that it also let a
  wrong edit through: a late project dependency missing from the reference, deleted along with the floor, matched it.
- **Fix (#202)**: the configuration keeps its own dependencies minus the floors, and the filtered copy resolves fresh
  copies of what it inherited. Haiku ran its own Gradle builds; Sol found two more shapes (a copied `withDependencies`
  action clearing or changing the copy), both fixed on that PR. Each shape has a real-Gradle case that fails on
  v0.7.1, on #200's version or on an intermediate fix.
- **Round 2 (`a215b73`)**: Astra found nothing blocking. The pre-existing limits it and Haiku listed went to
  [coverage gaps](coverage-gaps.md) in #203, narrowed on Sol's review.
- **rc.1 (`e49f900`)**: both tools ran unattended from Claude scheduled tasks on the fixture repositories. secure-it
  ran 12 of 12 and published a floor removal (`TEST_gradle#359`) that passed the gate. bump-it's first run failed one
  unit on a GitHub push error (`fatal error in commit_refs`); a rerun of that repository ran with no failure. One gate
  run hit an HTTP 502 from Maven Central and passed on rerun. Coverage gaps (29 and 30) matched earlier candidates;
  every PR the tools opened was green except one held by the cooldown, as planned.

Known limitations, for 0.7.3: classic branch protection isn't read at readiness; `ready-missing-required` is listed
only on the tick that marks the PR ready; the batch log keeps raw tool output unredacted (private, 30 days); after
npm's update, a copy of an overridden name moved to a version the plan doesn't give it still fails the fix; the Gradle
floor-removal limits in [coverage gaps](coverage-gaps.md).

What each step added: Haiku's gap-hunter found the inherited-defaults regression on #200; its notes led to #201's test
and the documented limits, and it was rightly overturned on calling the new-copy case a bypass. Sol found three shapes
on the fix PRs (late additions, a clearing action, a mutating action) and narrowed the docs. Astra was decisive once:
the late project dependency that turned a visible failure into a wrong edit passing.

v0.7.2 (`81c683c`) is rc.1 plus its release metadata.

## Release reviews and candidate of 0.7.3 — 2026-10-20

The v0.7.2 passes still failed fast-uri in leanish-development and the incubator ("did not land exactly at 3.1.9").
fast-uri's dependents already admit the fix, so the plan moves the lockfile only (`npm-lock`), through a temporary
pin; npm/cli#4834 ignores that pin as it does a lasting override, and #199's `npm update` covered overrides only.

- **Fix (#208)**: install leaving any planned target unlanded triggers the update. Before review, a probe ran real
  secure-it from the branch on both repositories, stopped before the agent: the plan was fast-uri 3.1.8 → 3.1.9
  (`npm-lock`) and it landed; main failed there with the production error; the gate's `compare` passed the result,
  which changed fast-uri's three lockfile lines only. On the PR, Sol found the copy check had lost v0.7.2's coverage
  of every planned name; restored.
- **Round 1 (`d844bf0`)**: Haiku's notes became #209 (what the copy check covers). Its blocker, a young transitive
  version an update brings, was overturned: the gate's cooldown holds every version a change adds or changes. Sol,
  unprimed, found that checking every planned name in the final lockfile refused copies install moved legitimately,
  which v0.7.2 accepted. Fixed in #210: the check covers what the update itself moved, measured around it in each
  install pass; what install moves is judged as without an update.
- **Round 2 (`a55efc9`)**: Sol and Astra found nothing blocking; Astra's note added #211, a test variant that fails
  on v0.7.2.
- **rc.1 (`c7a8a1c`)**: secure-it ran 12 of 12; bump-it 11 of 12, one unit failing on an osv.dev network timeout; a
  rerun of that repository ran with no failure. Every PR the tools opened was green except fast-uri, held by the
  cooldown as planned. Coverage gaps (29 and 30) matched earlier candidates.

Known limitations, for 0.7.4: those listed for 0.7.3 under 0.7.2, and bump-it's 43,000-character limit on its PR's
plan section, which a large routine batch exceeded on leanish-development (pre-existing; the next pass fit).

What each step added: Sol was decisive twice (the lost coverage on #208 and the over-broad check in round 1), and
Astra added a discriminating test. Haiku's findings on this release were mostly overturned or documentation.

v0.7.3 (`cd10a45`) is rc.1 plus its release metadata.

## Release reviews and candidate of 0.7.4 — 2026-10-23

secure-it's fast-uri pass over leanish-development (#215) hit the 840 s agent limit once and took 797 s the next time.
The agent spent that time on this repository's own checks under the agent `git` guard. The guard started processes on
every call, which doubled real-git test suites in the sandbox, and it refused `-c credential.helper=` and
`git remote add`, which failed 23 release-installer tests. #217 made the guard check only pushes.

- **#217**: Sol reviewed four rounds of a version that still parsed `git config`, `git remote` and `-c`. Two Haiku
  reviews then found more ways around that parsing (abbreviated write options, values that look like keys). The owner
  chose to keep only the push check and leave the rest to the boundaries that already held: read-only git metadata,
  the read-only token, and a sandbox that can't read the Keychain. Astra asked to hold it over
  `-c remote.<name>.receivePack`, then agreed it doesn't block: the agent can run any command anyway, and can't write
  to GitHub without a credential. Measured in the sandbox:
  - agent-runtime: 33.3 → 18.5 s.
  - tool-runtime: 13.1 s with one timeout → 5.7 s.
  - setup: 23 failures → 395 passing.
- **Release reviews on main** (#218 added the CHANGELOG entry #217 lacked):
  - Haiku ×2: both flagged `-c credential.helper` as a credential route. Measured in the tools' write sandbox, it
    finds no credential. `security find-internet-password -s github.com` returns 44 there and 0 outside, and
    `git credential fill` with `osxkeychain` fails with 128. The real finding was that the docs credited "git reads no
    home or system config" instead of the sandbox (#219).
  - Sol, unprimed: no blocker. The CHANGELOG overstated what `receivePack` can't do (#220).
  - Astra: no blocker. One more overstated sentence: in a write run any command reaches the network, so what the
    read-only token rules out is writing to GitHub (#221).
- **rc.1 (`8bd29ea`)**: `batch` for both tools on all fixtures.
  - secure-it: 12 of 12, 9 PRs. bump-it: 12 of 12, 15 PRs.
  - Every PR was green except fast-uri 3.1.9, held by the cooldown until 2026-10-26 as planned.
  - The longest agent run was 173 s. On 0.7.3's candidate, one took 384 s; the rest were comparable.
- **Passes on v0.7.4**: two regular passes of both tools, 28 commands each.
  - Failures: secure-it on kryptovero in both, pre-existing since 2026-10-21 (a fix that brings jackson 3.2.4,
    younger than the wait). The second pass also had one Maven Central 502 on sqs-codec; a rerun found nothing to fix.
  - The agent had no work on leanish-development in either pass: fast-uri's PR was already open, and bump-it's unit
    needed no agent. #215 was then closed by hand so secure-it would plan it again (#225). The agent ran this
    repository's full `npm run check`, every workspace passing (setup's 395 tests included), in 169 s and 255K
    tokens, against 840 s (timed out) and 797 s with about 425K tokens on v0.7.3.

Known limitations, for 0.7.5:
- Those listed for 0.7.4 under 0.7.3, including bump-it's and secure-it's 43,000-character limit on a PR's plan
  section.
- The `git` guard doesn't recognise a push under an alias or one whose `receivePack` runs another command.
- The incubator's Claude Code runner keeps Claude Code's `/doctor` and its builtin plugins' skills (incubator#31).

What each step added:
- The owner's question about the guard's purpose turned a growing parser into one check.
- Haiku found the parsing holes that led there, but its release "blockers" were overturned by measuring in the
  sandbox.
- Sol and Astra each found an overstated claim in the docs; Astra's hold was settled on its own thread before merging.

v0.7.4 (`1ba1779`) is rc.1 plus its release metadata.

## Release reviews and candidates of 0.7.5 — 2026-10-23

bump-it and secure-it refused a PR whose plan section passed 43,000 characters. #227 writes the plan uncompressed
whenever the whole section fits (so v0.7.4 reads every PR it could have written), compresses it with brotli when it
doesn't, and cuts the people's part only if even that doesn't fit. A body over GitHub's 65,536 characters fails before
anything is published.

- **rc.1 (`2f6e174`)**: `batch` for both tools on all fixtures: secure-it 12 of 12 (9 PRs), bump-it 12 of 12
  (15 PRs). A Haiku review found that reading only the first plan marker, strictly, refused PRs v0.7.4 read: v0.7.4
  takes the first well-formed block. #228 restored that and cleared stray markers on rewrite; CodeQL then flagged the
  cleanup's regex as polynomial, replaced by a linear scan.
- **rc.2 (`55afa39`)**: the same fixture results. A Haiku review found the cleanup could delete a person's text next
  to a stray marker. Asked how much code the change added, the owner judged the cleanup dispensable: #229 removed it
  (`plan-blocks.ts` from 104 to 81 code lines), keeping v0.7.4's rewrite plus the body check. Sol accepted the
  rollback limit below.
- **rc.3 (`989e9ed`)**: the same fixture results. Every PR was green except fast-uri, held by the cooldown until
  2026-10-26 as planned; one TEST_gradle check was rerun after a plugins.gradle.org timeout. Haiku ×2 and Sol,
  unprimed: documentation only. #230 took Sol's wording for the rollback and body-size notes.
- **rc.4 (`d807fe5`)**: the CHANGELOG only. Astra, on Sol's thread: no findings.
- **Passes on v0.7.5**: two regular passes of both tools, 28 commands each, one failure each: secure-it on kryptovero.
  FasterXML's own repository advisories (2026-10-20, not yet in GitHub's database or OSV) affect jackson-core and
  jackson-databind 3.2.3, GHSA-m8xf-2cr7-77ph critical among them, fixed in 3.2.4 (published 2026-10-18). kryptovero
  gets both through `jackson-dataformat-yaml:3.2.3`, whose 3.2.4 is still under the wait, so secure-it planned a floor
  on 3.2.4, the young fix the version rule allows. The agent moved `jackson-dataformat-yaml` and added `jackson-bom`
  3.2.4 instead, and the gate refused both: young, and no fix themselves. The first pass also published the repin PRs;
  the second found nothing new.

Known limitations, for 0.7.6:
- After rolling back to v0.7.4, its review ticks act on PRs with a compressed plan block; remove duplicate blocks
  before rolling back (CHANGELOG).
- A hand-typed malformed `:br` block before the plan hides the plan.
- The early body check doesn't count the state markers (about 160 characters) added at publication, as before.
- secure-it's agent can replace a planned Gradle floor with a parent move. The gate refuses it, so the fix waits for
  the parent to age (kryptovero, above).
- The `git` guard doesn't recognise a push under an alias or one whose `receivePack` runs another command.

What each step added, with rough API-equivalent cost:
- Haiku, six reviews (about 3.5 to 6 minutes each, 25K to 46K tokens of context, cents each): the two findings behind
  #228 and #229.
- Sol: the design of the limit and its PR reviews (11 calls, about $7); unprimed on rc.3, documentation only (about
  $0.60).
- Astra: clean on rc.4 (about $4).
- The owner's question about the change's size removed the code each round had been fixing.
- Claude implemented the release; the strict read, the polynomial regex and the deleted text were all its own.

v0.7.5 (`310925f`) is rc.4 plus its release metadata.

## Release reviews and candidates of 0.8.0 — 2026-10-25

A project's own repository advisories are unreviewed: whoever controls the repository can publish one at will. From
0.8.0 they only detect and veto; a fix or a young version needs a reviewed source, GitHub's reviewed database or OSV
(#235). Held PRs open with a notice of where each advisory behind their young versions appears, the agent is asked
once more with the gate's refusal (#235), and secure-it opens one held PR per group of young fixes that can move apart
(#236). The policy change isn't backward compatible, so 0.7.6 became 0.8.0.

Every candidate with code changes ran `batch` for both tools on all fixtures, as a rule secure-it 12 of 12 (9 PRs)
and bump-it 12 of 12 (15 PRs); rc.2 and rc.11 below were the exceptions. Every PR was green except fast-uri, held by the cooldown until 2026-10-26 as planned. Then
Haiku ×2 reviewed `git diff v0.7.5` (sources only), Sol reviewed it unprimed on a fresh clone and label, and Astra
followed on Sol's thread when Sol found nothing. From rc.3, Sol double-checked every Haiku point Claude dismissed.
From rc.13, by the owner's call, a finding blocked only if it weakened a gate or aborted a run in a realistic case.
Wrong or missing data in the notice's edge cases became a known limit.

- **rc.1 (`e34d167`)**: Haiku's checklist found that when the agent's second attempt couldn't apply or threw, the
  unit failed before the reduced retry, which v0.7.5 published through. #237 restored it, along with a retry note two
  targets share and a guard against `.`/`..` in Actions names.
- **rc.2 (`2217c14`)**: secure-it 11 of 12: cleanup closed TEST_strict#51 a second before review listed it
  (`git fetch` 128), so later runs waited 90 s after cleanup. Haiku found three blockers: OSV ranges with consecutive
  or unsorted `introduced` events were misread, an unreviewed advisory on a version with a reviewed fix was dropped
  silently, and a held PR losing its claim closed saying nothing remained. #238 fixed all three.
- **rc.3 (`950156c`)**: Haiku found no blocker. Sol, unprimed, found two. The notice said every advisory was backed
  while another fix's evidence was missing, and its table could push a held body past 65,536 (a 70,707-character
  warning). Haiku had raised the size risk, and it had been deferred as a known limit. #239 lists unchecked fixes and
  bounds every name and version.
- **rc.4 (`e04d9c8`)**: Haiku and Sol found nothing. Astra found two. Advisory text could carry a plan block read
  before the verified plan (P1), and an own plan without a topic aborted the run (#240).
- **rc.5 (`6a375fb`) and rc.6 (`4d4d2ab`)**: rc.5 was clean for Haiku and Sol. Astra ran out of Codex credits. Four
  Haiku audits of the docs (the owner's ask) led to #241, which is docs only: rc.6 kept rc.5's runs and Haiku reviews.
  On rc.6, Sol found that one malformed journal aborted the run and that a reduced retry kept the omitted moves'
  notes (#242).
- **rc.7 (`a36048b`)**: Haiku and Sol found nothing. Astra found that the retry still kept a note naming a kept
  package. #243 attributes each note to its leading `name@version`.
- **rc.8 (`194b30f`) to rc.10 (`b257625`)**: Sol found a blocker on each:
  - rc.8: a young carrier's evidence left out its bundle targets, and lookups dropped aliases known from other
    versions (#244).
  - rc.9: split held units lost the joint plan two npm roots need for one exact companion, so both failed where
    v0.7.5 published (#245).
  - rc.10: the evidence could push the plan past 1 MiB and stop a verified fix (#246 writes the PR without evidence
    on a size error).
- **rc.11 (`5b66dd1`)**: one bump-it unit failed: the agent wrote text after its final JSON (a model flake). A rerun
  was clean. Sol found nothing. Astra found that `required` and excepted npm holds recorded no targets, so the
  notice could claim every advisory was backed (#247).
- **rc.12 (`ca25f7b`)**: Haiku and Sol found nothing. Astra ran out of credits. The owner then cut the notice down
  (#248): it reports only problems, records held targets in one place, and cuts its table to fit with ⚠ rows first.
- **rc.13 (`1b715b0`) to rc.17 (`6013c18`)**: Sol or Astra found a blocker on each candidate, the first three from size
  limits:
  - rc.13, Sol: a body with no rows left could be within the marker's length of the limit, so GitHub refused it
    after the push (#249).
  - rc.14, Sol then Astra: veto records could pass 1 MiB. Sol withdrew this as unrealistic; Astra reinstated it with
    one repository-only advisory over about 2,000 candidates and eight moves, 1.2 MB (#251). A Haiku docs audit led
    to #250.
  - rc.15, Astra: the body was sized before publication's cleaning, which lengthens short local paths (#252). CodeQL
    then flagged two existing regexes the change made reachable, now linear scans.
  - rc.16, Sol: #251's ten recorded vetoes could leave out the one that forced a young choice. #253 keeps the
    nearest on either side. The owner replaced exact sizing with raw budgets: 61,440 for fresh text and 65,280 for
    published text. The cleaned title and body are checked against the client's limits before any push.
  - rc.17, Sol: lockstep Gradle fixes (`failOnVersionConflict()`) were split, and both failed verification. #254
    resolves held Maven plans through Gradle's reference before splitting; the real-Gradle tests passed 10 of 10 by
    hand.
- **rc.18 (`a46ba49`)**: Sol found nothing. Haiku's gap-hunter found a blocker, which Sol confirmed: #244 let a
  carrier that fixes only its own advisories through the bundle proof, so a young version the young-fix rule refused
  passed. v0.7.5 refused it (#255).
- **rc.19 (`28699bd`)**: Haiku found no gate weakening, only one report-only gap (below). Sol and Astra found
  nothing. Astra confirmed the thirteen blockers from rc.4 to rc.18 were closed, with no other route to them.
- **Passes on v0.8.0**: the six fixture repins (`fixture-repin`) merged green.
  - Pass 1 (2026-10-25 21:44): 28 commands, no errors. bump-it opened the repins leanish-skills#40,
    java-conventions#100, dtv#55, leanish-development#259, leanish-development-incubator#36, kryptovero#19 and
    sqs-codec#176. It also opened updates dtv#54, leanish-development#258, leanish-development-incubator#35 and
    sqs-codec#175 (zstd-jni). On kryptovero, secure-it reported the jackson advisories behind 0.7.5's failures as
    repository-only and proposed no fix.
  - Pass 2 (23:39): 28 commands, no errors. It reviewed the four open update PRs, kept them current and published
    nothing new.
  - `main` of leanish-development failed the gate on fast-uri 3.1.8's four advisories while the held fix waited for
    the cooldown. The owner took the young 3.1.9 (#225, leanish-development-incubator#28), as the held PR intends.

Known limitations, for 0.8.1 (the release notes give each in full):
- The notice's cells escape `|` and `<` but no other markdown; plan notes escape none. The notice also trusts the
  evidence stored in the plan.
- Held bodies use raw UTF-16 budgets, which can cut rows, drop evidence or refuse a publishable body.
- GitHub's update store differs from create (262,144 against 65,536); the tools never send more than 65,536.
- A malformed optional field on a draft repository advisory fails the gate. v0.7.5 skipped drafts first.
- Evidence lookups have no run-level budget.
- A transient npm planning error or a Gradle reference failure can regroup held work.
- The all-candidates-vetoed message doesn't name the veto, and retry notes match by package name only.
- Gradle reference checks include `gradle.ignoreConfigurations`.
- A local `./../x` action read from the working tree can resolve outside the root (as in v0.7.5).
- New in 0.8.0: when a package's reviewed fix is blocked, secure-it's report leaves out an unreviewed-only finding on
  another version (the gate still fails on it).
- A non-malware repository advisory is dropped when OSV has the same id for the package, whatever its ranges (as in
  v0.7.5).
- New in 0.8.0: secure-it may pick a young own-only carrier the ordinary proof refuses. Verification stops it.

What each step added, with rough API-equivalent cost:
- Haiku, 99 runs (about $5.70, each 1 to 25 minutes, under 68K tokens of context): 36 release reviews (about $0.17
  per candidate), 51 on fix PRs, 6 docs audits and 6 on #235/#236. It found 5 of the 22 blockers first (rc.1, three
  on rc.2, rc.18), plus older issues: the Actions next-page host pin, fixed in 0.8.0, and the OSV-range drop above.
  It was clean on 12 candidates where Sol or Astra then found one.
- Sol:
  - 17 unprimed reviews (rc.3 to rc.19), about $11. rc.3's cost is unknown, and rc.4's is estimated.
  - The implementation thread, about $22 over 91 rounds: plans, reviews of every fix, a second opinion on each
    dismissed Haiku point, and #254, #255 and part of #253, which it wrote.
  - It found 12 blockers first. It withdrew rc.14's under Claude's argument, and Astra reinstated it.
- Astra, six reviews (about $24, one estimated): 5 blockers first, including the only P1, plus rc.14's reinstated.
  rc.19 was its only clean pass.
- The owner set the blocking bar and simplified the notice and the sizing (#248, #253). Size limits took three
  candidates (rc.13 to rc.15), and each of those blockers came from an earlier fix.
- Claude implemented the rest. Five blockers came from its own fixes in this release: #242 (rc.7), #244 (rc.18),
  #248 (rc.13), #249 (rc.15) and #251 (rc.16).

v0.8.0 (`10b09ec`) is rc.19 plus its release metadata (#256).

## Release reviews and candidate of 0.8.1 — 2026-10-26

0.8.1 splits the runtime: `@leanish/agent-runtime` becomes the shared core the incubator is to consume, packable for
npm (#268 to #272). It hardens the Claude Code runner and adds a required `confinement` (#268, #269). It also brings
small fixes from 0.8.0's known limits: draft advisories and `..` local paths in the gate (#263), secure-it's report
(#264), literal code spans (#267), `npm run clean` (#262), and docs consolidation (#265, #266, #273).

Most implementation PRs had a Haiku pair, then Sol; #264 had three Haiku runs, #266 and #273 none, some PRs shared a
Sol thread, and Astra reviewed #263 to #265 and #268 to #271. Astra blocked #264 once: the carrier refusal's veto
note sat in the reason verification reports, which a retry can publish in a PR body; 2daf8bb keeps it in planning's
report only. Astra also asked #265 to restore a dropped fact (Gradle's native constraints). Sol raised 8 findings on
5 PRs. All were fixed before merge except one on #262: its guard against a symlinked `node_modules` was replaced by
plain `rm -rf` commands, and Sol's final review accepted that `clean` can follow such a link to delete `.vite`.

- **rc.1 (`7b80fb7`)**: `batch` for both tools on all fixtures: secure-it 12 of 12 (9 PRs), bump-it 12 of 12 (15
  PRs), no failed command. Every PR was green except fast-uri, held by the cooldown (the review prompt gave its
  deadline as 2026-10-26T23:05Z). Haiku ×2 reviewed `git diff v0.8.0` (code only, at `f22696b`; the later changes
  were #264's fix, reviewed by Astra, Haiku and Sol, and the docs in #273, checked by Sol). They found no regression.
  Their seven points were dismissed and agreed by Sol. The checklist's one "blocker" (an outside `uses: ./..`
  aborting the run) was disproved: `git ls-tree` refuses paths outside the repository, so v0.8.0 aborted the same
  way. Sol, unprimed on a fresh clone and label, found nothing; Astra, on its thread, found nothing and confirmed
  #264's leak was closed.
- **Passes on v0.8.1**: the six fixture repins (`fixture-repin`) merged green.
  - Pass 1 (2026-10-26 19:52Z): 28 commands, no errors. bump-it now carries the repin inside each repository's
    routine PR. The repin-only ones merged: leanish-development#276, leanish-skills#41 and dtv#57 (dtv's CI is off at
    the owner's request). The ones that also move other dependencies merged on the owner's OK: sqs-codec#178 and
    java-conventions#101 once green (the latter's supply-chain check first failed on a POM lookup with HTTP 429 and
    passed on a rerun); leanish-development-incubator#37 and kryptovero#20, whose CI is off, after local checks
    passed (the incubator's workspace checks and CDK synthesis, kryptovero's Gradle build; the incubator's LocalStack
    integration job wasn't run).
  - Pass 2 (20:55Z): 28 commands, one failed: bump-it's routine run on sqs-codec stopped when the Claude CLI hit
    its session limit. Its bump-it half rerun after the reset (22:24Z): 14 commands, no errors. It opened
    leanish-development-incubator#38 and sqs-codec#179, merged once green (sqs-codec's 12 checks; the incubator
    checked locally).

Known limitations, for 0.8.2 (listed in [coverage gaps](coverage-gaps.md) and the runtime's README):
- secure-it's report keeps a blocked package's unreviewed-only findings only for the copies blocked themselves.
- bump-it's plan table cells aren't literal.
- Two bump-it topics with the same branch name in one run make the second unit fail visibly.
- A local action reached through a symbolic link pointing outside the repository is read from the working tree.
- The agent runtime's `restricted` confinement relies on Claude Code's file-tool permissions beyond `readDenied`.
- Its `check-runs-then-jobs` mode reads a 403 without rate-limit headers as missing permission.

What each step added, with rough API-equivalent cost:
- Haiku, 26 runs (about $1.00, at most 67,053 prompt tokens each): its points led to changes on #263, #264, #265
  and #267. It found no blocker first, and its release pair's only claimed blocker was disproved.
- Sol, 33 completed calls of 34 attempts (about $5.70): 8 findings on 5 PRs, including #267's two change requests;
  nothing on rc.1 unprimed. Its plan thread triaged the release's scope.
- Astra, 6 reviews (about $20.50): one blocker (#264) and one documentation correction (#265). It approved rc.1.
- Claude implemented the release (main session about $87, an upper bound; sub-agents about $14.50). Ten of the issues
  reviewers found came from its PRs; none reached rc.1 except #262's accepted `clean` behavior.

v0.8.1 (`fab31b9`) is rc.1 plus its release metadata (#274).
