# Architecture

## Follow a generated method

1. `src/main.rs` parses the CLI arguments and coordinates the run.
2. `src/openapi/` reads YAML or JSON and resolves references within the chosen root. It keeps operation IDs, wire names, security, response status codes and media types.
3. `src/typescript/` projects the document into the version 1 template context. This is where OpenAPI schemas become TypeScript type expressions.
4. `src/profile/mod.rs` reads a project profile and renders all of its templates using MiniJinja.
5. `src/profile/output.rs` compares or writes the file plan. The output manifest tracks paths and content hashes. It is part of the generated output.

A profile controls the filenames and all the code written to them. For example, the Fetch profile decodes HTTP responses and event streams. The class profile delegates HTTP I/O to a supplied transport and emits an additional route table. Neither shape requires changing the Rust generator.

## Work on Quivra

Install [Rust with rustup](https://rustup.rs/) and make sure `cargo` is on your PATH. The checked-in `rust-toolchain.toml` selects the compiler and installs the formatting and lint components. Node.js 26 is used for the generated-client and npm distribution tests.

```sh
npm ci --ignore-scripts
npm run check:types
npm run check:examples
cargo fmt --all --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cargo build --locked
target/debug/quivra generate examples/openapi.yaml --profile examples/profiles/fetch --out examples/generated/fetch --check
target/debug/quivra generate examples/openapi.yaml --profile examples/profiles/transport --out examples/generated/transport --check
node examples/smoke.ts
```

When changing a profile or the generator, run both generation commands in the README and commit the generated files and their manifests. These files are fixtures for the CLI check and runtime tests.

## Output behavior

Use a dedicated directory for each generation. Generation renders the complete plan before changing any generated file. It serializes writers to the same output directory, stages changed files, replaces each file individually and records the new inventory. A journal allows a failed write to continue with the same inputs. Keep the manifest with the generated files, including in source control if the outputs are tracked.

Quivra removes only previously generated files whose recorded contents still match. When it encounters an edited or unowned file that would change, it reports the path and stops. Existing outputs from the prototype can be adopted if their bytes match the new plan. For changed output, generate into a new directory and review before replacing the old one. If a filename needs a case-only rename or is changing between file and directory, generate to a fresh directory.

`generate --check` compares declared files and their manifest without writing them. The check is intended for build scripts and CI.

## Update the inherited Architect skill

Quivra uses the same pinned Pixel Brewery Architect foundation as Archipel. The local
`quivra-architect` skill routes that guidance to Quivra's production modules.

The current upstream checker uses the version 1 lock format. Use Skills CLI 1.7.6
to restore or update the pinned copy. For an update, replace the commit in the
GitHub tree URL with a reviewed full SHA and run both commands:

```sh
npx --yes skills@1.7.6 add https://github.com/pixel-brewery/skills/tree/5ffad4f9f15c2034235c24d50da7df32ecc2fb3d/skills/architect --skill architect --agent codex --copy --yes
python3 .agents/scripts/sync_architect_core.py --check
```
