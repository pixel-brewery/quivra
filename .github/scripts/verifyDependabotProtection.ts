// #region Imports
import type { IRequestGitHub } from "./interfaces/IRequestGitHub.ts";
import { quivraDependabotPolicy } from "./quivraDependabotPolicy.ts";
// #endregion

/**
 * Preserves the repository-owned strict GitHub Actions Quality Gate requirement.
 * @param request - Authenticated read boundary shared by refresh and merge operations.
 * @returns An unsatisfied-protection diagnostic, or undefined when the rule is active.
 * @throws An error for other unexpected GitHub failures.
 * @public
 */
export async function verifyDependabotProtection(request: IRequestGitHub): Promise<string | undefined> {
    const fields = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    try {
        const rules = await request("GET", `${quivraDependabotPolicy.repositoryPath}/rules/branches/main?per_page=100`);
        if (!Array.isArray(rules)) return "invalid-main-protection";
        const strict = rules.some((value: unknown) => {
            const rule = fields(value);
            const parameters = fields(rule["parameters"]);
            const checks = parameters["required_status_checks"];
            return rule["type"] === "required_status_checks" && rule["ruleset_source_type"] === "Repository" &&
                rule["ruleset_source"] === quivraDependabotPolicy.repositoryName && Number.isSafeInteger(rule["ruleset_id"]) && Number(rule["ruleset_id"]) > 0 &&
                parameters["strict_required_status_checks_policy"] === true && Array.isArray(checks) && checks.some((item: unknown) => {
                    const check = fields(item);
                    return check["context"] === quivraDependabotPolicy.qualityGate && check["integration_id"] === quivraDependabotPolicy.actionsAppId;
                });
        });
        return strict ? undefined : "missing-strict-quality-gate";
    } catch (error) {
        const status = fields(error)["status"];
        if (status === 403 || status === 404) return "main-protection-unavailable";
        throw error;
    }
}
