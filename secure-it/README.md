# secure-it

Fixes what the [supply-chain gate](../core/gate)'s full scan fails on, at any depth, with the smallest change the version
rule picks, batching non-major fixes and opening each major separately. The code decides versions and verifies the
result; the tool writes npm files, and a coding agent (Codex or Claude Code, set by `agent.codingAgent`) applies
non-npm edits and major adaptations.

```bash
core/tool-runtime/run.sh secure-it run leanish/sqs-codec      # daily: batch fixes, majors apart
core/tool-runtime/run.sh secure-it review leanish/sqs-codec   # every few hours: look after its PRs
```

## Issues decide what runs

Every finding a run sees on the default branch, minus those a valid exception covers, is tracked by an issue the tool
opens with the write PAT (it needs **Issues: read and write**, see
[adopting the tools](../docs/adopting-tools.md)). An issue tracks one subject:

- **A decision:** the exact moves a unit would make. Past the release-age wait, or a trusted package's ordinary fix
  (said as a trusted exception), a run fixes it right away. Its PR says `Tracks #N.`, never a closing keyword. A PR
  may carry out only part of its decision (verification refused a package; the PR says what it left out), and the issue
  stays open while a scan still finds the rest; review never turns a tracked PR into another decision: its next run does,
  through that decision's issue.
- **A decision waiting for the wait:** it takes a version younger than `releaseAgeDays`. No PR opens: the issue says
  when each young version is past the wait, and a run fixes it then. Age always counts from the version's registry
  publication, never from the author's repository. A malware fix's destination always waits, trusted packages included.
- **A package without a decision:** blocked (no fix, or the rule refused one), informational (only the project's own
  repository reports it: nothing is done), or unassessed (planning failed this run).

An unassessed issue names a known planning failure on the affected roots, coupled or carried packages, including when
failed aged planning leaves young npm grouping unknown. It shows only the error's first line, with URL userinfo,
queries, fragments and recognizable credentials redacted. Local paths are cleaned before the detail is cut to 1,000
characters, including a visible cut marker, before quoting; quoting and body cleaning can expand that text. Without a
known cause (malware taking priority, say), it keeps the generic explanation. Reassessed issues use this run's causes.
An open issue whose decision an incomplete run no longer finds stays open and says the run couldn't assess it, with the
findings the run did see, instead of its earlier status; its record, grant and attempts stay as they are.

A run whose candidate planning fails, or whose inventory is incomplete, executes nothing and changes no issue; one unit
failing to plan leaves its findings tracked and retires nothing.

Every issue the tool opens carries the `leanish:secure-it-issue` label, and a run lists only issues with it, so the
login's PRs and other issues never crowd its listing. Removing the label takes an issue out of a run's listing: the run
opens another for what it tracked. Review still reads the issue a PR names (`Tracks #N.`) by its number, label or not,
so a PR taken early goes on under its recorded attempt and grant.

Issues don't change subject: when a decision changes (another version, another grouping), the run opens the new issue
first, then closes the old one as superseded by it. Once a complete scan no longer sees a finding, its issue closes as
resolved; a scan with coverage gaps closes nothing. An issue a person closes is dismissed: the run doesn't reopen it
for the same findings, and only a finding that comes back after it was gone opens a new one. Issue text never selects
versions: the code decides, and the only thing a person's input changes is whether a waiting decision runs early.

### Taking a fix early: `take-early`

Someone with write, maintain or admin access comments `take-early: <reason>` on a waiting decision's issue, then adds
the `take-early` label. The next run fixes exactly that decision, with the young versions it took then (or fewer as
they age), on a branch reserved for that label, and opens a draft PR with the [cooldown warning](#the-cooldown-warning).
It stays a draft until those granted versions are past the wait; then review retires it and the next run
fixes that work afresh, in the batch it now belongs to.

- **One label, one attempt**, recorded on the issue before anything executes. An attempt that the agent couldn't
  apply, that failed, or that a crash interrupted ends; so does one whose PR closed without merging, which also takes
  the label off. Only a new reason and a new label authorize another, and a retry never reduces the decision.
- **A label covers what the issue showed when it was added.** A young version the issue shows only later (the same
  moves now bring in another, say) needs a new reason and label. It counts as shown only once a later read of the
  issue confirms it was published (plus two minutes for clock skew); until then no label authorizes anything there.
- **Every refusal is said on the issue**, once: no write access, no reason before the label, a reason edited since,
  a decision that now takes a young version the label didn't cover, or a label on an issue that isn't a current
  decision (closed, superseded, a package without a decision).
- **Removing the label withdraws it:** review leaves the PR to its owner and says so on the issue. So does a moved
  base that changes the decision or takes a young version the label didn't cover. Whether a PR was taken early is
  read from its issue's attempt, not from the gate's cooldown.

Verification can find a young version planning didn't choose (a transitive move, say). Whether the decision was past
the wait or taken early, the run then publishes nothing, names the versions on the issue and tries again next run.

Review leaves a version-fix PR without a `Tracks` line to its owner; a run still matches one to a fix it plans by its
kind and topic alone, leaving it as it is when the plan is unchanged or redoing it, then with a `Tracks` line, when the
plan changed. Before upgrading from 0.10.x, close secure-it's open version-fix PRs by hand, keeping any human changes
you need: the first run assesses the findings and opens the corresponding issues. Don't close secure-it's issues to
start over: closing an issue dismisses its tracked findings. A new advisory finding can open a new issue; a dismissed
finding can open one again after a complete assessment records it absent and it later returns.

## What a run does

1. **Finds what fails.** It runs `candidates --rule security` on the default branch's head. The Gradle inventory runs
   the build, so it runs sandboxed (see [Isolation](#isolation)).
2. **Groups actionable fixes.**
   - Every non-major package goes in one routine security batch, across npm, Gradle and Actions.
   - Each package needing a major gets its own PR. A package's failing copies stay together: if any copy needs a
     major, all its actionable copies go in that major unit.
   - A package with a blocked copy (no fix or an identity break) is left out and reported, without blocking other
     packages. A copy that can't be decided because a check failed (its publisher identity, or a carrier's bundle,
     version listing or publish time, couldn't be read) is left out the same way and also reported under `errors`, so
     a batch counts the repository as failed. Keeping copies together preserves verification's requirement that targeted advisories affect no
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
     own compatible line that makes the connected set consistent: aged (trusted scopes: any age, or the proved
     required-dependency exception in step 5), adding no advisory group or malware, and passing the gate's publisher
     identity check. Unchanged compatible peers stay at base; a companion may move downward within its line when
     necessary.
   - All these choices use the security batch's same advisory snapshot, and each registry document is read once.
   - An impossible set leaves the batch blocked, with the conflicting peer ranges reported; unrelated fixes proceed.
     Unreadable locked manifests leave npm work blocked because incoming peer constraints cannot be ruled out. Those,
     and any other read a set needs that fails (a copy's version listing or candidate manifest, the version a fix
     requires of it, a candidate's identity or publish time), also report the set under `errors`.

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

   A young npm carrier passes as a `bundle-fix` only under [the gate's proof](../core/gate/README.md#a-young-carrier-with-a-bundled-fix-npm).
   Verification refuses a carrier choice that neither that proof nor an exception justifies.

   - **Young fixes go apart, each group its own decision.** Fixes whose target is younger than the release-age wait,
     everything coupled to them, and any fix whose required npm dependency is young leave the aged batch, so the aged
     fixes aren't held back. They're then split as far as they can be, one held routine unit (topic
     `security-young-<ecosystem|name>`, after its lowest full package key) per group, so no young fix waits for
     another. Each group is a [waiting decision](#issues-decide-what-runs): it runs once it ages, or on a `take-early` label:
     - **Always together, the couplings known when splitting:** coupled npm peers, a carrier and its carried package,
       and what planning the aged batch finds (a root that needs another root's fix). Planning a held group can find
       more; those don't rejoin groups already split, and each PR proves what it moves alone.
     - **Together, roots that only wait for the same young npm companion:** fixes that are aged themselves but require
       one young dependency wait for it alike, so one PR moves it for all.
     - **Apart on purpose, young fixes that share a young companion:** joined, each would wait for the other's
       version too. Each PR chooses and verifies the companion version its own requirements prove; when one merges,
       the other's review rebases it.
     - **Never regrouped by a failure:** every group is planned alone from metadata, then its issue decides whether
       it may execute. Planning failures are reported for that group; the others keep their grouping and still run.
       Gradle builds no extra preflight reference. Final verification applies each authorized plan's declarations
       and floors to an exported base and resolves its reference, checking the declarations and resolution failures
       outside the gate's `gradle.ignoreConfigurations`. A reference problem, sandbox failure, timeout, OOM or missing
       inventory fails that decision's attempt without joining it to another. Groups that only plan or resolve
       together therefore fail apart until a person moves them or their versions age into the aged batch.
       If aged planning fails, which of its npm roots would join young work is unknown: young units with npm work
       (in their fixes or coupled sets) fail too. Young work without npm still runs. A base-movement review reports
       the error and keeps affected PRs, including an early npm PR whose fix has aged since, which that plan could
       make wait again. Unknown grouping is never used to match or retire an early npm PR. Other PRs still rebase.
       Runs and base-movement reviews split the same way; an unchanged base keeps the recorded plan until a run
       recomputes the decisions.

     A major or malware unit with a young version stays whole and is held. What the PR finally holds is the
     verifying comparison's call, not this prediction.
4. **Looks at its open PRs first.**
   - An open PR for the same routine/major/malware unit, with an identical plan and a recognised head: keep its
     commits and refresh the plan section if its notes changed; its review owns further work. The unit reports
     `already-open`. Other major units still proceed. An already-open malware unit is left to review without
     planning other work.
   - One with a different plan, while its head is still the tool's: that PR is reconciled. The default branch is
     prepared as a clean base checkout for the new plan, so nothing the old plan did lingers. After verification,
     the tool appends the verified tree to the existing PR history as a normal commit.
   - One someone else pushed to: their PR is kept. An ordinary eligible fix goes in a PR of its own; an early
     decision cannot start another attempt while its first is still running, even under a renewed label.
   - One whose plan moves a package (companions included) that can't be decided now (its publisher identity, its
     carrier move or its direct-peer set, because a check failed): the unit fails and the PR is kept as it is, rather
     than rewritten without that move. Other units still go on.
   - A PR taken early belongs to its exact decision and the running attempt on its issue. Sharing a package or
     companion, or a sanitized branch name, cannot transfer that grant. Its descriptive topic can change without
     changing the decision. An ordinary eligible PR is matched by its kind and full recorded topic, before branch
     sanitization. Ownership is read from the current head's journal publication when needed; human pushes and a
     person marking an early draft ready remain protected.
   - If review finds an early decision changed on a moved base, it leaves the PR and says why on its issue; the next
     run tracks the new decision through its own issue. If no actionable fixes remain, review retires the PR. Once
     every granted version ages, graduation retires it so a run plans the work afresh.

   An early attempt is recorded only when its unit is about to execute, before preparing a branch, writing files or
   running an agent or verification reference. A deferred decision starts none. A failed execution ends the attempt;
   an interrupted bookkeeping write is recovered from the PR history on the next run.
5. **The tool resolves npm; the agent applies non-npm moves** (skill [`secure-it`](skills/secure-it/SKILL.md)).
   - **npm, by the tool.** In a sandboxed export of base, before any agent work, the tool pins every planned direct
     and peer companion to its exact target at once (unplanned directs keep base versions), installs, restores the
     intended ranges and the manifest's formatting, installs again and requires exact landing. Peer-resolved
     root/workspace copies use temporary exact declarations rather than overrides npm may ignore; unsupported
     nested/conflicting placements are reported and nothing in that unit is published. Existing floors remain, and
     new security overrides get matching floor records. Direct peers selected by code are explicit moves, even with
     no advisory of their own. With workspaces, npm can leave a new override or temporary pin for an already-locked
     package unapplied ([npm/cli#4834](https://github.com/npm/cli/issues/4834)); the tool then runs `npm update` for
     those names and refuses any copy of a planned name that the update moves to a version that is neither its own
     nor one the plan gives that name (a copy at a new path may also take a version another copy had in base). What
     install moves is judged as without an update. Verification still fails the fix if any copy keeps an advisory
     the plan targets.
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
     by Gradle, so a planned plugin fix's own fallout is in it; [`core/gate/README.md`](../core/gate/README.md)); a
     configuration the gate's `gradle.ignoreConfigurations` lists may fail to resolve, as in the gate, but the same
     way as in the plan's reference. A parent's proof and a floor removal's probe don't accept an incomplete
     resolution there: they keep the floor instead. Every apply, resolve and adapt path verifies the tool-written
     files before publishing.
   - **The skill asks for** focused edits in each file's style; comments the edit made false fixed without losing
     their context; code kept only for an unsupported old major removed; the repository's checks in every mode; for
     each major, the release notes or changelog it crosses, linked in its verdict; and PR text that maps advisories
     to packages, gives `from → to`, and states each major's adaptation verdict and the checks run. An `applied`
     answer must include all PR text; only `cannot-apply` may omit it or set it to `null` (bump-it's skill too).
6. **Verifies before publishing** (`verify.ts`):
   - existing floor records and declarations are preserved before comparison: compatibility floors never change;
     security-floor updates match exact planned moves and retain their scope and history; only planned security
     floors may be added, or removed in an explicit floor-removal plan;
     for an unchanged Maven security floor record, planned plugins may add declarations while every base version/reason
     occurrence remains, duplicates and declarations without a version counted. Head must resolve at or above the floor by Maven ordering; an absent resolution is allowed
     only if base did not resolve the package at that location either. Compatibility floors require exact declaration comparison.
     Every added declaration must also appear in the independent Gradle reference built from base plus the plan;
     a planned plugin move alone does not authorize extra declarations;
   - the gate's own policy (its config, its exceptions, workflows and actions outside planned pins) is untouched,
     major or not;
   - interpreted declarations and constraints match the plan's Gradle reference, including strict pins and floor
     removals; the [security model](../docs/security-model.md#secure-it-and-bump-it) explains the comparison and its
     limit for pins Gradle does not interpret;
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

   Advisories only the project's own repository publishes (unreviewed) plan no fix: such a version is reported, and
   waits for a reviewed source; when a reviewed fix moves the package anyway, they're a note on that fix instead.
   They still rule candidates out, and the plan notes the candidates ruled out that way ("ruled out by …, not
   corroborated by the sources this decision used"); the sampling and the required-npm-dependency case are in
   [how each source counts](../core/gate/README.md#how-each-source-counts).

   Before that reduction, a first refusal gets the agent asked once more for the same plan, from the base, with the
   refusal (`rejected`): an agent that moved a parent instead of the planned floor, say. The reduction then works
   from the second attempt's problems, or from the first refusal's when that attempt couldn't apply or failed before
   its verification; the run report keeps the first (`rejected`). A review's adaptation is never
   restarted this way, since a restart from the base would lose it.
7. **Publishes** draft PRs: `secure-it/<date>-security` for the routine, `secure-it/<date>-take-early-<label event>`
   for a held group taken early, `secure-it/<date>-<package>-major` for each major, or `secure-it/<date>-malware`.
   Only what its issue lets execute gets this far ([Issues](#issues-decide-what-runs)). Each unit
   starts from the scanned base and publishes at most one new or updated PR. A failed unit is reported and doesn't stop
   other major units. The tool appends the move table and the hidden plan for later runs to the agent's description, and
   keeps local paths out of the title, description and commit message
   ([`publication-text.ts`](../core/tool-runtime/src/publication-text.ts)). Multi-unit reports use `units`; a single
   unit keeps its outcome at the top level too.

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
  resolves under the configured release-age window and trusted-scope exclusions. Locked young base versions receive no
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

The tick from [`core/tool-runtime`](../core/tool-runtime), with secure-it's steps:

- **The base moved:**
  - The routine recomputes **the entire batch** on the new base, including newly actionable packages and retiring
    fixes the base now has. A major recomputes only its package's major unit. A unit with no actionable work is
    closed; blocked groups are reported. New malware on base prevents other units from verifying until it is fixed.
  - While any package's fix can't be decided on the new base (its publisher identity or a carrier's reads failed),
    or a direct-peer set in the PR's recomputation can't be, the PR is kept as it is and the tick reports an `error`:
    a move lost to a failed check isn't work the base no longer needs, so nothing is retired, replaced or rewritten
    until it can be decided.
  - A different decision on the new base: review leaves the PR unchanged and says why on its issue. The next run
    handles it through the new decision's issue. The same moves with changed metadata can still be refreshed.
  - The same plan: conflicted dependency files take the base's side, the tool re-writes npm files and the agent
    re-applies the non-npm plan; it also resolves any code conflicts.
  - A clean merge with the same plan also refreshes npm files before verification, without an agent. Matching npm
    floors keep their recorded date and reason; merged Gradle floor records remain intact.
  - Either way the result is verified like a run (including the one routine retry and visible omissions) and
    pushed, with the plan in the PR. Fixes remained on the new base, so an edit that leaves the base as it was fails
    verification; it doesn't retire the PR.
- **CI failed (version-fix units):** the agent adapts, at most twice, and the result is verified before it's pushed.
- **A PR taken early** stays a draft while any version its issue's grant covered is still young, even when the gate's
  recorded cooldown holds nothing. A date that can't be read keeps it waiting, with its time reported as unknown.
  Green CI, or only the gate's `cooldown` job failing in its hold step after a passing comparison, is `held`; other
  failures are adapted as usual. Once all granted versions aged, review closes the draft before branch, base or CI
  work (`graduated`), ends its attempt and returns its label. The next run plans afresh from the default branch.
  A person who marked it ready owns it: review leaves it alone, including at graduation. While it is young, review
  proceeds only while its grant stands (see [Issues](#issues-decide-what-runs)); verification admits only that grant's
  versions and trusted packages. The recorded cooldown is evidence, not authorization.
- **Ordinary tracked PRs** need no early grant and become ready on green, unless the gate's cooldown alone holds
  them. Trusted packages don't cause a gate hold. Verification refuses any non-trusted young version no grant covers.
- **A version-fix PR without `Tracks`** is left to its owner; review does not migrate, rebase, adapt or mark it ready.
  Floor-removal PRs intentionally track no issue and retain their separate review path.

## The cooldown warning

Whatever the verifying comparison holds goes into the plan, and the PR's description opens with a GitHub warning:
the versions that came early (published, held until, and why: the rule-picked fix, required by it, an exception),
plus provenance, publisher changes and new install scripts for npm, for information. It says that needing a version
and passing every check doesn't rule out malware, that secure-it keeps the PR a draft until everything
aged, and how a person takes it earlier: every other check green, the reason written on the PR, an admin merge. A PR
whose verification finds a young version its issue didn't authorize is not published; the issue says why.
A cooldown the comparison couldn't evaluate fails verification.

For every held version that fixes advisories (the gate records them, whether or not anything justified the version,
and an exception's named one, reviewed or not), the warning also says where those advisories appear. After the
verification, secure-it reads each advisory, and every alias the responses name, from the dependency's own repository
advisories, GitHub's database and OSV, fresh and only to inform. A table shows each source as it says: the fix it
declares, and whether its ranges put each replaced and proposed version among the affected ones; a bundled package is
named as bundled, and a removal as a removal. A lookup that fails reads "couldn't be fully checked", never "not
found".

The notice reports problems only, so a gap in it shows less, never a false all-clear. When no reviewed record (OSV, or
GitHub's reviewed database) backs some advisory as read now (withdrawn since, ranges that changed, or sources that
couldn't be read), a line opens the warning and those rows are marked ⚠. A fix whose evidence couldn't be read, wasn't
recorded, or covers only some of its targets is listed with its reason. The comparison's verdict stands either way. A fix's targets are reviewed advisories by the time it's proposed, except the one a release-age
exception names, which the owner's call lets in whichever source lists it; how each source counts is in
[the gate's rules](../core/gate/README.md#how-each-source-counts).

The table lists its ⚠ rows first. Composition uses raw UTF-16 length budgets: 61,440 for fresh text (including a fresh
agent description updating an existing PR), or 65,280 for text carrying a publication state marker, already published
and including its marker. The latter leaves 256 units below the client's limit for replacement and re-cleaning.
When the table would push the body past its budget, only its last rows give way: it shows the most that fit, with a line saying how many are left out, the plan's block keeps the whole evidence, and the
rest of the warning stays. When even no row fits (the plan with the evidence passes its block's or section's limit,
or the body its raw budget), the PR is written without the evidence, and each fix that had some is listed as unchecked,
saying why. A body that still cannot fit is refused. These conservative budgets can drop rows or evidence, or refuse
a body, even when GitHub could store it.

Publication also checks the cleaned title and marked body against the client's limits on create and update
([tool-runtime](../core/tool-runtime/README.md)). Enough path expansion can still exceed a limit; the final guard
refuses before the push, or before a text-only API update. This guard does not retry without evidence.
It also protects bump-it and non-held publications, whose composition keeps its existing raw check.

The agent never writes any of this.

## Isolation

Tokens, sandboxes, trust boundaries and the npm release-age exclusions are in the
[security model](../docs/security-model.md#secure-it-and-bump-it). For secure-it, the exclusions apply to initial edits,
rebases/conflict resolution and CI adaptation, and npm 11.17.0 or later is required whenever they're needed
([prerequisites](../docs/adopting-tools.md#prerequisites)).

## Setup

See [Adopting the tools](../docs/adopting-tools.md) for prerequisites, the two Keychain tokens and their permissions,
the first candidate preview, live run and launchd schedules, and the [config reference](../docs/tool-configuration.md)
for every field. The config is `~/.config/leanish/secure-it/agent.yaml`, with default Keychain services
`leanish-secure-it-write` and `leanish-secure-it-read`. The OSV-Scanner version pinned in
[`core/gate/tools.json`](../core/gate/tools.json) is installed into the tool's state directory (out of reach of
sandboxed commands) and verified by sha256 before every run; launchd or cron calls `run.sh`.

## Tests

Run the reproduction for young Gradle fixes from the repository root:

```sh
SUPPLY_CHAIN_GRADLE_TESTS=1 SUPPLY_CHAIN_GRADLE_BIN=/path/to/installed/gradle npm test --workspace secure-it -- gradle-real.test.ts -t 'aligned security moves'
```

It uses a local POM repository and an isolated Gradle cache; selecting an installed distribution avoids wrapper downloads.
