// #region Imports
import { isDependabotUser } from "./isDependabotUser.ts";
import { isGitHubActionsUser } from "./isGitHubActionsUser.ts";
// #endregion

/**
 * Accepts a real native-CI actor without excluding a maintainer's bot-branch fix.
 *
 * @param value - Actor metadata returned by GitHub for the actual native PR run.
 * @returns Whether the actor has a positive identity and supported service/user type.
 * Reserved service identities retain their immutable identifier checks.
 *
 * @public
 */
export function isNativeCiActor(value: unknown): boolean {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const actor = value as Record<string, unknown>;
    if (actor["id"] === 49699333 || actor["login"] === "dependabot[bot]") return isDependabotUser(value);
    if (actor["id"] === 41898282 || actor["login"] === "github-actions[bot]") return isGitHubActionsUser(value);
    return typeof actor["id"] === "number" && Number.isSafeInteger(actor["id"]) && actor["id"] > 0 &&
        typeof actor["login"] === "string" && actor["login"].length > 0 && ["Bot", "User"].includes(String(actor["type"]));
}
