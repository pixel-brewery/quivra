// #region Imports
import type { ApiMethod } from "./types/ApiMethod.ts";
// #endregion

/**
 * Calls GitHub with the native workflow token and a bounded metadata-only request.
 * @param method - Explicit operation chosen by the trusted automation owner.
 * @param endpoint - Relative GitHub REST endpoint.
 * @param body - Optional JSON request body.
 * @returns Parsed JSON or undefined for a successful empty dispatch/update response.
 * @remarks The controller pins the supported 2022-11-28 PR response contract,
 * including its synthetic/confirmed merge SHA. Changing this API version requires
 * an explicit response-contract migration; guard fields must remain available.
 * @throws An error with method, endpoint and HTTP status, without response payloads.
 * @public
 */
export async function requestGitHub(method: ApiMethod, endpoint: string, body?: object): Promise<unknown> {
    const response = await fetch(`https://api.github.com/${endpoint}`, {
        method, redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: {
            Accept: "application/vnd.github+json", Authorization: `Bearer ${process.env["GH_TOKEN"]}`,
            "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw Object.assign(new Error(`GitHub API ${method} ${endpoint} failed with HTTP ${response.status}.`), { status: response.status });
    if (response.status === 204 || response.headers.get("content-length") === "0") return undefined;
    const text = await response.text();
    return text ? JSON.parse(text) : undefined;
}
