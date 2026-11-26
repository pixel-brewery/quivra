// #region Imports
import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeWorkflowActionPins } from "./normalizeWorkflowActionPins.ts";
// #endregion

const line = `      - uses: actions/checkout@${"a".repeat(40)} # v7.0.1`;

test("permits only full immutable action pin and plain version-comment changes", () => {
    // Arrange
    const next = line.replace("a".repeat(40), "b".repeat(40)).replace("v7.0.1", "v8.0.0");
    // Act and Assert
    assert.equal(normalizeWorkflowActionPins(line), normalizeWorkflowActionPins(next));
});

for (const [name, changed] of [
    ["owner", line.replace("actions/", "other/")],
    ["action path", line.replace("checkout@", "checkout/subaction@")],
    ["mutable revision", line.replace("a".repeat(40), "main")],
    ["extra comment", line.replace("v7.0.1", "v7.0.1 execute-new-code")],
    ["source command", `${line}\n        run: changed`],
] as const) test(`retains ${name} as a material workflow difference`, () => {
    // Arrange and Act
    const normalized = normalizeWorkflowActionPins(changed);
    // Assert
    assert.notEqual(normalized, normalizeWorkflowActionPins(line));
});
