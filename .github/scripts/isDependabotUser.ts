// #region Imports
import { quivraDependabotPolicy } from "./quivraDependabotPolicy.ts";
// #endregion

/**
 * Checks Dependabot's immutable actor identifier, reserved login and bot type.
 * @param value - GitHub actor or pull-request-author metadata.
 * @returns Whether the metadata identifies the actual Dependabot service account.
 * @public
 */
export function isDependabotUser(value: unknown): boolean {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const user = value as Record<string, unknown>;
    return user["id"] === quivraDependabotPolicy.dependabotId && user["login"] === "dependabot[bot]" && user["type"] === "Bot";
}
