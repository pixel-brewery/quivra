// #region Imports
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createNativeCiFixture } from "./fixtures/createNativeCiFixture.ts";
import { readNativeCiProof } from "./readNativeCiProof.ts";
// #endregion

test("proves exact M/B/C and a unique real simple-PR association without a merged boolean", async () => {
    // Arrange
    const f = createNativeCiFixture();
    // Act
    const proof = await readNativeCiProof(f.pull, f.request);
    // Assert
    assert.deepEqual(proof, f.proof);
    assert.deepEqual(f.writes, []);
});

for (const changed of [
    { route: "branches/main", value: { name: "main", protected: true, commit: { sha: "f".repeat(40) } } },
    { route: "git/ref/heads/dependabot/cargo/test", value: { object: { type: "commit", sha: "f".repeat(40) } } },
    { route: "git/ref/pull/42/merge", value: { object: { type: "commit", sha: "f".repeat(40) } } },
    { route: `compare/${"a".repeat(40)}...${"b".repeat(40)}`, value: { behind_by: 1, merge_base_commit: { sha: "a".repeat(40) } } },
    { route: `git/commits/${"c".repeat(40)}`, value: { sha: "c".repeat(40), tree: { sha: "f".repeat(40) }, parents: [{ sha: "a".repeat(40) }, { sha: "b".repeat(40) }] } },
] as const) test(`withholds proof after source metadata changes at ${changed.route}`, async () => {
    // Arrange
    const f = createNativeCiFixture();
    f.values[changed.route] = changed.value;
    // Act and Assert
    assert.equal(await readNativeCiProof(f.pull, f.request), undefined);
    assert.deepEqual(f.writes, []);
});

test("rejects ambiguous same-head bot associations", async () => {
    // Arrange
    const f = createNativeCiFixture();
    f.values[`commits/${f.proof.headSha}/pulls?per_page=100`] = [f.pull, { ...f.pull, number: 43 }];
    // Act and Assert
    assert.equal(await readNativeCiProof(f.pull, f.request), undefined);
});

test("allows only the same action owner/path with a new immutable pin", async () => {
    // Arrange
    const baselineSource = readFileSync(new URL("../workflows/ci.yml", import.meta.url), "utf8");
    const allowed = createNativeCiFixture({ baselineSource, proposedSource: baselineSource.replace(/actions\/checkout@[a-f0-9]{40}/u, `actions/checkout@${"d".repeat(40)}`) });
    const denied = createNativeCiFixture({ baselineSource, proposedSource: baselineSource.replace("actions/checkout@", "other/checkout@") });
    // Act and Assert
    assert.deepEqual(await readNativeCiProof(allowed.pull, allowed.request), allowed.proof);
    assert.equal(await readNativeCiProof(denied.pull, denied.request), undefined);
});

test("rejects identical unsafe source on both main and the candidate", async () => {
    // Arrange
    const baselineSource = readFileSync(new URL("../workflows/ci.yml", import.meta.url), "utf8").replace("contents: read", "contents: write");
    const f = createNativeCiFixture({ baselineSource });
    // Act and Assert
    assert.equal(await readNativeCiProof(f.pull, f.request), undefined);
    assert.deepEqual(f.writes, []);
});
