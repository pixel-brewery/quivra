/**
 * Reports one bounded authorization of the original read-only PR workflow.
 *
 * @public
 */
export interface INativeCiApprovalResult {
    /**
     * Actual own Dependabot pull request considered by the authorizer.
     *
     * @public
     */
    readonly number: number;
    /**
     * Approval, existing verification or withheld unsafe/missing proof.
     *
     * @public
     */
    readonly status: "approved" | "waiting" | "skipped" | "blocked";
    /**
     * Original native PR run receiving the single approval request.
     *
     * @public
     */
    readonly runId?: number;
    /**
     * Exact current attempt observed immediately before authorization.
     *
     * @public
     */
    readonly attempt?: number;
    /**
     * Non-secret reason why no approval was issued.
     *
     * @public
     */
    readonly reason?: string;
}
