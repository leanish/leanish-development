# Guided installation

Use this workflow from the cloned repository root. Install the named tool only.
The package [command reference](README.md) defines JSONL results and flags; scripts
perform the work. Reruns reconcile existing state safely. Do not replace a
verified release pin, overwrite restored choices or touch unselected repositories.

Read every result: its statuses and exit codes are defined in the command
reference, and a blocker wins. Resolve blockers
before dependent steps; continue independent work when safe. Keep completed items
and PR URLs after partial failures. Never claim a choice, admin action, permission
or real run succeeded merely because a spec was generated. Batch/test-run use
their separate JSONL outcome/summary contract.

## Installing one tool

1. Run `node core/setup/src/cli.ts doctor`. Mac and a Claude Code or Codex desktop
   app are required for local tools and their schedule; there is no launchd,
   CLI-only or cloud fallback. **Gate-only adoption** (`add-repository`, gate-only)
   needs just Node, git and an authenticated gh; use “Adding one repository” below
   without these local-tool requirements. Use the sole
   usable agent from `data.agent`; when both work, ask which app/agent to use and
   rerun doctor with `--agent`. Codex CLI is still required for the sandbox even
   with Claude. Explain missing prerequisites and offer the documented install
   steps; do not change logins or bypass sandbox failures. Run `npm ci --ignore-scripts`
   first only if workspace dependencies are missing.
2. Run `node core/setup/src/cli.ts release`. Retain its immutable stable release
   tag, full SHA and installed path for all remaining commands and tasks. Never
   schedule a source worktree or silently repin an existing task. If that release
   lacks the setup launcher, report the found tag and stop guided installation:
   it needs a stable release shipping `core/setup/run.sh` (v0.7.0 or newer).
   Until one is published, offer the [manual guide](../../docs/adopting-tools.md);
   do not suggest another existing release or fabricate a successful install.
3. Ask which repositories to opt in, grouped by GitHub owner. Only these may be
   configured or adopted. Confirm the commit identity for a new installation;
   reuse existing choices on a restored Mac. For each owner run
   `node core/setup/src/cli.ts configure <tool> --owner <owner> --repo <owner/repo> --agent <agent> --name <name> --email <email>`.
   Repeat `--repo` for selected repos under that owner. Existing config choices
   win; adding the other tool later repeats only its missing steps.
4. Run `node core/setup/src/cli.ts enroll <tool> --owner <owner> --login <github-login>`.
   Show its exact PAT permission table and each role's `tokenUrl`: GitHub's form
   pre-filled with name, description, resource owner, 90-day expiry and that
   role's permissions. In each form the person selects only the opted-in
   repositories (GitHub can't pre-fill them), may adjust the expiry, generates
   the token, and obtains organization approval/SSO authorization if required.
   Show the printed `security` commands;
   the person runs them in their own Terminal, typing tokens into the private
   prompts. **Never run those enrollment commands yourself, ask for or accept a
   token in chat, read Keychain values, put a token in a file/argument, or inspect
   terminal history.** If a token is pasted, do not echo, store or use it; tell
   the person to revoke it immediately and create a replacement privately.
5. Run `node core/setup/src/cli.ts verify-tokens <tool> --owner <owner>` after the
   person reports enrollment complete. Only this process may read the configured
   Keychain items internally. A failed permission blocks. An exit-0 result can
   include unverified write/none/public permissions: explain that the authorized
   real test run covers these, without calling them proven grants. Existing PATs
   may need repository selection updated privately when adding a repo.
6. For each selected repo run
   `node core/setup/src/cli.ts gate --repo <owner/repo> --release <tag>` (with
   `--java <major>` if needed, checking doctor for that JDK). Explain that this
   opens/reconciles a PR pinned to the full release SHA and never merges it. Show
   proposed Actions, dependency graph/alerts, Dependabot PR and required-check
   changes. Only after explicit confirmation for this repo rerun with
   `--confirm-settings`. Installation alone does not authorize settings changes
   or merging. Hand non-admins the ready admin request; preserve pending PRs,
   blocked settings and “gate running, not enforced” reasons in the report.
7. For each owner run
   `node core/setup/src/cli.ts schedule <tool> --owner <owner> --release <tag> --agent <agent>`.
   Explain the default cadence and offer another time (`--time HH:MM`) or, for
   bump-it, day (`--day mon|...|sun`); rerun with the person's choice. Nothing
   remembers that choice: when this tool/owner's task already exists, read its
   time and day from the app and pass them again, unless the person asks to move it. Mention
   that GitHub's hourly limit and plan usage are the person's own, shared across
   owners, so several owners may want different times, and that scheduled
   executions can publish real PRs. After confirming the schedule, use this session's own
   app scheduling tool to create/update exactly one task for this tool/owner,
   covering all its configured repos. Reuse its name/title rather than creating
   a duplicate. Use the returned prompt unchanged, the local cron (or equivalent
   daily/weekly RRULE), time zone and task folder (never the release checkout);
   keep worktree mode off and add no other writable folders. Discuss
   permission requirements from the record; never disable or broaden the tools'
   own sandbox. The only permission change is `commandRule`: show its exact entry
   (a Claude `Bash(...)` allow rule, or a Codex execution rule that lets only
   this launcher out of the automation's sandbox) and the file it goes in. The
   person adds it, or asks you explicitly to add exactly that entry. It replaces
   earlier releases' rules (`commandRule.replaces`): for Claude, remove the
   entries of that form whose `<tag>` is another release, and leave every other
   entry; for Codex, overwrite the file, or reconcile with the person if it holds
   anything else. Codex loads rules on restart. Without it the task can't run
   unattended.
   If no scheduling tool is available, give the ready spec and its app control
   steps to the person. Do not claim a task was created or invent a tool.
   Never read/edit app databases or app configuration directories; the one
   exception is adding exactly the shown `commandRule` entry, and removing the
   entries it replaces, when the person asks.
8. Read the task back through the app tool/control. Write only its observed
   fields to a temporary `.json` export outside app storage: `id`, `cron` or
   `schedule`, `enabled`, `prompt`, `folder`, and time zone if returned. For an
   opaque native ID also export the exact observed `title`. Do not copy the
   desired spec and call it readback. Run
   `node core/setup/src/cli.ts schedule-check <tool> --owner <owner> --release <tag> --agent <agent> --task-file <json>`,
   with the same `--time`/`--day` chosen in step 7.
   Reconcile differences through the app. When the app returns no readback,
   `schedule-check` blocks: ask the person to check the task in the app (name,
   prompt, schedule, folder, enabled) and report the readback as unverified. A match proves task fields only.
   For Claude, whose scheduling tool stores no folder, also check that the task
   doesn't run in a folder holding the release or installation state, nor in a
   permission mode that approves edits elsewhere; otherwise report that boundary unverified. If unattended command
   permission, waiting for the command (Claude's completion notification, Codex's
   session continuation) or output reading are unavailable,
   report that the app cannot run this task unattended here; leave it pending.
9. Ask the person to pick **one** opted-in repository for a real run and consent
   to possible real PRs. Only after both choices run
   `node core/setup/src/cli.ts test-run <tool> --owner <owner> --release <tag> --repo <owner/repo>`.
   This reuses the batch runner's real review→run chain, not a preview or dry run.
   There is no dry run. Do not also click the app's Run now (that covers all repos)
   without separate consent. If declined, leave the schedule installed as chosen
   and label it untested. A successful CLI test does not prove app permissions:
   unattended execution still needs owner-machine acceptance; never infer it.
10. Report completed items per tool/owner, task/readback/permission state, test
    outcomes and PR links, pending adoption PRs, admin requests, blockers,
    “gate running, not enforced” repos with reasons, and any untested schedule.
    Do not call unfinished acceptance done. Mention that the other tool exists
    and offer to install it; do not install it without the person's choice.

## Adding one repository

Ask which single repository and which installed tools/owner to extend, or whether
the person wants only the CI gate. For local tools, reconcile `configure` with
only that new opt-in (existing entries remain), explain any private PAT selection
update and run `verify-tokens`, then `gate` with the same confirmation/admin/merge
boundaries above. The existing per-owner task already covers all configured
repos; do not add another task or run a batch as a side effect. Offer the real
one-repository test with explicit consent. If scheduling was never completed,
use the install flow's schedule/readback steps.

For gate-only adoption, use `release` and `gate` for the selected repo, with the
normal GitHub authentication and Node/git prerequisites. Do not require local
tool config, PATs, Keychain, a coding-agent login or a local task; do not use
doctor's desktop blockers to prevent CI-only adoption. Keep all writes in the
adoption PR unless repository settings were explicitly confirmed; never merge
unless separately asked. The manual [gate adoption reference](../gate/README.md#adopting-the-gate)
remains available. Report the resulting PR and any ready admin request.
