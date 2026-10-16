---
name: bump-it
description: Apply bump-it's selected Gradle declarations and action pins, adapting code only for a major. npm and wrapper files are written by the tool and must remain unchanged.
compatibleCodingAgents: [codex, claude-code]
inputSchema:
  type: object
  additionalProperties: false
  required: [repo, mode, today, kind, moves, toolWritten]
  properties:
    repo: { type: string }
    mode: { type: string, enum: [apply, adapt, resolve] }
    today: { type: string }
    kind: { type: string, enum: [routine, major] }
    moves:
      type: array
      items:
        type: object
        additionalProperties: false
        required: [ecosystem, name, from, to, mechanism, locations, major]
        properties:
          ecosystem: { type: string, enum: [npm, Maven, GitHub Actions, Gradle Wrapper] }
          name: { type: string }
          from: { type: string }
          to: { type: string }
          mechanism: { type: string, enum: [npm-range, gradle-declared, action-pin, gradle-wrapper] }
          locations: { type: array, items: { type: string } }
          major: { type: boolean }
          commitSha: { type: string }
          wrapper:
            type: object
            additionalProperties: false
            required: [distributionUrl, distributionSha256, jarSha256]
            properties:
              distributionUrl: { type: string }
              distributionSha256: { type: string, minLength: 64, maxLength: 64 }
              jarSha256: { type: string, minLength: 64, maxLength: 64 }
    toolWritten: { type: array, items: { type: string } }
    reconciliation:
      type: object
      additionalProperties: false
      required: [baseSha, revertedFiles]
      properties:
        baseSha: { type: string, minLength: 40, maxLength: 40 }
        revertedFiles: { type: array, items: { type: string } }
    failingChecks: { type: array, items: { type: string } }
    conflicted: { type: array, items: { type: string } }
outputSchema:
  type: object
  if:
    properties:
      outcome: { const: applied }
  then:
    required: [publication]
    properties:
      publication: { type: object }
  additionalProperties: false
  required: [outcome, summary]
  properties:
    outcome:
      type: string
      enum: [applied, cannot-apply]
    summary:
      type: string
      minLength: 1
      maxLength: 2000
    publication:
      type: [object, "null"]
      additionalProperties: false
      required: [title, body, commitMessage]
      properties:
        title:
          type: string
          minLength: 1
          maxLength: 200
        body:
          type: string
          minLength: 1
          maxLength: 20000
        commitMessage:
          type: string
          minLength: 1
          maxLength: 200
---

# bump-it

The tool already chose the versions and computed npm files. Read this repository's AGENTS.md or CONTRIBUTING.md,
then apply only the moves supplied. The tool verifies the edit and publishes; you never commit, push, create branches
or touch git metadata. Leave no temporary files: everything in the working tree is committed.

## Apply

When `reconciliation` is supplied, the tool is redoing an existing PR from the default branch at `baseSha`.
It has restored `revertedFiles` in both the index and working tree to that base (removing paths absent there), then
written the new `toolWritten` files. HEAD still contains the earlier PR, or its merge with the base: staged reversions
of its old pins, code and docs are intentional, including paths outside `moves`. Do not unstage or undo that restore,
or re-plan from HEAD. Read `from` against `baseSha` and apply the supplied moves to the prepared working tree;
assess the final diff against `baseSha`, not HEAD. Redo any major adaptation needed for the new target; earlier
adaptations are not carried forward automatically. This context authorizes only the listed restorations and the
usual planned edits, not arbitrary staged changes. The tool verifies the complete result against this base.

- `npm-range`: already applied by the tool. Never change npm dependency fields, package versions, ranges or lockfiles.
  Keep every `toolWritten` lockfile byte for byte. Keep manifests' dependency fields unchanged (dependencies,
  devDependencies, optionalDependencies, peerDependencies, bundleDependencies/bundledDependencies,
  peerDependenciesMeta, overrides, workspaces). Only a major may adapt a manifest's other fields (scripts, config).
- `gradle-declared`: edit the declarations in every configuration location, to exactly `to`, keeping the repository's
  version catalog and build conventions. Never add or change transitive constraints or raise a floor.
- Never change a Gradle `strictly(...)` version (a catalog's `strictly = ...` included), even when it pins a moved
  dependency at `from`: a strict version is the repository owner's deliberate pin. If the plan can't be applied
  without changing one, answer cannot-apply naming the file and the declaration. Never write one either: your
  declarations use a plain version. The tool compares strict declarations and strict constraints Gradle interprets
  against the planned reference. Pins Gradle does not resolve still belong to the owner; preserve them and leave
  them visible in the PR diff.
- `gradle-wrapper`: already generated and applied by the tool. Never touch wrapper files: gradlew, gradlew.bat,
  gradle/wrapper/gradle-wrapper.properties or gradle/wrapper/gradle-wrapper.jar. Keep their bytes and executable
  modes unchanged in every editing mode. Do not run the wrapper task or download/replace a wrapper yourself.
- `action-pin`: replace the planned action's uses in the named files with its same owner/repo/path at `commitSha # to`.
  Preserve the action's path. When a file has several versions, move only the uses at `from` to that move's target.
- Never edit a dependency version outside the supplied moves. The tool-written npm graph can already include
  refreshed or induced transitive versions absent from `moves`; preserve them exactly as written, even if another
  open PR picked different versions. Do not revert them for being outside the move list or resolve them yourself.
- Never change .github/dependency-floors.json, supply-chain.json, supply-chain-exceptions.json, or workflows/actions
  beyond the supplied pins.
- Code, tests, docs and manifest scripts/config may change only for `kind: major`, to adapt to that major.

## Code and comments

Within the files this skill lets you edit:

- Change only what the moves, and a major's adaptation, need, in each file's style: formatting, import order, naming.
- When your edit makes a comment, Javadoc/KDoc/JSDoc or (in a major) a doc false, fix it in the same edit, keeping the
  context it carries: case labels, advisory IDs, the reason for a choice. Leave accurate comments as they are.
- Adapting to a major, remove code kept only for versions the repository no longer supports (judged by its declared
  ranges, peer ranges included); keep it while a declared range still spans both majors.

## Verify

In every mode, run the repository's relevant checks after your edit. They're part of the job, never optional; report
any you couldn't run, with why. For each major, read the release notes or changelog of the versions it crosses (the
package's GitHub releases with `gh`, its CHANGELOG) before your verdict, and link them in it; if you can't read them,
say so in the verdict rather than asserting nothing needs adapting. npm commands inherit min-release-age and
min-release-age-exclude from the runner. Use `npm ci --ignore-scripts` when installation is needed: do not write
lockfiles at all. Do not run npm install, npm update or any command that rewrites the tool's npm files;
--package-lock-only is not a check. Don't run Gradle's wrapper task: the tool has already generated and protected the
wrapper files.

## Resolve and adapt

In `resolve`, resolve the named code conflicts, preserving the base's changes and this major's adaptation; leave no
conflict markers. The tool has taken the base's side of mechanical dependency files and re-written its npm plan and generated wrapper files.
Then apply the non-npm moves. In `adapt`, investigate `failingChecks` (Actions job names and commit status contexts)
with `gh run list --commit <head SHA>`, `gh run view --log-failed` or commit status reads. These use Actions and
Commit statuses permissions, never the Checks API. Fix only what this major broke. If it cannot be fixed within these limits, answer cannot-apply. Routine failures are not adapted.

## Answer

End with one fenced json block and nothing after it.

- `applied`: a `summary`, and a `publication` with:
  - `title`: lower case, what changes (`moving glob to 11.0.3`).
  - `body`: what moves and why, with `from → to` wherever the text names a move. For each major, a verdict: what you
    adapted, a line per file with why, or "no adaptation needed" with the reason (which of its breaking changes you
    checked against which usage). Base it on what you read; never invent a rationale. Then the checks: each command
    you ran with its result, and any you couldn't run, with why. The tool appends its table and plan block, so don't
    repeat them; don't narrate your process; leave out environment noise (sandbox denials, daemon fallbacks,
    warnings) unless it changes what a reviewer should trust.
  - `commitMessage`: in the repository's style.
- `cannot-apply`: a `summary` of what stopped you; omit `publication` or set it to null.

Never claim a check passed unless you ran it successfully.
