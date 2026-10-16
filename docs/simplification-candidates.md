# Simplification candidates

No open candidates are recorded.

## Completed: strict pins through Gradle

The owner chose to remove the separate source-parser check. Strict pins are protected by Gradle's inventory and the
[planned reference comparison](../packages/remediation/src/gradle-reference.ts), which compare interpreted strict
declarations and strict constraints, including those supplied by catalogs.

Pins Gradle doesn't resolve, such as an inactive branch or unused catalog entry, aren't checked. This is a deliberate
scope choice: the agent's instructions still forbid changing them, and the owner reviews the PR diff. The separate
Java parser, compiler downloads, protected parser state and catalog comparison are gone.

## Reviewed and kept (2026-10-16)

After the strict-pin parser went, the rest of the code was searched for the same pattern (re-reading what an
authoritative tool already interprets, or guarding a case no build depends on). These were checked and kept; each entry
says what was tried or measured, so the analysis needn't be repeated unless what it rests on changes.

- **Gradle source scan** ([`gradle-sources.ts`](../packages/ci/src/gradle-sources.ts)): planning only, verification
  doesn't use it. Gradle's inventory exports `allDependencies`, declared and inherited or plugin-added alike, with no
  origin, so only this scan tells bump-it which coordinates the repository's own files name; without it bump-it would
  plan moves no file can make. It errs toward "named": a wrong answer fails visibly or skips with a note. Revisit if
  Gradle can export who declared each dependency.
- **Actions `uses:` placement** ([`actions-inventory.ts`](../packages/ci/src/actions-inventory.ts)): replacing the walk
  with fixed paths (`jobs.*.uses`, `jobs.*.steps[*].uses`, `runs.steps[*].uses`) was tried. It came out no smaller (the
  alias, cycle and node-budget handling is the real complexity and stays) and it dropped the fallback that inventories a
  `uses:` in places the code doesn't know, such as GitHub's step `parallel` groups, tying the gate to GitHub's schema.
- **Own SemVer and advisory ranges** ([`versions.ts`](../packages/ci/src/versions.ts)): replacing them with the `semver`
  library was tried. Once adapters kept the callers' contracts it was the same size, and it changed verdicts on edge
  cases (parts above `Number.MAX_SAFE_INTEGER`, versions over 256 characters, leading zeros, `≤`, en dashes, `=<`),
  turning readable advisories into ones that can't be read.
- **Floor removal** (`selectRemovals` in [`floor-removal.ts`](../packages/secure-it/src/floor-removal.ts)): of about
  650 lines, about 40 are the per-floor search with its drop-one-and-retry; the rest (the unlocked probe in a copy, the
  removal edit's verification, the plan's validation) is needed to remove any floor safely. Removing all or none would
  save about 25 lines and let one floor still needed block every other removal. The owner kept automatic removal.
- **Required-young peers** (`holdRequiredYoung` in [`secure-it.ts`](../packages/secure-it/src/secure-it.ts), about 34
  lines): it moves a fix whose required dependency is still young into the existing held `security-cooldown` unit, and
  the requirement-age proof it relies on is needed by the gate anyway. Holding the whole fix for a person would save
  about 80 to 100 lines and make manual what now resolves itself when the wait ends.
- **`landed` and `carriersShipped`** ([`verify.ts`](../packages/secure-it/src/verify.ts)): not duplicates of the gate.
  The gate judges whether a new version is safe and old enough; these check the edit landed exactly the planned npm
  version and, for a carrier, the registry archive's bundle. The gate reads bundles only for young changes
  (`bundleFixProofs`), so for an aged carrier this is the only bundle check.
- **Bundle tar reader** ([`npm-bundles.ts`](../packages/ci/src/npm-bundles.ts)): node-tar's parser doesn't refuse
  unsafe paths or links (only its extractor does), so the path, link and budget policy would stay custom anyway, and
  the library adds six packages. The reader reads manifests only and refuses every link and device entry.
- **Link rules** (`linkProblems` and `resolved` in [`git-copies.ts`](../packages/remediation/src/git-copies.ts)): every
  refusal (an added or changed link or submodule, a changed path behind a link in base or head, a link leaving the
  repository, a case or Unicode variant, a link to the root) is pinned by a test that fails without it; a collapsed
  single rule wasn't proven equivalent, and these rules took ten release candidates to get right. Loops and chains past
  40 links are skipped on purpose: no checkout follows them either, so nothing can be written through them.
