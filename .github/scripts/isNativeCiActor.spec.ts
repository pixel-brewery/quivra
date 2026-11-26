// #region Imports
import assert from "node:assert/strict";
import { test } from "node:test";
import { isNativeCiActor } from "./isNativeCiActor.ts";
// #endregion

test("admits a maintainer's genuine native CI while preserving reserved service identities", () => {
    // Arrange
    const actors = [{ id: 12, login: "maintainer", type: "User" }, { id: 49699333, login: "dependabot[bot]", type: "Bot" }, { id: 41898282, login: "github-actions[bot]", type: "Bot" }];
    // Act and Assert
    for (const actor of actors) assert.equal(isNativeCiActor(actor), true);
});

test("rejects forged service names, invalid IDs and unsupported actor types", () => {
    // Arrange
    const actors = [{ id: 12, login: "dependabot[bot]", type: "Bot" }, { id: 41898282, login: "other", type: "Bot" }, { id: 0, login: "maintainer", type: "User" }, { id: 12, login: "organization", type: "Organization" }];
    // Act and Assert
    for (const actor of actors) assert.equal(isNativeCiActor(actor), false);
});
