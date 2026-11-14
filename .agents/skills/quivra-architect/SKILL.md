---
name: quivra-architect
description: Plan, implement, test, or review Quivra's Rust CLI, OpenAPI projection, project-owned MiniJinja profiles, generated TypeScript, and Node/native distribution.
metadata:
  inherits: architect
---

# Quivra Architect

Read the [Architect base](../architect/SKILL.md), its [shared workflow](../architect/references/common/workflow.md), [AGENTS.md](../../../AGENTS.md), and [the project contract](references/project.md) at task start. The shared base is installed from `pixel-brewery/skills`. Its Git commit and content hash are in `skills-lock.json`.

Use the shared workflow for scope, reference passes, ownership, delegation and verification. Combine the relevant common modules and local contract for the production boundary.

| Boundary | Shared guidance | Quivra guidance |
| --- | --- | --- |
| Crate design, module ownership, changes to public CLI or repository structure | [Architecture](../architect/references/common/architecture.md), [Repository structure](../architect/references/common/repository-structure.md) | [Project contract](references/project.md) |
| OpenAPI loading, references, schema semantics or emitted HTTP clients | [Backend contracts](../architect/references/common/backend-contracts.md), [API contract](../architect/references/common/api.md) | [Generation contract](references/generation.md) |
| Template context, file plans, filesystem access or recoverable generation | [Architecture](../architect/references/common/architecture.md), [Platform](../architect/references/common/platform.md) | [Generation contract](references/generation.md) |
| Node launcher, native artifacts, test design or package verification | [Platform](../architect/references/common/platform.md), [Testing](../architect/references/common/testing.md) | [Project contract](references/project.md) and the applicable production contract |

The shared HTTP guidance informs the specification and generated client boundary. This repository owns a command-line tool and uses the local Rust and Node conventions in the project contract.

Validate inheritance with `python3 .agents/scripts/sync_architect_core.py --check`. Maintain the derived skill here and the inherited foundation upstream.
