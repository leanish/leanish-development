# secure-it

Fixes what the [supply-chain gate](../ci)'s full scan fails on, at any depth, with the smallest change the version
rule picks, batching non-major fixes and opening each major separately. The code decides versions and verifies the
result; the tool writes npm files, and a coding agent (Codex or Claude Code, set by `agent.codingAgent`) applies
non-npm edits and major adaptations.

```bash
packages/remediation/run.sh secure-it run leanish/sqs-codec      # daily: batch fixes, majors apart
packages/remediation/run.sh secure-it review leanish/sqs-codec   # every few hours: look after its PRs
```

## What a run does

1. **Finds what fails.** It runs `candidates --rule security` on the default branch's head. The Gradle inventory runs
   the build, so it runs sandboxed (see [Isolation](#isolation)).
2. **Groups actionable fixes.**
   - Every non-major package goes in one routine security batch, across npm, Gradle and Actions.
   - Each package needing a major gets its own PR. A package's failing copies stay together: if any copy needs a
     major, all its actionable copies go in that major unit.
   - A package with a blocked copy (no fix or an identity break) is left out and reported, without blocking other
     packages. Keeping copies together preserves verification's requirement that targeted advisories affect no
     version of a planned package left in the tree. Advisories no version fixes stay, inherited.
   - A Gradle fix is blocked and reported when its coordinate is pinned with `strictly(...)` (declared or as a
     dependency constraint) where the fix would act: where it's vulnerable, and every configuration declaring it. The
     pin is the owner's; the gate keeps failing until they decide. Such a coordinate is never taken as a parent that
     carries another fix (that fix gets a floor instead), and a floor declared strictly is never removed. Pins only
     in other configurations, such as Gradle's own strict constraints on its embedded Kotlin, don't count.
   - Malware takes priority: every malicious package goes together, and if any malicious fix cannot move, nothing
     else is planned. No other unit runs while malware remains on the base.
3. **Plans the change** (`plan.ts`), for each version and location.
   - For npm, code reads locked and candidate manifests to find direct peer constraints in either direction.
     Rule-picked security targets stay fixed. A direct that must move with them gets the lowest safe version in its
     own compatible line that makes the connected set consistent: aged (own scopes: any age, or the proved
     required-dependency exception in step 5), adding no advisory group or malware, and passing the gate's publisher
     identity check. Unchanged compatible peers stay at base; a companion may move downward within its line when
     necessary.
   - All these choices use the security batch's same advisory snapshot, and each registry document is read once.
   - An impossible set leaves the batch blocked, with the conflicting peer ranges reported; unrelated fixes proceed.
     Unreadable locked manifests leave npm work blocked because incoming peer constraints cannot be ruled out.

   | Ecosystem | Situation | Mechanism |
   |---|---|---|
   | npm | a direct dependency | change its range and lock |
   | npm | a transitive one that every parent's range allows | lock exactly `to`, through temporary pins (a declaration for peers) |
   | npm | a transitive one a parent's range excludes, when that parent has a version in its own line, past the wait, whose range admits the fix (and that adds no advisory, keeps its publisher, and moves without an override itself) | move that parent too, and lock the copy inside its new range; of a parent's versions, the one admitting the most of the copies it must (the lowest of those that tie) |
   | npm | otherwise (also a copy the parent's chosen version doesn't admit) | a lasting override plus a floor entry (the PR notes why no parent could move, or why the one that moves doesn't admit it) |
   | npm | a copy its parent bundles (`inBundle`) | move the carrier (the nearest non-bundled ancestor) to the version the security rule picks for its bundle, read from the registry archive (`carries` in the plan); a carrier that would need an override is reported instead |
   | Gradle | a dependency the repository's sources declare | change its version |
   | Gradle | a transitive one, or one only a plugin declares, that a dependency the sources declare brings in every affected configuration | first, that declaration's lowest version in its own line, past the wait, that brings a fixed version (proved by a reference resolution, at most 6 per vulnerable module; the declaration moves wherever it's declared, `carries` in the plan) |
   | Gradle | otherwise, or when no such version is proved | a floor: an explicit dependency with `because(...)`, plus its entry in `.github/dependency-floors.json` (the PR notes why no parent could move) |
   | Actions | any | pin to the tag's commit |
   - **Young fixes go apart.** Fixes whose target is younger than the release-age wait, everything coupled to them,
     and any fix whose required npm dependency is young form their own routine unit (topic `security-cooldown`), so
     the aged fixes aren't held back. A major or malware unit with a young version stays whole and is held.
4. **Looks at its open PRs first.**
   - An open PR for the same routine/major/malware unit, with an identical plan and a recognised head: keep its
     commits and refresh the plan section if its notes changed; its review owns further work. The unit reports
     `already-open`. Other major units still proceed. An already-open malware unit is left to review without
     planning other work.
   - One with a different plan, while its head is still the tool's: that PR is reconciled. The default branch is
     merged into it, every file it changed goes back to the base's content, and the new plan is applied on top, so
     nothing the old plan did lingers. It's pushed as a normal commit.
   - One someone else pushed to: the fix goes in a PR of its own.
5. **The tool resolves npm; the agent applies non-npm moves** (skill [`secure-it`](skills/secure-it/SKILL.md)).
   - **npm, by the tool.** In a sandboxed export of base, before any agent work, the tool pins every planned direct
     and peer companion to its exact target at once (unplanned directs keep base versions), installs, restores the
     intended ranges and the manifest's formatting, installs again and requires exact landing. Peer-resolved
     root/workspace copies use temporary exact declarations rather than overrides npm may ignore; unsupported
     nested/conflicting placements are reported and nothing in that unit is published. Existing floors remain, and
     new security overrides get matching floor records. Direct peers selected by code are explicit moves, even with
     no advisory of their own.
   - **Required versions with no aged satisfier.** When a security target needs one, code proves the registry
     requirement and pins its lowest stable, non-deprecated target exactly, including young direct-peer companions
     and recursive requirements. Reciprocal direct peers are solved jointly at their resolved locations, and aged
     bridges are pinned when needed to preserve the proof. The gate independently validates every security root
     before reconstructing the batch's joint requirements; ordinary upgrades cannot narrow the proof's constraints.
     Parent, range, location, target and reason are recorded in the plan identity, PR and run report. Unsafe lowest
     versions, missing metadata, conflicting constraints or a proof bound block the unit. Existing compatibility pins
     remain constraints. Exact declarations support root/workspace anchors; placements the exact resolver cannot
     represent are reported without publication. A verification retry drops connected required sets together,
     leaving unrelated fixes.
   - **Induced versions are npm's choice**, under the release-age window and exclusions, not additional rule-picked
     targets. This covers transitive changes a planned move requires, and new or purely transitive peers unless they
     need the proved exception above. `compare` judges each changed version's advisories, age and identity. They may
     differ from another open PR's target; that PR doesn't constrain resolution. A failed comparison prevents
     publishing that edit rather than silently choosing a coupled target. The PR description lists required
     transitive changes too.
   - **The agent** never changes npm dependency fields or lockfiles; only a major may adapt manifest scripts or
     config, and it changes code only for a major move. Direct dependencies outside the plan stay unchanged. In
     Gradle, the edit must resolve and declare exactly what the plan's reference does (the base with the plan applied
     by Gradle, so a planned plugin fix's own fallout is in it; [`packages/ci/README.md`](../ci/README.md)). Every
     apply, resolve and adapt path verifies the tool-written files before publishing.
   - **The skill asks for** focused edits in each file's style; comments the edit made false fixed without losing
     their context; code kept only for an unsupported old major removed; the repository's checks in every mode; for
     each major, the release notes or changelog it crosses, linked in its verdict; and PR text that maps advisories
     to packages, gives `from → to`, and states each major's adaptation verdict and the checks run. An `applied`
     answer must include all PR text; only `cannot-apply` may omit it or set it to `null` (bump-it's skill too).
6. **Verifies before publishing** (`verify.ts`):
   - existing floor records and declarations are preserved before comparison: compatibility floors never change;
     security-floor updates match exact planned moves and retain their scope and history; only planned security
     floors may be added, or removed in an explicit floor-removal plan;
   - the gate's own policy (its config, its exceptions, workflows and actions outside planned pins) is untouched,
     major or not;
   - no line with `strictly` in its code (not in a string or a comment) changed in a Gradle build, settings or catalog file (floor removals included),
     and the edit keeps the reference's strict declarations and constraints;
   - `compare` against the base passes;
   - every move landed at exactly `to` at every planned location (Gradle: declared at exactly `to`);
   - none of the targeted advisories affects what's left, using compare's head findings from the same snapshot;
   - no other direct dependency or action use changed;
   - only dependency files changed, unless a move is a major.

   A routine batch that fails verification may retry **once**, from the original base, without the whole package
   groups named by its problems, including their whole connected direct-peer set. Every problem must identify a
   planned move through a version-labelled finding or a named landing/declaration failure. A global or unplanned
   induced-transitive failure cannot identify a parent safely, so it gets no reduction. If no moves remain, or the
   second verification fails, nothing is published. Malware and major units are never reduced. Omitted moves and
   the original problems appear in the run report, the PR description and its persisted plan; only the remaining
   moves are claimed as applied. npm may still induce transitive changes, and these still face `compare`. The next
   run reconsiders omitted fixes.
7. **Publishes** draft PRs: `secure-it/<date>-security` for the routine, `secure-it/<date>-<package>-major` for each
   major, or `secure-it/<date>-malware`. Each unit starts from the scanned base and publishes at most one new or
   updated PR. A failed unit is reported and doesn't stop other major units. The tool appends the move table and the
   hidden plan for later runs to the agent's description, and keeps local paths out of the title, description and
   commit message ([`publication-text.ts`](../remediation/src/publication-text.ts)). Multi-unit reports use `units`;
   a single unit keeps its outcome at the top level too.

## Removing redundant security floors

A run also considers a separate **`floor-removal`** unit, after the security-fix units, unless malware remains on
base. Its draft PR uses `secure-it/<date>-floor-removal`. It never removes compatibility floors or mixes floor
removal with version fixes, and an open fix PR does not prevent this unit from running.

Each security floor first qualifies alone. The tool then resolves the whole candidate removal set **together,
without dependency locks**, and checks that every advisory recorded by every removed floor stays absent from all
resolved copies of that package. A failing joint result drops one implicated floor (or the last floor in deterministic
order for a resolution-wide error) and resolves the remainder again. Retained floors and their reasons appear in the
run report and the PR's plan notes. Incomplete inventories or advisory coverage cannot prove a removal.

- **npm:** an exported scratch copy loses the selected override versions and both adjacent lock formats
  (`package-lock.json` and `npm-shrinkwrap.json`). Sandboxed `npm install --package-lock-only --ignore-scripts`
  resolves under the configured release-age window and own-scope exclusions. Locked young base versions receive no
  special exemption in this unlocked proof. The tool writes the successful joint result's exact manifest and
  lockfile bytes; npm-only removal uses no agent.
- **Gradle:** a trusted init script removes only the selected exact advisory-bearing declarations from the selected
  configurations and disables dependency locking. Shared parent configurations stay intact; a floor declared directly
  on a buildscript or settings classpath (which resolves while its script compiles) is dropped as its dependencies
  are finalized. The inventory runs sandboxed with `--no-daemon` and configuration caching disabled. A declaration
  already used in resolution cannot be safely removed by this probe, so that floor is retained with a reason, as is
  a floor declared with `strictly(...)` (the owner's pin), which isn't probed at all. After proof, the agent removes
  only the named declarations from the real build files; it cannot edit the tool-written floor/npm files or adapt
  code.

Before publication, verification requires exactly the planned records and declarations to disappear, preserves
all others and repository policy, and checks the recorded npm hashes. Unrelated direct versions and declarations
stay at base: if fresh npm resolution updates a direct parent, this unit fails verification rather than including
an unplanned parent bump. `compare` judges every induced version, and its head findings must still contain none of
the removed floors' advisories. No removal is published on a failed proof or verification.

Review recomputes the unlocked proof on a moved base and reconciles by reverting the old plan before applying the
new one. An unavailable or unsafe proof retains the PR and reports why; no floors remaining on base retires it.
Failed CI is reported without agent adaptation: the exact proved edit cannot be changed legitimately. The shared
review attempt budget still applies. An unchanged recognised plan reports `already-open`, refreshing changed plan
notes without changing commits; a human-pushed PR is left alone and any needed removal goes on a separate branch.
Hidden plans record complete floor identities and file hashes, never npm file contents.

## What a review does

A verified CI adaptation replaces the PR title and description with the agent's new verdict and check results,
keeping the verified plan and publication state markers.

The tick from [`packages/remediation`](../remediation), with secure-it's steps:

- **The base moved:**
  - The routine recomputes **the entire batch** on the new base, including newly actionable packages and retiring
    fixes the base now has. A major recomputes only its package's major unit. A unit with no actionable work is
    closed; blocked groups are reported. New malware on base prevents other units from verifying until it is fixed.
  - Older per-package plans without a batch kind keep their original package scope and topic during review. Runs
    create the new units independently; legacy PRs retire once their fixes are on the base.
  - A different plan on the new base: the PR is reconciled as in a run (reverted to the base, conflicts included,
    then the new plan applied), with the agent's new title and description.
  - The same plan: conflicted dependency files take the base's side, the tool re-writes npm files and the agent
    re-applies the non-npm plan; it also resolves any code conflicts.
  - A clean merge with the same plan also refreshes npm files before verification, without an agent. Matching npm
    floors keep their recorded date and reason; merged Gradle floor records remain intact.
  - Either way the result is verified like a run (including the one routine retry and visible omissions) and
    pushed, with the plan in the PR. Fixes remained on the new base, so an edit that leaves the base as it was fails
    verification; it doesn't retire the PR.
- **CI failed (version-fix units):** the agent adapts, at most twice, and the result is verified before it's pushed.
  CI and failing names come from the head SHA's Actions runs/jobs plus commit statuses; no Checks permission is
  needed.
- **A held PR** (the verifying comparison held young versions; its plan records them) never becomes ready on the
  tool's say. Green CI, or only the gate's `cooldown` job failing in its hold step after a passing comparison, is
  `held`; any other failure is adapted as usual. Once the last held version has aged, the draft is closed with a
  comment before anything else (`graduated`), and the next run plans again from the default branch with fresh checks.
  A held PR a person marked ready is theirs: the tick leaves it alone.

## The cooldown warning

Whatever the verifying comparison holds goes into the plan, and the PR's description opens with a GitHub warning:
the versions that came early (published, held until, and why: the rule-picked fix, required by it, an exception),
plus provenance, publisher changes and new install scripts for npm, for information. It says that needing a version
and passing every check doesn't rule out malware, that secure-it keeps the PR a draft and retires it once everything
aged, and how a person takes it earlier: every other check green, the reason written on the PR, an admin merge. A PR
planned as aged that the comparison holds anyway is held the same way. A cooldown the comparison couldn't evaluate
fails verification.

## Isolation

Tokens, sandboxes and trust boundaries are in the [security model](../../docs/security-model.md#secure-it-and-bump-it).
What applies to secure-it:

- The tool's process reads its two tokens from the Keychain and runs no repository code. The agent gets the
  read-only token alone.
- The Gradle inventory and tool-run npm run under `codex sandbox` with the agent's write profile, whichever coding
  agent is configured.
- npm dependency edits use `--package-lock-only --ignore-scripts` under the configured release-age window, which
  agent check commands inherit too. Planned young/unreadable targets and young/unreadable base versions in the
  affected lockfiles get explicit `--min-release-age-exclude` flags, alongside own-scope patterns. Each exclusion is
  reported; exact target checks and `compare` still judge all induced versions, including age and identity. This
  applies to initial edits, rebases/conflict resolution and CI adaptation.
- npm 11.17.0 or later is required whenever exclusions are needed. The tool checks the sandbox's npm before starting
  the agent and reports the required exclusions and detected version on failure.

## Setup

See [Adopting the tools](../../docs/adopting-tools.md) for prerequisites, the first candidate preview, live run,
Keychain permissions and launchd schedules, and the [config reference](../../docs/tool-configuration.md) for every
field.

- **Config:** `~/.config/leanish/secure-it/agent.yaml`.
- **Tokens:** two fine-grained tokens in the Keychain, default services `leanish-secure-it-write` and
  `leanish-secure-it-read`:
  - one that writes (Contents, Pull requests and Workflows: write; Actions, Commit statuses and Metadata: read);
  - a read-only one for the agent.

  Optional `secrets` overrides may share a pair with bump-it; every opted-in repo uses this pair, and write/read
  values must differ. PAT mode remains an alternative when GitHub App mode lands.
- **Tools:** Node 24, git, `gh`, npm and the Codex CLI (for the sandbox, whichever agent runs); a Codex login for
  `codingAgent: codex` or the logged-in `claude` CLI for `codingAgent: claude-code`; npm >= 11.17.0 when a planned
  npm fix or an own scope needs a release-age exclusion.
- **OSV-Scanner:** the version pinned in [`packages/ci/tools.json`](../ci/tools.json), installed into the tool's
  state directory (out of reach of sandboxed commands) and verified by sha256 before every run.
- **Schedule:** launchd or cron calls `run.sh`.
