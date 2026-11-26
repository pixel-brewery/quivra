// #region Imports
import assert from "node:assert/strict";
import { test } from "node:test";
import { createNativeCiFixture } from "./fixtures/createNativeCiFixture.ts";
import type { IRequestGitHub } from "./interfaces/IRequestGitHub.ts";
import { runDependabotAutomation } from "./runDependabotAutomation.ts";
// #endregion

const source = "a".repeat(40);
const repository = { id: 1457527723, full_name: "pixel-brewery/quivra" };

for (const event of ["schedule", "workflow_dispatch", "workflow_run"]) test(`continues a reconciled source from trusted ${event} context`, async () => {
    // Arrange
    const original = process.env;
    process.env = { GITHUB_REPOSITORY: repository.full_name, GITHUB_REPOSITORY_ID: String(repository.id),
        QUIVRA_DEPENDABOT_AUTO_MERGE: "true", GH_TOKEN: "synthetic-test-token", GITHUB_EVENT_PATH: "unused-continuation-event",
        GITHUB_EVENT_NAME: event, SOURCE_SHA: source };
    const reads: string[] = [];
    const request: IRequestGitHub = async (method, endpoint) => {
        assert.equal(method, "GET");
        reads.push(endpoint);
        if (endpoint.startsWith("repositories/")) return { ...repository, default_branch: "main", private: false, visibility: "public", fork: false };
        if (endpoint.includes("rules/branches/")) return [{ type: "required_status_checks", ruleset_source_type: "Repository", ruleset_source: repository.full_name, ruleset_id: 1,
            parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: "Quality Gate", integration_id: 15368 }] } }];
        if (endpoint.includes(`/commits/${source}?`)) return { sha: source, files: [{ filename: "Cargo.lock" }] };
        if (endpoint.endsWith("branches/main")) return { name: "main", protected: true, commit: { sha: "b".repeat(40) } };
        throw new Error("Unexpected continuation request.");
    };
    try {
        // Act
        const result = await runDependabotAutomation("continue", request);
        // Assert
        assert.deepEqual(result, { status: "superseded", sourceSha: source, requested: [], existing: [] });
        assert(reads.some((endpoint) => endpoint.includes(`/commits/${source}?`)));
    } finally { process.env = original; }
});

test("rejects continuation from an untrusted PR event before any API request", async () => {
    // Arrange
    const original = process.env;
    process.env = { GITHUB_REPOSITORY: repository.full_name, GITHUB_REPOSITORY_ID: String(repository.id),
        QUIVRA_DEPENDABOT_AUTO_MERGE: "true", GH_TOKEN: "synthetic-test-token", GITHUB_EVENT_PATH: "unused-pr-event",
        GITHUB_EVENT_NAME: "pull_request", SOURCE_SHA: source };
    let requests = 0;
    try {
        // Act and Assert
        await assert.rejects(runDependabotAutomation("continue", async () => { requests++; return undefined; }), /completed CI workflow event/u);
        assert.equal(requests, 0);
    } finally { process.env = original; }
});

test("authorizes native CI only from the trusted default-branch controller", async () => {
    // Arrange
    const original = process.env;
    const f = createNativeCiFixture();
    process.env = { GITHUB_REPOSITORY: repository.full_name, GITHUB_REPOSITORY_ID: String(repository.id), GITHUB_REF: "refs/heads/main",
        QUIVRA_DEPENDABOT_AUTO_MERGE: "true", GH_TOKEN: "synthetic-test-token", GITHUB_EVENT_PATH: "unused-trusted-event", GITHUB_EVENT_NAME: "schedule" };
    try {
        // Act
        const result = await runDependabotAutomation("authorize", f.request);
        // Assert
        assert.deepEqual(result, { status: "authorized", results: [{ number: 42, status: "approved", runId: 7, attempt: 1 }] });
        assert.equal(f.writes.length, 1);
    } finally { process.env = original; }
});

test("rejects native approval from a non-main ref before any API request", async () => {
    // Arrange
    const original = process.env;
    const f = createNativeCiFixture();
    process.env = { GITHUB_REPOSITORY: repository.full_name, GITHUB_REPOSITORY_ID: String(repository.id), GITHUB_REF: "refs/heads/dependabot/test",
        QUIVRA_DEPENDABOT_AUTO_MERGE: "true", GH_TOKEN: "synthetic-test-token", GITHUB_EVENT_PATH: "unused-trusted-event", GITHUB_EVENT_NAME: "workflow_dispatch" };
    try {
        // Act and Assert
        await assert.rejects(runDependabotAutomation("authorize", f.request), /default-branch workflow/u);
        assert.equal(f.reads.size, 0);
        assert.deepEqual(f.writes, []);
    } finally { process.env = original; }
});
