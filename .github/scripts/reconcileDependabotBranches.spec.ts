// #region Imports
import assert from "node:assert/strict";
import { test } from "node:test";
import type { IRequestGitHub } from "./interfaces/IRequestGitHub.ts";
import { reconcileDependabotBranches } from "./reconcileDependabotBranches.ts";
// #endregion

const repo = { id: 1457527723, full_name: "pixel-brewery/quivra" };
const mainSha = "a".repeat(40);
const oldHead = "b".repeat(40);
const freshHead = "c".repeat(40);
const bot = { id: 49699333, login: "dependabot[bot]", type: "Bot" };
const actions = { id: 41898282, login: "github-actions[bot]", type: "Bot" };

function fixture(options: { stale?: boolean; runs?: readonly object[]; foreign?: boolean; conflicted?: boolean; changed?: boolean } = {}) {
    let refreshed = false;
    let reads = 0;
    const branch = "dependabot/cargo/major-update";
    const writes: { method: string; endpoint: string; body: object | undefined }[] = [];
    const request: IRequestGitHub = async (method, endpoint, body) => {
        const route = endpoint.replace("repos/pixel-brewery/quivra/", "");
        if (method !== "GET") {
            writes.push({ method, endpoint, body });
            if (method === "PUT") { assert.deepEqual(body, { expected_head_sha: oldHead }); refreshed = true; }
            return undefined;
        }
        if (endpoint.startsWith("repositories/")) return { ...repo, default_branch: "main", private: false, visibility: "public", fork: false, allow_squash_merge: true };
        if (route.startsWith("rules/branches/")) return [{ type: "required_status_checks", ruleset_source_type: "Repository", ruleset_source: repo.full_name, ruleset_id: 1,
            parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: "Quality Gate", integration_id: 15368 }] } }];
        if (route === "actions/workflows/ci.yml") return { id: 8, path: ".github/workflows/ci.yml", name: "CI", state: "active" };
        if (route.startsWith("pulls?")) return [...(options.conflicted ? [{ number: 41, user: bot }] : []), { number: 42, user: bot }];
        if (route === "pulls/41") throw Object.assign(new Error("GitHub update conflict HTTP 422."), { status: 422 });
        if (route === "pulls/42") {
            reads++;
            return { number: 42, state: "open", draft: false, merged: false, user: bot,
                head: { ref: branch, repo: options.foreign ? { ...repo, id: 1 } : repo, sha: options.changed && reads > 1 ? "e".repeat(40) : refreshed ? freshHead : oldHead },
                base: { ref: "main", repo, sha: mainSha } };
        }
        if (route === "branches/main") return { name: "main", protected: true, commit: { sha: mainSha } };
        if (route.startsWith("compare/")) return { behind_by: options.stale && !refreshed ? 1 : 0, merge_base_commit: { sha: mainSha } };
        if (route.startsWith("actions/workflows/ci.yml/runs?")) {
            const sha = refreshed ? freshHead : oldHead;
            const runs = (options.runs ?? []).map((run) => ({ id: 7, run_attempt: 1, workflow_id: 8, name: "CI", path: ".github/workflows/ci.yml", head_sha: sha, head_branch: branch, repository: repo, head_repository: repo, ...run }));
            return { total_count: runs.length, workflow_runs: runs };
        }
        throw new Error("Unexpected route " + route);
    };
    return { request, writes };
}

test("refreshes a stale Cargo major branch with an expected-head guard and exact full-CI dispatch", async () => {
    // Arrange
    const f = fixture({ stale: true });
    // Act
    const result = await reconcileDependabotBranches(f.request, async () => {});
    // Assert
    assert.deepEqual(result, [{ number: 42, status: "verification-requested", head: freshHead }]);
    assert.deepEqual(f.writes.map((write) => write.method), ["PUT", "POST"]);
    assert.deepEqual(f.writes[1]?.body, { ref: "dependabot/cargo/major-update", inputs: { expected_head_sha: freshHead } });
});

test("an unchanged approval-pending token-authored PR still receives explicit CI", async () => {
    // Arrange
    const f = fixture({ runs: [{ event: "pull_request", actor: actions, status: "completed", conclusion: "action_required" }] });
    // Act
    await reconcileDependabotBranches(f.request);
    // Assert
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0]?.method, "POST");
});

for (const run of [
    { event: "workflow_dispatch", actor: actions, status: "completed", conclusion: "failure" },
    { event: "pull_request", actor: bot, status: "in_progress", conclusion: null },
]) test(`retains an existing ${run.event} attempt without duplicate dispatch`, async () => {
    // Arrange
    const f = fixture({ runs: [run] });
    // Act
    const result = await reconcileDependabotBranches(f.request);
    // Assert
    assert.equal(result[0]?.status, "waiting");
    assert.deepEqual(f.writes, []);
});

test("one conflicted PR cannot starve a healthy branch", async () => {
    // Arrange
    const f = fixture({ conflicted: true });
    // Act
    const result = await reconcileDependabotBranches(f.request);
    // Assert
    assert.equal(result[0]?.status, "blocked");
    assert.equal(result[1]?.status, "verification-requested");
    assert.equal(f.writes.length, 1);
});

for (const options of [{ foreign: true }, { changed: true }]) test(`withholds mutations for an ineligible or changed candidate ${JSON.stringify(options)}`, async () => {
    // Arrange
    const f = fixture(options);
    // Act
    const result = await reconcileDependabotBranches(f.request);
    // Assert
    assert.equal(result[0]?.status, "skipped");
    assert.deepEqual(f.writes, []);
});
