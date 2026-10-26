# tool-runtime

What secure-it and bump-it share. Each tool is its own command with its own config, schedule, skill and PRs; this
package is the code around them. Setup and operation are in [Adopting the tools](../../docs/adopting-tools.md); every
`agent.yaml` field is in the [config reference](../../docs/tool-configuration.md); tokens and sandboxes are in the
[security model](../../docs/security-model.md#secure-it-and-bump-it).

- **Config** (`config.ts`): `~/.config/leanish/<tool>/agent.yaml`, read strictly (unknown fields fail). It holds the
  opted-in repositories, the coding agent (`claude-code` or `codex`) with its model and one effort for every call,
  optional Keychain service overrides, the commit identity, the state and cache directories, paths the agent may not
  read, an optional price table and, for bump-it, `maxNewMajorsPerRun`. What's about the repository (release age, own
  packages, registries) comes from its `.github/supply-chain.json`.
- **The tool's PRs** (`own-pr.ts`, `publication.ts`):
  - **Recognition:** a PR is the tool's when it comes from one of its branches (`<tool>/<date>-<topic>`) of the
    repository itself and carries its body marker (`<!-- leanish:<tool> -->`) or its label (`leanish:<tool>`).
    Publications and updates add the label.
  - **State:** the body records the head the tool pushed, the base it computed against, and how many times the agent
    adapted it.
  - **Race checks:** every write re-reads the PR first and stops unless it's still the tool's, open, and at the
    expected head.
  - **Published text** (`publication-text.ts`): the title, body and commit message keep the machine out. A path in the
    working copy becomes repository-relative; one under the home, temp, state or cache directories becomes
    `<local path>`. The tool's own `<!-- leanish:… -->` markers (state and plan) pass through untouched, so this cleans
    what readers see, not every byte; any other `<!-- leanish:plan` in the text, or one cleaning would leave, is
    defused (`defused()` in `plan-blocks.ts`, written `&lt;!-- leanish:plan`), and removing old markers never joins the
    text around them, so a body's first plan block is always the tool's own. Agent descriptions must not include the
    reserved plan or state markers. On create and update, publication checks the cleaned title (nonblank, at most 256
    UTF-16 units) and the marked body (at most 65,536) against the client's limits.
  - **Journal** (`journal.ts`): before each update push, the tool records the head/base, title, full body (plan
    included) and adaptation count in its state directory. If the body update fails, the next run or review
    recognises the tool's exact head and restores that publication before reuse or CI handling. An old head/base-only
    entry can't restore it: review refuses readiness or adaptation until a run recomputes and republishes.
- **Plan redos** (`reconcile.ts`): both tools detach at the exact base with a clean index/worktree, then write the new
  plan's files. Earlier PR edits and adaptations are discarded. Only after verification does publication reattach the
  existing PR head as first parent; a moved base is a second merge parent. The runtime stages the same files, requires
  the verified tree, checks the remote head and pushes normally. Attached conflict-resolution workspaces stay intact.
- **Agent workspace guard** (`command.ts`): before every invocation, reject staged, unstaged and untracked changes
  against HEAD outside the input's `toolWritten` paths and the tool's explicitly declared dependency restores.
  Conflicted reviews use `resolve`, including when only dependency files conflict. That mode also permits its
  `conflicted` paths and clean merge changes whose index and files still match Git's `AUTO_MERGE` tree, with
  `MERGE_HEAD` present; extra edits to those paths fail. Restores are guard metadata, leaving the agent free to
  reapply the plan over them. Their content hash (or absence), executable bit and index entries must still match
  the state recorded at restoration. Intentional npm/wrapper rewrites update the content expectation while retaining
  the original index expectation. Ignored build output is not a Git change. The error names the unexplained paths and
  stops the unit before the agent starts.
- **The review tick** (`review.ts`) goes through every open PR of the tool, in this order:
  1. Someone else pushed: leave the PR alone.
  2. The base moved: the tool recomputes on the new base, before anything else, with the base merged in or the
     conflicting merge left in progress for it to resolve.
  3. CI pending: nothing. Green: mark a draft ready. When a check the base's rulesets require from Actions hasn't
     reported (required checks of classic branch protection aren't read), the outcome is `ready-missing-required` (a workflow can start only once a PR is ready, so the tool
     doesn't wait for it; GitHub still blocks the merge); the rules are read with Metadata: read, which every
     fine-grained token has, and rules GitHub refuses or fails to return, or requirements another app may
     report, add a note. No checks: report. CI comes from the head SHA's Actions workflow
     runs/jobs and commit statuses, including the failing names the agent adapts to (Actions and Commit statuses: read; no
     Checks permission), so Checks-only results
     from other apps are not read.
  4. CI failed: version-fix secure-it units and bump-it majors can adapt, at most twice, each attempt counted before it
     starts. bump-it routines and floor-removal units report failures without an agent; the shared attempt budget
     still applies. After exhaustion, the PR is closed with a comment. A verified adaptation replaces the PR's title
     and description with the agent's new verdict and check results, keeping the verified plan and publication state
     markers.

  Steps 1 and 3 use no model. A PR held by the gate's cooldown stays a draft rather than counting as a failure; see
  [requirements](../../docs/requirements.md). A problem with one PR doesn't stop the others.
- **The command** (`command.ts`): `<tool> run|review <owner/repo> [--config <file>]`. It reads both tokens from the
  Keychain and refuses identical ones, syncs the working copy and runs the agent isolated with only the read-only
  token. It always ends with one `run finished` line on stderr, and tells run.sh once that line is out.
- **Repository code under the sandbox** (`sandboxed.ts`): a command that runs the repository's code (the Gradle
  inventory, bump-it's npm resolution and wrapper generation) runs under `codex sandbox` with the agent's write
  profile, whichever coding agent is configured. Tool-run Gradle builds always use `--no-daemon`, so they never connect
  to a daemon started under another sandbox; `GRADLE_OPTS` and repository JVM settings are left intact. What the
  sandbox denies and allows is in the security model, linked above.
- **Git copies** (`git-copies.ts`): a commit's files exported to a temporary directory (to inventory a commit the
  working copy doesn't have checked out), and what the working tree changed since a commit. These are read-only git
  commands on the git metadata the workspace created.
- **Strict pins** (`gradle-reference.ts`): compares the strict declarations and strict constraints Gradle interprets
  in each configuration with the planned reference; what fails verification, and the pins it can't see, are in the
  [security model](../../docs/security-model.md#secure-it-and-bump-it).
- **OSV-Scanner** (`osv-scanner.ts`): the version `core/gate/tools.json` pins, installed into protected tool state by
  CI's installer and checked by sha256 before every use.
- **`run.sh`**: `run.sh <tool> run|review <owner/repo>`, what launchd or cron calls. It takes one lock per tool and
  repository (exit 75 while another run holds it), and writes the final line itself when it stops before the tool
  reports.

Parts adapted from the incubator's bump-it are listed in [PROVENANCE.md](PROVENANCE.md).
