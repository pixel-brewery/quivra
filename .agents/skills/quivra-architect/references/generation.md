# Quivra generation contract

Read the [profile guide](../../../../docs/profiles.md) before changing the template data or the CLI's behavior.

- Preserve the distinction between the input specification, the TypeScript template context and files emitted by a profile. The parser has no assumptions about the class, framework or transport a project wants in its client.
- Preserve wire identifiers while normalizing generated identifiers. Diagnose collisions, unsupported inputs and invalid references with the relevant operation or path.
- Keep references local to the configured root. Do not enable network loading or executable template hooks as an incidental change.
- Keep the manifest version, `inspect` output, npm type declarations and profile guide aligned. Provide a compatibility decision when changing fields, syntax, or CLI behavior existing profiles rely on.
- Render all files before writes. Use the output owner for staging, collision handling and the inventory, and preserve recovery for both retries and concurrent generator processes. Verify edited or handwritten file behavior through the public CLI.
- Prove that both starter profiles still work from the same document. For contract changes, run runtime smoke checks so successful type-checking alone cannot hide generation or wire regressions.
