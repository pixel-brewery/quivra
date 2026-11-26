// #region Imports
import { createHash } from "node:crypto";
import type { IRequestGitHub } from "./interfaces/IRequestGitHub.ts";
import { normalizeWorkflowActionPins } from "./normalizeWorkflowActionPins.ts";
import { quivraDependabotPolicy as policy } from "./quivraDependabotPolicy.ts";
// #endregion

/**
 * Reads and authenticates the canonical CI workflow as one bounded Git blob.
 *
 * @remarks Read-only authority comes from a fixed, explicitly reviewed digest in
 * trusted-main policy. No YAML/expression heuristic or runtime-learned source can
 * establish that authority. The caller also compares normalized main/head bytes.
 *
 * @param ref - Exact commit containing the workflow; branches are not accepted.
 * @param request - Read-only GitHub metadata boundary.
 * @returns Supported read-only source, or undefined when the blob or policy is invalid.
 * @throws The original metadata request error; failed requests are never approval proof.
 *
 * @public
 */
export async function readReadonlyCiSource(ref: string, request: IRequestGitHub): Promise<string | undefined> {
    if (!/^[a-f0-9]{40}$/u.test(ref)) return undefined;
    const raw = await request("GET", `${policy.repositoryPath}/contents/${policy.workflowPath}?ref=${ref}`);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const file = raw as Record<string, unknown>;
    if (file["type"] !== "file" || file["encoding"] !== "base64" || typeof file["content"] !== "string" || !/^[a-f0-9]{40}$/u.test(String(file["sha"]))) return undefined;
    const bytes = Buffer.from(file["content"], "base64");
    if (!bytes.length || bytes.length > 65_536 || createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== file["sha"]) return undefined;
    const text = bytes.toString("utf8");
    return /^[a-f0-9]{64}$/u.test(policy.reviewedCiSha256) &&
        createHash("sha256").update(normalizeWorkflowActionPins(text)).digest("hex") === policy.reviewedCiSha256 ? text : undefined;
}
