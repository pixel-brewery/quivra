/**
 * Reports one dependency branch's metadata reconciliation without merging it.
 *
 * @public
 */
export interface IReconcileResult {
    /**
     * Pull request inspected in the canonical repository.
     * @public
     */
    readonly number: number;
    /**
     * Current refresh or verification outcome.
     * @public
     */
    readonly status: "skipped" | "waiting" | "blocked" | "verification-requested";
    /**
     * Diagnostic for a deferred, invalid or conflicted candidate.
     * @public
     */
    readonly reason?: string;
    /**
     * Exact head explicitly requested for a new read-only CI run.
     * @public
     */
    readonly head?: string;
}
