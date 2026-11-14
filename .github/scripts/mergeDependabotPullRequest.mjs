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

const skipped = (reason) => ({ status: "skipped", reason });
const validId = (id) => Number.isSafeInteger(id) && id > 0;
const canonicalRepository = (repo) => repo?.id === repositoryId && repo?.full_name === repositoryName;
const canonicalPublicRepository = (repo) =>
    canonicalRepository(repo) && repo.default_branch === defaultBranch &&
    repo.private === false && repo.visibility === "public" && repo.fork === false;
const dependabot = (user) => user?.id === dependabotId && user?.login === "dependabot[bot]" && user?.type === "Bot";

export async function mergeDependabotPullRequest(event, request) {
    const originalRun = event?.workflow_run;
    if (event?.action !== "completed" || !canonicalRepository(event.repository) ||
        !validId(originalRun?.id) || !validId(originalRun?.run_attempt)) {
        return skipped("unsupported-event");
    }
    const repo = await request("GET", `repositories/${repositoryId}`);
    if (!canonicalPublicRepository(repo) || repo.allow_squash_merge !== true) {
        return skipped("unsupported-repository");
    }

    const workflow = await request("GET", `${repositoryPath}/actions/workflows/ci.yml`);
    if (!validId(workflow?.id) || workflow.path !== workflowPath || workflow.name !== workflowName ||
        workflow.state !== "active") {
        return skipped("unexpected-workflow");
    }

    const runPath = `${repositoryPath}/actions/runs/${originalRun.id}`;
    const run = await request("GET", runPath);
    if (!eligibleRun(run, originalRun, workflow)) {
        return skipped("ineligible-workflow-run");
    }
    const pullRequests = run.pull_requests;
    if (!Array.isArray(pullRequests) || pullRequests.length !== 1 ||
        !validId(pullRequests[0]?.number)) {
        return skipped("ambiguous-pull-request");
    }
    const [association] = pullRequests;
    if (association.head?.sha !== run.head_sha || association.head?.ref !== run.head_branch ||
        association.base?.ref !== defaultBranch || !shaPattern.test(association.base?.sha ?? "") ||
        association.base?.repo?.id !== repositoryId || association.head?.repo?.id !== repositoryId) {
        return skipped("ineligible-pull-request-association");
    }

    const pullRequestPath = `${repositoryPath}/pulls/${association.number}`;
    const pullRequest = await request("GET", pullRequestPath);
    if (!eligiblePullRequest(pullRequest, association)) {
        return skipped("ineligible-pull-request");
    }

    const jobs = await request("GET", `${runPath}/attempts/${run.run_attempt}/jobs?per_page=100`);
    if (!successfulJobs(jobs, run)) {
        return skipped("incomplete-verification");
    }

    const protection = await verifyProtection(request);
    if (protection) {
        return skipped(protection);
    }
    const mainPath = `${repositoryPath}/branches/${defaultBranch}`;
    const merge = await request("GET", `${repositoryPath}/git/commits/${pullRequest.merge_commit_sha}`);
    if (merge?.sha !== pullRequest.merge_commit_sha ||
        !Array.isArray(merge.parents) || merge.parents.length !== 2 ||
        merge.parents[0]?.sha !== association.base.sha || merge.parents[1]?.sha !== run.head_sha) {
        return skipped("unverified-merge-commit");
    }

    // GitHub's merge endpoint checks the expected head atomically. Re-read the
    // merge candidate and base immediately before it. Strict branch rules also
    // prevent a changed main from merging without fresh verification.
    const [currentRun, currentPullRequest, main] = await Promise.all([
        request("GET", runPath),
        request("GET", pullRequestPath),
        request("GET", mainPath),
    ]);
    if (!eligibleRun(currentRun, originalRun, workflow) ||
        !eligiblePullRequest(currentPullRequest, association) ||
        currentPullRequest.merge_commit_sha !== pullRequest.merge_commit_sha ||
        currentRun.pull_requests?.length !== 1 ||
        currentRun.pull_requests[0]?.number !== association.number ||
        currentRun.pull_requests[0]?.base?.sha !== association.base.sha ||
        main?.name !== defaultBranch || main.protected !== true || main.commit?.sha !== association.base.sha) {
        return skipped("verification-changed");
    }

    const merged = await request("PUT", `${pullRequestPath}/merge`, {
        sha: run.head_sha,
        merge_method: "squash",
    });
    if (merged?.merged !== true || !shaPattern.test(merged.sha ?? "")) {
        throw new Error("GitHub did not confirm the merge. Inspect the pull request before retrying.");
    }
    return { status: "merged", pullRequest: association.number, sha: merged.sha };
}

function eligibleRun(run, originalRun, workflow) {
    return run?.id === originalRun.id && run.run_attempt === originalRun.run_attempt &&
        run.workflow_id === workflow.id && run.name === workflow.name &&
        (run.path === workflowPath || run.path === `${workflowPath}@refs/heads/${run.head_branch}`) &&
        run.event === "pull_request" && run.status === "completed" && run.conclusion === "success" &&
        canonicalRepository(run.repository) && canonicalRepository(run.head_repository) &&
        dependabot(run.actor) && run.head_sha === originalRun.head_sha && shaPattern.test(run.head_sha) &&
        run.head_branch === originalRun.head_branch && /^dependabot\//u.test(run.head_branch ?? "");
}

function eligiblePullRequest(pullRequest, association) {
    return pullRequest?.number === association.number && pullRequest.state === "open" &&
        pullRequest.draft === false && pullRequest.merged === false && pullRequest.mergeable === true &&
        dependabot(pullRequest.user) && canonicalRepository(pullRequest.head?.repo) &&
        canonicalRepository(pullRequest.base?.repo) && pullRequest.base.ref === defaultBranch &&
        pullRequest.head.ref === association.head.ref && pullRequest.head.sha === association.head.sha &&
        pullRequest.base.sha === association.base.sha && shaPattern.test(pullRequest.merge_commit_sha ?? "");
}

function successfulJobs(jobs, run) {
    if (jobs?.total_count !== requiredJobs.length || !Array.isArray(jobs.jobs) ||
        jobs.jobs.length !== requiredJobs.length) {
        return false;
    }
    const pending = new Set(requiredJobs);
    const ids = new Set();
    for (const job of jobs.jobs) {
        if (!pending.delete(job?.name) || !validId(job.id) || ids.has(job.id) ||
            job.run_id !== run.id || job.run_attempt !== run.run_attempt ||
            job.head_sha !== run.head_sha || job.status !== "completed" || job.conclusion !== "success") {
            return false;
        }
        ids.add(job.id);
    }
    return pending.size === 0;
}

async function verifyProtection(request) {
    try {
        const rules = await request("GET", `${repositoryPath}/rules/branches/${defaultBranch}?per_page=100`);
        if (!Array.isArray(rules)) {
            return "invalid-main-protection";
        }
        const statusRule = rules.find((rule) =>
            rule.type === "required_status_checks" && rule.ruleset_source_type === "Repository" &&
            rule.ruleset_source === repositoryName && validId(rule.ruleset_id) &&
            rule.parameters?.strict_required_status_checks_policy === true &&
            rule.parameters.required_status_checks?.some((check) =>
                check.context === qualityGate && check.integration_id === actionsAppId));
        if (!statusRule) {
            return "missing-strict-quality-gate";
        }
        // GitHub omits bypass actors for read-only callers. The maintainer
        // configures the ruleset without bypass actors before opting in.
        // Check the active rule and submit the exact head to the normal merge API.
        return undefined;
    } catch (error) {
        if ([403, 404].includes(error.status)) {
            return "main-protection-unavailable";
        }
        throw error;
    }
}

async function requestGitHub(method, endpoint, body) {
    const response = await fetch(`https://api.github.com/${endpoint}`, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${process.env.GH_TOKEN}`,
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2026-03-10",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
        const error = new Error(`GitHub API ${method} ${endpoint} failed with HTTP ${response.status}.`);
        error.status = response.status;
        throw error;
    }
    return response.json();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    try {
        const env = process.env;
        if (env.GITHUB_EVENT_NAME !== "workflow_run" || env.GITHUB_REPOSITORY !== repositoryName ||
            env.GITHUB_REPOSITORY_ID !== String(repositoryId) ||
            env.QUIVRA_DEPENDABOT_AUTO_MERGE !== "true" || !env.GH_TOKEN) {
            throw new Error("Dependabot merge requires the opted-in workflow_run context.");
        }
        const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8"));
        console.log(JSON.stringify(await mergeDependabotPullRequest(event, requestGitHub)));
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
