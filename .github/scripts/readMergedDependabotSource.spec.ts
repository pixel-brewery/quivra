// #region Imports
import assert from "node:assert/strict";
import { test } from "node:test";
import { createNativeCiFixture } from "./fixtures/createNativeCiFixture.ts";
import { readMergedDependabotSource } from "./readMergedDependabotSource.ts";
// #endregion

function fixture() {
    const f = createNativeCiFixture();
    const closed = { ...f.pull, state: "closed", merged: true, merged_at: "2026-11-26T11:00:00Z", merge_commit_sha: f.proof.baseSha };
    const { merged: omitted, ...simple } = closed;
    void omitted;
    f.values[`commits/${f.proof.baseSha}/pulls?per_page=100`] = [simple];
    f.values["pulls/42"] = closed;
    return { ...f, closed, simple };
}

test("recovers current main using simple association followed by a full merged confirmation", async () => {
    // Arrange
    const f = fixture();
    // Act
    const source = await readMergedDependabotSource(f.request);
    // Assert
    assert.equal(source, f.proof.baseSha);
    assert.equal(f.reads.get("pulls/42"), 1);
    assert.deepEqual(f.writes, []);
});

for (const reason of ["ambiguous", "not-merged", "other-source", "other-author", "simple-only"]) test(`does not recover an unconfirmed merge: ${reason}`, async () => {
    // Arrange
    const f = fixture();
    if (reason === "ambiguous") f.values[`commits/${f.proof.baseSha}/pulls?per_page=100`] = [f.simple, { ...f.simple, number: 43 }];
    if (reason === "not-merged") f.values["pulls/42"] = { ...f.closed, merged: false };
    if (reason === "other-source") f.values["pulls/42"] = { ...f.closed, merge_commit_sha: "f".repeat(40) };
    if (reason === "other-author") f.values["pulls/42"] = { ...f.closed, user: { id: 1, login: "maintainer", type: "User" } };
    if (reason === "simple-only") f.values["pulls/42"] = f.simple;
    // Act and Assert
    assert.equal(await readMergedDependabotSource(f.request), undefined);
    assert.deepEqual(f.writes, []);
});

test("a later main cannot reuse the recovered merge output", async () => {
    // Arrange
    const f = fixture();
    let reads = 0;
    // Act
    const source = await readMergedDependabotSource(async (method, endpoint, body) => endpoint.endsWith("branches/main") && ++reads === 2
        ? { name: "main", protected: true, commit: { sha: "f".repeat(40) } } : f.request(method, endpoint, body));
    // Assert
    assert.equal(source, undefined);
});
