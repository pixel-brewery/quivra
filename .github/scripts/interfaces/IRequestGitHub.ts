// #region Imports
import type { ApiMethod } from "../types/ApiMethod.ts";
// #endregion

/**
 * Supplies the authenticated metadata boundary without loading pull-request code.
 *
 * @public
 */
export interface IRequestGitHub {
    /**
     * Performs one bounded GitHub REST operation.
     * @param method - Read, branch refresh, dispatch or protected merge operation.
     * @param endpoint - Relative API endpoint owned by the fixed repository policy.
     * @param body - Optional JSON request payload.
     * @returns Decoded JSON, or undefined for a successful empty response.
     * @throws An error containing a public status code when the request fails.
     * @public
     */
    (method: ApiMethod, endpoint: string, body?: object): Promise<unknown>;
}
