# Tool configuration

secure-it and bump-it each read `~/.config/leanish/<tool>/agent.yaml`. Pass
`--config /absolute/path/agent.yaml` to use another file. They share the parser,
but have separate repository opt-ins, default Keychain services, state and
schedules. Unknown fields fail, including a field belonging to the other tool.

Start with the complete examples:

- [secure-it agent.yaml](examples/secure-it-agent.yaml)
- [bump-it agent.yaml](examples/bump-it-agent.yaml)

Replace `acme/widget` and the commit identity. Paths may be absolute or start
with `~/`; the tools expand `~`, not shell variables such as `$HOME`. Setup,
permissions and schedules are in the [adoption guide](adopting-tools.md).

## agent.yaml

| Field | Required / default | Meaning |
|---|---|---|
| `repos` | Required, nonempty list | Explicit opt-in. Each entry has `repo: owner/repo`; duplicates are rejected case-insensitively. A command still names exactly one repository. |
| `repos[].branch` | Repository's default branch | Base branch to sync, plan against and target with PRs. |
| `agent.codingAgent` | Required: `claude-code` or `codex` | Which CLI runs the agent. Both edit only inside their sandbox; see the [security model](security-model.md#secure-it-and-bump-it). |
| `agent.model` | Required | `claude-code`: a model the `claude` CLI accepts, such as `claude-haiku-5-5`. `codex`: a concrete model ID or family `sol`, `astra`, `luna`; a family resolves to the newest listed model in the installed CLI's catalog, not a pinned ID. |
| `agent.effort` | Required; example `high` | Effort for every agent call: routine and security moves, majors, their review adaptations and conflict resolution. |
| `secrets` | Optional mapping | Override either or both default services; `{}` uses both defaults. Every opted-in repository uses the same pair. |
| `secrets.write` | `leanish-<tool>-write` | macOS Keychain service holding the tool's write PAT. |
| `secrets.read` | `leanish-<tool>-read` | Different service holding a different, read-only PAT for the agent. Both equal names and equal token values are refused. |
| `commitIdentity.name`, `commitIdentity.email` | Required | Author and committer for the tool's commits; also the identity exposed to agent commands. No developer-global git identity is inherited. |
| `dirs.state` | `~/.local/share/leanish/<tool>` | Workspaces, separate git metadata, publication journal, protected OSV-Scanner and the repository-advisory cache (out of the sandbox's reach). bump-it also stores deferred-major ordering here. Keep this outside temp and cache roots; see the adoption guide. |
| `dirs.cache` | `~/.cache/leanish/<tool>` | Sandbox-writable cache for Gradle and npm. Keep separate from state and between tools. |
| `readDeny` | `[]` | Extra absolute paths denied to sandboxed commands, in addition to existing sensitive home paths. These paths' names can reach the model; their contents cannot. Other readable files can reach the model provider. With `claude-code`, a path containing a glob character (`* ? [ ] { } ! \`) is refused: Claude Code reads its permission rules as patterns. |
| `modelPrices` | Built-in dated OpenAI Standard prices | Absolute path to an optional JSON table replacing the built-in rates; see [below](#optional-price-table). Claude models have no built-in rate. |
| `maxNewMajorsPerRun` | bump-it only, `3` | Nonnegative integer. Caps newly opened major PRs, never updates to existing ones. `0` defers all new majors. Deferred majors have priority next run. |

Notes on `secrets`:

- The defaults (`leanish-secure-it-write` / `leanish-secure-it-read`,
  `leanish-bump-it-write` / `leanish-bump-it-read`) name no owner or repository.
- Both tools may share one write/read pair through overrides; the two items in a
  pair stay distinct.
- Existing explicit service names still work.
- Unknown fields also fail inside `secrets` and each `repos` entry; there are no
  per-repository secrets.

`run.sh` keeps its locks separately, in
`${XDG_STATE_HOME:-$HOME/.local/state}/leanish/<tool>/locks`. Changing `dirs.state`
does not move them, so every launcher for the same tool/repository should use the
same user and `XDG_STATE_HOME`.

## GitHub API usage and advisory cache

Every `run` and `review` writes one `GitHub API requests` JSON line to stderr,
immediately before `run finished`, including failures and handled termination
signals. `tool`, `repo` and `command` identify the command; `total` counts API
attempts and `byKind` groups them by HTTP method and normalized path. Pagination,
retries and refused requests count separately; cache hits do not. For example:

```json
{"ts":"2026-10-11T19:00:00.000Z","level":"info","msg":"GitHub API requests","tool":"secure-it","command":"run","repo":"acme/widget","total":3,"byKind":{"GET /repos/{owner}/{repo}/pulls":1,"GET /repos/{owner}/{repo}/security-advisories":2}}
```

The counter covers the tool process's own GitHub API calls (planning,
verification, PRs, checks). Calls by child commands or coding agents, and git
clone/fetch/push traffic, are not counted. The summary keeps no URLs, query
values, tag names or credentials.

Local tools reuse repository security advisories for **one hour**, under
`dirs.state/repository-advisories-v1`:

- **Protected.** Agents and sandboxed builds can't write it; a build that could
  edit the cache could hide an advisory from verification. The path is resolved
  once (symlinks included), and a state directory that resolves into a
  sandbox-writable directory is refused, as for the protected OSV-Scanner.
- **Keyed** by source repository and a hash of the read credential, so a
  different token cannot reuse a private response.
- **Only complete listings.** An entry is written only after every page succeeds
  and parses; empty listings are cached too. 403, 429, server errors, malformed
  responses and partial listings are never cached, and rate-limit errors still
  fail with the existing diagnostic.
- **Best effort.** Atomic replacement permits concurrent processes, though
  simultaneous misses may each fetch. Missing, expired, corrupt or unreadable
  entries cause a fresh fetch; failing to write the cache does not fail a run.

The window spans repeated local snapshots and separate commands in a weekly pass;
an advisory published during it appears after expiry. Delete the
`repository-advisories-v1` directory to force a fresh read. Each tool uses its
own state directory by default. Action tag refs are always fetched, since tags
can move, and the CI gate CLI always fetches repository advisories fresh; verdict
and verification rules are unchanged.

## Repository policy

The gate judges a PR with head's version and advisory policy. The tools read these
files from base and preserve configuration and exceptions in their proposals through
the policy fence, so those policies remain the same in head. The files are documented with the gate:

| File | Reference |
|---|---|
| `.github/supply-chain.json` | [Gate configuration](../core/gate/README.md#configuration-githubsupply-chainjson): lockfiles/builds, allowed registries, `releaseAgeDays`, trusted packages, repository mappings and compatible lines. |
| `.github/supply-chain-exceptions.json` | [Exceptions](../core/gate/README.md#exceptions-githubsupply-chain-exceptionsjson): narrowly scoped vulnerability, release-age and reviewed identity exceptions. Malware cannot be excepted. |
| `.github/dependency-floors.json` | [Floors](../core/gate/README.md#floors-githubdependency-floorsjson): recorded security/compatibility constraints and npm overrides. |

The tools preserve this policy and its exceptions. bump-it never raises floors;
secure-it removes only the exact security floors in a jointly verified
[floor-removal plan](../secure-it/README.md#removing-redundant-security-floors).
Compatibility floors stay.

## Optional price table

`modelPrices` names a JSON object keyed by the **actual model IDs in the report**,
not family aliases such as `sol`. Each entry requires:

- four nonnegative USD prices per million tokens: `inputPerMTok`,
  `cachedInputPerMTok`, `cacheWritePerMTok`, `outputPerMTok`;
- three provenance strings: `basis` (assumptions/context tier), `source`
  (provider pricing URL), `asOf` (date checked, `YYYY-MM-DD`);
- optionally, `longContextThresholdTokens` (a positive integer) with a
  `longContext` object holding the same four prices. A request above the
  threshold without that object cannot be priced.

Unknown fields fail. Prices more than 90 days old still estimate the run but add
a dated gap. Models missing from the table, and incomplete measurements, produce
explicit cost gaps. [The parser](../core/agent-runtime/src/usage/model-prices.ts)
and [cost calculation](../core/agent-runtime/src/usage/api-cost.ts) define the
format.

The [default table](../core/tool-runtime/src/model-prices.ts) covers GPT-6.1
Sol, GPT-6 Sol/Astra/Luna and retained GPT-5.6 Sol/Terra/Luna, checked on
2026-10-08 against [OpenAI pricing](https://developers.openai.com/api/docs/pricing)
and its model pages. It assumes Standard API processing without a regional
premium; configure a table for Fast, Flex or other pricing, and for Claude models.
Long-context rates apply per request above 272,000 input tokens. The table needs
periodic refresh.

The result is an API-equivalent estimate of measured tokens, not a subscription
bill or a spending limit. Claude Code also reports its own list-price estimate
per call (`providerCostUsd`); that is not a bill either.
