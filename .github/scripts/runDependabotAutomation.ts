// #region Imports
import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { IRequestGitHub } from "./interfaces/IRequestGitHub.ts";
import { approveReadonlyDependabotCi } from "./approveReadonlyDependabotCi.ts";
import { mergeDependabotPullRequest } from "./mergeDependabotPullRequest.ts";
import { quivraDependabotPolicy as policy } from "./quivraDependabotPolicy.ts";
import { readMergedDependabotSource } from "./readMergedDependabotSource.ts";
import { reconcileDependabotBranches } from "./reconcileDependabotBranches.ts";
import { requestGitHub } from "./requestGitHub.ts";
import { requestMergedContinuation } from "./requestMergedContinuation.ts";
// #endregion

/**
 * Runs one trusted native-TypeScript dependency operation without installing code.
 * @param mode - Trusted refresh, native CI authorization, protected merge or source continuation phase.
 * @param request - Metadata boundary; production uses the native workflow token.
 * @returns The phase's credential-free metadata outcome.
 * @throws An error for an unsupported context, failed proof or failed API request.
 * @public
 */
export async function runDependabotAutomation(mode: string | undefined, request: IRequestGitHub = requestGitHub): Promise<unknown> {
    const env = process.env;
    if (env["GITHUB_REPOSITORY"] !== policy.repositoryName || env["GITHUB_REPOSITORY_ID"] !== String(policy.repositoryId) ||
        env["QUIVRA_DEPENDABOT_AUTO_MERGE"] !== "true" || !env["GH_TOKEN"] || !env["GITHUB_EVENT_PATH"])
        throw new Error("Dependency automation requires the opted-in canonical workflow context.");
    const eventName = env["GITHUB_EVENT_NAME"];
    if (mode === "authorize" && ["workflow_run", "workflow_dispatch", "schedule"].includes(String(eventName))) {
        if (env["GITHUB_REF"] !== "refs/heads/main") throw new Error("Native CI authorization requires the default-branch workflow.");
        return { status: "authorized", results: await approveReadonlyDependabotCi(request) };
    }
    if (mode === "reconcile" && ["workflow_run", "workflow_dispatch", "schedule"].includes(String(eventName))) {
        const results = await reconcileDependabotBranches(request);
        const merged = results.filter((result) => result.status === "merged").at(-1);
        const source = merged?.sha ?? await readMergedDependabotSource(request);
        if (source && env["GITHUB_OUTPUT"]) await appendFile(env["GITHUB_OUTPUT"], `sha=${source}\n`);
        return { status: "reconciled", results };
    }
    if (mode === "continue" && ["workflow_run", "workflow_dispatch", "schedule"].includes(String(eventName)))
        return requestMergedContinuation(env["SOURCE_SHA"] ?? "", request);
    if (eventName !== "workflow_run") throw new Error("Merge requires a completed CI workflow event.");
    if (mode === "merge") {
        const payload: unknown = JSON.parse(await readFile(env["GITHUB_EVENT_PATH"], "utf8"));
        const result = await mergeDependabotPullRequest(payload, request);
        if (env["GITHUB_OUTPUT"]) await appendFile(env["GITHUB_OUTPUT"], `merged=${result.status === "merged"}\n${result.status === "merged" ? `sha=${result.sha}\n` : ""}`);
        return result;
    }
    throw new Error("Unsupported dependency workflow operation.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    try {
        if (process.argv.length !== 2) throw new Error("Unexpected dependency automation arguments.");
        console.log(JSON.stringify(await runDependabotAutomation(process.env["DEPENDABOT_MODE"])));
    } catch (error) {
        console.error(error instanceof Error ? error.message : "Dependency automation failed.");
        process.exitCode = 1;
    }
}
