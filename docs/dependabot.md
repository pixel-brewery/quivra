# Dependency updates

Dependabot checks Cargo dependencies, npm tooling and GitHub Actions every Monday. Compatible Cargo updates share a pull request; Cargo majors receive individual pull requests under the same verification policy. GitHub Actions and npm tooling updates are grouped. TypeScript and Node type majors have no exclusions. The npm launcher has no hand-maintained runtime dependencies; packaging creates native package references from the release version.

## Automatic merges

When every required check of a Dependabot pull request is green, [Dependabot auto-merge](../.github/workflows/dependabot-merge.yml) squash-merges it; GitHub still enforces the `main` ruleset on that merge. A merge made with the workflow token starts no push workflows, so the same job dispatches CI, **Release Quivra** and, when its paths changed, Pages with the merge commit as `expected_head_sha` or `source_sha`, and each of them checks that input against the commit it runs on. CI completion and an hourly schedule start the workflow, so a pull request that is still waiting for checks is merged on a later run.
