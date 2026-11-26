// #region Imports
import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mergeDependabotPullRequest } from "./mergeDependabotPullRequest.ts";
import { quivraDependabotPolicy as policy } from "./quivraDependabotPolicy.ts";
import { reconcileDependabotBranches } from "./reconcileDependabotBranches.ts";
import { requestGitHub } from "./requestGitHub.ts";
import { requestMergedContinuation } from "./requestMergedContinuation.ts";
// #endregion

/**
 * Runs one trusted native-TypeScript dependency operation without installing code.
 * @param mode - Explicit workflow phase: reconcile branches, merge a verified head, or continue its source.
 * @returns The phase's credential-free metadata outcome.
 * @throws An error for an unsupported context, failed proof or failed API request.
 * @public
 */
export async function runDependabotAutomation(mode: string | undefined): Promise<unknown> {
    const env = process.env;
    if (env["GITHUB_REPOSITORY"] !== policy.repositoryName || env["GITHUB_REPOSITORY_ID"] !== String(policy.repositoryId) ||
        env["QUIVRA_DEPENDABOT_AUTO_MERGE"] !== "true" || !env["GH_TOKEN"] || !env["GITHUB_EVENT_PATH"])
        throw new Error("Dependency automation requires the opted-in canonical workflow context.");
    const eventName = env["GITHUB_EVENT_NAME"];
    if (mode === "reconcile" && ["workflow_run", "workflow_dispatch", "schedule"].includes(String(eventName)))
        return { status: "reconciled", results: await reconcileDependabotBranches(requestGitHub) };
    if (eventName !== "workflow_run") throw new Error("Merge and continuation require a completed CI workflow event.");
    if (mode === "merge") {
        const payload: unknown = JSON.parse(await readFile(env["GITHUB_EVENT_PATH"], "utf8"));
        const result = await mergeDependabotPullRequest(payload, requestGitHub);
        if (env["GITHUB_OUTPUT"]) await appendFile(env["GITHUB_OUTPUT"], `merged=${result.status === "merged"}\n${result.status === "merged" ? `sha=${result.sha}\n` : ""}`);
        return result;
    }
    if (mode === "continue") return requestMergedContinuation(env["SOURCE_SHA"] ?? "", requestGitHub);
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
