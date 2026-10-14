# supply-chain

Dependency security and freshness for npm, Gradle and GitHub Actions, with one
version/advisory policy shared by CI and the update tools.

[What it handles and where it stops](docs/what-it-handles.md): a plain-language guide.

- **The CI gate** compares base and head against one advisory snapshot. A PR fails
  on what it makes worse; malware always fails. A daily scan checks the default
  branch; a PR is judged whenever it changes.
- **secure-it** batches actionable non-major security fixes, keeps malware fixes
  together, and opens a separate PR per major. It can remove redundant security
  floors only after a joint resolution without lockfiles proves them unnecessary.
- **bump-it** chooses the highest eligible versions under the release-age policy:
  one routine PR for minors, patches, npm transitives and Gradle wrappers, and one
  per major. The tool computes npm files and generates wrappers; a coding agent
  (Codex or Claude Code) handles other edits and major adaptations. Every proposed
  change is verified.

The gate runs in GitHub Actions. The tools run on macOS and propose PRs; they do
not merge them. Node 24 is required; npm 11.17+ is needed for release-age exclusions.
Packages remain private: adoption uses a reviewed Git commit, with no npm publish.
The current release is **v0.4.2**; the [CHANGELOG](CHANGELOG.md) lists its changes
and what's unreleased. Licensed under Apache-2.0.

## Adoption and operation

- [Requirements and scenario behavior](docs/requirements.md)
- [Why this adds value alongside dependency alerts](docs/why.md)
- [Adopting the gate](packages/ci/README.md#adopting-the-gate), including
  [repository policy, exceptions and floors](packages/ci/README.md)
- [Adopting secure-it and bump-it](docs/adopting-tools.md): prerequisites, PATs and
  Keychain, candidate preview, launchd, logs, costs and troubleshooting
- [Tool configuration](docs/tool-configuration.md): every agent.yaml field, including
  the coding agent, model and effort
- [Security model](docs/security-model.md) and [coverage gaps](docs/coverage-gaps.md)
- [Validation evidence](docs/validation.md): real runs on fixture repositories and
  what each behaviour's evidence is
- [Release procedure](docs/releasing.md) and [CHANGELOG](CHANGELOG.md)

## Packages

- [`ci`](packages/ci): inventories, advisory/version rules, candidate selection and
  the reusable gate with daily default-branch scans
- [`secure-it`](packages/secure-it): security batches, separate majors and verified
  removal of security floors; compatibility floors stay
- [`bump-it`](packages/bump-it): routine/major plans, tool-computed npm changes and
  checksummed Gradle wrapper generation
- [`remediation`](packages/remediation): shared config, sandboxed inventories,
  publication (PR text cleanup, race checks, journal recovery), review ticks and `run.sh`
- [`agent-basics`](packages/agent-basics): the Codex and Claude Code runners and their
  support, mostly copied from leanish-development's runtime, with
  [provenance](packages/agent-basics/PROVENANCE.md)

## Development

```bash
npm ci --ignore-scripts
npm run check
```

Some integration tests skip locally (real Gradle unless `SUPPLY_CHAIN_GRADLE_TESTS=1`,
as CI sets; the Seatbelt probe without a usable `codex sandbox`). A skip isn't a
pass: see [automated checks and skips](docs/validation.md#automated-checks-and-skips).
