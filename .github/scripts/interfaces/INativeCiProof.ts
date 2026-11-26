/**
 * Binds one open bot pull request to its live main, head and synthetic merge.
 *
 * @public
 */
export interface INativeCiProof {
    /**
     * Actual same-repository Dependabot pull request.
     *
     * @public
     */
    readonly number: number;
    /**
     * Current protected main and first synthetic parent.
     *
     * @public
     */
    readonly baseSha: string;
    /**
     * Current own branch head and second synthetic parent.
     *
     * @public
     */
    readonly headSha: string;
    /**
     * Current GitHub pull-request merge ref with the same tree as the updated head.
     *
     * @public
     */
    readonly mergeSha: string;
    /**
     * Exact own Dependabot branch containing the head.
     *
     * @public
     */
    readonly headBranch: string;
}
