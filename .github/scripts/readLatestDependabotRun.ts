// #region Imports
import type { IPullRequestAssociation } from "./interfaces/IPullRequestAssociation.ts";
import { isCanonicalRepository } from "./isCanonicalRepository.ts";
import { quivraDependabotPolicy } from "./quivraDependabotPolicy.ts";
// #endregion

/**
 * Selects the latest native run identity for one exact own-main PR association.
 * @param value - Complete bounded workflow-run inventory returned by GitHub.
 * @param workflowId - Trusted active CI workflow identifier.
 * @param association - Exact candidate PR, current main, own branch and source SHA.
 * @param includeDiagnostics - Include head-only dispatches solely for diagnostic deduplication; defaults to false.
 * @returns The latest matching identity without hiding eligible failures. Attempt
 * and state require a fresh run GET; cached list values cannot establish proof.
 * Diagnostics participate only when explicitly requested for deduplication.
 * @throws An error when the inventory or expected association is malformed.
 * @public
 */
export function readLatestDependabotRun(value: unknown, workflowId: number, association: IPullRequestAssociation, includeDiagnostics = false): Record<string, unknown> | undefined {
    const { number, headSha, headBranch, baseSha } = association;
    if (!Number.isSafeInteger(number) || number <= 0 || !/^[a-f0-9]{40}$/u.test(headSha) || !/^[a-f0-9]{40}$/u.test(baseSha) || !/^dependabot\/[a-zA-Z0-9_./-]+$/u.test(headBranch) || headBranch.includes("..") || headBranch.includes("//"))
        throw new Error("Invalid exact native PR association.");
    const response = value as { total_count?: unknown; workflow_runs?: unknown } | null;
    if (!response || !Number.isSafeInteger(response.total_count) || typeof response.total_count !== "number" || response.total_count < 0 || response.total_count > 100 || !Array.isArray(response.workflow_runs) || response.workflow_runs.length !== response.total_count)
        throw new Error("Invalid complete CI verification inventory.");
    return response.workflow_runs.filter((value): value is Record<string, unknown> => {
        if (!value || typeof value !== "object") return false;
        const run = value as Record<string, unknown>;
        return typeof run["id"] === "number" && Number.isSafeInteger(run["id"]) && run["id"] > 0 && run["workflow_id"] === workflowId &&
            run["name"] === quivraDependabotPolicy.workflowName &&
            (run["path"] === quivraDependabotPolicy.workflowPath || run["path"] === `${quivraDependabotPolicy.workflowPath}@refs/heads/${headBranch}`) &&
            ((run["event"] === "pull_request" && matchesAssociation(run["pull_requests"], association)) || (includeDiagnostics && run["event"] === "workflow_dispatch")) && run["head_sha"] === headSha && run["head_branch"] === headBranch &&
            isCanonicalRepository(run["repository"]) && isCanonicalRepository(run["head_repository"]);
    }).sort((left, right) => Number(right["id"]) - Number(left["id"]))[0];
}

function matchesAssociation(value: unknown, expected: IPullRequestAssociation): boolean {
    if (!Array.isArray(value) || value.length !== 1) return false;
    const fields = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const linked = fields(value[0]), head = fields(linked["head"]), base = fields(linked["base"]);
    return linked["number"] === expected.number && base["ref"] === quivraDependabotPolicy.defaultBranch && base["sha"] === expected.baseSha && fields(base["repo"])["id"] === quivraDependabotPolicy.repositoryId &&
        head["sha"] === expected.headSha && head["ref"] === expected.headBranch && fields(head["repo"])["id"] === quivraDependabotPolicy.repositoryId;
}
