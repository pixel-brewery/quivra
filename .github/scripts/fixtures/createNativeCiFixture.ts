// #region Imports
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IRequestGitHub } from "../interfaces/IRequestGitHub.ts";
// #endregion

/**
 * Provides real-shaped, isolated metadata for the native CI trust-boundary specs.
 *
 * @param options - Optional exact source texts and read-numbered API responses.
 * @returns Mutable fixture records, a credential-free boundary and every mutation.
 * @throws An error for an undeclared metadata route or unreadable local CI source.
 *
 * @public
 */
export function createNativeCiFixture(options: {
    baselineSource?: string;
    proposedSource?: string;
    overrides?: Record<string, (read: number) => unknown>;
} = {}) {
    const repo = { id: 1457527723, full_name: "pixel-brewery/quivra" };
    const bot = { id: 49699333, login: "dependabot[bot]", type: "Bot" };
    const actions = { id: 41898282, login: "github-actions[bot]", type: "Bot" };
    const proof = { number: 42, baseSha: "a".repeat(40), headSha: "b".repeat(40), mergeSha: "c".repeat(40), headBranch: "dependabot/cargo/test" };
    const head = { ref: proof.headBranch, repo, sha: proof.headSha }, base = { ref: "main", repo, sha: proof.baseSha };
    const pull = { number: proof.number, state: "open", draft: false, merged: false, mergeable: true, merged_at: null, user: bot, head, base, merge_commit_sha: proof.mergeSha };
    const workflow = { id: 8, path: ".github/workflows/ci.yml", name: "CI", state: "active" };
    const run = { id: 7, run_attempt: 1, workflow_id: workflow.id, path: workflow.path, name: workflow.name, event: "pull_request", status: "completed", conclusion: "action_required",
        repository: repo, head_repository: repo, actor: actions, triggering_actor: bot, head_sha: proof.headSha, head_branch: proof.headBranch, pull_requests: [{ number: proof.number, head, base }] };
    const source = readFileSync(new URL("../../workflows/ci.yml", import.meta.url), "utf8");
    const blob = (text: string) => ({ type: "file", encoding: "base64", content: Buffer.from(text).toString("base64"), sha: createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest("hex") });
    // The commit association endpoint returns SimplePullRequest, without `merged`.
    const { merged: omitted, ...simple } = pull;
    void omitted;
    const values: Record<string, unknown> = {
        [`repositories/${repo.id}`]: { ...repo, default_branch: "main", private: false, visibility: "public", fork: false, allow_squash_merge: true },
        "rules/branches/main?per_page=100": [{ type: "required_status_checks", ruleset_source_type: "Repository", ruleset_source: repo.full_name, ruleset_id: 11,
            parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: "Quality Gate", integration_id: 15368 }] } }],
        "branches/main": { name: "main", protected: true, commit: { sha: proof.baseSha } },
        "actions/workflows/ci.yml": workflow,
        "pulls?state=open&base=main&per_page=100&page=1": [simple],
        "pulls/42": pull,
        [`git/ref/heads/${proof.headBranch}`]: { object: { type: "commit", sha: proof.headSha } },
        "git/ref/pull/42/merge": { object: { type: "commit", sha: proof.mergeSha } },
        [`compare/${proof.baseSha}...${proof.headSha}`]: { behind_by: 0, merge_base_commit: { sha: proof.baseSha } },
        [`git/commits/${proof.headSha}`]: { sha: proof.headSha, tree: { sha: "e".repeat(40) } },
        [`git/commits/${proof.mergeSha}`]: { sha: proof.mergeSha, tree: { sha: "e".repeat(40) }, parents: [{ sha: proof.baseSha }, { sha: proof.headSha }] },
        [`contents/${workflow.path}?ref=${proof.baseSha}`]: blob(options.baselineSource ?? source),
        [`contents/${workflow.path}?ref=${proof.headSha}`]: blob(options.proposedSource ?? options.baselineSource ?? source),
        [`commits/${proof.headSha}/pulls?per_page=100`]: [simple],
        [`actions/workflows/ci.yml/runs?head_sha=${proof.headSha}&per_page=100`]: { total_count: 1, workflow_runs: [run] },
        "actions/runs/7": run,
    };
    const writes: { method: string; endpoint: string; body: object | undefined }[] = [];
    const reads = new Map<string, number>();
    const request: IRequestGitHub = async (method, endpoint, body) => {
        if (method !== "GET") { writes.push({ method, endpoint, body }); return undefined; }
        const route = endpoint.replace(`repos/${repo.full_name}/`, "");
        const count = (reads.get(route) ?? 0) + 1;
        reads.set(route, count);
        const override = options.overrides?.[route];
        if (override) return override(count);
        if (!Object.hasOwn(values, route)) throw new Error(`Unexpected native metadata request: ${route}`);
        return structuredClone(values[route]);
    };
    return { request, values, writes, reads, repo, bot, actions, run, pull, workflow, proof };
}
