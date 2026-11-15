# Distributing Quivra

Quivra runs as a native command-line executable. The npm package adds a small Node launcher and an optional JavaScript API with TypeScript declarations. Both use the same executable. Node.js 26 runs the repository’s TypeScript build tools. npm installs the launcher as compiled ESM JavaScript with generated declaration files.

## GitHub builds

Run **Package distributions** from the repository's Actions tab to build and inspect archives for a source commit. The workflow uploads these files in one artifact per target.

- A native executable archive and its SHA-256 checksum.
- An npm tarball for that target.

The separate `quivra-npm` artifact contains the platform-independent `@pixel-brewery/quivra` npm tarball.

The matrix covers Intel and Apple Silicon macOS, x64 and ARM64 Linux with glibc, and x64 and ARM64 Windows. The Linux builds use Ubuntu 22.04 runners. The release workflow attaches the verified native archive and checksum for each target to the matching GitHub Release. A downloaded archive contains the executable and can be used without Node or Rust. GitHub Releases are visible to people who can read the source repository. [GitHub Releases documentation](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)

On Linux or macOS, verify and extract the chosen archive with `sha256sum -c <archive>.sha256` or `shasum -a 256 -c <archive>.sha256`, then `tar -xzf <archive>`. Windows includes `tar.exe` for extraction and PowerShell's `Get-FileHash -Algorithm SHA256 <archive>` for comparing the checksum.

## npm distribution

The public package is `@pixel-brewery/quivra` on the GitHub Packages npm registry at `npm.pkg.github.com`. Its optional dependencies are pinned to the same release version. macOS uses `@pixel-brewery/quivra-darwin-<arch>`, Linux uses `@pixel-brewery/quivra-linux-<arch>-gnu`, and Windows uses `@pixel-brewery/quivra-win32-<arch>-msvc`. Each native package declares the matching npm platform constraints. Keep optional dependencies enabled during installation. The packages have no lifecycle install scripts or separate binary downloads. [npm package manifest documentation](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/)

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

The package exports the configuration schemas at `@pixel-brewery/quivra/schemas/profile.schema.json` and `@pixel-brewery/quivra/schemas/batch.schema.json`. Use their installed files for [editor validation](https://github.com/pixel-brewery/quivra/blob/main/docs/profiles.md#editor-validation), or print them with `quivra schema profile` and `quivra schema batch`.

## Package publication and visibility

Quivra is distributed under the MIT License. The npm tarballs and native release archives include the license.

The **Release Quivra** workflow publishes the verified npm artifacts and the GitHub Release automatically from protected `main`. [Versioning and release workflow](https://github.com/pixel-brewery/quivra/blob/main/docs/ci-cd.md)

GitHub Packages initially creates a new package with private visibility. If the workflow flags a new package, an authorized package administrator can set **Danger Zone → Change visibility → Public** in that package's settings. After the visibility change, re-run the failed jobs in the original release run. [GitHub Packages visibility settings](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility#configuring-visibility-of-packages-for-an-organization)

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
