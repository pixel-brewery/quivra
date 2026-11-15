# Quivra repository instructions

Quivra is a Rust CLI from Pixel Brewery that generates TypeScript clients from OpenAPI documents. Its public npm entry point is `@pixel-brewery/quivra`. Consumer-owned MiniJinja profiles define the emitted code. The Node distribution launches the same native executable and exposes a typed process API.

## Architecture skill

- For every repository task, read and apply [.agents/skills/quivra-architect/SKILL.md](.agents/skills/quivra-architect/SKILL.md). It derives from the versioned [Pixel Brewery Architect base](.agents/skills/architect/SKILL.md), installed by the Skills CLI. Read the base and its shared workflow, then follow Quivra's router.
- Delegate independent tasks as directed by the shared workflow. Give agents disjoint edit ownership, use one owner for staging and refs, and coordinate one heavy build or test job at a time.
- Keep Quivra rules in the derived skill. Change inherited rules upstream in `pixel-brewery/skills`. Keep the upstream base and `skills-lock.json` in sync and run `python3 .agents/scripts/sync_architect_core.py --check` after updates.
- Follow the Rust and TypeScript naming conventions in the local skill, including Archipel-style interfaces for the Node API and the transport preset.
- Keep actual code paths, behavior, packaging and tests authoritative. Prefer Cargo conventions and the pinned toolchain. Do not add another build system to wrap Cargo.

## Issue tracking

- Track project work on the [Quivra GitHub project board](https://github.com/orgs/pixel-brewery/projects/14). Public issues and pull requests belong in `pixel-brewery/quivra`. Use [private vulnerability reporting](https://github.com/pixel-brewery/quivra/security/advisories/new) for suspected vulnerabilities.
- Before creating a follow-up, search the board and the repository's open and closed issues. Link the existing item when it already covers the work.
- Read the board's current Status options before assigning a status. Add tracked items explicitly and verify they appear once with the intended status. Keep the backlog in GitHub.

## Verification and delivery

- Run `cargo fmt --all --check`, `cargo clippy --locked --all-targets -- -D warnings` and `cargo test --locked` for relevant Rust changes. For generation changes, regenerate both examples, run `generate --check`, and run the TypeScript compiler and Node smoke test documented in the repository.
- Keep project-provided templates and generated clients reproducible. Update the generated examples and their manifests through Quivra.
- Develop in the designated checkout. Preserve unrelated work and the owner's repository and branch policies. Build-only package verification is allowed for distribution changes.

## Release authority

- The maintained release workflow is authorized to publish automatically from protected `main` in the canonical public `pixel-brewery/quivra` repository. This covers the verified version commit and tag, the seven npm packages on GitHub Packages, and the matching GitHub Release with native archives.
- The release App is scoped to the atomic push of the verified version commit and tag. The workflow uses `GITHUB_TOKEN` for package publication and GitHub Release operations. Published package versions and release assets are immutable.
- Manual release dispatch, publication outside the maintained workflow, manual tags or releases, and visibility changes require explicit owner authorization.
