// #region Imports
import type { INativeCiProof } from "./interfaces/INativeCiProof.ts";
import type { IRequestGitHub } from "./interfaces/IRequestGitHub.ts";
import { isCanonicalRepository } from "./isCanonicalRepository.ts";
import { isDependabotUser } from "./isDependabotUser.ts";
import { normalizeWorkflowActionPins } from "./normalizeWorkflowActionPins.ts";
import { quivraDependabotPolicy as policy } from "./quivraDependabotPolicy.ts";
import { readReadonlyCiSource } from "./readReadonlyCiSource.ts";
// #endregion

const fields = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const validSha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);

/**
 * Proves live M/B/C identity, unique bot association and the canonical read-only CI.
 *
 * @remarks This is the native TypeScript adaptation of the shared Cursor authorizer
 * proof. Both callers still apply their own run/attempt and branch-protection gates.
 * No source, dependency or workflow from a pull request is executed here.
 *
 * @param value - Full current pull-request metadata from the canonical repository.
 * @param request - GitHub metadata boundary; this function performs only reads.
 * @returns The exact live proof, or undefined when any association or source changed.
 * @throws A metadata request error instead of treating unavailable evidence as safe.
 *
 * @public
 */
export async function readNativeCiProof(value: unknown, request: IRequestGitHub): Promise<INativeCiProof | undefined> {
    const pull = fields(value), head = fields(pull["head"]), base = fields(pull["base"]);
    const number = pull["number"], branch = head["ref"], B = head["sha"], C = pull["merge_commit_sha"];
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0 || pull["state"] !== "open" || pull["draft"] !== false || pull["merged"] !== false || pull["mergeable"] !== true ||
        !isDependabotUser(pull["user"]) || !isCanonicalRepository(head["repo"]) || !isCanonicalRepository(base["repo"]) || base["ref"] !== "main" ||
        typeof branch !== "string" || !/^dependabot\/[a-zA-Z0-9_./-]+$/u.test(branch) || branch.includes("..") || branch.includes("//") || !validSha(B) || !validSha(C)) return undefined;
    const prefix = policy.repositoryPath;
    const main = fields(await request("GET", `${prefix}/branches/main`));
    const M = fields(main["commit"])["sha"];
    if (main["name"] !== "main" || main["protected"] !== true || !validSha(M) || base["sha"] !== M) return undefined;
    const ownRef = fields(fields(await request("GET", `${prefix}/git/ref/heads/${branch}`))["object"]);
    const mergeRef = fields(fields(await request("GET", `${prefix}/git/ref/pull/${number}/merge`))["object"]);
    if (ownRef["type"] !== "commit" || ownRef["sha"] !== B || mergeRef["type"] !== "commit" || mergeRef["sha"] !== C) return undefined;
    const comparison = fields(await request("GET", `${prefix}/compare/${M}...${B}`));
    if (comparison["behind_by"] !== 0 || fields(comparison["merge_base_commit"])["sha"] !== M) return undefined;
    const candidate = fields(await request("GET", `${prefix}/git/commits/${B}`));
    const merge = fields(await request("GET", `${prefix}/git/commits/${C}`));
    const tree = fields(candidate["tree"])["sha"];
    if (candidate["sha"] !== B || merge["sha"] !== C || !validSha(tree) || fields(merge["tree"])["sha"] !== tree || !Array.isArray(merge["parents"]) || merge["parents"].length !== 2 ||
        fields(merge["parents"][0])["sha"] !== M || fields(merge["parents"][1])["sha"] !== B) return undefined;
    const baseline = await readReadonlyCiSource(M, request);
    const proposed = await readReadonlyCiSource(B, request);
    if (!baseline || !proposed || normalizeWorkflowActionPins(baseline) !== normalizeWorkflowActionPins(proposed)) return undefined;
    const associated = await request("GET", `${prefix}/commits/${B}/pulls?per_page=100`);
    if (!Array.isArray(associated) || associated.length >= 100) return undefined;
    const matches = associated.filter((item: unknown) => {
        const related = fields(item), relatedHead = fields(related["head"]), relatedBase = fields(related["base"]);
        return related["state"] === "open" && related["draft"] === false && related["merged"] !== true && related["merged_at"] == null &&
            isDependabotUser(related["user"]) && isCanonicalRepository(relatedHead["repo"]) && isCanonicalRepository(relatedBase["repo"]) &&
            relatedHead["sha"] === B && typeof relatedHead["ref"] === "string" && /^dependabot\/[a-zA-Z0-9_./-]+$/u.test(relatedHead["ref"]) && relatedBase["ref"] === "main";
    });
    if (matches.length !== 1 || fields(matches[0])["number"] !== number) return undefined;
    return { number, baseSha: M, headSha: B, mergeSha: C, headBranch: branch };
}
