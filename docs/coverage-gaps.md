# Coverage gaps

What the gate can't see, in two kinds: **reported gaps**, which every report lists next to its verdict (a verdict can pass with them), and **limits**, which no report mentions because the gate can't detect them. For a plain-language overview of coverage, see [What supply-chain handles](what-it-handles.md).

## Reported gaps

- **Dependencies without a GitHub source repository** (npm `repository` and POM `scm` name none): OSV still covers them; their own repository advisories can't be read.
- **A known source repository whose advisories can't be read**: renamed, deleted or made private (404).
- **Repository advisory ranges the gate can't read**: free-text ranges are read as maintainers write them (`< 1.1.21, >= 2.0.0 < 2.1.7`, `6.x <6.1.2`, `4.0–33.7.1`, `≤ 3.4.1`, `4.1.91.Final =< 4.1.117.Final`), but prose such as `< 2.245.0 (on Windows, < 2.246.0)` is reported, not guessed. One reading is known to over-match: an AND range written upper bound first (`< 2.0.0, >= 1.0.0`) reads as every version.
- **Unpinned or unverified remote actions** a PR didn't touch (`uses: actions/checkout@v7`): their version (and advisories) can't be told. A new or changed remote action or reusable workflow must be pinned; that fails, it isn't a gap.
- **`docker://` actions**, new or not: no advisory source covers container images.
- **Local actions without an `action.yml`**, and local reusable workflows that don't exist.

## Limits

- **Operating-system packages** in container images: no scanner here reads them (Trivy or similar, later).
- **Code copied into a package without its own manifest**: npm bundles are read package by package (each bundled `node_modules/<name>/package.json`); JavaScript vendored into a package's own files isn't a package anywhere, so its advisories can't match.
- **Shaded Java dependencies**: classes a library copies (and usually relocates) into its own jar aren't a module in the Gradle inventory, only the jar that ships them is; an advisory on the shaded library doesn't match it, and the only fix is another version of the shading artifact.
- **What a Gradle build hides from its own inventory** (see the [security model](security-model.md)), and dependencies that aren't external modules: the inventory exports module coordinates only, so local files and JARs aren't covered.
- **Advisories behind a `strictly(...)` pin**: the tools never move the owner's strict versions, so secure-it reports a fix that needs one as blocked, and the default branch's scan keeps failing until the owner moves the pin.
- **Strict versions and dependency targets through variables in inactive branches**: verification parses build scripts with Gradle's own compilers and compares each `strictly(...)` call with its enclosing receivers, navigation operators, generic target types and non-closure arguments, including chains, scopes and property receivers. A version or dependency target that reaches a call through a variable, a helper or a property file is checked only when the pin is active, through the inventory; assignments elsewhere aren't traced. Parameter defaults are visited too. A `strictly` identifier or string occurrence the visitor can't account for triggers a whole-file comparison; even an unrelated change to such a file is refused.
- **Gradle scripts loaded with an unusual extension**: changed `.gradle` and `.gradle.kts` files are always parsed. Changed `.groovy`, `.kt` and `.kts` helpers are parsed when either side mentions `strictly` (`.kt`/`.kts` as Kotlin, `.groovy` as Groovy). A script loaded with `apply from:` under another extension, such as `pins.txt`, isn't fingerprinted. Routine plans still refuse such outside-plan file edits, but a major can change one; an inactive pin in it can escape the textual guard. Prose and Java mentioning `strictly` aren't parsed as Groovy.
- **Links in workflow and action metadata (gate)**: the gate reads a symbolic link in a commit as the path it points to, so the actions behind a linked workflow, action metadata file or folder aren't read. This is pre-existing in 0.5.1. The tools refuse edits that add links or change what's behind one.
- **npm aliases without a version** (`"compat": "npm:lib"`): the inventory reads them, but neither tool can rewrite them, so an update fails visibly and a person makes it.
- **Scheduled runs are best effort**: GitHub may delay or skip them, and disables them after 60 days without activity in a public repository.

## Checks that fail rather than leave a gap

These apply to versions a PR adds or changes, in `compare`; unchanged versions and the full `scan` don't get them.

- **Packages from another npm registry**: age and identity are checked against the npm registry only, so they fail, or (own packages) need a reviewed `identity` exception.
- **Maven versions outside Maven Central and the Gradle Plugin Portal**: their release age can't be checked, so they fail unless their repository is listed in `maven.repositories`. Own Maven packages skip the age check.

## Automated test coverage

- **Reusable workflow required-check guards**: the guards that keep a failed Gradle inventory from skipping the required comparison, and keep cooldown red when comparison fails, have no automated test (see [Adopting the gate](../packages/ci/README.md#adopting-the-gate) and the `supply-chain` and `cooldown` job conditions in [supply-chain.yml](../.github/workflows/supply-chain.yml)).

## Gradle wrapper updates

bump-it selects and verifies the root Gradle wrapper outside the gate's dependency inventory:

- It reads stable, non-broken releases from services.gradle.org and published repository advisories from
  gradle/gradle; it doesn't scan the distribution archive.
- Nested wrappers, mirrors, custom distributions and prerelease base wrappers are not upgraded.
- The official wrapper jar is checksummed. The generated shell/batch scripts aren't compared with official ones, but
  all four generated files are protected against agent edits, byte for byte and by executable mode.
- A missing or unreadable advisory range leaves the wrapper out with a reported reason; other moves continue.
  Verification of a planned wrapper fails closed.
