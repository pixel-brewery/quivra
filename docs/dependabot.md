# Dependency updates

Dependabot checks Cargo dependencies, npm tooling and GitHub Actions every Monday. Compatible Cargo updates share a pull request, while major Cargo updates get individual review. GitHub Actions updates are grouped. The npm launcher has no hand-maintained runtime dependencies. TypeScript upgrades are selected explicitly. Packaging generates the native package references from the release version.

## Enable automatic merges

For the canonical public repository, a maintainer can set the Actions repository variable `QUIVRA_DEPENDABOT_AUTO_MERGE` to `true` once an active repository ruleset protects `main` with a strict `Quality Gate` status check from the GitHub Actions app. Keep that status rule free of bypass actors. The workflow checks the active rule through GitHub before submitting the exact head to the standard merge API. [GitHub rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository) · [GitHub Actions variables](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-variables)

The workflow considers one same-repository Dependabot pull request after CI succeeds. It checks the successful run attempt, all three platform jobs, `Quality Gate`, and the current head, base and merge candidate. It squash-merges the verified head through GitHub's normal branch checks. Ambiguous or stale metadata leaves the pull request open for another CI run or manual review. Required reviews and other active branch rules still apply.

After a successful dependency merge, a separate job requests publication for that exact `main` commit. Retry a failed release from its original run to reuse the verified artifacts.
