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
Dependabot also tracks the TypeScript and Node type dependencies in the root npm lockfile.
The npm wrapper’s platform packages are generated at the release version. See the [Dependabot guide](dependabot.md) for guarded automatic merges.

## Publish from protected `main`

Each source push to protected `main` starts **Release Quivra** with a patch increment.
The guarded Dependabot merge workflow dispatches it with the exact merge commit after
its own merges. The release workflow updates `Cargo.toml` and `Cargo.lock`, creates a
version commit with `[skip ci]`, and bundles that commit for verification. CI tests the
bundled source with the new version. The packaging matrix installs and tests each platform
package, and the workflow verifies the archive manifests and binary checksums from that run.

The publish job checks the source, candidate commit and archive bytes again. The Pixel
Brewery Releases App atomically pushes the verified version commit to `main` and the
matching `vVERSION` tag. The job uses the repository's `GITHUB_TOKEN` to upload the six
native packages before the launcher and verify all seven public registry archives. It
then creates the GitHub Release from that tag and attaches the verified native archives
and checksums. Re-run failed jobs in the original run to reuse the verified candidate and
archives, including after a partial upload.

Keep the canonical repository public. The `main` ruleset requires pull requests and
strict **Quality Gate** checks and gives only the Pixel Brewery Releases App a bypass
for the version commit. A separate ruleset protects `main` against deletion and
non-fast-forward updates for every actor. Restrict the `release-main` environment to
`main` and allow public GitHub Packages in the organization. [Distribution guide](distribution.md)

## Run a release manually

With explicit owner authorization, start **Release Quivra** from `main` in Actions and
choose a `patch`, `minor` or `major` increment, or supply an exact stable version higher
than the version on `main`.

For a build-only check, run **Package distributions** on the desired source and download
the six platform artifacts and the launcher artifact.
