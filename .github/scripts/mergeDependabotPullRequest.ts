import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repositoryId = 1457527723;
const repositoryName = "pixel-brewery/quivra";
const repositoryPath = `repos/${repositoryName}`;
const defaultBranch = "main";
const dependabotId = 49699333;
const actionsAppId = 15368;
const workflowPath = ".github/workflows/ci.yml";
const workflowName = "CI";
const qualityGate = "Quality Gate";
const requiredJobs = ["Verify (ubuntu-24.04)", "Verify (macos-15)", "Verify (windows-2025)", qualityGate];
const shaPattern = /^[0-9a-f]{40}$/u;

type ApiMethod = "GET" | "PUT";
type RequestGitHub = (method: ApiMethod, endpoint: string, body?: object) => Promise<unknown>;

interface IWorkflowTrigger {
    id: number;
    attempt: number;
    headSha: string;
    headBranch: string;
}

interface IPullRequestAssociation {
    number: number;
    headSha: string;
    headBranch: string;
    baseSha: string;
}

interface ISkippedMerge {
    status: "skipped";
    reason: string;
}

interface IConfirmedMerge {
    status: "merged";
    pullRequest: number;
    sha: string;
}

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

function canonicalRepository(value: unknown): boolean {
    const repository = fields(value);
    return repository["id"] === repositoryId && repository["full_name"] === repositoryName;
}

function dependabot(value: unknown): boolean {
    const user = fields(value);
    return user["id"] === dependabotId && user["login"] === "dependabot[bot]" && user["type"] === "Bot";
}

export async function mergeDependabotPullRequest(
    payload: unknown,
    request: RequestGitHub,
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
    const mergeSha = readMergeSha(await request("GET", pullRequestPath), association);
    if (!mergeSha) {
        return skipped("ineligible-pull-request");
    }

    const jobs = await request("GET", `${runPath}/attempts/${trigger.attempt}/jobs?per_page=100`);
    if (!successfulJobs(jobs, trigger)) {
        return skipped("incomplete-verification");
    }

    const protection = await verifyProtection(request);
    if (protection) {
        return skipped(protection);
    }

    const merge = fields(await request("GET", `${repositoryPath}/git/commits/${mergeSha}`));
    if (merge["sha"] !== mergeSha || !Array.isArray(merge["parents"]) || merge["parents"].length !== 2 ||
        fields(merge["parents"][0])["sha"] !== association.baseSha ||
        fields(merge["parents"][1])["sha"] !== association.headSha) {
        return skipped("unverified-merge-commit");
    }

    // GitHub's merge endpoint checks the expected head atomically. Re-read the
    // merge candidate and base immediately before it. Strict branch rules also
    // prevent a changed main from merging without fresh verification.
    const [runResponse, currentPullRequest, mainResponse] = await Promise.all([
        request("GET", runPath),
        request("GET", pullRequestPath),
        request("GET", `${repositoryPath}/branches/${defaultBranch}`),
    ]);
    const currentRun = fields(runResponse);
    const currentAssociation = readAssociation(currentRun["pull_requests"], trigger);
    const main = fields(mainResponse);
    if (!eligibleRun(currentRun, trigger, workflow["id"]) ||
        readMergeSha(currentPullRequest, association) !== mergeSha ||
        currentAssociation?.number !== association.number ||
        currentAssociation.baseSha !== association.baseSha ||
        main["name"] !== defaultBranch || main["protected"] !== true || fields(main["commit"])["sha"] !== association.baseSha) {
        return skipped("verification-changed");
    }

    const merged = fields(await request("PUT", `${pullRequestPath}/merge`, {
        sha: association.headSha,
        merge_method: "squash",
    }));
    if (merged["merged"] !== true || !validSha(merged["sha"])) {
        throw new Error("GitHub did not confirm the merge. Inspect the pull request before retrying.");
    }
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
        run["event"] === "pull_request" && run["status"] === "completed" && run["conclusion"] === "success" &&
        canonicalRepository(run["repository"]) && canonicalRepository(run["head_repository"]) &&
        dependabot(run["actor"]) && run["head_sha"] === trigger.headSha && run["head_branch"] === trigger.headBranch;
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
    const pending = new Set(requiredJobs);
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

async function verifyProtection(request: RequestGitHub): Promise<string | undefined> {
    try {
        const rules = await request("GET", `${repositoryPath}/rules/branches/${defaultBranch}?per_page=100`);
        if (!Array.isArray(rules)) {
            return "invalid-main-protection";
        }
        if (!rules.some(isStrictQualityGateRule)) {
            return "missing-strict-quality-gate";
        }
        // GitHub omits bypass actors for read-only callers. The maintainer
        // configures the ruleset without bypass actors before opting in.
        // Check the active rule and submit the exact head to the normal merge API.
        return undefined;
    } catch (error) {
        const status = fields(error)["status"];
        if (status === 403 || status === 404) {
            return "main-protection-unavailable";
        }
        throw error;
    }
}

function isStrictQualityGateRule(value: unknown): boolean {
    const rule = fields(value);
    const parameters = fields(rule["parameters"]);
    const checks = parameters["required_status_checks"];
    return rule["type"] === "required_status_checks" && rule["ruleset_source_type"] === "Repository" &&
        rule["ruleset_source"] === repositoryName && validId(rule["ruleset_id"]) &&
        parameters["strict_required_status_checks_policy"] === true &&
        Array.isArray(checks) && checks.some((value: unknown) => {
            const check = fields(value);
            return check["context"] === qualityGate && check["integration_id"] === actionsAppId;
        });
}

async function requestGitHub(method: ApiMethod, endpoint: string, body?: object): Promise<unknown> {
    const response = await fetch(`https://api.github.com/${endpoint}`, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${process.env["GH_TOKEN"]}`,
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2026-03-10",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
        throw Object.assign(
            new Error(`GitHub API ${method} ${endpoint} failed with HTTP ${response.status}.`),
            { status: response.status },
        );
    }
    return response.json();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    try {
        const env = process.env;
        if (env["GITHUB_EVENT_NAME"] !== "workflow_run" || env["GITHUB_REPOSITORY"] !== repositoryName ||
            env["GITHUB_REPOSITORY_ID"] !== String(repositoryId) ||
            env["QUIVRA_DEPENDABOT_AUTO_MERGE"] !== "true" || !env["GH_TOKEN"] ||
            !env["GITHUB_EVENT_PATH"]) {
            throw new Error("Dependabot merge requires the opted-in workflow_run context.");
        }
        const event: unknown = JSON.parse(await readFile(env["GITHUB_EVENT_PATH"], "utf8"));
        console.log(JSON.stringify(await mergeDependabotPullRequest(event, requestGitHub)));
    } catch (error) {
        console.error(error instanceof Error ? error.message : "Dependabot merge failed.");
        process.exitCode = 1;
    }
}
