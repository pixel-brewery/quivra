# Quivra project contract

Read [the architecture overview](../../../../docs/architecture.md) and the owning implementation before changing it.

## Repository ownership

- `src/main.rs` owns arguments and command orchestration. Use Cargo's standard crate layout and keep Rust modules private unless a real caller needs their types.
- `src/openapi/` owns document loading, dialect handling, reference resolution and the OpenAPI model. `src/typescript/` owns TypeScript projection and the serialized template context.
- `src/profile/` owns template execution and the file plan, including output ownership and failure recovery. `examples/profiles/` contains the editable starter profiles. The Rust CLI embeds those same sources for `init`.
- `examples/generated/` is generated. `distribution/` owns npm packaging, the Node launcher and TypeScript declarations for the process API. Build-only workflows are under `.github/workflows/`.

## Engineering and verification

Use Cargo with the checked-in toolchain and lockfile. Prefer small fallible functions, typed inputs, path/operation context on errors, and deterministic ordering at persisted or serialized boundaries. Avoid panics on user-controlled input. Keep the Node package a thin process adapter. Author Node tooling and wrappers in strict TypeScript, and use the Node 26 version in `.node-version`. Run repository scripts with Node type stripping. Compile the npm entry point and its declarations during packaging. Put the general behavior in Rust or in project-owned templates as appropriate.

Keep unit tests beside the owning Rust module and CLI integration tests in `tests/`. Verify generated code with strict TypeScript and the fake-transport smoke test. A distribution change needs an actual packed install, launcher invocation and typed API check, as documented in the [distribution guide](../../../../docs/distribution.md). Respect the release authority in [AGENTS.md](../../../../AGENTS.md).

## Naming and published contracts

Use Rust conventions for the CLI and core: `snake_case` for modules, functions and fields,
`PascalCase` for structs, enums and traits, and `SCREAMING_SNAKE_CASE` for constants.
Use the naming and visibility appropriate to a Rust trait or enum when adapting a shared pattern.

Follow Archipel's TypeScript conventions for hand-authored public declarations and
the transport preset. Prefix interfaces with `I`, place them under `interfaces/`,
put other public types under `types/`, and give each public declaration its own file.
Use explicit ESM imports and `import type` where applicable. Name private fields with a
leading underscore and group class members under Fields, Ctor, Properties and Methods.
A consumer-owned profile may choose its own layout. Preserve JSON and wire names.

Use Conventional Commits for delivery. Public npm names use
`@pixel-brewery/quivra` and the related platform package names in `distribution/`.
