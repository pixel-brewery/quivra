/**
 * Identifies the exact CI attempt whose head and current state must be verified.
 *
 * @public
 */
export interface IWorkflowTrigger {
    /**
     * Immutable workflow-run identifier.
     * @public
     */
    readonly id: number;
    /**
     * Exact run attempt, including reruns.
     * @public
     */
    readonly attempt: number;
    /**
     * Complete SHA of the source verified by that attempt.
     * @public
     */
    readonly headSha: string;
    /**
     * Same-repository Dependabot branch containing the verified source.
     * @public
     */
    readonly headBranch: string;
}
