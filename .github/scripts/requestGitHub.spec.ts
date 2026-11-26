// #region Imports
import assert from "node:assert/strict";
import { test } from "node:test";
import { requestGitHub } from "./requestGitHub.ts";
// #endregion

test("pins the supported PR response contract that retains the required merge SHA", async (context) => {
    // Arrange
    const mergeSha = "c".repeat(40);
    context.mock.method(globalThis, "fetch", async (...args: Parameters<typeof fetch>) => {
        const version = new Headers(args[1]?.headers).get("X-GitHub-Api-Version");
        assert.equal(version, "2022-11-28");
        return Response.json(version === "2022-11-28" ? { merge_commit_sha: mergeSha } : {});
    });
    // Act
    const result = await requestGitHub("GET", "repos/pixel-brewery/quivra/pulls/16");
    // Assert
    assert.deepEqual(result, { merge_commit_sha: mergeSha });
});

test("accepts successful empty dispatch responses without parsing nonexistent JSON", async (context) => {
    // Arrange
    context.mock.method(globalThis, "fetch", async () => new Response(null, { status: 204 }));
    // Act
    const result = await requestGitHub("POST", "repos/pixel-brewery/quivra/actions/workflows/ci.yml/dispatches", { ref: "main" });
    // Assert
    assert.equal(result, undefined);
});

test("retains a public HTTP status without disclosing the response payload", async (context) => {
    // Arrange
    const response = new Response("private-response-fixture", { status: 403 });
    context.mock.method(globalThis, "fetch", async () => response);
    // Act and Assert
    await assert.rejects(requestGitHub("GET", "repos/pixel-brewery/quivra/branches/main"), (error: unknown) =>
        error instanceof Error && error.message.includes("HTTP 403") && !error.message.includes("private-response-fixture"));
    assert.equal(response.bodyUsed, false);
});
