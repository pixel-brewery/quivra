// #region Imports
import assert from "node:assert/strict";
import { test } from "node:test";
import { createNativeCiFixture } from "./fixtures/createNativeCiFixture.ts";
import { readLatestDependabotRun } from "./readLatestDependabotRun.ts";
// #endregion

for (const changed of [
    { number: 43 },
    { base: { ref: "release", sha: "a".repeat(40), repo: { id: 1457527723 } } },
    { base: { ref: "main", sha: "f".repeat(40), repo: { id: 1457527723 } } },
    { base: { ref: "main", sha: "a".repeat(40), repo: { id: 1 } } },
]) test(`filters unrelated native associations before selecting the newest ID: ${JSON.stringify(changed)}`, () => {
    // Arrange
    const f = createNativeCiFixture();
    const newer = { ...f.run, id: 9, pull_requests: [{ ...f.run.pull_requests[0], ...changed }] };
    // Act
    const selected = readLatestDependabotRun({ total_count: 2, workflow_runs: [f.run, newer] }, f.workflow.id, f.proof);
    // Assert
    assert.equal(selected?.["id"], 7);
});

test("a newer eligible failed native run still blocks the older successful identity", () => {
    // Arrange
    const f = createNativeCiFixture();
    const newer = { ...f.run, id: 9, conclusion: "failure" };
    // Act
    const selected = readLatestDependabotRun({ total_count: 2, workflow_runs: [{ ...f.run, conclusion: "success" }, newer] }, f.workflow.id, f.proof);
    // Assert
    assert.equal(selected?.["id"], 9);
    assert.equal(selected?.["conclusion"], "failure");
});

test("only the diagnostic deduplication mode can select a head-only dispatch", () => {
    // Arrange
    const f = createNativeCiFixture();
    const diagnostic = { ...f.run, id: 9, event: "workflow_dispatch", pull_requests: [] };
    const inventory = { total_count: 2, workflow_runs: [f.run, diagnostic] };
    // Act and Assert
    assert.equal(readLatestDependabotRun(inventory, f.workflow.id, f.proof)?.["id"], 7);
    assert.equal(readLatestDependabotRun(inventory, f.workflow.id, f.proof, true)?.["id"], 9);
});
