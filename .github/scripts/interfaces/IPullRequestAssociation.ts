/**
 * Binds a verified CI source to exactly one protected-main dependency candidate.
 *
 * @public
 */
export interface IPullRequestAssociation {
    /**
     * Positive pull-request number in the fixed repository.
     * @public
     */
    readonly number: number;
    /**
     * Verified Dependabot source SHA.
     * @public
     */
    readonly headSha: string;
    /**
     * Verified Dependabot branch name.
     * @public
     */
    readonly headBranch: string;
    /**
     * Current main SHA and first parent of the synthetic merge candidate.
     * @public
     */
    readonly baseSha: string;
}
