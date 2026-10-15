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
- **Changed strict pins in inactive Kotlin/Groovy branches**: the `.gradle`/`.gradle.kts` backstop uses a hand-written lexer. String or comment forms it doesn't understand, such as Groovy slashy (`/…/`) and dollar-slashy (`$/…/$`) strings, can hide a changed `strictly(...)` in a branch the Gradle inventory doesn't see. Active pins are still caught by the inventory and reference checks. Version 0.6.0 plans to replace the lexer with the official parsers Gradle ships (its Groovy and Kotlin compilers). TOML catalogs already use `smol-toml` to compare the whole entries strict versions belong to.
- **Known malware in a Gradle release (0.5.2, fix planned)**: bump-it treats a `gradle/gradle` advisory that affects the current wrapper and its target alike as inherited, malware (CWE-506) included, so it could move the wrapper to an official release that a malware advisory also covers. The wrapper is outside the gate's inventory, so nothing later stops it.
- **Deprecated transitives a major brings (0.5.2, fix planned)**: a bump-it major keeps the dependency graph npm resolves for it without checking new transitives for deprecation, so a newly induced transitive can be a deprecated release.
- **Links in workflow and action metadata (gate)**: the gate reads a symbolic link in a commit as the path it points to, so the actions behind a linked workflow, action metadata file or folder aren't read. This is pre-existing in 0.5.1. The tools refuse edits that add links or change what's behind one.
- **Maven versions with a trailing zero part**: comparing `1.0-0.1` with a missing component looks only at its first item, so it compares equal to `1.0`, and a repository advisory covering `>1.0 <1.1` doesn't match it (Maven's own comparison examines the whole part).
- **Case variants through an intermediate link**: the tools refuse a link whose final target the commit has only by another case or Unicode form, but don't check the folders on the way, so `outer → Alias/file` with `alias → scripts` passes on a case-insensitive checkout. Planned for 0.6.0.
- **`uses` keys outside a step**: the Actions inventory reads every YAML key named `uses` as an action reference, so a valid workflow with `env: { uses: production }` or an action input named `uses` fails the inventory, and the gate or the tools stop before their updates.
- **Lookalike source hosts**: a package repository URL on a host that only ends in `github.com` (`https://notgithub.com/acme/lib`) is read as the GitHub repository `acme/lib` when looking up repository advisories, instead of reporting no GitHub source.
- **Custom conflict-marker sizes**: publication checks a merge's conflicted files for 7-character markers; a `.gitattributes` `conflict-marker-size` makes git write longer ones, which it doesn't recognize.
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
