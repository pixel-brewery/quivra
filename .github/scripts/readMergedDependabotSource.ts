// #region Imports
import type { IRequestGitHub } from "./interfaces/IRequestGitHub.ts";
import { isCanonicalRepository } from "./isCanonicalRepository.ts";
import { isDependabotUser } from "./isDependabotUser.ts";
import { quivraDependabotPolicy as policy } from "./quivraDependabotPolicy.ts";
// #endregion

const fields = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/**
 * Recovers the confirmed bot merge at current main for an interrupted continuation.
 *
 * @remarks The exact current commit association avoids a recent-closed inventory
 * window. Simple association records select a candidate; only a full merged PR
 * and a fresh protected-main read authorize its source output. Existing workflow
 * inventories still prevent duplicate verification, publication and deployment.
 *
 * @param request - Read-only canonical repository metadata boundary.
 * @returns The exact current confirmed bot merge, or undefined for another source.
 * @throws An error for malformed, incomplete or unavailable source evidence.
 *
 * @public
 */
export async function readMergedDependabotSource(request: IRequestGitHub): Promise<string | undefined> {
    const prefix = policy.repositoryPath;
    const main = fields(await request("GET", `${prefix}/branches/main`));
    const sha = fields(main["commit"])["sha"];
    if (main["name"] !== "main" || main["protected"] !== true || typeof sha !== "string" || !/^[a-f0-9]{40}$/u.test(sha)) throw new Error("Invalid protected continuation source.");
    const associated = await request("GET", `${prefix}/commits/${sha}/pulls?per_page=100`);
    if (!Array.isArray(associated) || associated.length >= 100) throw new Error("Invalid complete current-merge association.");
    const candidates = associated.filter((value: unknown) => confirmedShape(value, sha));
    if (candidates.length !== 1) return undefined;
    const number = fields(candidates[0])["number"];
    const pull = fields(await request("GET", `${prefix}/pulls/${String(number)}`));
    if (pull["number"] !== number || pull["merged"] !== true || !confirmedShape(pull, sha)) return undefined;
    const current = fields(await request("GET", `${prefix}/branches/main`));
    return current["name"] === "main" && current["protected"] === true && fields(current["commit"])["sha"] === sha ? sha : undefined;
}

function confirmedShape(value: unknown, sha: string): boolean {
    const pull = fields(value), head = fields(pull["head"]), base = fields(pull["base"]);
    const branch = head["ref"];
    return typeof pull["number"] === "number" && Number.isSafeInteger(pull["number"]) && pull["number"] > 0 && pull["state"] === "closed" &&
        typeof pull["merged_at"] === "string" && Number.isFinite(Date.parse(pull["merged_at"])) && pull["merge_commit_sha"] === sha &&
        isDependabotUser(pull["user"]) && isCanonicalRepository(head["repo"]) && isCanonicalRepository(base["repo"]) && base["ref"] === "main" &&
        typeof branch === "string" && /^dependabot\/[a-zA-Z0-9_./-]+$/u.test(branch) && !branch.includes("..") && !branch.includes("//");
}
