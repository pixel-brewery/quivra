/**
 * Defines the immutable repository, actor and full-verification identities.
 *
 * @public
 */
export const quivraDependabotPolicy = {
    repositoryId: 1457527723,
    repositoryName: "pixel-brewery/quivra",
    repositoryPath: "repos/pixel-brewery/quivra",
    defaultBranch: "main",
    dependabotId: 49699333,
    githubActionsId: 41898282,
    actionsAppId: 15368,
    workflowPath: ".github/workflows/ci.yml",
    workflowName: "CI",
    /**
     * SHA-256 of the explicitly reviewed CI after immutable action-pin normalization.
     *
     * @remarks Reviewed at protected main 7329fa32cb0be86bcaa5a677f6cb07586b081b21.
     * Root contents:read and the empty Quality Gate permissions grant no writes;
     * no custom secrets, environment binding or reusable job is present. Changes
     * to CI logic require another deliberate review and trusted-policy update.
     * This value must never be learned from an API response or PR configuration.
     *
     * @public
     */
    reviewedCiSha256: "8d8352ccad281ac326275ca5613db80270f684f38e8f81ca8f37821f9a7625b5",
    qualityGate: "Quality Gate",
    requiredJobs: ["Verify (ubuntu-24.04)", "Verify (macos-15)", "Verify (windows-2025)", "Quality Gate"],
} as const;
