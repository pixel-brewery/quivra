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

## Build and inspect a release candidate

1. Land the intended version in `Cargo.toml` and `Cargo.lock` on `main`.
2. Use **Release Quivra** in Actions. Choose `main`, enter the exact version and leave
   the **publish** box unchecked.
3. Download the six platform artifacts and the launcher artifact from the resulting
   workflow run. The release workflow runs the same CI first, installs and tests
   each platform package, and verifies the combined archive manifests and binary checksums.

## Publish to GitHub Packages

- Keep the canonical source repository public and protect `main` with pull-request rules,
  deletion and force-push protection, and strict **Quality Gate** checks.
- Keep `release-main` restricted to `main` with a required release reviewer.
- Allow public GitHub Packages in the organization so a package administrator can set the
  seven packages to Public after their first upload.

To publish packages, select **publish** in **Release Quivra**. Leave **github_release** unchecked
to publish the npm packages without creating a release or tag. Select both options to also
create a GitHub Release from the same commit and native artifacts.

The workflow checks the repository, branch, verification jobs, package contents, and existing
published bytes. The GitHub Actions `GITHUB_TOKEN` writes the six native packages before the
launcher. A read-only job then verifies public visibility, canonical repository association,
and exact downloaded archive bytes.

On the first release, set all seven packages to **Public** when the visibility check asks.
Re-run failed jobs in the original run to preserve the exact verified artifacts. Follow the same
retry procedure after a partial upload failure. The [distribution guide](distribution.md) explains
package visibility and consumer authentication.
