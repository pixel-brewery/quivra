# Distributing Quivra

Quivra runs as a native command-line executable. The npm package adds a small Node launcher and an optional JavaScript API with TypeScript declarations. Both use the same executable. Node.js 26 runs the repository’s TypeScript build tools. npm installs the launcher as compiled ESM JavaScript with generated declaration files.

## GitHub builds

Run **Package distributions** from the repository's Actions tab on the commit you intend to distribute. The workflow uploads one artifact per target with:

- A native executable archive and its SHA-256 checksum.
- An npm tarball for that target.

The separate `quivra-npm` artifact contains the platform-independent `@pixel-brewery/quivra` npm tarball.

The matrix covers Intel and Apple Silicon macOS, x64 and ARM64 Linux with glibc, and x64 and ARM64 Windows. The Linux builds use Ubuntu 22.04 runners. When requested, the release workflow attaches the native archive and checksum for each target to the GitHub Release. A downloaded archive contains the executable and can be used without Node or Rust. GitHub Releases are visible to people who can read the source repository. [GitHub Releases documentation](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)

On Linux or macOS, verify and extract the chosen archive with `sha256sum -c <archive>.sha256` or `shasum -a 256 -c <archive>.sha256`, then `tar -xzf <archive>`. Windows includes `tar.exe` for extraction and PowerShell's `Get-FileHash -Algorithm SHA256 <archive>` for comparing the checksum.

## npm distribution

The public package is `@pixel-brewery/quivra` on the GitHub Packages npm registry at `npm.pkg.github.com`. Its optional dependencies are pinned to the same Cargo version. macOS uses `@pixel-brewery/quivra-darwin-<arch>`, Linux uses `@pixel-brewery/quivra-linux-<arch>-gnu`, and Windows uses `@pixel-brewery/quivra-win32-<arch>-msvc`. Each native package declares the matching npm platform constraints. Keep optional dependencies enabled during installation. The packages have no lifecycle install scripts or separate binary downloads. [npm package manifest documentation](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/)

After publication, configure the `@pixel-brewery` scope in the consuming project's `.npmrc`:

```ini
@pixel-brewery:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

GitHub Packages requires authentication even for public npm packages. Use an existing classic GitHub personal access token with `read:packages`, or the consuming workflow's `GITHUB_TOKEN` with `packages: read` and package access. Keep the token in the environment. Mosaik already routes this scope to GitHub Packages. [GitHub Packages npm authentication](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry#authenticating-to-github-packages)

Then install and run Quivra:

```sh
npm install -D @pixel-brewery/quivra
npx quivra --help
```

The optional ESM API invokes the same Rust commands. Paths are resolved relative to the calling process's working directory.

```ts
import { generate, inspect } from "@pixel-brewery/quivra";

const options = { spec: "openapi.yaml", profile: "profiles/fetch" };
const context = await inspect(options);
await generate({ ...options, out: "src/api" });
await generate({ ...options, out: "src/api", check: true });
```

Use `generateBatch({ batch, profile, out })` with a JSON [batch manifest](https://github.com/pixel-brewery/quivra/blob/main/docs/profiles.md#generating-multiple-documents) to generate several clients and a shared index in one run. Set `check: true` to test the complete output for drift.

## First release

Quivra is distributed under the MIT License. The npm tarballs and native release archives include the license.

Run **Release Quivra** from `main` with **publish** selected. Leave **github_release** unchecked for a packages-only publication. GitHub Packages initially creates each package with private visibility. After the first workflow upload, open the package settings for each of the six native packages and the launcher and set **Danger Zone → Change visibility → Public**. The organization must allow public packages. The workflow's public-package check lists the packages that still need their visibility changed. Once all seven are public, re-run the failed jobs from that same release run. [GitHub Packages visibility settings](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility#configuring-visibility-of-packages-for-an-organization)

For later versions, dispatch the release workflow from protected `main` and approve `release-main`. The job uses the repository's Actions token to publish the exact candidate tarballs. See [the CI/CD guide](https://github.com/pixel-brewery/quivra/blob/main/docs/ci-cd.md) for repository settings.

## Build a package locally

With Rust and Node.js 26 on a listed platform, prepare the current host's launchable packages from the repository root:

```sh
npm ci --ignore-scripts
cargo build --locked --release
target=$(rustc -vV | sed -n 's/^host: //p')
binary=target/release/quivra
case "$target" in *windows*) binary="$binary.exe";; esac
node distribution/prepare.ts native "$target" "$binary" target/distribution/native
node distribution/prepare.ts launcher target/distribution/launcher
mkdir -p target/distribution/artifacts
npm pack ./target/distribution/native ./target/distribution/launcher --ignore-scripts --pack-destination target/distribution/artifacts
```

Install both generated `.tgz` packages together in a temporary npm project to test the unpublished version. The packaging workflow performs this installation without registry access.
