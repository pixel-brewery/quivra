/**
 * Reports a withheld merge without weakening its missing verification proof.
 *
 * @public
 */
export interface ISkippedMerge {
    /**
     * Indicates that no merge was performed.
     * @public
     */
    readonly status: "skipped";
    /**
     * Stable diagnostic identifying the unsatisfied prerequisite.
     * @public
     */
    readonly reason: string;
}
