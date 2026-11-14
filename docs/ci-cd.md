# CI, releases and dependency updates

The canonical repository is `pixel-brewery/quivra` with GitHub repository ID `1457527723`.

## Verification

The [CI workflow](../.github/workflows/ci.yml) runs on pull requests, merge queues and
pushes to `main`. It checks the pinned Architect skill, runs Rust format and lint
checks and exercises the CLI on Linux, macOS and Windows. It checks the committed
generated outputs with TypeScript 7 and runs both clients against fake transports.
The stable **Quality Gate** check requires every platform job to pass.

[Dependabot](../.github/dependabot.yml) checks Cargo and GitHub Actions every Monday.
GitHub's Dependabot security updates also run when valid advisories are found.
The npm wrapper has no managed runtime dependencies in its source manifest.
Its platform packages are generated at the release version. See the [Dependabot guide](dependabot.md) for guarded automatic merges.

## Build and inspect a release candidate

1. Land the intended version in `Cargo.toml` and `Cargo.lock` on `main`.
2. Use **Release Quivra** in Actions. Choose `main`, enter the exact version and leave
   the **publish** box unchecked.
3. Download the six platform artifacts and the launcher artifact from the resulting
   workflow run. The release workflow runs the same CI first, installs and tests
   each platform package, and verifies the combined archive manifests and binary checksums.

For the first public npm release, use the reviewed tarballs from a single successful
candidate run as described in the [distribution guide](distribution.md).
A maintainer can attach that same run's native archive and checksum files to a GitHub
Release pointing to the candidate's commit.

## Enable the publishing job

- Make the canonical source repository public for npm provenance and the required
  GitHub protection on this repository's current plan.
- Protect `main` with pull-request review rules, deletion and force-push protection,
  and require **Quality Gate** with up-to-date branches.
- Keep `release-main` restricted to `main`. Configure the desired release reviewer
  in this environment after GitHub makes that protection available.
- Configure direct Trusted Publishing for all seven npm packages. Use
  `pixel-brewery/quivra`, `release.yml`, and `release-main`.

When releasing a new version, select **publish** in **Release Quivra**.
The workflow checks the repository, branch, verification jobs, package contents
and existing published bytes. Each npm platform package is published before the
launcher. The GitHub Release is created from the same commit and native artifacts.
After a partial registry failure, retry failed jobs in the original run so the
artifacts remain byte-for-byte identical.
