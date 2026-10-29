# Releasing supply-chain

All workspace packages stay private in this repository, and adopters use a
reviewed Git commit. The root version identifies the release. One package,
`@leanish/agent-runtime`, is also published to npm from each stable release; see
[Publishing @leanish/agent-runtime](#publishing-leanishagent-runtime).

The flow follows java-conventions: a small release PR with a dated CHANGELOG
entry, merged, its exact merge commit tagged, and a matching GitHub release. A
release candidate is run for real and reviewed first, so the release ships what
was reviewed. Each release lists its changes in [the CHANGELOG](../CHANGELOG.md);
unreleased changes collect under its "Unreleased" heading.

1. Start from the latest reviewed main. Keep PAT mode documented; GitHub App mode
   remains deferred and will be an alternative to PAT mode when implemented.
2. Tag the candidate commit on main with a lightweight `v<version>-rc.<n>` tag
   (candidate tags never move either) and publish it as a GitHub prerelease
   (`gh release create v<version>-rc.<n> --prerelease --verify-tag`), so the
   guided installer can install it by name. The repository's immutable releases
   setting makes it immutable on publication; `release --candidate` refuses it
   otherwise. Before any release PR:
   - When the release changes guided setup, accept it from the candidate: run the
     guided installation for real with `release --candidate v<version>-rc.<n>` and
     that tag as `--release`, with the fixture repositories as its opted-in
     repositories, through gate adoption, a test run, the app's scheduled task,
     its readback and one unattended run. A candidate only ever touches fixture
     repositories: `gate`, `batch`, `test-run` and `schedule` refuse anything
     else. After the stable release, move the acceptance task to the release
     (`schedule ... --release v<version>`) or delete it.
   - Before the fixture runs, with the tools idle, delete every tool branch on the
     owner's fixture repositories so the runs start clean (GitHub closes their PRs
     with them): `node core/setup/src/cli.ts fixture-cleanup --bump-it-config <path>
     --secure-it-config <path>` (the two fixture configs) lists the branches; rerun
     it with `--apply` to delete them. Don't start the runs while a branch is
     reported blocked. Record the previous candidate's run evidence before
     cleaning: closed PRs stay readable, their branches don't.
   - Run the tools for real from a checkout of the candidate, as the
     [adoption guide](adopting-tools.md) describes, on adopting repositories
     where the release's changes apply, including the owner's fixture
     repositories (never in regular passes; only a candidate pass opts them in).
     A candidate's tool code doesn't change those repositories' gate pins: when
     the candidate changes the gate, get its CI evidence from runs pinned to it.
   - Review the candidate in three steps, each only if the one before found no
     blocker; a blocker is fixed in a new candidate, which starts again at the
     first step:
     1. Two cheap reviewers compare the candidate with the deployed release
        (`git diff v<deployed> v<version>-rc.<n>`): one goes through a fixed
        checklist of risky cases (links, case and Unicode variants, base versus
        head, a folder where a file is expected, unusual paths, submodules,
        very large or looping inputs), the other looks freely for what the
        change breaks or lets through.
     2. Whoever didn't implement the release's changes reviews the candidate's
        whole state, unprimed: say what to review, not where to look, and not
        what the first step found. Real runs only reach the cases the adopting
        repositories have today; this review looks for the ones they didn't
        exercise.
     3. On a candidate the second step finds clean, a different reviewer takes a
        final, critical pass on that review: it challenges it and looks for what
        it missed.

     Whoever implemented judges each finding against the rule below rather than
     taking every one as required, and records in [validation](validation.md)
     what each step added (a finding the others missed, or one rightly
     overturned) or whether it only cost time and tokens, so their worth can be
     judged across releases.

   A fix found here lands on main through its own PR and gets a new candidate,
   `rc.<n+1>`, which is run and reviewed again. A candidate blocks only on what
   is new in the release or worse than the deployed release:
   - Findings that weaken verification or the gate, produce wrong data, or abort
     whole runs, compared with the deployed release, block.
   - A finding whose only effect is that a tool doesn't update something
     automatically (it skips it with a note, or the attempt fails visibly)
     doesn't block: document it as a known limitation and fix it later.
   - A problem the deployed release already has doesn't block either: document
     it as a known limitation in [coverage gaps](coverage-gaps.md) and fix it in
     the next release. Holding a release for every older problem a fresh review
     finds would keep the deployed release, which has them all, running longer.
3. Open `release/<version>` from the reviewed candidate's commit; if main moved
   past it, those commits need a candidate of their own first. Set the root
   version in `package.json` and both root version fields in `package-lock.json`;
   turn the CHANGELOG's "Unreleased" heading into the version and release date.
   Keep every `private: true` and workspace version intact.
4. Run `npm run check` and require green CI and CodeQL on the release PR's head.
   CI exercises the real Gradle inventory acceptance tests. Report integration
   skips (see [validation](validation.md#automated-checks-and-skips)), and retain
   the [real-run evidence](validation.md).
5. Right before merging, check against the candidate: main must still be at the
   candidate's commit (the squash lands on main, not on the PR's head), and
   `git diff v<version>-rc.<n> HEAD` on the release PR may show only the release
   metadata of step 3 and the docs' current-release pointers. Anything else,
   including commits main gained meanwhile, needs a new candidate, run and
   reviewed.
   Squash-merge the release PR and create a lightweight `v<version>` tag at
   **its exact merge commit**. Once that commit's `check` and `supply-chain` checks
   are green (publishing requires them; a release created earlier fails before
   packing, and its run's failed jobs can be re-run), create the matching GitHub
   release with the fixes and a link to `CHANGELOG.md`, as java-conventions does. Do not move an
   existing tag; publishing `@leanish/agent-runtime` is a separate step (below).
6. When the reusable workflow or gate code changes, resolve the tag's full commit
   SHA and repin adopting workflows to
   `leanish/leanish-development/.github/workflows/supply-chain.yml@<full-sha> # v<version>`.
   Require green adoption PR checks before merging. Tool-only releases do not
   require gate repins. The owner's fixture repositories follow every stable
   release instead, through `node core/setup/src/cli.ts fixture-repin
   --bump-it-config <path> --secure-it-config <path> --release v<version>` (dry
   run, then `--apply`): one PR per fixture changing only the gate caller's ref
   and `# v<version>` comment, merged by hand once green. Their docs point at the
   workflow instead of repeating the version, so nothing else needs updating.
7. Install tools from that release commit in a stable checkout outside `/tmp`,
   following the [adoption guide](adopting-tools.md). Preserve the owner's configs
   and secret-service overrides when switching the scheduled runner. Do not put
   credentials in Git, release notes or scheduling files.

These steps release supply-chain only; consumer repository releases are separate
decisions. Subsequent development must not move a released tag or an adopter's pin.

## trustedPackages migration

The tools read `.github/supply-chain.json` at startup as well as during verification.
v0.10.0 is the first release that accepts `trustedPackages`; the v0.9.1 parser rejects it.
Migrate each repository in this order:

1. Keep `ownPackages` while moving every gate pin and every installed bump-it and
   secure-it that reads the repository to v0.10.0 (or a later release that still accepts the alias).
   Include runners, scheduled tasks and manual checkouts; installing a new release
   alone does not repoint an existing schedule. For this repository, include
   `released-supply-chain.yml`.
2. Once every reader supports it, rename `ownPackages` to `trustedPackages` in this
   repository, adopters and fixtures. Remove the old name; configuring both is an
   error. Renaming preserves the same trust under head's policy.
3. Complete the rename before moving any reader to 0.11.0, which removes the alias.

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
   `check` and `supply-chain` checks green (`cooldown` runs on pull requests
   only), and npm 11.5.1 or later. It runs `npm ci`, packs the package
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
