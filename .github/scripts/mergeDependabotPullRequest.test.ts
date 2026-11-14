import assert from "node:assert/strict";
import { test } from "node:test";

import { mergeDependabotPullRequest } from "./mergeDependabotPullRequest.ts";

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
    [`repositories/${repoId}`]: {
        ...repo, default_branch: "main", private: false, visibility: "public", fork: false, allow_squash_merge: true,
    },
    "actions/workflows/ci.yml": workflow,
    "actions/runs/7": run,
    "actions/runs/7/attempts/2/jobs?per_page=100": jobs,
    "pulls/42": pullRequest,
    [rulesPath]: [rule],
    [`git/commits/${candidate}`]: { sha: candidate, parents: [{ sha: base.sha }, { sha: head.sha }] },
    "branches/main": main,
};

function mock(overrides: Record<string, () => unknown> = {}) {
    const writes: { endpoint: string; body: object | undefined }[] = [];
    const request: RequestGitHub = async (method, endpoint, body) => {
        if (method === "PUT") {
            writes.push({ endpoint, body });
            return { merged: true, sha: "d".repeat(40) };
        }
        const key = endpoint.replace(`repos/${repoName}/`, "");
        assert.ok(Object.hasOwn(data, key), `Unexpected GitHub API request ${endpoint}`);
        return Object.hasOwn(overrides, key) ? overrides[key]?.() : data[key];
    };
    return { request, writes };
}

test("merges the verified head with the protection visible to a read-only caller", async () => {
    const { request, writes } = mock();
    assert.deepEqual(await mergeDependabotPullRequest(event, request), {
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
        const { request, writes } = mock({ [rulesPath]: loadRules });
        assert.deepEqual(await mergeDependabotPullRequest(event, request), { status: "skipped", reason });
        assert.deepEqual(writes, []);
    }
});

test("skips a merge if main has changed before the write", async () => {
    const { request, writes } = mock({ "branches/main": () => ({ ...main, commit: { sha: "f".repeat(40) } }) });
    assert.deepEqual(await mergeDependabotPullRequest(event, request), { status: "skipped", reason: "verification-changed" });
    assert.deepEqual(writes, []);
});
