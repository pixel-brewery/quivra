// #region Imports
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createNativeCiFixture } from "./fixtures/createNativeCiFixture.ts";
import { readReadonlyCiSource } from "./readReadonlyCiSource.ts";
// #endregion

test("accepts the actual CI only after its Git blob content hash matches", async () => {
    // Arrange
    const f = createNativeCiFixture();
    // Act
    const source = await readReadonlyCiSource(f.proof.baseSha, f.request);
    // Assert
    assert(source?.startsWith("name: CI\n"));
    assert.deepEqual(f.writes, []);
});

for (const changed of [{ sha: "0".repeat(40) }, { encoding: "utf8" }, { type: "symlink" }, { content: "" }]) test(`rejects unverifiable Git content ${JSON.stringify(changed)}`, async () => {
    // Arrange
    const f = createNativeCiFixture();
    const route = `contents/${f.workflow.path}?ref=${f.proof.baseSha}`;
    f.values[route] = { ...(f.values[route] as object), ...changed };
    // Act and Assert
    assert.equal(await readReadonlyCiSource(f.proof.baseSha, f.request), undefined);
    assert.deepEqual(f.writes, []);
});

test("rejects a mutable source before any metadata access", async () => {
    // Arrange
    const f = createNativeCiFixture();
    // Act and Assert
    assert.equal(await readReadonlyCiSource("main", f.request), undefined);
    assert.equal(f.reads.size, 0);
});

for (const [name, value] of [
    ["custom context", '"${{ secrets.PUBLISH_TOKEN }}"'],
    ["uppercase context", '"${{ SECRETS.PUBLISH_TOKEN }}"'],
    ["indexed context", '"${{ secrets[\'PUBLISH_TOKEN\'] }}"'],
    ["whole context", '"${{ toJSON(secrets) }}"'],
    ["escaped identifier", '"${{ se\\u0063rets.PUBLISH_TOKEN }}"'],
    ["escaped dollar", '"\\u0024{{ secrets.PUBLISH_TOKEN }}"'],
    ["escaped braces", '"$\\u007b\\u007b secrets.PUBLISH_TOKEN }}"'],
    ["escaped line break", '"${{ se\\\n          crets.PUBLISH_TOKEN }}"'],
    ["single-quoted YAML braces", "'${{ format(''}}{0}'', secrets.PUBLISH_TOKEN) }}'"],
    ["double-quoted expression braces", '"${{ format(\'}}{0}\', secrets.PUBLISH_TOKEN) }}"'],
] as const) test(`an unreviewed identical baseline/head cannot learn a safe digest from ${name}`, async () => {
    // Arrange
    const baselineSource = readFileSync(new URL("../workflows/ci.yml", import.meta.url), "utf8").replace("          persist-credentials: false", `          token: ${value}\n          persist-credentials: false`);
    const f = createNativeCiFixture({ baselineSource });
    // Act and Assert
    assert.equal(await readReadonlyCiSource(f.proof.baseSha, f.request), undefined);
    assert.equal(await readReadonlyCiSource(f.proof.headSha, f.request), undefined);
    assert.deepEqual(f.writes, []);
});

test("even harmless new CI commands require an explicit reviewed baseline update", async () => {
    // Arrange
    const baselineSource = readFileSync(new URL("../workflows/ci.yml", import.meta.url), "utf8") + "\n# Deliberate new reviewed-source content\n";
    const f = createNativeCiFixture({ baselineSource });
    // Act and Assert
    assert.equal(await readReadonlyCiSource(f.proof.baseSha, f.request), undefined);
});
