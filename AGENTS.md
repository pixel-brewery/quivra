# Quivra repository instructions

Quivra is a Rust CLI from Pixel Brewery that generates TypeScript clients from OpenAPI documents. Its public npm entry point is `@pixel-brewery/quivra`. Consumer-owned MiniJinja profiles define the emitted code. The Node distribution launches the same native executable and exposes a typed process API.

## Architecture skill

- For every repository task, read and apply [.agents/skills/quivra-architect/SKILL.md](.agents/skills/quivra-architect/SKILL.md). It derives from the versioned [Pixel Brewery Architect base](.agents/skills/architect/SKILL.md), installed by the Skills CLI. Read the base and its shared workflow, then follow Quivra's router.
- Delegate independent tasks as directed by the shared workflow. Give agents disjoint edit ownership, use one owner for staging and refs, and coordinate one heavy build or test job at a time.
- Keep Quivra rules in the derived skill. Change inherited rules upstream in `pixel-brewery/skills`. Keep the upstream base and `skills-lock.json` in sync and run `python3 .agents/scripts/sync_architect_core.py --check` after updates.
- Follow the Rust and TypeScript naming conventions in the local skill, including Archipel-style interfaces for the Node API and the transport preset.
- Keep actual code paths, behavior, packaging and tests authoritative. Prefer Cargo conventions and the pinned toolchain. Do not add another build system to wrap Cargo.

## Verification and delivery

- Run `cargo fmt --all --check`, `cargo clippy --locked --all-targets -- -D warnings` and `cargo test --locked` for relevant Rust changes. For generation changes, regenerate both examples, run `generate --check`, and run the TypeScript compiler and Node smoke test documented in the repository.
- Keep project-provided templates and generated clients reproducible. Update the generated examples and their manifests through Quivra.
- Develop in the designated checkout. Preserve unrelated work and the owner's repository and branch policies. Do not publish npm packages, create a release or a release tag, or change repository visibility without explicit authorization. Build-only package verification is allowed for distribution changes.
