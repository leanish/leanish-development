# @leanish/agent-runtime

What secure-it and bump-it need to run a coding agent, without leanish-development-incubator's agent framework:

- **Skills:** loading `SKILL.md` entrypoints and support skills, rendering the input as YAML, and reading back the final
  fenced JSON block, both checked against the skill's schemas (`skill/run-skill.ts`, `skill-loader.ts`,
  `input-render.ts`, `output-parse.ts`, `validator.ts`).
- **Runners:** Codex (`skill/codex-runner.ts`: a staged `CODEX_HOME`, a sandbox profile per access level, the model
  family resolved from Codex's own catalog) and Claude Code (`claude-code-runner.ts`: inline settings with no user,
  project or local ones loaded (an administrator's managed policy still applies), and a required confinement: `sandbox`
  runs every command in Claude Code's sandbox with edits only in the working copies, `restricted` (for hosts without the
  sandbox) keeps only the read tools and refuses write runs; usage and failure reasons from its stream-json events in
  `claude-code-stream.ts`). It needs the `claude` CLI 2.1.259 or later
  (`--permission-prompts none`); see [Adopting the tools](https://github.com/leanish/leanish-development/blob/main/docs/adopting-tools.md#prerequisites).
- **Usage:** what each skill run consumed (tokens, quota, an API-price estimate) and the final `run finished` line
  every command ends with (`usage/`, `report/run-report.ts`).
- **Git and GitHub:** a workspace whose git metadata the agent can't write, publishing with lease checks
  (`working-copy/`), and a narrow GitHub client (`github/github-client.ts`).
- **Isolation** (`isolation.ts`, `guard/`): the agent's commands get no credentials but the read-only token they're
  handed. They can't read the sensitive home paths, configured private paths, or the resolved file-backed Codex login
  (its symlink target included). They use the tool's commit identity, npm without lifecycle scripts and with the
  repository's release age, and the `gh`/`git` guards first on their PATH. The guards are guard rails, not a boundary;
  the boundaries are the read-only token, the read-only git metadata and the credential scrub. See the
  [security model](https://github.com/leanish/leanish-development/blob/main/docs/security-model.md#secure-it-and-bump-it).
  The isolation is an agent-neutral `IsolationPolicy` (see below), which either runner gets through its adapter.
- **Secrets:** `SecretStore`, with macOS Keychain as its one implementation for now (`secret-store.ts`).

Most of it is copied from the runtime of leanish-development-incubator (private), which is to consume this package
instead of its copies; until it does, a fix to a copied file is made in both repositories.
[PROVENANCE.md](PROVENANCE.md) lists every file, where it comes from and what changed.

Its exports are the modules tool-runtime, secure-it and bump-it import, plus what the incubator's runtime uses and they
don't: `./errors`, `./skill/validate-compat`, `./types/effort`, `./logger/correlation` (`withCorrelation`,
`getCorrelation`), `./logger/redactor` (`SecretEntry`), `./skill/skill` (`LoadedSkill`), `./skill/stage-skills` (`writePluginDir`,
`WritePluginDirArgs`), `./usage/skill-usage-record` (`SkillUsageRecorder`, `SkillUsageRecord`, `SkillRunStart`,
`SkillUsageOutcome`, `ModelUsageSummary`), `./usage/usage-totals` (`totalSkillUsage`, `UsageTotals`) and
`./usage/quota` (`observeQuota`, `QuotaUsage`, `QuotaWindowObservation`, `RateLimitSnapshot`). The symbols named are
what the incubator uses, but each exported subpath's whole module is public API: everything else it exports too (such as
`./logger/redactor`'s `Redactor`, `./skill/stage-skills`' `stageSkills`, `./usage/quota`'s `RESET_JITTER_SECONDS` or
`./usage/skill-usage-record`'s `toSkillUsageRecord`).

Skill schemas also accept the `[object, null]` type union and a restricted constant-property
`if`/`then` that requires one non-null object. Both tools' answers use them so that only cannot-apply may leave
`publication` null; applied still needs the complete publication text. Other unions, general conditionals, unknown
keywords and malformed objects are still rejected.

## Credentials

`SkillCall.credentials` gives the agent's commands their env with the secret values among it (`Credentials`, from
`./skill/run-skill`), or a resolver for them, `() => Promise<Credentials | undefined>`. An object is used as given. A
resolver is called once per `runSkill` call (nothing is cached across calls) after the call's checks pass (a declared
entrypoint, its skills loaded, valid input, a working copy for a write run), its input is rendered and its runner
found, and before the call is announced to the `usageRecorder` and its runner starts. When it throws or rejects,
`runSkill` logs `runSkill failed` once with the reason `credentials-unresolved` and the error's class only (its
message could quote a secret the logger can't redact yet), then fails with that same error, and nothing is started or
recorded. `undefined`, or `null` from a resolver written without the types, means no credentials, as when the field is
left out. So a host such as the incubator, whose target credentials are resolved per call, resolves them
only for calls that reach a runner.

## Isolation policy

An `IsolationPolicy` says what the agent's commands may not read (`readDenied`), the env they get (`env`) and where
the build tools' caches go (`buildCacheRoot`); `loginHome`, the Codex home whose `codex login` a run reuses, is
optional and only the Codex adapter uses it. `isolationPolicy(settings)` builds one on a developer's machine (the
sensitive home paths, the Codex login, the guards, the commit identity and the release age), as secure-it and bump-it
do. Runners get it through their adapters, which check it (absolute paths, string env values) and take the runner's
other options (binary, timeouts, staging…) separately: `codexRunnerOptions(policy, tuning?)` and
`claudeCodeRunnerOptions(policy, confinement, tuning?)`; `assertValidPolicy(policy, entry)` is that same check, exported
for other entries that take a policy (the tools' sandboxed commands). A policy can also be written out by hand: nothing in it
needs settings, a home or a login.

How each incubator host composes it when it adopts this package:

- **Local Codex:** `isolationPolicy(...)` from what its `localCodexOptions` reads today: `AGENT_RUNTIME_READ_DENY`
  as `readDeny`, `AGENT_RUNTIME_COMMAND_PATH` as `commandPath`, the developer's git identity as `commitIdentity`, its
  release age (7 days), and its `XDG_CACHE_HOME`-based cache as `buildCacheRoot`; then
  `new CodexRunner(codexRunnerOptions(policy))`.
- **Local Claude Code:** the same policy with `claudeCodeRunnerOptions(policy, "restricted")`, so adoption doesn't
  suddenly require a working sandbox.
- **Lambda:** `{ buildCacheRoot: LAMBDA_BUILD_CACHE_ROOT, readDenied: [], env: {} }`, with no login: Codex gets its
  cache under `/tmp` as today, and Claude Code runs `restricted` (it gets the cache's env too, but runs no commands).

Write access still needs the `sandbox` confinement: a `restricted` runner refuses a write run before staging
anything, and a `sandbox` run fails when Claude Code's sandbox is unavailable (`failIfUnavailable`).

## Run report

Every command ends with one `run finished` JSON line (`report/run-report.ts`): its status and exit code, what it did,
each skill run's usage and the totals, on every exit path, a SIGINT / SIGTERM / SIGHUP included (written, then the
signal raised again).

A command that owns its process starts it with `startRunReport({ stream, marker?, extra?, beforeFinalLine? })`, which
returns `identified(fields)`, the `usageRecorder` for `SkillContext`, and `end(end)`. The signal handling is in place
until the run completes, by `end` or by a signal, through one path: `extra()` gives the host's fields as they stand
then; `beforeFinalLine(record)` gives lines written right before the final one, in the same write; `end` resolves
once the line is flushed, and a second `end`, or one racing a signal, writes nothing more. When `extra` or
`beforeFinalLine` throws, the line is still written without what it would have added, and its `error` says why.
When the stream fails the write (a closed pipe, a full disk), `end` still resolves and the command keeps its exit
code: the `error` the stream emits afterwards is heard and dropped, only by the listener the write added, which goes
once the stream reports `error` or `close` (after a successful write, at once). It hears that first event only: a
second `error`, or one after `close`, still ends a process with no `error` listener of its own, as before 0.9.0, and so
does an `error` a stream emits while being destroyed by something else: a stream already destroyed or errored is
written without listening, since its write fails without a new `error`. While such a listener waits it hears the stream's
first `error` whatever its cause, so an unrelated `error` in that window is dropped too, the notice's and the final
line's alike. The `start` marker's failure notice is written the same way, so a stream that fails it, throws, or whose
`on` throws doesn't end the process nor `startRunReport`.
`marker` is for a wrapper that writes its own final line unless told otherwise: its `env` variable names the file, and
is read and removed from the environment as reporting starts, before the command starts any child process.
`when: "start"` writes the file as soon as reporting is in place; `when: "after-final-line"` once the final line is
flushed (best effort: if writing it fails, the wrapper writes its own line too, a duplicate rather than none).
secure-it and bump-it use `after-final-line` with run.sh's `TOOL_REPORT_MARKER`, and `beforeFinalLine` for their
`GitHub API requests` line.

How the incubator's hosts compose it when they adopt this package:

- **Local (`run-local`):** `startRunReport({ stream: stderr, marker: { env: "AGENT_RUNTIME_REPORT_MARKER", when:
  "start" }, extra: () => counts })`, with its dispatch, delayed-message and self-publish counts as `extra`;
  `identified({ agent })` replaces its `agentIdentified(...)`, and `end(...)` its `finally` block. The marker file then
  holds `reported` instead of `run-local`; a wrapper only checks that it isn't empty.
- **Lambda:** no `startRunReport`, whose signal handlers belong to a process, not to an invocation. Each invocation
  creates its own `RunReport`, passes its `usageRecorder` to the skills it runs, and logs the line
  `finish({ ..., extra })` returns (`finishRecord` also gives the record). `writeFinalLine` writes it to a stream when
  that's where it goes, with the same handling of a failed write: it resolves either way, saying nothing (a stream that
  throws doesn't reject it either), so a host that must know the line went out writes it itself;
  `reportOnTerminationSignals` stays for a host that wires signals itself.

## Known limits

secure-it and bump-it use neither of these; a host that adopts one should handle it first.

- **`restricted` confinement:** it denies the edit and shell tools and the paths given as `readDenied` (none by
  default). Any other read is bounded only by Claude Code's own file-tool permissions, which this package doesn't
  verify. A host should pass an explicit read-denial policy (credentials and the other sensitive paths) and test it
  against those files.
- **`headChecks: "check-runs-then-jobs"`:** a 403 counts as a rate limit only with `x-ratelimit-remaining: 0` or a
  `retry-after` header. Any other 403 is taken as a token without Checks read, and the head's CI is read from the
  Actions jobs instead. So a rate limit GitHub sends without those headers loses every other app's check runs. The
  result's `source` (`actions-jobs`) shows the fallback happened, but not why; a host that requires checks from other
  apps should fail closed on it.

## Publishing

In this repository the package stays private at `0.0.0` and exports `src`, which the tools run directly. For npm,
`npm run pack -- --out <absolute-dir>` (or `npm run pack -w @leanish/agent-runtime -- ...` from the root) compiles
`src` with `tsconfig.build.json`, stages it with a generated manifest in a temporary directory, packs it and prints the
tarball's path. The version is the root `package.json`'s unless `--version <version>` is given; without `--out` the
tarball goes to a new temporary directory. [Releasing](https://github.com/leanish/leanish-development/blob/main/docs/releasing.md#publishing-leanishagent-runtime) says
when it's published.

The published package has:

- `dist/`: every module as `.js` with its `.d.ts`; each export of this `package.json` points at them (`types` and
  `default`), so the two export maps can't drift apart;
- `guard/`, with `gh` and `git` executable; `guardDir()` (`./guard-dir`) returns its path from either form;
- `README.md`, `PROVENANCE.md` and the repository's `LICENSE`;
- the same dependencies (`ajv`, `yaml`), and no scripts or devDependencies;
- `@types/node` (`>=24`) as an optional peer, which npm doesn't install: a JavaScript consumer goes without it, and a
  TypeScript consumer must declare `@types/node` `>=24` itself, since the declarations name Node's types. With
  `skipLibCheck: true`, a consumer missing it gets no error: the declarations' `NodeJS.*` references silently become
  `any`.

`test/packed-package.test.ts` packs it and installs the tarball into consumers outside the repository. One gets no
`@types/node` and loads every export with plain Node. The other also installs this repository's own `@types/node`,
packed, without the registry, and type-checks against the declarations a file that imports by name every symbol listed
above, and `Credentials`.
