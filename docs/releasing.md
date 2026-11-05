# Releasing supply-chain

Releases follow [release-flow](https://github.com/leanish/leanish-skills/blob/main/skills/wip/release-flow/SKILL.md):
candidates, real runs, reviews, what blocks, the release PR, tagging and repins.
This page only adds what is specific to this repository.

All workspace packages stay private in this repository, and adopters use a
reviewed Git commit. The root version identifies the release. One package,
`@leanish/agent-runtime`, is also published to npm from each stable release; see
[Publishing @leanish/agent-runtime](#publishing-leanishagent-runtime). Keep PAT
mode documented; GitHub App mode remains deferred and will be an alternative to PAT
mode when implemented.

## Candidates

Publish each candidate tag as a GitHub prerelease
(`gh release create v<version>-rc.<n> --prerelease --verify-tag`), so the guided
installer can install it by name. The repository's immutable releases setting
makes it immutable on publication; `release --candidate` refuses it otherwise.

A candidate's real runs, before any release PR:

- When the release changes guided setup, accept it from the candidate: run the
  guided installation for real with `release --candidate v<version>-rc.<n>` and
  that tag as `--release`, with the fixture repositories as its opted-in
  repositories, through gate adoption, a test run, the app's scheduled task,
  its readback and one unattended run. A candidate only ever touches fixture
  repositories: `gate`, `batch`, `test-run` and `schedule` refuse anything
  else. After the stable release, move the acceptance task to the release
  (`schedule ... --release v<version>`) or delete it.
- Run the owner's fixture repositories once per coding-agent adapter, Claude
  Code first and then Codex, with the tools idle and nothing else writing
  their configs. Install the candidate first (`node core/setup/src/cli.ts
  release --candidate v<version>-rc.<n>`); a pass refuses an uninstalled
  release before touching anything. Then, per adapter:
  `bash core/setup/scripts/fixture-pass.sh --release v<version>-rc.<n> --owner
  <owner> --agent claude-code|codex --model <model> --effort <effort> --out
  <directory>` (the output directory outside the repository). The owner's
  installation configs must list only the fixture repositories. Each pass
  first deletes every tool branch on those repositories so it starts clean
  (GitHub closes their PRs with them; `fixture-cleanup` run on the same
  configs without `--apply` lists them), stopping if a branch is reported
  blocked, then runs secure-it and bump-it with `batch`. For the pass it
  switches the `agent:` section of those configs to the requested agent and
  restores them on any exit, so the regular configs stay as they are; it
  writes nothing to Git. Record each pass's evidence (its PRs and their CI)
  before starting the next one or cleaning: closed PRs stay readable, their
  branches don't.
- Runs from a candidate's checkout follow the
  [adoption guide](adopting-tools.md) and include the owner's fixture
  repositories (never in regular passes; only a candidate pass opts them in).
  A candidate's tool code doesn't change those repositories' gate pins: when
  the candidate changes the gate, get its CI evidence from runs pinned to it:
  a PR (compare) and a default-branch push (scan) through Actions, not only
  the CLI.

Reviews and real runs are recorded in [validation](validation.md), and known
limitations in [coverage gaps](coverage-gaps.md).

## Release PR

The version is the root's: set it in `package.json` and in both root version fields
of `package-lock.json`, and keep every `private: true` and workspace version intact.

CI exercises the real Gradle inventory acceptance tests, and
[validation](validation.md#automated-checks-and-skips) lists the checks and what
can skip. The docs that name the current release are the README's "current release"
line.

## After the release

- When the reusable workflow or gate code changes, repin adopting workflows to
  `leanish/leanish-development/.github/workflows/supply-chain.yml@<full-sha> # v<version>`.
  Tool-only releases do not require gate repins. The owner's fixture repositories
  follow every stable release instead, through `node core/setup/src/cli.ts
  fixture-repin --bump-it-config <path> --secure-it-config <path> --release
  v<version>` (dry run, then `--apply`): one PR per fixture changing only the gate
  caller's ref and `# v<version>` comment, merged by hand once green. Their docs
  point at the workflow instead of repeating the version, so nothing else needs
  updating.
- The [adoption guide](adopting-tools.md) says how to install the tools. Switch the
  scheduled runner to the new install.

These steps release supply-chain only; consumer repository releases are separate
decisions.

## trustedPackages migration

The tools read `.github/supply-chain.json` at startup as well as during verification.
v0.10.0 is the first release that accepts `trustedPackages`; the v0.9.1 parser rejects it.
Migrate each repository in this order:

1. Keep `ownPackages` while moving every gate pin and every installed bump-it and
   secure-it that reads the repository to a v0.10 release (0.11.0 no longer accepts the alias).
   Include runners, scheduled tasks and manual checkouts; installing a new release
   alone does not repoint an existing schedule. For this repository, include
   `released-supply-chain.yml`.
2. Once every reader supports it, rename `ownPackages` to `trustedPackages` in this
   repository, adopters and fixtures. Remove the old name; configuring both is an
   error. Renaming preserves the same trust under head's policy.
3. Complete the rename before moving any reader to 0.11.0, which removed the alias:
   a config that still has `ownPackages` fails there, saying to rename the field (or
   to delete it, when `trustedPackages` is there too). A gate already on 0.11.0
   passes the PR making the rename, comparing against base's own lockfiles and
   Gradle builds, with a note that base's policy couldn't be read; head's policy
   judges it. That note can't say whether the rename also changed what is
   trusted: review the policy diff.

## Publishing @leanish/agent-runtime

`@leanish/agent-runtime` is published to npm as compiled JavaScript with
declarations, so other repositories can run a coding agent the same way. Its
first version, 0.9.0, was published by hand; from then on, publishing a stable
GitHub release runs [publish-agent-runtime.yml](../.github/workflows/publish-agent-runtime.yml),
with npm's trusted publishing (OIDC): no npm token is stored anywhere, and npm
adds provenance (it does for a public repository like this one).

1. `prepare` skips prereleases (candidates never publish) and accepts only a
   stable `v<major>.<minor>.<patch>` release. It requires the `npm`
   environment to have a required reviewer, the tag's commit on main with its
   `check` and `gate / supply-chain` checks green (`cooldown` runs on pull requests
   only; main's `ci` runs still in progress on that commit are watched to the
   end first, for up to 20 minutes; otherwise it fails before packing, and the
   run's failed jobs can be re-run), and npm 11.5.1 or later. It runs `npm ci`, packs the package
   (`npm run pack -w @leanish/agent-runtime`), checks the tarball's name and
   version against the tag, installs it in an empty project and imports every
   export, and records its sha512 integrity. It has no publishing permission.
   It hands the tarball to `publish` through its job outputs (base64, at most
   256 KiB encoded; a bigger tarball fails here and is published by hand). The
   workflow uses plain `git` and no artifact actions. This repository now trusts
   `actions`, so the gate permits them; the workflow still avoids the artifact
   actions because they have no immutable releases, using job outputs for the handoff.
2. `publish` runs in the `npm` environment, so it waits for the owner's
   approval; nothing else in the release flow waits for it. It publishes
   exactly the tarball `prepare` checked (its integrity is compared first). A
   rerun after a publish that went through only confirms the published
   integrity: a version is never replaced. Rerun `publish` alone while GitHub
   still lets the run be rerun (up to 30 days); after that, no rerun is
   possible (the workflow only starts from a release being published), so
   publish by hand (below).

**One-time setup, by the owner:**

- GitHub: an environment `npm` with the owner as required reviewer and
  deployments limited to tags `v*`. Leave "Prevent self-review" off while the
  owner is also the account that creates the release.
- npmjs.com, package settings: a trusted publisher for GitHub Actions with
  repository `leanish/leanish-development`, workflow `publish-agent-runtime.yml`
  and environment `npm`, allowed to `npm publish` (not only `npm stage publish`).
  Set it up shortly before the first publish through the workflow: it expires
  if it isn't used. Once that publish works, set "require two-factor
  authentication and disallow tokens".

**By hand** (the fallback, e.g. while the workflow is unavailable): check out
the stable tag, run `npm ci`, then
`npm run pack -w @leanish/agent-runtime -- --out <absolute-dir>` (it prints the
tarball's path as its last line; its
[README](../core/agent-runtime/README.md#publishing) says what it contains), and
`npm publish <tarball> --access public` with the owner's npm login.

The repository's manifest keeps `private: true` and `0.0.0`; only the staged
one is published.
