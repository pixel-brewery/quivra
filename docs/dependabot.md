# Dependency updates

Dependabot checks Cargo dependencies and GitHub Actions every Monday. Compatible Cargo updates share a pull request, while major Cargo updates get individual review. GitHub Actions updates are grouped. The npm launcher has no registry dependencies of its own. Packaging generates the native package references from the release version.

## Enable automatic merges

For the canonical public repository, a maintainer can set the Actions repository variable `QUIVRA_DEPENDABOT_AUTO_MERGE` to `true` once an active repository ruleset protects `main` with a strict `Quality Gate` status check from the GitHub Actions app. Configure that status rule without bypass actors. The workflow checks the rules through GitHub before it attempts to merge. [GitHub rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository) · [GitHub Actions variables](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-variables)

The workflow considers one same-repository Dependabot pull request after CI succeeds. It checks the successful run attempt, all three platform jobs, `Quality Gate`, and the current head, base and merge candidate. It squash-merges the verified head through GitHub's normal branch checks. Ambiguous or stale metadata leaves the pull request open for another CI run or manual review. Required reviews and other active branch rules still apply.

Quivra's release workflow remains separately dispatched. A dependency merge does not request a release.
