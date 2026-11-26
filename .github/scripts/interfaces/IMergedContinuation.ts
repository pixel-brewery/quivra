/**
 * Reports source-bound CI and release requests without duplicating existing runs.
 *
 * @public
 */
export interface IMergedContinuation {
    /**
     * Indicates whether the exact source remains current main.
     * @public
     */
    readonly status: "continued" | "superseded";
    /**
     * Complete protected merge source requested by the successful merger.
     * @public
     */
    readonly sourceSha: string;
    /**
     * Existing workflows newly dispatched for this exact source.
     * @public
     */
    readonly requested: readonly string[];
    /**
     * Workflows with an already retained successful, failed or pending run.
     * @public
     */
    readonly existing: readonly string[];
}
