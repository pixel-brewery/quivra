// #region Imports
import assert from "node:assert/strict";
import { test } from "node:test";

import { createNativeCiFixture } from "./fixtures/createNativeCiFixture.ts";
import { mergeDependabotPullRequest } from "./mergeDependabotPullRequest.ts";
// #endregion

type RequestGitHub = Parameters<typeof mergeDependabotPullRequest>[1];

const repoId = 1457527723;
const repoName = "pixel-brewery/quivra";
const repo = { id: repoId, full_name: repoName };
const head = { ref: "dependabot/cargo/test", repo, sha: "b".repeat(40) };
const base = { ref: "main", repo, sha: "a".repeat(40) };
const candidate = "c".repeat(40);
const bot = { id: 49699333, login: "dependabot[bot]", type: "Bot" };
const association = { number: 42, base, head };
const workflow = { id: 8, path: ".github/workflows/ci.yml", name: "CI", state: "active" };
const run = {
    id: 7,
    run_attempt: 2,
    workflow_id: workflow.id,
    path: workflow.path,
    name: workflow.name,
    event: "pull_request",
    status: "completed",
    conclusion: "success",
    repository: repo,
    head_repository: repo,
    actor: bot,
    head_sha: head.sha,
    head_branch: head.ref,
    pull_requests: [association],
};
const event = { action: "completed", repository: repo, workflow_run: run };
const pullRequest = {
    ...association, state: "open", draft: false, merged: false, mergeable: true,
    user: bot, merge_commit_sha: candidate,
};
const jobNames = ["Verify (ubuntu-24.04)", "Verify (macos-15)", "Verify (windows-2025)", "Quality Gate"];
const jobs = {
    total_count: jobNames.length,
    jobs: jobNames.map((name, index) => ({
        id: index + 1, run_id: run.id, run_attempt: run.run_attempt,
        head_sha: head.sha, name, status: "completed", conclusion: "success",
    })),
};
const rule = {
    type: "required_status_checks",
    ruleset_source_type: "Repository",
    ruleset_source: repoName,
    ruleset_id: 11,
    parameters: {
        strict_required_status_checks_policy: true,
        required_status_checks: [{ context: "Quality Gate", integration_id: 15368 }],
    },
};
const rulesPath = "rules/branches/main?per_page=100";
const main = { name: "main", protected: true, commit: { sha: base.sha } };
const data: Record<string, unknown> = {
    ...createNativeCiFixture().values,
    [`repositories/${repoId}`]: {
        ...repo, default_branch: "main", private: false, visibility: "public", fork: false, allow_squash_merge: true,
    },
    "actions/workflows/ci.yml": workflow,
    "actions/runs/7": run,
    "actions/runs/7/attempts/2/jobs?per_page=100": jobs,
    [`actions/workflows/ci.yml/runs?head_sha=${head.sha}&per_page=100`]: { total_count: 1, workflow_runs: [run] },
    [`compare/${base.sha}...${head.sha}`]: { behind_by: 0, merge_base_commit: { sha: base.sha } },
    "pulls/42": pullRequest,
    [rulesPath]: [rule],
    [`git/commits/${candidate}`]: { sha: candidate, tree: { sha: "e".repeat(40) }, parents: [{ sha: base.sha }, { sha: head.sha }] },
    "branches/main": main,
};

function mock(overrides: Record<string, () => unknown> = {}) {
    const writes: { endpoint: string; body: object | undefined }[] = [];
    let merged = false;
    const request: RequestGitHub = async (method, endpoint, body) => {
        if (method === "PUT") {
            writes.push({ endpoint, body });
            merged = true;
            return { merged: true, sha: "d".repeat(40) };
        }
        const key = endpoint.replace(`repos/${repoName}/`, "");
        if (key === "pulls/42" && merged) return { ...pullRequest, state: "closed", merged: true, merge_commit_sha: "d".repeat(40) };
        assert.ok(Object.hasOwn(data, key), `Unexpected GitHub API request ${endpoint}`);
        return Object.hasOwn(overrides, key) ? overrides[key]?.() : data[key];
    };
    return { request, writes };
}

test("merges the verified head with the protection visible to a read-only caller", async () => {
    // Arrange
    const { request, writes } = mock();
    // Act
    const result = await mergeDependabotPullRequest(event, request);
    // Assert
    assert.deepEqual(result, {
        status: "merged",
        pullRequest: association.number,
        sha: "d".repeat(40),
    });
    assert.deepEqual(writes, [{
        endpoint: `repos/${repoName}/pulls/42/merge`,
        body: { sha: head.sha, merge_method: "squash" },
    }]);
});

test("skips when protection is unavailable or the gate belongs to another app", async () => {
    for (const [loadRules, reason] of [
        [() => { throw Object.assign(new Error("Forbidden"), { status: 403 }); }, "main-protection-unavailable"],
        [() => [{
            ...rule, parameters: {
                ...rule.parameters, required_status_checks: [{ context: "Quality Gate", integration_id: 0 }],
            },
        }], "missing-strict-quality-gate"],
    ] as const) {
        // Arrange
        const { request, writes } = mock({ [rulesPath]: loadRules });
        // Act
        const result = await mergeDependabotPullRequest(event, request);
        // Assert
        assert.deepEqual(result, { status: "skipped", reason });
        assert.deepEqual(writes, []);
    }
});

test("skips a merge if main has changed before the write", async () => {
    // Arrange
    let reads = 0;
    const { request, writes } = mock({ "branches/main": () => ++reads === 1 ? main : ({ ...main, commit: { sha: "f".repeat(40) } }) });
    // Act
    const result = await mergeDependabotPullRequest(event, request);
    // Assert
    assert.deepEqual(result, { status: "skipped", reason: "verification-changed" });
    assert.deepEqual(writes, []);
});

test("a newer diagnostic dispatch cannot shadow successful native PR proof", async () => {
    // Arrange
    const diagnostic = { ...run, id: 9, event: "workflow_dispatch", actor: { id: 41898282, login: "github-actions[bot]", type: "Bot" } };
    const { request, writes } = mock({ [`actions/workflows/ci.yml/runs?head_sha=${head.sha}&per_page=100`]: () => ({ total_count: 2, workflow_runs: [run, diagnostic] }) });
    // Act
    const result = await mergeDependabotPullRequest(event, request);
    // Assert
    assert.equal(result.status, "merged");
    assert.equal(writes.length, 1);
});

const actions = { id: 41898282, login: "github-actions[bot]", type: "Bot" };
const inventoryPath = `actions/workflows/ci.yml/runs?head_sha=${head.sha}&per_page=100`;

function dispatchProof(overrides: Record<string, () => unknown> = {}) {
    const dispatched = { ...run, event: "workflow_dispatch", actor: actions, pull_requests: [] };
    return { dispatched, ...mock({
        "actions/runs/7": () => dispatched,
        [inventoryPath]: () => ({ total_count: 1, workflow_runs: [dispatched] }),
        ...overrides,
    }) };
}

test("diagnostic head dispatch cannot substitute for native branch-rule proof", async () => {
    // Arrange
    const { dispatched, request, writes } = dispatchProof();
    // Act
    const result = await mergeDependabotPullRequest({ ...event, workflow_run: dispatched }, request);
    // Assert
    assert.deepEqual(result, { status: "skipped", reason: "ineligible-workflow-run" });
    assert.deepEqual(writes, []);
});

test("an approval-only PR attempt cannot upgrade diagnostic dispatch into native proof", async () => {
    // Arrange
    const dispatched = { ...run, event: "workflow_dispatch", actor: actions, pull_requests: [] };
    const { request, writes } = dispatchProof({ [inventoryPath]: () => ({ total_count: 2, workflow_runs: [dispatched, { ...run, id: 9, conclusion: "action_required" }] }) });
    // Act
    const result = await mergeDependabotPullRequest({ ...event, workflow_run: dispatched }, request);
    // Assert
    assert.deepEqual(result, { status: "skipped", reason: "ineligible-workflow-run" });
    assert.deepEqual(writes, []);
});

for (const [name, changed] of [
    ["untrusted actor identifier", { actor: { ...bot, id: 1 } }],
    ["invalid human CI identity", { actor: { id: 0, login: "maintainer", type: "User" } }],
    ["fork source", { head_repository: { ...repo, id: 1 } }],
    ["different workflow", { workflow_id: 99 }],
    ["changed run attempt", { run_attempt: 3 }],
] as const) test(`rejects ${name} without a merge write`, async () => {
    // Arrange
    const altered = { ...run, ...changed };
    const { request, writes } = mock({ "actions/runs/7": () => altered });
    // Act
    const result = await mergeDependabotPullRequest(event, request);
    // Assert
    assert.equal(result.status, "skipped");
    assert.deepEqual(writes, []);
});

for (const actor of [{ id: 1, login: "maintainer", type: "User" }, actions]) test(`merges actual native CI from ${actor.login} only after the full unchanged proof`, async () => {
    // Arrange
    const native = { ...run, actor };
    const { request, writes } = mock({ "actions/runs/7": () => native, [inventoryPath]: () => ({ total_count: 1, workflow_runs: [native] }) });
    // Act
    const result = await mergeDependabotPullRequest({ ...event, workflow_run: native }, request);
    // Assert
    assert.equal(result.status, "merged");
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0]?.body, { sha: head.sha, merge_method: "squash" });
});

test("rejects ambiguous native associations including two same-head pull requests", async () => {
    // Arrange
    const { request, writes } = mock({ "actions/runs/7": () => ({ ...run, pull_requests: [association, { ...association, number: 43 }] }) });
    // Act
    const result = await mergeDependabotPullRequest(event, request);
    // Assert
    assert.equal(result.status, "skipped");
    assert.deepEqual(writes, []);
});

for (const conclusion of ["failure", "action_required", null]) test(`a later ordinary CI attempt with ${conclusion} withholds the merge`, async () => {
    // Arrange
    const { request, writes } = mock({ [inventoryPath]: () => ({ total_count: 2, workflow_runs: [run, { ...run, id: 9, conclusion, status: conclusion === null ? "in_progress" : "completed" }] }) });
    // Act
    const result = await mergeDependabotPullRequest(event, request);
    // Assert
    assert.deepEqual(result, { status: "skipped", reason: "superseded-verification" });
    assert.deepEqual(writes, []);
});

test("requires the verified head itself to contain current main for native PR proof", async () => {
    // Arrange
    const { request, writes } = mock({ [`compare/${base.sha}...${head.sha}`]: () => ({ behind_by: 1, merge_base_commit: { sha: "f".repeat(40) } }) });
    // Act
    const result = await mergeDependabotPullRequest(event, request);
    // Assert
    assert.deepEqual(result, { status: "skipped", reason: "stale-head" });
    assert.deepEqual(writes, []);
});

test("a newer failed run discovered after proof prevents the final merge", async () => {
    // Arrange
    let reads = 0;
    const { request, writes } = mock({ [inventoryPath]: () => ({ total_count: 1, workflow_runs: [++reads === 1 ? run : { ...run, id: 9, conclusion: "failure" }] }) });
    // Act
    const result = await mergeDependabotPullRequest(event, request);
    // Assert
    assert.deepEqual(result, { status: "skipped", reason: "verification-changed" });
    assert.deepEqual(writes, []);
});

test("preserves exact platform, job-attempt and synthetic-parent proof", async () => {
    for (const overrides of [
        { "actions/runs/7/attempts/2/jobs?per_page=100": () => ({ ...jobs, jobs: jobs.jobs.slice(1) }) },
        { "actions/runs/7/attempts/2/jobs?per_page=100": () => ({ ...jobs, jobs: jobs.jobs.map((job) => ({ ...job, run_attempt: 3 })) }) },
        { [`git/commits/${candidate}`]: () => ({ sha: candidate, parents: [{ sha: head.sha }, { sha: base.sha }] }) },
    ]) {
        // Arrange
        const { request, writes } = mock(overrides);
        // Act
        const result = await mergeDependabotPullRequest(event, request);
        // Assert
        assert.equal(result.status, "skipped");
        assert.deepEqual(writes, []);
    }
});
