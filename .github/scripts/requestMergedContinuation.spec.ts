// #region Imports
import assert from "node:assert/strict";
import { test } from "node:test";
import type { IRequestGitHub } from "./interfaces/IRequestGitHub.ts";
import { requestMergedContinuation } from "./requestMergedContinuation.ts";
// #endregion

const repo = { id: 1457527723, full_name: "pixel-brewery/quivra" };
const sha = "d".repeat(40);

function fixture(options: { existing?: boolean; superseded?: boolean; changed?: boolean; malformed?: boolean; malformedRun?: boolean; pages?: boolean; malformedFiles?: boolean } = {}) {
    const writes: { endpoint: string; body: object | undefined }[] = [];
    let mainReads = 0;
    const request: IRequestGitHub = async (method, endpoint, body) => {
        const route = endpoint.replace("repos/pixel-brewery/quivra/", "");
        if (method === "POST") { writes.push({ endpoint, body }); return undefined; }
        if (endpoint.startsWith("repositories/")) return { ...repo, default_branch: "main", private: false, visibility: "public", fork: false };
        if (route.startsWith("rules/branches/")) return [{ type: "required_status_checks", ruleset_source_type: "Repository", ruleset_source: repo.full_name, ruleset_id: 1,
            parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: "Quality Gate", integration_id: 15368 }] } }];
        if (route === "branches/main") { mainReads++; return { name: "main", protected: true, commit: { sha: options.superseded || (options.changed && mainReads > 1) ? "e".repeat(40) : sha } }; }
        if (route.startsWith("commits/")) return { sha, files: options.malformedFiles ? [{ filename: 42 }] : [{ filename: options.pages ? ".github/workflows/publish-pages.yml" : "Cargo.lock" }] };
        const file = route.includes("publish-pages.yml") ? "publish-pages.yml" : route.includes("release.yml") ? "release.yml" : "ci.yml";
        const workflow = { id: file === "ci.yml" ? 8 : file === "release.yml" ? 9 : 10, path: `.github/workflows/${file}`, name: file === "ci.yml" ? "CI" : file === "release.yml" ? "Release Quivra" : "Publish GitHub Pages", state: "active" };
        if (route.includes("/runs?")) {
            if (options.malformed) return { total_count: 2, workflow_runs: [] };
            const runs = options.existing ? [{ id: options.malformedRun ? 0 : 80, run_attempt: options.malformedRun ? 0 : 1, workflow_id: workflow.id, path: workflow.path, head_sha: sha, head_branch: "main", event: "workflow_dispatch", repository: repo, head_repository: repo, status: "completed", conclusion: "failure" }] : [];
            return { total_count: runs.length, workflow_runs: runs };
        }
        if (route.startsWith("actions/workflows/")) return workflow;
        throw new Error("Unexpected route " + route);
    };
    return { request, writes };
}

test("requests main verification and the existing release with their exact source inputs", async () => {
    // Arrange
    const f = fixture();
    // Act
    const result = await requestMergedContinuation(sha, f.request);
    // Assert
    assert.deepEqual(result.requested, ["ci.yml", "release.yml"]);
    assert.deepEqual(f.writes.map((write) => write.body), [
        { ref: "main", inputs: { expected_head_sha: sha } }, { ref: "main", inputs: { source_sha: sha } },
    ]);
});

test("retains original failed attempts rather than issuing duplicate publication requests", async () => {
    // Arrange
    const f = fixture({ existing: true });
    // Act
    const result = await requestMergedContinuation(sha, f.request);
    // Assert
    assert.deepEqual(result.existing, ["ci.yml", "release.yml"]);
    assert.deepEqual(f.writes, []);
});

for (const options of [{ superseded: true }, { changed: true }]) test(`does not dispatch a superseded source ${JSON.stringify(options)}`, async () => {
    // Arrange
    const f = fixture(options);
    // Act
    const result = await requestMergedContinuation(sha, f.request);
    // Assert
    assert.equal(result.status, "superseded");
    assert.deepEqual(f.writes, []);
});

test("fails closed for an incomplete continuation inventory", async () => {
    // Arrange
    const f = fixture({ malformed: true });
    // Act and Assert
    await assert.rejects(requestMergedContinuation(sha, f.request), /Invalid continuation inventory/u);
    assert.deepEqual(f.writes, []);
});

test("malformed run identifiers cannot suppress a genuine continuation request", async () => {
    // Arrange
    const f = fixture({ existing: true, malformedRun: true });
    // Act and Assert
    await assert.rejects(requestMergedContinuation(sha, f.request), /Unexpected continuation run identity/u);
    assert.deepEqual(f.writes, []);
});

test("continues the existing Pages workflow only when its original push paths changed", async () => {
    // Arrange
    const f = fixture({ pages: true });
    // Act
    const result = await requestMergedContinuation(sha, f.request);
    // Assert
    assert.deepEqual(result.requested, ["ci.yml", "release.yml", "publish-pages.yml"]);
    assert.deepEqual(f.writes[2]?.body, { ref: "main", inputs: { expected_head_sha: sha } });
});

test("retains a genuine existing Pages attempt instead of redeploying the same source", async () => {
    // Arrange
    const f = fixture({ pages: true, existing: true });
    // Act
    const result = await requestMergedContinuation(sha, f.request);
    // Assert
    assert.deepEqual(result.existing, ["ci.yml", "release.yml", "publish-pages.yml"]);
    assert.deepEqual(f.writes, []);
});

test("rejects malformed changed-file metadata before any continuation dispatch", async () => {
    // Arrange
    const f = fixture({ malformedFiles: true });
    // Act and Assert
    await assert.rejects(requestMergedContinuation(sha, f.request), /Invalid complete continuation source-file inventory/u);
    assert.deepEqual(f.writes, []);
});
