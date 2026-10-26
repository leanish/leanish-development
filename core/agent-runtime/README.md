# @leanish/agent-runtime

What secure-it and bump-it need to run a coding agent, without leanish-development's agent framework:

- **Skills:** loading `SKILL.md` entrypoints and support skills, rendering the input as YAML, and reading back the final
  fenced JSON block, both checked against the skill's schemas (`skill/run-skill.ts`, `skill-loader.ts`,
  `input-render.ts`, `output-parse.ts`, `validator.ts`).
- **Runners:** Codex (`skill/codex-runner.ts`: a staged `CODEX_HOME`, a sandbox profile per access level, the model
  family resolved from Codex's own catalog) and Claude Code (`claude-code-runner.ts`: inline settings with no user,
  project or local ones loaded (an administrator's managed policy still applies), and a required confinement: `sandbox`
  runs every command in Claude Code's sandbox with edits only in the working copies, `restricted` (for hosts without the
  sandbox) keeps only the read tools and refuses write runs; usage and failure reasons from its stream-json events in
  `claude-code-stream.ts`). It needs the `claude` CLI 2.1.259 or later
  (`--permission-prompts none`); see [Adopting the tools](../../docs/adopting-tools.md#prerequisites).
- **Usage:** what each skill run consumed (tokens, quota, an API-price estimate) and the final `run finished` line
  every command ends with (`usage/`, `report/run-report.ts`).
- **Git and GitHub:** a workspace whose git metadata the agent can't write, publishing with lease checks
  (`working-copy/`), and a narrow GitHub client (`github/github-client.ts`).
- **Isolation** (`isolation.ts`, `guard/`): the agent's commands get no credentials but the read-only token they're
  handed. They can't read the sensitive home paths, configured private paths, or the resolved file-backed Codex login
  (its symlink target included). They use the tool's commit identity, npm without lifecycle scripts and with the
  repository's release age, and the `gh`/`git` guards first on their PATH. The guards are guard rails, not a boundary;
  the boundaries are the read-only token, the read-only git metadata and the credential scrub. See the
  [security model](../../docs/security-model.md#secure-it-and-bump-it).
- **Secrets:** `SecretStore`, with macOS Keychain as its one implementation for now (`secret-store.ts`).

Most of it is copied from leanish-development's runtime, temporarily: [PROVENANCE.md](PROVENANCE.md) lists every file,
where it comes from and what changed. A fix to a copied file is made in both repositories until a shared
`leanish/agent-kit` replaces the copies.

One such change: skill schemas also accept the `[object, null]` type union and a restricted constant-property
`if`/`then` that requires one non-null object. Both tools' answers use them so that only cannot-apply may leave
`publication` null; applied still needs the complete publication text. Other unions, general conditionals, unknown
keywords and malformed objects are still rejected.
