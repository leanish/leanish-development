# Why this, and not just Dependabot, OSV-Scanner or Renovate

Those tools are good, and this repository uses two of them: [OSV-Scanner](https://github.com/google/osv-scanner) finds the advisories, and Dependabot's **alerts** stay on as a second source. What they don't do, alone or together, is the reason this exists.

## What the gate adds

- **A PR fails only on what it makes worse.** Base and head are read against **one** advisory snapshot (one OSV-Scanner run over both, one pass over every repository advisory). A finding is ecosystem + package + advisory group, whatever the version or location. So an upgrade that fixes A while B still affects the new version passes, a new advisory on a dependency both sides share is a warning, and only a finding the PR brings fails. Malware always fails.
  - OSV-Scanner's own PR mode compares advisory ids without the package, so a PR that swaps one vulnerable package for another with the same advisory id passes, and inherited malware isn't "new".
  - Dependabot's dependency review checks what a PR adds, against GitHub's database only, and fails on any advisory of an added version, even one the base already had.
- **Advisories before the databases have them.** The gate reads the security advisories each dependency's own GitHub repository publishes, which can be days ahead of GitHub's reviewed database and of OSV: snappy-java's CVE-2026-90559 and six more, and three vite advisories published the same day, were in neither when this gate first reported them. Unreviewed, they detect (a PR adding one fails) and rule versions out; a fix waits for a reviewed source ([how each source counts](../core/gate/README.md#how-each-source-counts)).
- **Every external module Gradle really resolves**, not just declared dependencies: every resolvable configuration of every project (tests, annotation processors, Checkstyle, PIT…), the buildscript and settings classpaths, buildSrc and included builds. Local files and JARs aren't modules and aren't covered.
- **The age rule, with a proof instead of a bypass.** Every new version waits (7 days by default), but a young version passes when it's exactly the security fix the version rule would pick: the lowest fixing version in the compatible line, with no older fix in that line. For npm, a dependency the fix needs can also pass, but only its lowest satisfying version and only when none is aged; the gate reconstructs that proof itself. A backport beats a newer major; a hand-written exception is the last resort.
- **Publisher identity.** An npm version that replaces one the registry still lists fails when its provenance is dropped or moves to another repository or workflow, or, without provenance, when its publisher never published the package before. A package new to the repository has nothing to compare with, so this check doesn't apply to it.
- **Recorded floors, checked.** A floor in `.github/dependency-floors.json` must be declared at that version with a `because(...)` naming its advisories, and take effect (npm: the override pins it and the lockfile installs it); every npm override needs an entry. Removing floors that are no longer needed is secure-it's job.
- **Remote actions are dependencies too.** A new or changed remote action or reusable workflow must be pinned to a commit whose comment names a tag pointing at it, and its advisories are checked like any package's. Local actions are followed to their `action.yml`; `docker://` actions are a reported gap.
- **The default branch is scanned daily** against the day's advisories; a PR is judged whenever it changes.

## What secure-it and bump-it add

- **Transitive fixes at any depth.** A vulnerable package four levels down gets the smallest change that fixes it: a lockfile update, an override, or a Gradle floor recorded with its `because(...)`. Gradle's native `constraints` blocks are another way to repair a transitive; this implementation writes and verifies explicit floors instead. Dependabot's security updates only see GitHub-reviewed advisories, don't write Gradle floors, and can be blocked by another open PR touching the same lockfile.
- **One rule per job.** secure-it takes the smallest fix (lowest version, compatible line first), batching non-majors across ecosystems and keeping each major apart. bump-it takes the highest version past the wait that adds no finding, minors and patches together, each major apart. A coding agent (Codex or Claude Code) adapts code to a major.
- **Floors come off when they're no longer needed:** secure-it resolves without them, together and without the lockfile's influence, and removes only the security floors that prove redundant. Compatibility floors stay.
- **The owner's pins stay.** Neither tool moves a Gradle `strictly(...)` pin: secure-it reports a fix that needs one as blocked, and bump-it notes the pin.

## What each alternative does better

- **Dependabot** alerts and security updates are a switch in the repository settings, cover ecosystems this gate doesn't, and the alerts are free; keep alerts on. Disable security-update PRs when secure-it produces the repository's security fixes. Version updates need a `dependabot.yml`, and then cost nothing to run.
- **OSV-Scanner** alone is enough for a full scan of one tree, and has call analysis for Go and Rust.
- **Renovate** has far more managers, grouping and scheduling options, and auto-merge, and runs as a hosted app.
- **None of them** compares base and head against the same data, reads repository advisories, or proves a young fix; that's the niche.

## Why not run Dependabot updates or Renovate next to bump-it

This project's choice: one producer of update PRs per repository. Renovate and Dependabot could take some routine updates, but neither picks versions by bump-it's rule (the highest version old enough that adds no finding, on the gate's advisory snapshot) or adapts code to a major with an agent. Next to bump-it, either would be a second producer of PRs on the same lockfiles, with its own configuration and conflicts. Dependabot's alerts stay on: free, a second source, and nothing to maintain.
