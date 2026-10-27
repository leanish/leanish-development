# Provenance

Parts of this package are adapted from the incubator ([leanish/leanish-development-incubator](https://github.com/leanish/leanish-development-incubator), private; it was named leanish/leanish-development at the time) at `c6282df` (tag `agent-basics-source`), from its bump-it agent. Unlike [`agent-runtime`](../agent-runtime/PROVENANCE.md), which the incubator is to consume, these stay tool code here: while both copies exist, a fix in one is replicated by hand in the other.

| File | Source | How | Local changes |
|---|---|---|---|
| `src/ci-state.ts` | `agents/bump-it/src/ci-state.ts` | copied | `CiConclusion` defined here instead of bump-it's handler type; failingCheckNames supplies both failed Actions jobs and commit status contexts to adaptations, which review hands them from the snapshot that classified CI (the module is no longer exported); onlyCooldownHolds tells the gate's cooldown hold (its job's hold step, or the `failure` cooldown status older gates' daily rescan posted) from a failure; unreportedRequired names Actions-bound required checks the head never reported apart from unobservable ones (another app or any source) |
| `src/own-pr.ts` | `agents/bump-it/src/own-pr.ts` | adapted | one set of rules per tool instead of bump-it's constants; the PR's state (pushed head, base, adaptations) in its body; labels and body markers named `leanish:<tool>` |
| `src/publication.ts` | `agents/bump-it/src/publication.ts` | adapted | parametrised by the tool's rules; several open PRs per tool; workspace and logger passed in instead of the runtime; no Dependabot closing; the PR's state recorded on every publication; pre-push journal saves the full title/body/plan and adaptation count, which `ownership.ts` (new) restores with the same guards; adds the current label on publication, body recovery, state recording and marking ready; closeAndDelete can leave a PR that is no longer a draft; published and rewritten text keeps local paths out (`publication-text.ts`) |
| `run.sh` | `agents/bump-it/local/run.sh` | adapted | for any tool; owner/slug checked like the tool does; no secrets or runtime variables (the tool reads its own) |
| `test/ci-state.test.ts` | `agents/bump-it/test/ci-state.test.ts` | copied | imports; uses actions-jobs source; failingCheckNames regression for Actions job and commit status failures; onlyCooldownHolds; unreportedRequired |
| `test/fake-github.ts` | `agents/bump-it/test/fake-github.ts` | adapted | secure-it's rules and PR state; no Dependabot PR factory; CI fixtures use actions-jobs source |
| `test/run-sh.test.ts` | `agents/bump-it/test/local-run.test.ts` | adapted | the lock, the final-line handshake and the phases, with a fake tool command |
| `src/config.ts`, `src/review.ts`, `src/ownership.ts`, `src/branches.ts`, `src/command.ts`, `src/publication-text.ts`, `src/journal.ts`, `src/sandboxed.ts`, `src/git-copies.ts`, `src/osv-scanner.ts`, `src/npm-version.ts` and their tests | — | new | — |

The npm graph, repository-override, temporary-pin and manifest-format helpers were moved here from bump-it within supply-chain, with bump-it re-exports preserving its imports. `npm-exact.ts`, `manifest-spec.ts` and `npm-file-checks.ts` are shared materialization/protection code written here, not upstream runtime copies. The secure-it npm phase uses these helpers without bump-it's transitive refresh selector.

Temporary pins align both string and object-form root self-overrides with exact declarations, preserving child rules and `$` references; repository override bytes are restored after resolution.
