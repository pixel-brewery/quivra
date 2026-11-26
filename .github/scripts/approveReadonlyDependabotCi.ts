// #region Imports
import type { INativeCiApprovalResult } from "./interfaces/INativeCiApprovalResult.ts";
import type { INativeCiProof } from "./interfaces/INativeCiProof.ts";
import type { IRequestGitHub } from "./interfaces/IRequestGitHub.ts";
import { isCanonicalRepository } from "./isCanonicalRepository.ts";
import { isDependabotUser } from "./isDependabotUser.ts";
import { isGitHubActionsUser } from "./isGitHubActionsUser.ts";
import { isNativeCiProofCurrent } from "./isNativeCiProofCurrent.ts";
import { quivraDependabotPolicy as policy } from "./quivraDependabotPolicy.ts";
import { readLatestDependabotRun } from "./readLatestDependabotRun.ts";
import { readNativeCiProof } from "./readNativeCiProof.ts";
import { verifyDependabotProtection } from "./verifyDependabotProtection.ts";
// #endregion

const fields = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const serviceActor = (value: unknown): boolean => isDependabotUser(value) || isGitHubActionsUser(value);

/**
 * Authorizes only the original action-required native PR run under a read-only proof.
 *
 * @remarks This never dispatches replacement verification, changes branch rules,
 * creates reviews/statuses or executes PR dependencies. Every approval uses the
 * existing native workflow token once, after fresh M/B/C, workflow and attempt
 * checks. A successful approval only starts CI; its real checks must still pass.
 *
 * @param request - Trusted metadata boundary with Actions write and source/PR read.
 * @returns One explicit bounded outcome for each own bot candidate, at most thirty.
 * @throws An error when repository, workflow or protection identity cannot be proved.
 *
 * @public
 */
export async function approveReadonlyDependabotCi(request: IRequestGitHub): Promise<readonly INativeCiApprovalResult[]> {
    const repository = fields(await request("GET", `repositories/${policy.repositoryId}`));
    if (!isCanonicalRepository(repository) || repository["default_branch"] !== "main" || repository["private"] !== false || repository["visibility"] !== "public" || repository["fork"] !== false)
        throw new Error("Native CI authorization requires the canonical public repository.");
    const protection = await verifyDependabotProtection(request);
    if (protection) throw new Error(protection);
    const workflow = fields(await request("GET", `${policy.repositoryPath}/actions/workflows/ci.yml`));
    const workflowId = workflow["id"];
    if (typeof workflowId !== "number" || !Number.isSafeInteger(workflowId) || workflowId <= 0 || workflow["path"] !== policy.workflowPath || workflow["name"] !== policy.workflowName || workflow["state"] !== "active")
        throw new Error("Native CI authorization workflow changed.");
    const candidates: unknown[] = [];
    for (let page = 1; page <= 5; page++) {
        const batch = await request("GET", `${policy.repositoryPath}/pulls?state=open&base=main&per_page=100&page=${page}`);
        if (!Array.isArray(batch) || batch.length > 100) throw new Error("Invalid bounded approval inventory.");
        candidates.push(...batch.filter((value: unknown) => isDependabotUser(fields(value)["user"])));
        if (batch.length < 100) break;
        if (page === 5) throw new Error("Native CI authorization inventory exceeds its bound.");
    }
    const results: INativeCiApprovalResult[] = [];
    for (const value of candidates.slice(0, 30)) {
        const number = fields(value)["number"];
        if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) continue;
        try { results.push(await authorize(number, workflowId, request)); }
        catch (error) { results.push({ number, status: "blocked", reason: error instanceof Error ? error.message.slice(0, 256) : "request-failed" }); }
    }
    return results;
}

async function latestNative(proof: INativeCiProof, workflowId: number, request: IRequestGitHub): Promise<Record<string, unknown> | undefined> {
    const inventory = await request("GET", `${policy.repositoryPath}/actions/workflows/ci.yml/runs?head_sha=${proof.headSha}&per_page=100`);
    const selected = readLatestDependabotRun(inventory, workflowId, proof.headSha, proof.headBranch);
    if (!selected) return undefined;
    const run = fields(await request("GET", `${policy.repositoryPath}/actions/runs/${String(selected["id"])}`));
    if (run["id"] !== selected["id"] || run["workflow_id"] !== workflowId || run["name"] !== policy.workflowName ||
        (run["path"] !== policy.workflowPath && run["path"] !== `${policy.workflowPath}@refs/heads/${proof.headBranch}`) ||
        run["event"] !== "pull_request" || run["head_sha"] !== proof.headSha || run["head_branch"] !== proof.headBranch ||
        !isCanonicalRepository(run["repository"]) || !isCanonicalRepository(run["head_repository"]) ||
        typeof run["run_attempt"] !== "number" || !Number.isSafeInteger(run["run_attempt"]) || run["run_attempt"] <= 0 ||
        !Array.isArray(run["pull_requests"]) || run["pull_requests"].length !== 1) return undefined;
    const linked = fields(run["pull_requests"][0]), head = fields(linked["head"]), base = fields(linked["base"]);
    return linked["number"] === proof.number && base["ref"] === "main" && base["sha"] === proof.baseSha && fields(base["repo"])["id"] === policy.repositoryId &&
        head["sha"] === proof.headSha && head["ref"] === proof.headBranch && fields(head["repo"])["id"] === policy.repositoryId ? run : undefined;
}

async function authorize(number: number, workflowId: number, request: IRequestGitHub): Promise<INativeCiApprovalResult> {
    const pullPath = `${policy.repositoryPath}/pulls/${number}`;
    const proof = await readNativeCiProof(await request("GET", pullPath), request);
    if (!proof) return { number, status: "skipped", reason: "unverified-readonly-native-source" };
    const run = await latestNative(proof, workflowId, request);
    if (!run || run["status"] !== "completed" || run["conclusion"] !== "action_required") return { number, status: "waiting", reason: "native-verification-not-action-required" };
    if (!serviceActor(run["actor"]) || !serviceActor(run["triggering_actor"])) return { number, status: "skipped", reason: "unsupported-approval-actor" };
    const fresh = await readNativeCiProof(await request("GET", pullPath), request);
    if (!fresh || fresh.baseSha !== proof.baseSha || fresh.headSha !== proof.headSha || fresh.mergeSha !== proof.mergeSha || fresh.headBranch !== proof.headBranch)
        return { number, status: "skipped", reason: "native-source-changed" };
    const latest = await latestNative(fresh, workflowId, request);
    if (!latest || latest["id"] !== run["id"] || latest["run_attempt"] !== run["run_attempt"] || latest["status"] !== "completed" || latest["conclusion"] !== "action_required" ||
        !serviceActor(latest["actor"]) || !serviceActor(latest["triggering_actor"])) return { number, status: "skipped", reason: "native-attempt-changed" };
    const protection = await verifyDependabotProtection(request);
    if (protection || !(await isNativeCiProofCurrent(fresh, request))) return { number, status: "skipped", reason: protection ?? "native-source-changed" };
    await request("POST", `${policy.repositoryPath}/actions/runs/${String(latest["id"])}/approve`);
    return { number, status: "approved", runId: Number(latest["id"]), attempt: Number(latest["run_attempt"]) };
}
