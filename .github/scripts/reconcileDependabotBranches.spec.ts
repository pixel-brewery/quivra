// #region Imports
import assert from "node:assert/strict";
import { test } from "node:test";
import { createNativeCiFixture } from "./fixtures/createNativeCiFixture.ts";
import type { IRequestGitHub } from "./interfaces/IRequestGitHub.ts";
import { mergeDependabotPullRequest } from "./mergeDependabotPullRequest.ts";
import { reconcileDependabotBranches } from "./reconcileDependabotBranches.ts";
// #endregion

const repo = { id: 1457527723, full_name: "pixel-brewery/quivra" };
const mainSha = "a".repeat(40);
const oldHead = "b".repeat(40);
const freshHead = "c".repeat(40);
const mergeSha = "d".repeat(40);
const confirmedSha = "f".repeat(40);
const bot = { id: 49699333, login: "dependabot[bot]", type: "Bot" };
const actions = { id: 41898282, login: "github-actions[bot]", type: "Bot" };

function fixture(options: { stale?: boolean; runs?: readonly object[]; currentRun?: Record<string, unknown>; foreign?: boolean; conflicted?: boolean; changed?: boolean; transientUnknown?: boolean; failedJob?: boolean; wrongMergeParent?: boolean; unsafeSource?: boolean } = {}) {
    let refreshed = false;
    let merged = false;
    let reads = 0;
    const branch = "dependabot/cargo/major-update";
    const sourceData = createNativeCiFixture(options.unsafeSource ? { baselineSource: "name: CI\npermissions:\n  contents: write\njobs:\n  verify:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: true\n" } : {}).values;
    const sourceBlob = sourceData[`contents/.github/workflows/ci.yml?ref=${mainSha}`];
    const writes: { method: string; endpoint: string; body: object | undefined }[] = [];
    const nativeRun = () => ({ id: 7, run_attempt: 1, workflow_id: 8, name: "CI", path: ".github/workflows/ci.yml",
        head_sha: refreshed ? freshHead : oldHead, head_branch: branch, repository: repo, head_repository: repo,
        event: "pull_request", actor: bot, status: "completed", conclusion: "success",
        pull_requests: [{ number: 42, head: { ref: branch, sha: refreshed ? freshHead : oldHead, repo }, base: { ref: "main", sha: mainSha, repo } }],
    });
    const request: IRequestGitHub = async (method, endpoint, body) => {
        const route = endpoint.replace("repos/pixel-brewery/quivra/", "");
        if (method !== "GET") {
            writes.push({ method, endpoint, body });
            if (method === "PUT" && route === "pulls/42/merge") {
                assert.deepEqual(body, { sha: oldHead, merge_method: "squash" });
                merged = true;
                return { merged: true, sha: confirmedSha };
            }
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
            return { number: 42, state: merged ? "closed" : "open", draft: false, merged, user: bot,
                mergeable: options.transientUnknown && reads === 1 ? null : true,
                merge_commit_sha: merged ? confirmedSha : mergeSha,
                head: { ref: branch, repo: options.foreign ? { ...repo, id: 1 } : repo, sha: options.changed && reads > 1 ? "e".repeat(40) : refreshed ? freshHead : oldHead },
                base: { ref: "main", repo, sha: mainSha } };
        }
        if (route === "branches/main") return { name: "main", protected: true, commit: { sha: mainSha } };
        if (/^actions\/runs\/\d+$/u.test(route)) {
            const id = Number(route.split("/").at(-1));
            const declared = options.runs?.find((run) => ((run as Record<string, unknown>)["id"] ?? 7) === id);
            return { ...nativeRun(), ...declared, id, ...options.currentRun };
        }
        if (/^actions\/runs\/7\/attempts\/\d+\/jobs\?per_page=100$/u.test(route)) return { total_count: 4, jobs: ["Verify (ubuntu-24.04)", "Verify (macos-15)", "Verify (windows-2025)", "Quality Gate"].map((name, index) => ({ id: 70 + index, name, run_id: 7, run_attempt: options.currentRun?.["run_attempt"] ?? 1, head_sha: oldHead, status: "completed", conclusion: options.failedJob && index === 3 ? "failure" : "success" })) };
        if (route === `git/commits/${mergeSha}`) return { sha: mergeSha, tree: { sha: "e".repeat(40) }, parents: [{ sha: options.wrongMergeParent ? freshHead : mainSha }, { sha: refreshed ? freshHead : oldHead }] };
        if (route === `git/commits/${oldHead}` || route === `git/commits/${freshHead}`) return { sha: refreshed ? freshHead : oldHead, tree: { sha: "e".repeat(40) } };
        if (route === `git/ref/heads/${branch}`) return { object: { type: "commit", sha: refreshed ? freshHead : oldHead } };
        if (route === "git/ref/pull/42/merge") return { object: { type: "commit", sha: mergeSha } };
        if (route.startsWith("contents/.github/workflows/ci.yml?ref=")) return sourceBlob;
        if (route.endsWith("/pulls?per_page=100") && route.startsWith("commits/")) return [{ number: 42, state: "open", draft: false, merged_at: null, user: bot,
            head: { ref: branch, repo, sha: refreshed ? freshHead : oldHead }, base: { ref: "main", repo, sha: mainSha } }];
        if (route.startsWith("compare/")) return { behind_by: options.stale && !refreshed ? 1 : 0, merge_base_commit: { sha: mainSha } };
        if (route.startsWith("actions/workflows/ci.yml/runs?")) {
            const sha = refreshed ? freshHead : oldHead;
            const runs = (options.runs ?? []).map((run) => ({ ...nativeRun(), head_sha: sha, ...run }));
            return { total_count: runs.length, workflow_runs: runs };
        }
        throw new Error("Unexpected route " + route);
    };
    return { request, writes, payload: { action: "completed", repository: repo, workflow_run: nativeRun() } };
}

test("a later reconciliation resumes a transiently skipped regular PR proof through the full native merger", async () => {
    // Arrange
    const f = fixture({ transientUnknown: true, runs: [{}] });
    // Act
    const first = await mergeDependabotPullRequest(f.payload, f.request);
    const resumed = await reconcileDependabotBranches(f.request);
    // Assert
    assert.deepEqual(first, { status: "skipped", reason: "ineligible-pull-request" });
    assert.deepEqual(resumed, [{ number: 42, status: "merged", sha: confirmedSha, head: oldHead }]);
    assert.deepEqual(f.writes, [{ method: "PUT", endpoint: "repos/pixel-brewery/quivra/pulls/42/merge", body: { sha: oldHead, merge_method: "squash" } }]);
});

for (const options of [{ failedJob: true }, { wrongMergeParent: true }, { changed: true }]) test(`resumption retains every native proof barrier ${JSON.stringify(options)}`, async () => {
    // Arrange
    const f = fixture({ ...options, runs: [{}] });
    // Act
    const result = await reconcileDependabotBranches(f.request);
    // Assert
    assert.equal(result[0]?.status, "skipped");
    assert.deepEqual(f.writes, []);
});

test("successful diagnostic dispatch does not replace native PR proof for resumption", async () => {
    // Arrange
    const f = fixture({ runs: [{ event: "workflow_dispatch", actor: actions }] });
    // Act
    const result = await reconcileDependabotBranches(f.request);
    // Assert
    assert.equal(result[0]?.status, "waiting");
    assert.deepEqual(f.writes, []);
});

test("a newer diagnostic run does not starve a successful native PR resumption", async () => {
    // Arrange
    const f = fixture({ runs: [{ id: 7 }, { id: 9, event: "workflow_dispatch", actor: actions }] });
    // Act
    const result = await reconcileDependabotBranches(f.request);
    // Assert
    assert.equal(result[0]?.status, "merged");
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0]?.method, "PUT");
});

test("reconciliation hydrates approved native attempt2 even when the list retains attempt1/action_required", async () => {
    // Arrange
    const f = fixture({ runs: [{ run_attempt: 1, conclusion: "action_required" }], currentRun: { run_attempt: 2, conclusion: "success", actor: actions } });
    // Act
    const result = await reconcileDependabotBranches(f.request);
    // Assert
    assert.equal(result[0]?.status, "merged");
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0]?.method, "PUT");
});

test("a newer failed PR attempt blocks resumption of an older successful attempt", async () => {
    // Arrange
    const f = fixture({ runs: [{ id: 7 }, { id: 9, conclusion: "failure" }] });
    // Act
    const result = await reconcileDependabotBranches(f.request);
    // Assert
    assert.equal(result[0]?.status, "waiting");
    assert.deepEqual(f.writes, []);
});

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

test("an unchanged approval-pending token-authored native run is retained for guarded authorization", async () => {
    // Arrange
    const f = fixture({ runs: [{ event: "pull_request", actor: actions, status: "completed", conclusion: "action_required" }] });
    // Act
    const result = await reconcileDependabotBranches(f.request);
    // Assert
    assert.equal(result[0]?.status, "waiting");
    assert.deepEqual(f.writes, []);
});

for (const stale of [false, true]) test(`an unsafe identical main/head CI cannot receive diagnostic dispatch after refresh=${stale}`, async () => {
    // Arrange
    const f = fixture({ stale, unsafeSource: true });
    // Act
    const result = await reconcileDependabotBranches(f.request, async () => undefined);
    // Assert
    assert.equal(result[0]?.reason, "unverified-readonly-native-source");
    assert.deepEqual(f.writes.map((write) => write.method), stale ? ["PUT"] : []);
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
