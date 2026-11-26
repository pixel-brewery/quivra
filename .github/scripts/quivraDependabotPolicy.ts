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
    qualityGate: "Quality Gate",
    requiredJobs: ["Verify (ubuntu-24.04)", "Verify (macos-15)", "Verify (windows-2025)", "Quality Gate"],
} as const;
