/**
 * Describes a protected merge confirmed by GitHub and its resulting pull request.
 *
 * @public
 */
export interface IConfirmedMerge {
    /**
     * Indicates that GitHub confirmed the squash merge.
     * @public
     */
    readonly status: "merged";
    /**
     * Merged same-repository Dependabot pull-request number.
     * @public
     */
    readonly pullRequest: number;
    /**
     * Complete source SHA used by the post-merge CI and release continuation.
     * @public
     */
    readonly sha: string;
}
