// #region Imports
import { quivraDependabotPolicy } from "./quivraDependabotPolicy.ts";
// #endregion

/**
 * Checks the service actor allowed to dispatch fresh native-token verification.
 * @param value - Actor metadata fetched from the actual workflow run.
 * @returns Whether the actor is GitHub Actions' immutable bot account.
 * @public
 */
export function isGitHubActionsUser(value: unknown): boolean {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const user = value as Record<string, unknown>;
    return user["id"] === quivraDependabotPolicy.githubActionsId && user["login"] === "github-actions[bot]" && user["type"] === "Bot";
}
