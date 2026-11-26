// #region Imports
import { setTimeout as delay } from "node:timers/promises";
import type { IReconcileResult } from "./interfaces/IReconcileResult.ts";
import type { IRequestGitHub } from "./interfaces/IRequestGitHub.ts";
import { isCanonicalRepository } from "./isCanonicalRepository.ts";
import { isDependabotUser } from "./isDependabotUser.ts";
import { isGitHubActionsUser } from "./isGitHubActionsUser.ts";
import { quivraDependabotPolicy as policy } from "./quivraDependabotPolicy.ts";
import { readLatestDependabotRun } from "./readLatestDependabotRun.ts";
import { verifyDependabotProtection } from "./verifyDependabotProtection.ts";
// #endregion

const shaPattern = /^[0-9a-f]{40}$/u;
const branchPattern = /^dependabot\/[a-zA-Z0-9_./-]+$/u;
const fields = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/**
 * Refreshes stale bot branches and requests full read-only CI at their exact new heads.
 * @remarks Uses the same bounded refresh/dispatch contract as the shared repository
 * automation. Quivra's separate native merger retains all four jobs and synthetic
 * merge-parent proof. One conflicted PR cannot starve the remaining candidates.
 * @param request - Native-token metadata boundary from the trusted default branch.
 * @param wait - Optional bounded polling delay for deterministic offline checks.
 * @returns One explicit outcome per eligible dependency pull request, at most thirty.
 * @throws An error for invalid repository, protection, workflow or inventory metadata.
 * @public
 */
export async function reconcileDependabotBranches(request: IRequestGitHub, wait: () => Promise<void> = () => delay(750)): Promise<readonly IReconcileResult[]> {
    const repository = fields(await request("GET", `repositories/${policy.repositoryId}`));
    if (!isCanonicalRepository(repository) || repository["default_branch"] !== policy.defaultBranch || repository["private"] !== false ||
        repository["visibility"] !== "public" || repository["fork"] !== false || repository["allow_squash_merge"] !== true)
        throw new Error("Dependency reconciliation requires the canonical public protected-main repository.");
    const protection = await verifyDependabotProtection(request);
    if (protection) throw new Error(protection);
    const workflow = fields(await request("GET", `${policy.repositoryPath}/actions/workflows/ci.yml`));
    if (!Number.isSafeInteger(workflow["id"]) || Number(workflow["id"]) <= 0 || workflow["path"] !== policy.workflowPath ||
        workflow["name"] !== policy.workflowName || workflow["state"] !== "active") throw new Error("Dependency CI workflow changed.");
    const pulls: unknown[] = [];
    for (let page = 1; page <= 5; page++) {
        const batch = await request("GET", `${policy.repositoryPath}/pulls?state=open&base=main&per_page=100&page=${page}`);
        if (!Array.isArray(batch) || batch.length > 100) throw new Error("Invalid dependency inventory.");
        pulls.push(...batch);
        if (batch.length < 100) break;
        if (page === 5) throw new Error("Dependency inventory exceeds its bound.");
    }
    const results: IReconcileResult[] = [];
    const candidates = pulls.filter((value) => isDependabotUser(fields(value)["user"])).slice(0, 30);
    for (const value of candidates) {
        const number = fields(value)["number"];
        if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) continue;
        try { results.push(await reconcilePull(number, Number(workflow["id"]), request, wait)); }
        catch (error) { results.push({ number, status: "blocked", reason: error instanceof Error ? error.message.slice(0, 256) : "request-failed" }); }
    }
    return results;
}

async function reconcilePull(number: number, workflowId: number, request: IRequestGitHub, wait: () => Promise<void>): Promise<IReconcileResult> {
    const path = `${policy.repositoryPath}/pulls/${number}`;
    let pull = fields(await request("GET", path));
    if (!eligible(pull, number)) return { number, status: "skipped", reason: "pull-request-changed" };
    const main = fields(await request("GET", `${policy.repositoryPath}/branches/main`));
    const mainSha = fields(main["commit"])["sha"];
    if (main["name"] !== "main" || main["protected"] !== true || typeof mainSha !== "string" || !shaPattern.test(mainSha)) throw new Error("Invalid protected main.");
    let head = fields(pull["head"]);
    const oldHead = String(head["sha"]);
    const comparison = fields(await request("GET", `${policy.repositoryPath}/compare/${mainSha}...${oldHead}`));
    if (!Number.isSafeInteger(comparison["behind_by"]) || Number(comparison["behind_by"]) < 0 || !shaPattern.test(String(fields(comparison["merge_base_commit"])["sha"])))
        throw new Error("Invalid branch comparison.");
    if (comparison["behind_by"] !== 0 || fields(comparison["merge_base_commit"])["sha"] !== mainSha) {
        await request("PUT", `${path}/update-branch`, { expected_head_sha: oldHead });
        for (let attempt = 0; attempt < 16; attempt++) {
            await wait();
            pull = fields(await request("GET", path));
            if (!eligible(pull, number) || fields(pull["head"])["sha"] !== oldHead) break;
        }
        if (!eligible(pull, number)) return { number, status: "skipped", reason: "pull-request-changed" };
        if (fields(pull["head"])["sha"] === oldHead) return { number, status: "waiting", reason: "branch-refresh-pending" };
    }
    head = fields(pull["head"]);
    const headSha = String(head["sha"]);
    const headBranch = String(head["ref"]);
    const inventory = await request("GET", `${policy.repositoryPath}/actions/workflows/ci.yml/runs?head_sha=${headSha}&per_page=100`);
    const latest = readLatestDependabotRun(inventory, workflowId, headSha, headBranch);
    if (latest && ((latest["event"] === "workflow_dispatch" && isGitHubActionsUser(latest["actor"])) ||
        (latest["event"] === "pull_request" && isDependabotUser(latest["actor"]))))
        return { number, status: "waiting", reason: "verification-already-requested" };
    const current = fields(await request("GET", path));
    if (!eligible(current, number) || fields(current["head"])["sha"] !== headSha || fields(current["head"])["ref"] !== headBranch)
        return { number, status: "skipped", reason: "pull-request-changed" };
    await request("POST", `${policy.repositoryPath}/actions/workflows/ci.yml/dispatches`, { ref: headBranch, inputs: { expected_head_sha: headSha } });
    return { number, status: "verification-requested", head: headSha };
}

function eligible(pull: Record<string, unknown>, number: number): boolean {
    const head = fields(pull["head"]);
    const base = fields(pull["base"]);
    const branch = String(head["ref"]);
    return pull["number"] === number && pull["state"] === "open" && pull["draft"] === false && pull["merged"] === false &&
        isDependabotUser(pull["user"]) && isCanonicalRepository(head["repo"]) && isCanonicalRepository(base["repo"]) &&
        base["ref"] === "main" && shaPattern.test(String(head["sha"])) && branchPattern.test(branch) && !branch.includes("..") && !branch.includes("//");
}
