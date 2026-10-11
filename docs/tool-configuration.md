# Tool configuration

secure-it and bump-it each read `~/.config/leanish/<tool>/agent.yaml`. Pass
`--config /absolute/path/agent.yaml` to use another file. They share the parser,
but have separate repository opt-ins, default Keychain services, state and
schedules. Unknown fields fail, including a field belonging to the other tool.

Start with the complete examples:

- [secure-it agent.yaml](examples/secure-it-agent.yaml)
- [bump-it agent.yaml](examples/bump-it-agent.yaml)

Replace `acme/widget` and the commit identity; override Keychain service names only
if needed. Paths may be absolute or start with `~/`; the tools expand `~`, but do not expand shell
variables such as `$HOME`. The [adoption guide](adopting-tools.md) covers setup,
permissions and schedules.

## agent.yaml

| Field | Required / default | Meaning |
|---|---|---|
| `repos` | Required, nonempty list | Explicit opt-in. Each entry has `repo: owner/repo`; duplicates are rejected case-insensitively. A command still names exactly one repository. |
| `repos[].branch` | Repository's default branch | Base branch to sync, plan against and target with PRs. |
| `agent.codingAgent` | Required: `codex` | Currently the only runner that permits edits. |
| `agent.model` | Required | Concrete model ID or family `sol`, `astra`, `luna`. A family resolves to the newest listed model in the installed CLI's catalog; it is not a pinned model ID. |
| `agent.effort` | Required; example `medium` | Effort for ordinary agent calls. The runner checks catalog-supported efforts when available. |
| `agent.majorEffort` | Required; example `high` | Effort for majors, including their review adaptations and conflict resolution. |
| `secrets` | Optional mapping | Override either or both default services; `{}` uses both defaults. Every opted-in repository uses the same pair. |
| `secrets.write` | `leanish-<tool>-write` | macOS Keychain service holding the tool's write PAT. |
| `secrets.read` | `leanish-<tool>-read` | Different service holding a different, read-only PAT for the agent. Both equal names and equal token values are refused. |
| `commitIdentity.name`, `commitIdentity.email` | Required | Author and committer for the tool's commits; also the identity exposed to agent commands. No developer-global git identity is inherited. |
| `dirs.state` | `~/.local/share/leanish/<tool>` | Workspaces, separate git metadata, publication journal, protected OSV-Scanner and the repository-advisory cache (out of the sandbox's reach). bump-it also stores deferred-major ordering here. Keep this outside temp and cache roots; see the adoption guide. |
| `dirs.cache` | `~/.cache/leanish/<tool>` | Sandbox-writable cache for Gradle and npm. Keep separate from state and between tools. |
| `readDeny` | `[]` | Extra absolute paths denied to sandboxed commands, in addition to existing sensitive home paths. These paths' names can reach the model; their contents cannot. Other readable files can reach the model provider. |
| `modelPrices` | Built-in dated OpenAI Standard prices | Absolute path to an optional JSON table replacing the built-in rates. Unknown models and incomplete measurements still produce explicit cost gaps. |
| `maxNewMajorsPerRun` | bump-it only, `3` | Nonnegative integer. Caps newly opened major PRs, never updates to existing ones. `0` defers all new majors. Deferred majors have priority next run. |

The defaults are `leanish-secure-it-write` / `leanish-secure-it-read` and
`leanish-bump-it-write` / `leanish-bump-it-read`, with no owner or repository in
the names. Both tools may point to the same write/read pair through overrides;
the write and read items within a pair must remain distinct. Existing explicit
service names still work. PAT mode remains an alternative when GitHub App mode
lands. Unknown fields also fail inside `secrets` and each `repos` entry;
per-repository secrets are not supported.

`run.sh` has a separate lock directory:
`${XDG_STATE_HOME:-$HOME/.local/state}/leanish/<tool>/locks`. Changing `dirs.state`
does not move these locks. Every launcher for the same tool/repository should use
the same user and `XDG_STATE_HOME`.

## GitHub API usage and advisory cache

Every `run` and `review` writes one `GitHub API requests` JSON line to stderr,
immediately before `run finished`, including failures and handled termination
signals. `tool`, `repo` and `command` identify the command; `total` counts API
attempts and `byKind` groups them by HTTP method and normalized path. Pagination,
retries and refused requests count separately; cache hits do not. For example:

```json
{"ts":"2026-10-11T19:00:00.000Z","level":"info","msg":"GitHub API requests","tool":"secure-it","repo":"acme/widget","command":"run","total":3,"byKind":{"GET /repos/{owner}/{repo}/pulls":1,"GET /repos/{owner}/{repo}/security-advisories":2}}
```

The counter covers the tool process's GitHub API calls, including planning,
verification, PRs and checks. GitHub calls made by child commands or coding
agents, and git clone/fetch/push traffic, are outside this counter. URLs, query
values, tag names and credentials are not retained in the summary.

Local tools reuse repository security advisories for **one hour** under
`dirs.state/repository-advisories-v1`, which agents and sandboxed builds can't write: a
build that could edit the cache could hide an advisory from verification. Entries are keyed by source repository
and a hash of the read credential, so a different token cannot reuse a private
response. Each entry contains a complete, parsed-successfully API listing;
all pages must succeed before it is written. Empty successful listings are
cached too. Atomic replacement permits concurrent processes; simultaneous
misses may still fetch separately. Missing, expired, corrupt or unreadable
entries cause a fresh fetch; inability to write the cache does not fail a run.
403, 429, server errors, malformed responses and partial listings are never
cached. Rate-limit errors still fail with the existing diagnostic.

The one-hour window spans repeated local snapshots and separate commands in a
weekly pass; an advisory published during it appears after expiry. Delete the
`repository-advisories-v1` directory to force the next local read to be fresh.
Each tool uses its own configured cache directory by default. Action tag refs
are fetched as before, since tags can move. The CI gate CLI always fetches fresh
repository advisories; its verdict rules and the local verification rules are
unchanged.

## Repository policy

The base repository owns the version and advisory policy. These formats already
have a reference in the gate documentation; the tools consume the same files:

| File | Reference |
|---|---|
| `.github/supply-chain.json` | [Gate configuration](../packages/ci/README.md#configuration-githubsupply-chainjson): lockfiles/builds, allowed registries, `releaseAgeDays`, own packages, repository mappings and compatible lines. |
| `.github/supply-chain-exceptions.json` | [Exceptions](../packages/ci/README.md#exceptions-githubsupply-chain-exceptionsjson): narrowly scoped vulnerability, release-age and reviewed identity exceptions. Malware cannot be excepted. |
| `.github/dependency-floors.json` | [Floors](../packages/ci/README.md#floors-githubdependency-floorsjson): recorded security/compatibility constraints and npm overrides. |

The tools preserve this policy and exceptions. bump-it never raises floors;
secure-it removes only the exact security floors in a jointly verified
[floor-removal plan](../packages/secure-it/README.md#removing-redundant-security-floors).
Compatibility floors stay. An own npm scope exempts its own packages from age,
not their dependencies or the other checks.

## Optional price table

`modelPrices` names a JSON object keyed by the **actual model IDs in the report**,
not family aliases such as `sol`. Each entry requires all four nonnegative USD
prices per million tokens: `inputPerMTok`, `cachedInputPerMTok`,
`cacheWritePerMTok`, `outputPerMTok`; and three provenance strings: `basis`
(assumptions/context tier), `source` (provider pricing URL), `asOf` (date checked,
`YYYY-MM-DD`). The default [table](../packages/remediation/src/model-prices.ts) covers GPT-6.1 Sol, GPT-6 Sol/Astra/Luna and retained GPT-5.6 Sol/Terra/Luna, checked on 2026-10-08 against [OpenAI pricing](https://developers.openai.com/api/docs/pricing) and its model pages. Rates assume Standard API processing without a regional premium; configure an override for Fast, Flex or other pricing. Long-context rates apply per request above 272,000 input tokens. The table needs periodic refresh; family aliases are resolved by the runner before pricing.

Optional `longContextThresholdTokens` is a positive integer. If a request above
that threshold has no `longContext` object with the same four price fields, it
cannot be priced. Unknown fields fail. Prices more than 90 days old still estimate
the run but add a dated gap. [The parser](../packages/agent-basics/src/usage/model-prices.ts)
and [cost calculation](../packages/agent-basics/src/usage/api-cost.ts) define this
format. The result is an API-equivalent estimate of measured tokens, not a
subscription bill or a spending limit.
