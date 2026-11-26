// #region Imports
import assert from "node:assert/strict";
import { test } from "node:test";
import { requestGitHub } from "./requestGitHub.ts";
// #endregion

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
