// #region Imports
import type { IMergedContinuation } from "./interfaces/IMergedContinuation.ts";
import type { IRequestGitHub } from "./interfaces/IRequestGitHub.ts";
import { isCanonicalRepository } from "./isCanonicalRepository.ts";
import { quivraDependabotPolicy as policy } from "./quivraDependabotPolicy.ts";
import { verifyDependabotProtection } from "./verifyDependabotProtection.ts";
// #endregion

const fields = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/**
 * Continues the existing CI and release workflows after a native-token merge.
 * @remarks Failed or cancelled runs are retained for an explicit retry of the
 * original run. This dispatches no arbitrary source, tag or publication command.
 * @param sourceSha - Exact squash merge confirmed by the merger.
 * @param request - Metadata boundary with read access and workflow dispatch authority.
 * @returns Newly requested, already existing or superseded workflow outcomes.
 * @throws An error when repository, protection, workflow or source proof is invalid.
 * @public
 */
export async function requestMergedContinuation(sourceSha: string, request: IRequestGitHub): Promise<IMergedContinuation> {
    if (!/^[0-9a-f]{40}$/u.test(sourceSha)) throw new Error("Continuation requires an exact protected merge source.");
    const repository = fields(await request("GET", `repositories/${policy.repositoryId}`));
    if (!isCanonicalRepository(repository) || repository["default_branch"] !== "main" || repository["private"] !== false || repository["visibility"] !== "public" || repository["fork"] !== false)
        throw new Error("Unsupported continuation repository.");
    const protection = await verifyDependabotProtection(request);
    if (protection) throw new Error(protection);
    const commit = fields(await request("GET", `${policy.repositoryPath}/commits/${sourceSha}?per_page=100`));
    const files = commit["files"];
    if (commit["sha"] !== sourceSha || !Array.isArray(files) || files.length >= 100 || !files.every((value: unknown) => typeof fields(value)["filename"] === "string"))
        throw new Error("Invalid complete continuation source-file inventory.");
    const pagesChanged = files.some((value: unknown) => {
        const file = fields(value);
        return [file["filename"], file["previous_filename"]].some((path) => typeof path === "string" &&
            (path.startsWith("site/") || [".github/workflows/publish-pages.yml", ".github/assets/quivra-icon.png", "schemas/profile.schema.json", "schemas/batch.schema.json"].includes(path)));
    });
    const requested: string[] = [];
    const existing: string[] = [];
    for (const definition of [
        { file: "ci.yml", name: "CI", input: "expected_head_sha" },
        { file: "release.yml", name: "Release Quivra", input: "source_sha" },
        ...(pagesChanged ? [{ file: "publish-pages.yml", name: "Publish GitHub Pages", input: "expected_head_sha" }] : []),
    ]) {
        const main = fields(await request("GET", `${policy.repositoryPath}/branches/main`));
        if (main["name"] !== "main" || main["protected"] !== true) throw new Error("Continuation requires protected main.");
        if (fields(main["commit"])["sha"] !== sourceSha) return { status: "superseded", sourceSha, requested, existing };
        const endpoint = `${policy.repositoryPath}/actions/workflows/${definition.file}`;
        const workflow = fields(await request("GET", endpoint));
        const path = `.github/workflows/${definition.file}`;
        if (!Number.isSafeInteger(workflow["id"]) || Number(workflow["id"]) <= 0 || workflow["path"] !== path || workflow["name"] !== definition.name || workflow["state"] !== "active")
            throw new Error("Continuation workflow changed.");
        const response = fields(await request("GET", `${endpoint}/runs?branch=main&head_sha=${sourceSha}&per_page=100`));
        const runs = response["workflow_runs"];
        if (!Number.isSafeInteger(response["total_count"]) || Number(response["total_count"]) < 0 || Number(response["total_count"]) > 100 || !Array.isArray(runs) || runs.length !== response["total_count"])
            throw new Error("Invalid continuation inventory.");
        if (!runs.every((value: unknown) => {
            const run = fields(value);
            return Number.isSafeInteger(run["id"]) && Number(run["id"]) > 0 && Number.isSafeInteger(run["run_attempt"]) && Number(run["run_attempt"]) > 0 &&
                run["workflow_id"] === workflow["id"] && run["head_sha"] === sourceSha && run["head_branch"] === "main" &&
                ["push", "workflow_dispatch"].includes(String(run["event"])) && isCanonicalRepository(run["repository"]) && isCanonicalRepository(run["head_repository"]) &&
                (run["path"] === path || run["path"] === `${path}@refs/heads/main`);
        })) throw new Error("Unexpected continuation run identity.");
        if (runs.length) { existing.push(definition.file); continue; }
        const current = fields(await request("GET", `${policy.repositoryPath}/branches/main`));
        if (current["name"] !== "main" || current["protected"] !== true) throw new Error("Continuation requires protected main.");
        if (fields(current["commit"])["sha"] !== sourceSha) return { status: "superseded", sourceSha, requested, existing };
        await request("POST", `${endpoint}/dispatches`, { ref: "main", inputs: { [definition.input]: sourceSha } });
        requested.push(definition.file);
    }
    return { status: "continued", sourceSha, requested, existing };
}
