# Distributing Quivra

Quivra runs as a native command-line executable. The npm package adds a small Node launcher and an optional JavaScript API with TypeScript declarations. Both use the same executable. Node.js 26 runs the repository’s TypeScript build tools. npm installs the launcher as compiled ESM JavaScript with generated declaration files.

## GitHub builds

Run **Package distributions** from the repository's Actions tab on the commit you intend to distribute. The workflow uploads one artifact per target with:

- A native executable archive and its SHA-256 checksum.
- An npm tarball for that target.

The separate `quivra-npm` artifact contains the platform-independent `@pixel-brewery/quivra` npm tarball.

The matrix covers Intel and Apple Silicon macOS, x64 and ARM64 Linux with glibc, and x64 and ARM64 Windows. The Linux builds use Ubuntu 22.04 runners. The release workflow attaches the native archive and checksum for each target to the GitHub Release. A downloaded archive contains the executable and can be used without Node or Rust. GitHub Releases are visible to people who can read the source repository. [GitHub Releases documentation](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)

On Linux or macOS, verify and extract the chosen archive with `sha256sum -c <archive>.sha256` or `shasum -a 256 -c <archive>.sha256`, then `tar -xzf <archive>`. Windows includes `tar.exe` for extraction and PowerShell's `Get-FileHash -Algorithm SHA256 <archive>` for comparing the checksum.

## npm distribution

The public package is `@pixel-brewery/quivra` on `registry.npmjs.org`. Its optional dependencies are pinned to the same Cargo version. macOS uses `@pixel-brewery/quivra-darwin-<arch>`, Linux uses `@pixel-brewery/quivra-linux-<arch>-gnu`, and Windows uses `@pixel-brewery/quivra-win32-<arch>-msvc`. Each native package declares the matching npm platform constraints. Keep optional dependencies enabled during installation. The packages have no lifecycle install scripts or separate binary downloads. [npm package manifest documentation](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/)

Once published, use:

```sh
npm install -D @pixel-brewery/quivra
npx quivra --help
```

npm resolves an entire scope through its configured registry. If a project routes `@pixel-brewery` to GitHub Packages, that registry will also receive Quivra requests. The install commands above apply to projects where the scope resolves to the public npm registry. [npm scope and registry configuration](https://docs.npmjs.com/cli/v11/using-npm/scope/#associating-a-scope-with-a-registry)

The optional ESM API invokes the same Rust commands. Paths are resolved relative to the calling process's working directory.

```ts
import { generate, inspect } from "@pixel-brewery/quivra";

const options = { spec: "openapi.yaml", profile: "profiles/fetch" };
const context = await inspect(options);
await generate({ ...options, out: "src/api" });
await generate({ ...options, out: "src/api", check: true });
```

## First release and trusted publishing

The repository owner chooses the distribution license before the first public release. The package preparation currently leaves the license metadata unset.

npm requires the packages to exist before adding Trusted Publishers. For the initial publication, a Pixel Brewery npm maintainer can use the tarballs from one reviewed packaging run. Sign in to the public registry and publish the six native tarballs with `npm publish --access public ./<native-package-version>.tgz`. Confirm the native versions are visible from the registry, then publish `./pixel-brewery-quivra-<version>.tgz` the same way. [Publishing public organization packages](https://docs.npmjs.com/creating-and-publishing-an-organization-scoped-package/) · [npm trust prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust/#prerequisites)

Configure a Trusted Publisher for every package in npm's package settings:

| Setting | Value |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `pixel-brewery` |
| Repository | `quivra` |
| Workflow filename | `release.yml` |
| Environment | `release-main` |
| Allowed action | Direct publish (`npm publish`) |

Set up the publisher when the first OIDC release is ready to run. npm expires a new configuration after two days if it has yet to publish successfully. For the first GitHub Release, a maintainer can attach the native archives and sidecars from the same reviewed packaging run. For subsequent releases, a maintainer dispatches the release workflow from protected `main`. Publishing through that workflow requires the public canonical repository and approval through the `release-main` environment. Packaging verification also works while the repository is private. See [the CI/CD guide](https://github.com/pixel-brewery/quivra/blob/main/docs/ci-cd.md) for the workflow and repository settings. GitHub Release visibility follows the repository, and automatic npm provenance requires public source and public packages. [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) · [GitHub Releases documentation](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)

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
