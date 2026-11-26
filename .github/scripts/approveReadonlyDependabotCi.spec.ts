// #region Imports
import assert from "node:assert/strict";
import { test } from "node:test";
import { approveReadonlyDependabotCi } from "./approveReadonlyDependabotCi.ts";
import { createNativeCiFixture } from "./fixtures/createNativeCiFixture.ts";
import type { IRequestGitHub } from "./interfaces/IRequestGitHub.ts";
// #endregion

test("approves the original proved native run exactly once without merge or status writes", async () => {
    // Arrange
    const f = createNativeCiFixture();
    // Act
    const results = await approveReadonlyDependabotCi(f.request);
    // Assert
    assert.deepEqual(results, [{ number: 42, status: "approved", runId: 7, attempt: 1 }]);
    assert.deepEqual(f.writes, [{ method: "POST", endpoint: "repos/pixel-brewery/quivra/actions/runs/7/approve", body: undefined }]);
    assert.equal(f.reads.get("actions/runs/7"), 2);
});

test("fresh current-attempt metadata wins over a stale list and newer diagnostic run", async () => {
    // Arrange
    const f = createNativeCiFixture();
    f.values[`actions/workflows/ci.yml/runs?head_sha=${f.proof.headSha}&per_page=100`] = { total_count: 2, workflow_runs: [f.run, { ...f.run, id: 9, event: "workflow_dispatch" }] };
    f.values["actions/runs/7"] = { ...f.run, run_attempt: 2 };
    // Act
    const result = await approveReadonlyDependabotCi(f.request);
    // Assert
    assert.equal(result[0]?.attempt, 2);
    assert.equal(result[0]?.runId, 7);
    assert.equal(f.writes.length, 1);
});

for (const changed of [
    { status: "queued", conclusion: null },
    { status: "in_progress", conclusion: null },
    { conclusion: "success" },
    { conclusion: "failure" },
    { conclusion: "cancelled" },
    { conclusion: "skipped" },
    { event: "workflow_dispatch" },
    { workflow_id: 99 },
    { head_sha: "f".repeat(40) },
    { run_attempt: 0 },
    { pull_requests: [] },
]) test(`never approves an inapplicable native attempt ${JSON.stringify(changed)}`, async () => {
    // Arrange
    const f = createNativeCiFixture();
    f.values["actions/runs/7"] = { ...f.run, ...changed };
    // Act
    await approveReadonlyDependabotCi(f.request);
    // Assert
    assert.deepEqual(f.writes, []);
});

for (const changed of [
    { actor: { id: 1, login: "maintainer", type: "User" } },
    { triggering_actor: { id: 1, login: "maintainer", type: "User" } },
    { actor: { id: 1, login: "github-actions[bot]", type: "Bot" } },
    { triggering_actor: undefined },
]) test(`requires immutable service identities for approval ${JSON.stringify(changed)}`, async () => {
    // Arrange
    const f = createNativeCiFixture();
    f.values["actions/runs/7"] = { ...f.run, ...changed };
    // Act
    const results = await approveReadonlyDependabotCi(f.request);
    // Assert
    assert.equal(results[0]?.status, "skipped");
    assert.deepEqual(f.writes, []);
});

for (const route of ["branches/main", "git/ref/heads/dependabot/cargo/test", "git/ref/pull/42/merge"]) test(`a live ref changing immediately before approval withholds the POST: ${route}`, async () => {
    // Arrange
    const overrides: Record<string, (read: number) => unknown> = {};
    const f = createNativeCiFixture({ overrides });
    overrides[route] = (read) => read < 3 ? f.values[route] : route === "branches/main"
        ? { name: "main", protected: true, commit: { sha: "f".repeat(40) } }
        : { object: { type: "commit", sha: "f".repeat(40) } };
    // Act
    await approveReadonlyDependabotCi(f.request);
    // Assert
    assert.deepEqual(f.writes, []);
});

test("a changed latest attempt after the initial proof cannot receive approval", async () => {
    // Arrange
    const overrides: Record<string, (read: number) => unknown> = {};
    const f = createNativeCiFixture({ overrides });
    overrides["actions/runs/7"] = (read) => read === 1 ? f.run : { ...f.run, run_attempt: 2, status: "queued", conclusion: null };
    // Act
    const results = await approveReadonlyDependabotCi(f.request);
    // Assert
    assert.equal(results[0]?.reason, "native-attempt-changed");
    assert.deepEqual(f.writes, []);
});

test("a failed approval request is reported once without an automatic POST retry", async () => {
    // Arrange
    const f = createNativeCiFixture();
    const request: IRequestGitHub = async (method, endpoint, body) => {
        const response = await f.request(method, endpoint, body);
        if (method === "POST") throw new Error("GitHub approval HTTP 409.");
        return response;
    };
    // Act
    const results = await approveReadonlyDependabotCi(request);
    // Assert
    assert.equal(results[0]?.status, "blocked");
    assert.equal(f.writes.length, 1);
});

test("a missing effective protected gate prevents all authorization", async () => {
    // Arrange
    const f = createNativeCiFixture();
    f.values["rules/branches/main?per_page=100"] = [];
    // Act and Assert
    await assert.rejects(approveReadonlyDependabotCi(f.request), /missing-strict-quality-gate/u);
    assert.deepEqual(f.writes, []);
});
