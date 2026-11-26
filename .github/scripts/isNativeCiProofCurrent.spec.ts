// #region Imports
import assert from "node:assert/strict";
import { test } from "node:test";
import { createNativeCiFixture } from "./fixtures/createNativeCiFixture.ts";
import { isNativeCiProofCurrent } from "./isNativeCiProofCurrent.ts";
// #endregion

test("rechecks the full own open PR and all three unchanged refs", async () => {
    // Arrange
    const f = createNativeCiFixture();
    // Act and Assert
    assert.equal(await isNativeCiProofCurrent(f.proof, f.request), true);
    assert.deepEqual(f.writes, []);
});

for (const changed of [
    { route: "pulls/42", value: { state: "closed" } },
    { route: "git/ref/heads/dependabot/cargo/test", value: { object: { type: "commit", sha: "f".repeat(40) } } },
    { route: "git/ref/pull/42/merge", value: { object: { type: "commit", sha: "f".repeat(40) } } },
]) test(`rejects a source change at the mutation boundary: ${changed.route}`, async () => {
    // Arrange
    const f = createNativeCiFixture();
    f.values[changed.route] = changed.value;
    // Act and Assert
    assert.equal(await isNativeCiProofCurrent(f.proof, f.request), false);
});
