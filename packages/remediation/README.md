# remediation

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
    `<local path>`. The tool's own `<!-- leanish:… -->` markers (state and plan) pass through untouched.
  - **Journal** (`journal.ts`): before each update push, the tool records the head/base, title, full body (plan
    included) and adaptation count in its state directory. If the body update fails, the next run or review
    recognises the tool's exact head and restores that publication before reuse or CI handling. An old head/base-only
    entry can't restore it: review refuses readiness or adaptation until a run recomputes and republishes.
- **The review tick** (`review.ts`) goes through every open PR of the tool, in this order:
  1. Someone else pushed: leave the PR alone.
  2. The base moved: the tool recomputes on the new base, before anything else, with the base merged in or the
     conflicting merge left in progress for it to resolve.
  3. CI pending: nothing. Green: mark the PR ready. No checks: report. CI comes from the head SHA's Actions workflow
     runs/jobs and commit statuses (Actions and Commit statuses: read; no Checks permission), so Checks-only results
     from other apps are not read.
  4. CI failed: version-fix secure-it units and bump-it majors can adapt, at most twice, each attempt counted before it
     starts. bump-it routines and floor-removal units report failures without an agent; the shared attempt budget
     still applies. After exhaustion, the PR is closed with a comment.

  Steps 1 and 3 use no model. A PR held by the gate's cooldown stays a draft rather than counting as a failure; see
  [requirements](../../docs/requirements.md). A problem with one PR doesn't stop the others.
- **The command** (`command.ts`): `<tool> run|review <owner/repo> [--config <file>]`. It reads both tokens from the
  Keychain and refuses identical ones, syncs the working copy and runs the agent isolated with only the read-only
  token. It always ends with one `run finished` line on stderr, and tells run.sh once that line is out.
- **Repository code under the sandbox** (`sandboxed.ts`): a command that runs the repository's code (the Gradle
  inventory, bump-it's npm resolution and wrapper generation) runs under `codex sandbox` with the agent's write
  profile, whichever coding agent is configured. It can't reach the Keychain or the sensitive home paths, and writes
  only to the working copy, the temp dirs and the build cache. Tool-run Gradle builds always use `--no-daemon`, so they
  never connect to a daemon started under another sandbox; `GRADLE_OPTS` and repository JVM settings are left intact.
- **Git copies** (`git-copies.ts`): a commit's files exported to a temporary directory (to inventory a commit the
  working copy doesn't have checked out), and what the working tree changed since a commit. These are read-only git
  commands on the git metadata the workspace created.
- **OSV-Scanner** (`osv-scanner.ts`): the version `packages/ci/tools.json` pins, installed into protected tool state by
  CI's installer and checked by sha256 before every use.
- **`run.sh`**: `run.sh <tool> run|review <owner/repo>`, what launchd or cron calls. It takes one lock per tool and
  repository (exit 75 while another run holds it), and writes the final line itself when it stops before the tool
  reports.

Parts adapted from leanish-development's bump-it are listed in [PROVENANCE.md](PROVENANCE.md).
