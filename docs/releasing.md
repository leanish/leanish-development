# Releasing supply-chain

All workspace packages remain private. Consumers use a reviewed Git commit;
there is no npm publication. The root version identifies the release.

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
   **its exact merge commit**. Create the matching GitHub release with the fixes
   and a link to `CHANGELOG.md`, as java-conventions does. Do not move an
   existing tag or publish packages.
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
