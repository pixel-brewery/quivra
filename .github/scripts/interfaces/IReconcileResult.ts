/**
 * Reports one dependency branch's refresh, verification or fully protected merge.
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
     * Current refresh, verification or protected-merge outcome.
     * @public
     */
    readonly status: "skipped" | "waiting" | "blocked" | "verification-requested" | "merged";
    /**
     * Diagnostic for a deferred, invalid or conflicted candidate.
     * @public
     */
    readonly reason?: string;
    /**
     * Exact head requested for verification or confirmed by the native merge proof.
     * @public
     */
    readonly head?: string;
    /**
     * Exact protected merge confirmed by the native merger, for source continuation.
     *
     * @public
     */
    readonly sha?: string;
}
