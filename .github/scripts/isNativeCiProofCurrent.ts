// #region Imports
import type { INativeCiProof } from "./interfaces/INativeCiProof.ts";
import type { IRequestGitHub } from "./interfaces/IRequestGitHub.ts";
import { isCanonicalRepository } from "./isCanonicalRepository.ts";
import { isDependabotUser } from "./isDependabotUser.ts";
import { quivraDependabotPolicy as policy } from "./quivraDependabotPolicy.ts";
// #endregion

const fields = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/**
 * Rechecks the actual own pull request and all three live refs before a mutation.
 *
 * @param proof - Previously verified immutable source, association and workflow proof.
 * @param request - Read-only GitHub metadata boundary.
 * @returns Whether the same open bot PR and protected main still name exactly M/B/C.
 * @throws A metadata request error instead of assuming unchanged refs.
 *
 * @public
 */
export async function isNativeCiProofCurrent(proof: INativeCiProof, request: IRequestGitHub): Promise<boolean> {
    const prefix = policy.repositoryPath;
    const pull = fields(await request("GET", `${prefix}/pulls/${proof.number}`));
    const head = fields(pull["head"]), base = fields(pull["base"]);
    if (pull["number"] !== proof.number || pull["state"] !== "open" || pull["draft"] !== false || pull["merged"] !== false || pull["mergeable"] !== true ||
        !isDependabotUser(pull["user"]) || !isCanonicalRepository(head["repo"]) || !isCanonicalRepository(base["repo"]) ||
        base["ref"] !== "main" || base["sha"] !== proof.baseSha || head["sha"] !== proof.headSha || head["ref"] !== proof.headBranch || pull["merge_commit_sha"] !== proof.mergeSha) return false;
    const main = fields(await request("GET", `${prefix}/branches/main`));
    const branch = fields(fields(await request("GET", `${prefix}/git/ref/heads/${proof.headBranch}`))["object"]);
    const merge = fields(fields(await request("GET", `${prefix}/git/ref/pull/${proof.number}/merge`))["object"]);
    return main["name"] === "main" && main["protected"] === true && fields(main["commit"])["sha"] === proof.baseSha &&
        branch["type"] === "commit" && branch["sha"] === proof.headSha && merge["type"] === "commit" && merge["sha"] === proof.mergeSha;
}
