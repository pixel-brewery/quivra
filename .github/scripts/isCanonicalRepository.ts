// #region Imports
import { quivraDependabotPolicy } from "./quivraDependabotPolicy.ts";
// #endregion

/**
 * Checks both stable repository identity fields rather than trusting a name alone.
 * @param value - GitHub repository metadata from a run, pull request or REST lookup.
 * @returns Whether both identity fields describe the canonical Quivra repository.
 * @public
 */
export function isCanonicalRepository(value: unknown): boolean {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const repository = value as Record<string, unknown>;
    return repository["id"] === quivraDependabotPolicy.repositoryId && repository["full_name"] === quivraDependabotPolicy.repositoryName;
}
