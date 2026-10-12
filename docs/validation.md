# Validation evidence

Each section is dated with when its results were observed. They supplement the automated tests;
they do not replace verification of a new plan or its current-head CI. GitHub App
mode is deferred; this evidence uses the supported PAT mode.

## Gradle wrapper generation (E2)

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

## Joint unlocked floor removal (D2)

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

supply-chain v0.4.2 ran for real on the owner's fixture repositories (`leanish/supply-chain_TEST_*`, private
test inputs kept out of regular passes; see each repository's `VALIDATION.md` for heads, costs and details):

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

## Fixture coverage

What the fixture repositories exercise, by evidence state: **real tool run** (the tools ran for
real and the outcome is recorded), **seed/probe** (seeded and probed locally, outcome not yet
recorded from a tool run), or **unit tests only** (no fixture end-to-end evidence; covered by the
tests in this repository). Case numbers refer to each fixture's `EXPECTED.md`.

| Behaviour | Fixture case | Evidence |
|---|---|---|
| Gate: new findings fail, inherited ones warn; finding identity | gradle 4, npm-actions 7, npm-bundles A | real tool run |
| Gate: default-branch scan; PR judged when it changes | all fixtures (push and PR runs) | real tool run |
| Malware fails and can't be excepted; malware repairs first | — | unit tests only (no real malware can be published) |
| Release age and cooldown hold; proven young fix | npm-bundles A (young carrier) | real tool run (held draft); retirement after 2026-10-15 pending |
| npm required young-dependency proof | — | unit tests only |
| npm publisher identity | npm-actions 7 (minimist blocker), 15 (first seed) | real tool run |
| npm signature or provenance failure | — | unit tests only |
| Actions pins: full SHA plus release tag | gradle, npm-actions, conventions 8 | real tool run |
| Gradle inventory: buildSrc, plugins, configurations | gradle 3/5, conventions 1/5 | real tool run |
| Gradle declared versus resolved | gradle 10, npm-actions 10 | seed/probe |
| secure-it npm direct fix | npm-actions 7 (JSON5) | real tool run |
| secure-it npm parent search, override and floor | npm-actions B, 7 (glob/minimatch) | real tool run |
| secure-it bundled fix through its carrier | npm-bundles A | real tool run |
| secure-it Gradle parent search and floor | gradle 4/C (consumed seeds; re-seed steps in its EXPECTED) | real tool run |
| secure-it floor removal | gradle (#13 open) | real tool run (PR open) |
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

## Automated checks and skips

`npm run check` runs all workspace typechecks and tests. CI enables the real-Gradle
suites with `SUPPLY_CHAIN_GRADLE_TESTS=1`: the gate's inventory coverage and
reference tests, and secure-it's floor-removal and parent-search tests. Local checks
skip them unless explicitly enabled. The Seatbelt test skips when `codex sandbox`
cannot apply a sandbox inside the current process. macOS launchd plist checks skip
on other operating systems. Report these skips separately from passed tests.

The reusable workflow also inventories base/head and runs the gate on the exact
PR candidate.
