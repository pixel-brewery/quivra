// #region Imports
import type { IConfirmedMerge } from "./interfaces/IConfirmedMerge.ts";
import type { IPullRequestAssociation } from "./interfaces/IPullRequestAssociation.ts";
import type { IRequestGitHub } from "./interfaces/IRequestGitHub.ts";
import type { ISkippedMerge } from "./interfaces/ISkippedMerge.ts";
import type { IWorkflowTrigger } from "./interfaces/IWorkflowTrigger.ts";
import { isCanonicalRepository as canonicalRepository } from "./isCanonicalRepository.ts";
import { isDependabotUser as dependabot } from "./isDependabotUser.ts";
import { isNativeCiActor } from "./isNativeCiActor.ts";
import { isNativeCiProofCurrent } from "./isNativeCiProofCurrent.ts";
import { quivraDependabotPolicy } from "./quivraDependabotPolicy.ts";
import { readLatestDependabotRun } from "./readLatestDependabotRun.ts";
import { readNativeCiProof } from "./readNativeCiProof.ts";
import { verifyDependabotProtection } from "./verifyDependabotProtection.ts";
// #endregion

const { repositoryId, repositoryName, repositoryPath, defaultBranch, workflowPath, workflowName, requiredJobs } = quivraDependabotPolicy;
const shaPattern = /^[0-9a-f]{40}$/u;

function fields(value: unknown): Record<string, unknown> {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        return value as Record<string, unknown>;
    }
    return {};
}

function skipped(reason: string): ISkippedMerge {
    return { status: "skipped", reason };
}

function validId(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validSha(value: unknown): value is string {
    return typeof value === "string" && shaPattern.test(value);
}

/**
 * Merges only the latest complete exact-head proof against protected current main.
 * @remarks Preserves all platform jobs, actor identities, rerun attempts and synthetic
 * merge-parent verification. Only actual regular PR CI supplies native branch
 * proof; a head-only diagnostic workflow dispatch never substitutes for that proof.
 * @param payload - Completed CI workflow event supplied by the trusted bootstrap.
 * @param request - Authenticated metadata boundary that executes no PR code.
 * @returns A confirmed protected squash merge or its unsatisfied prerequisite.
 * @throws An error for a failed request or unconfirmed atomic merge.
 * @public
 */
export async function mergeDependabotPullRequest(
    payload: unknown,
    request: IRequestGitHub,
): Promise<IConfirmedMerge | ISkippedMerge> {
    const event = fields(payload);
    const trigger = readTrigger(event["workflow_run"]);
    if (event["action"] !== "completed" || !canonicalRepository(event["repository"]) || !trigger) {
        return skipped("unsupported-event");
    }

    const repo = fields(await request("GET", `repositories/${repositoryId}`));
    if (!canonicalRepository(repo) || repo["default_branch"] !== defaultBranch ||
        repo["private"] !== false || repo["visibility"] !== "public" || repo["fork"] !== false ||
        repo["allow_squash_merge"] !== true) {
        return skipped("unsupported-repository");
    }

    const workflow = fields(await request("GET", `${repositoryPath}/actions/workflows/ci.yml`));
    if (!validId(workflow["id"]) || workflow["path"] !== workflowPath || workflow["name"] !== workflowName ||
        workflow["state"] !== "active") {
        return skipped("unexpected-workflow");
    }

    const runPath = `${repositoryPath}/actions/runs/${trigger.id}`;
    const run = fields(await request("GET", runPath));
    if (!eligibleRun(run, trigger, workflow["id"])) {
        return skipped("ineligible-workflow-run");
    }
    const association = readAssociation(run["pull_requests"], trigger);
    if (!association) {
        return skipped("ineligible-pull-request-association");
    }

    const pullRequestPath = `${repositoryPath}/pulls/${association.number}`;
    const pullRequest = await request("GET", pullRequestPath);
    const mergeSha = readMergeSha(pullRequest, association);
    if (!mergeSha) {
        return skipped("ineligible-pull-request");
    }

    const inventory = await request("GET", `${repositoryPath}/actions/workflows/ci.yml/runs?head_sha=${trigger.headSha}&per_page=100`);
    const latest = readLatestDependabotRun(inventory, workflow["id"], association);
    if (latest?.["id"] !== trigger.id) return skipped("superseded-verification");
    const latestRun = fields(await request("GET", runPath));
    const latestAssociation = readAssociation(latestRun["pull_requests"], trigger);
    if (!eligibleRun(latestRun, trigger, workflow["id"]) || latestAssociation?.number !== association.number || latestAssociation.baseSha !== association.baseSha ||
        (typeof latest["run_attempt"] === "number" && latest["run_attempt"] > trigger.attempt))
        return skipped("superseded-verification");
    const comparison = fields(await request("GET", `${repositoryPath}/compare/${association.baseSha}...${association.headSha}`));
    if (comparison["behind_by"] !== 0 || fields(comparison["merge_base_commit"])["sha"] !== association.baseSha)
        return skipped("stale-head");

    const jobs = await request("GET", `${runPath}/attempts/${trigger.attempt}/jobs?per_page=100`);
    if (!successfulJobs(jobs, trigger)) {
        return skipped("incomplete-verification");
    }

    const protection = await verifyDependabotProtection(request);
    if (protection) {
        return skipped(protection);
    }

    const merge = fields(await request("GET", `${repositoryPath}/git/commits/${mergeSha}`));
    if (merge["sha"] !== mergeSha || !Array.isArray(merge["parents"]) || merge["parents"].length !== 2 ||
        fields(merge["parents"][0])["sha"] !== association.baseSha ||
        fields(merge["parents"][1])["sha"] !== association.headSha) {
        return skipped("unverified-merge-commit");
    }
    const sourceProof = await readNativeCiProof(pullRequest, request);
    if (!sourceProof || sourceProof.baseSha !== association.baseSha || sourceProof.headSha !== association.headSha || sourceProof.mergeSha !== mergeSha)
        return skipped("unverified-native-source");

    // GitHub's merge endpoint checks the expected head atomically. Re-read the
    // merge candidate and base immediately before it. Strict branch rules also
    // prevent a changed main from merging without fresh verification.
    const [currentPullRequest, mainResponse, currentInventory] = await Promise.all([
        request("GET", pullRequestPath),
        request("GET", `${repositoryPath}/branches/${defaultBranch}`),
        request("GET", `${repositoryPath}/actions/workflows/ci.yml/runs?head_sha=${trigger.headSha}&per_page=100`),
    ]);
    const currentLatest = readLatestDependabotRun(currentInventory, workflow["id"], association);
    if (currentLatest?.["id"] !== trigger.id) return skipped("verification-changed");
    const currentRun = fields(await request("GET", runPath));
    const currentAssociation = readAssociation(currentRun["pull_requests"], trigger);
    const main = fields(mainResponse);
    if (!eligibleRun(currentRun, trigger, workflow["id"]) ||
        (typeof currentLatest["run_attempt"] === "number" && currentLatest["run_attempt"] > trigger.attempt) ||
        readMergeSha(currentPullRequest, association) !== mergeSha ||
        currentAssociation?.number !== association.number ||
        currentAssociation.baseSha !== association.baseSha ||
        main["name"] !== defaultBranch || main["protected"] !== true || fields(main["commit"])["sha"] !== association.baseSha) {
        return skipped("verification-changed");
    }

    if (!(await isNativeCiProofCurrent(sourceProof, request))) return skipped("verification-changed");
    const merged = fields(await request("PUT", `${pullRequestPath}/merge`, {
        sha: association.headSha,
        merge_method: "squash",
    }));
    if (merged["merged"] !== true || !validSha(merged["sha"])) {
        throw new Error("GitHub did not confirm the merge. Inspect the pull request before retrying.");
    }
    const confirmed = fields(await request("GET", pullRequestPath));
    const confirmedHead = fields(confirmed["head"]);
    const confirmedBase = fields(confirmed["base"]);
    if (confirmed["number"] !== association.number || confirmed["state"] !== "closed" || confirmed["merged"] !== true || confirmed["merge_commit_sha"] !== merged["sha"] ||
        !dependabot(confirmed["user"]) || confirmedHead["sha"] !== association.headSha || confirmedHead["ref"] !== association.headBranch ||
        !canonicalRepository(confirmedHead["repo"]) || !canonicalRepository(confirmedBase["repo"]) || confirmedBase["ref"] !== defaultBranch)
        throw new Error("GitHub merge confirmation changed. Inspect the pull request before retrying.");
    return { status: "merged", pullRequest: association.number, sha: merged["sha"] };
}

function readTrigger(value: unknown): IWorkflowTrigger | undefined {
    const run = fields(value);
    if (validId(run["id"]) && validId(run["run_attempt"]) && validSha(run["head_sha"]) &&
        typeof run["head_branch"] === "string" && run["head_branch"].startsWith("dependabot/")) {
        return { id: run["id"], attempt: run["run_attempt"], headSha: run["head_sha"], headBranch: run["head_branch"] };
    }
    return undefined;
}

function eligibleRun(run: Record<string, unknown>, trigger: IWorkflowTrigger, workflowId: number): boolean {
    return run["id"] === trigger.id && run["run_attempt"] === trigger.attempt &&
        run["workflow_id"] === workflowId && run["name"] === workflowName &&
        (run["path"] === workflowPath || run["path"] === `${workflowPath}@refs/heads/${trigger.headBranch}`) &&
        run["event"] === "pull_request" && isNativeCiActor(run["actor"]) &&
        run["status"] === "completed" && run["conclusion"] === "success" &&
        canonicalRepository(run["repository"]) && canonicalRepository(run["head_repository"]) &&
        run["head_sha"] === trigger.headSha && run["head_branch"] === trigger.headBranch;
}

function readAssociation(value: unknown, trigger: IWorkflowTrigger): IPullRequestAssociation | undefined {
    if (!Array.isArray(value) || value.length !== 1) {
        return undefined;
    }
    const candidate = fields(value[0]);
    const head = fields(candidate["head"]);
    const base = fields(candidate["base"]);
    if (validId(candidate["number"]) && head["sha"] === trigger.headSha && head["ref"] === trigger.headBranch &&
        base["ref"] === defaultBranch && validSha(base["sha"]) &&
        fields(base["repo"])["id"] === repositoryId && fields(head["repo"])["id"] === repositoryId) {
        return {
            number: candidate["number"],
            headSha: trigger.headSha,
            headBranch: trigger.headBranch,
            baseSha: base["sha"],
        };
    }
    return undefined;
}

function readMergeSha(value: unknown, association: IPullRequestAssociation): string | undefined {
    const pullRequest = fields(value);
    const head = fields(pullRequest["head"]);
    const base = fields(pullRequest["base"]);
    if (pullRequest["number"] === association.number && pullRequest["state"] === "open" &&
        pullRequest["draft"] === false && pullRequest["merged"] === false && pullRequest["mergeable"] === true &&
        dependabot(pullRequest["user"]) && canonicalRepository(head["repo"]) && canonicalRepository(base["repo"]) &&
        base["ref"] === defaultBranch && head["ref"] === association.headBranch && head["sha"] === association.headSha &&
        base["sha"] === association.baseSha && validSha(pullRequest["merge_commit_sha"])) {
        return pullRequest["merge_commit_sha"];
    }
    return undefined;
}

function successfulJobs(value: unknown, trigger: IWorkflowTrigger): boolean {
    const response = fields(value);
    if (response["total_count"] !== requiredJobs.length || !Array.isArray(response["jobs"]) ||
        response["jobs"].length !== requiredJobs.length) {
        return false;
    }
    const pending = new Set<string>(requiredJobs);
    const ids = new Set<number>();
    for (const value of response["jobs"]) {
        const job = fields(value);
        if (typeof job["name"] !== "string" || !pending.delete(job["name"]) || !validId(job["id"]) ||
            ids.has(job["id"]) || job["run_id"] !== trigger.id || job["run_attempt"] !== trigger.attempt ||
            job["head_sha"] !== trigger.headSha || job["status"] !== "completed" || job["conclusion"] !== "success") {
            return false;
        }
        ids.add(job["id"]);
    }
    return pending.size === 0;
}
