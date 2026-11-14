# Contributing to Quivra

## Report an issue

For bugs, include your Quivra version, the command, the expected and actual results, and a minimal OpenAPI document and profile when possible. [Choose a GitHub issue template](https://github.com/pixel-brewery/quivra/issues/new/choose).

Report suspected vulnerabilities privately through [GitHub security advisories](https://github.com/pixel-brewery/quivra/security/advisories/new).

## Work on a change

Use Rust via [rustup](https://rustup.rs/) and the Node.js version in [`.node-version`](.node-version). From the repository root, run the checks that apply to your changes.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check:types
npm run test:automation
cargo fmt --all --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
```

For generation changes, use the [two-profile demo](README.md#try-two-clients-from-one-spec) to regenerate the clients and run the smoke test. Include the updated generated files and their manifests. Run `npm run check:examples` to type-check the generated clients, and see the [architecture guide](docs/architecture.md) for the `generate --check` commands used in CI.

For changes to npm packaging or the native launcher, follow the [package verification steps](docs/distribution.md). For template and profile changes, see the [profile guide](docs/profiles.md).
