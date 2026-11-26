// #region Imports
import { isCanonicalRepository } from "./isCanonicalRepository.ts";
import { quivraDependabotPolicy } from "./quivraDependabotPolicy.ts";
// #endregion

/**
 * Selects the latest genuine CI attempt for one exact head without hiding failures.
 * @param value - Complete bounded workflow-run inventory returned by GitHub.
 * @param workflowId - Trusted active CI workflow identifier.
 * @param headSha - Exact source SHA under consideration.
 * @param headBranch - Same-repository Dependabot source branch.
 * @param includeDiagnostics - Include head-only dispatches solely for diagnostic deduplication; defaults to false.
 * @returns The latest matching native PR run, including its approval-blocked state;
 * diagnostics participate only when explicitly requested for deduplication.
 * @throws An error when the inventory is incomplete or malformed.
 * @public
 */
export function readLatestDependabotRun(value: unknown, workflowId: number, headSha: string, headBranch: string, includeDiagnostics = false): Record<string, unknown> | undefined {
    const response = value as { total_count?: unknown; workflow_runs?: unknown } | null;
    if (!response || !Number.isSafeInteger(response.total_count) || typeof response.total_count !== "number" || response.total_count < 0 || response.total_count > 100 || !Array.isArray(response.workflow_runs) || response.workflow_runs.length !== response.total_count)
        throw new Error("Invalid complete CI verification inventory.");
    return response.workflow_runs.filter((value): value is Record<string, unknown> => {
        if (!value || typeof value !== "object") return false;
        const run = value as Record<string, unknown>;
        return typeof run["id"] === "number" && Number.isSafeInteger(run["id"]) && run["id"] > 0 && run["workflow_id"] === workflowId &&
            run["name"] === quivraDependabotPolicy.workflowName &&
            (run["path"] === quivraDependabotPolicy.workflowPath || run["path"] === `${quivraDependabotPolicy.workflowPath}@refs/heads/${headBranch}`) &&
            (run["event"] === "pull_request" || (includeDiagnostics && run["event"] === "workflow_dispatch")) && run["head_sha"] === headSha && run["head_branch"] === headBranch &&
            isCanonicalRepository(run["repository"]) && isCanonicalRepository(run["head_repository"]);
    }).sort((left, right) => Number(right["id"]) - Number(left["id"]))[0];
}
