import assert from "node:assert/strict";
import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { generate, inspect } from "@pixel-brewery/quivra";

const repositoryPath = process.argv[2];
if (!repositoryPath) throw new Error("Provide the Quivra checkout path.");
const repo = resolve(repositoryPath);
const spec = resolve(repo, "examples/openapi.yaml");
const profile = resolve(repo, "examples/profiles/fetch");
const out = resolve("generated path with spaces");

for (const file of ["profile.schema.json", "batch.schema.json"]) {
    const installed = new URL(import.meta.resolve(`@pixel-brewery/quivra/schemas/${file}`));
    assert.deepEqual(await readFile(installed), await readFile(resolve(repo, "schemas", file)));
}

const context = await inspect({ spec, profile });
assert.equal(context.api.title, "Widget API");
await generate({ spec, profile, out });
const client = resolve(out, "client.ts");
const generated = await readFile(client, "utf8");
assert.match(generated, /export async function listWidgets/);
await generate({ spec, profile, out, check: true });

const edit = "// changed by the smoke test\n";
await appendFile(client, edit);
await assert.rejects(generate({ spec, profile, out, check: true }));
assert.equal(await readFile(client, "utf8"), generated + edit);
