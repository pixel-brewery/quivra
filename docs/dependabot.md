# Dependency updates

Dependabot checks Cargo dependencies, npm tooling and GitHub Actions every Monday. Compatible Cargo updates share a pull request; Cargo majors receive individual pull requests under the same verification policy. GitHub Actions and npm tooling updates are grouped. TypeScript and Node type majors have no exclusions. The npm launcher has no hand-maintained runtime dependencies; packaging creates native package references from the release version.

## Enable automatic merges

The canonical public repository opts in with the Actions variable `QUIVRA_DEPENDABOT_AUTO_MERGE=true`. An active repository ruleset must protect `main` with a strict `Quality Gate` from the GitHub Actions app. Dependency automation uses the normal protected merge endpoint and has no bypass. The existing release App retains its separate authority for verified version commits, as described in the [release guide](ci-cd.md#publish-from-protected-main). The automation reads the effective status-check rule before refreshing or merging candidates; GitHub remains responsible for required reviews, thread resolution and every other active branch rule. [GitHub rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository) · [Actions variables](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-variables)

The privileged jobs load only the trusted `main` implementation, use the existing native workflow token, and install no pull-request dependencies or artifacts. They introduce no new App or secret. Branch refresh requires pull-request/content write permission; requesting read-only CI requires Actions write permission. Verification itself retains read-only repository permissions.

## Refresh and verify the exact source

Every CI or maintained release completion, the hourly schedule and an explicit controller dispatch reconcile open same-repository Dependabot pull requests. Release completion also catches version commits that intentionally skip push CI. A stale branch is updated with an expected-head guard, then polled within a fixed limit. A concurrently changed or conflicted candidate is reported individually so other updates can continue. No reconciliation path merges a pull request; only a CI completion can invoke the separate merge owner.

A refreshed head, or an unchanged head whose PR workflow requires approval, receives an explicit dispatch of the complete CI workflow. The input `expected_head_sha` must equal the actual source checked out by CI. Ordinary accepted queued/running attempts and existing trusted dispatches are retained; genuine failed checks never become successful proof through metadata or an approval decision.

Only the separate merge owner can merge. It requires:

- The latest matching successful run and its current attempt at the exact head. A later approval-only PR attempt is excluded; a later ordinary failed or running attempt still blocks merging.
- All three exact platform jobs (`Verify (ubuntu-24.04)`, `Verify (macos-15)`, `Verify (windows-2025)`) and `Quality Gate`, each completed successfully with the matching run, attempt and head.
- The fixed repository IDs, workflow identity, actual Dependabot author and an accepted service actor. Ordinary PR runs retain the Dependabot actor restriction; native-token dispatches require GitHub Actions' actual bot account and a unique live commit-to-PR association.
- Current-main ancestry plus the existing synthetic merge candidate with precisely the current base and verified head as its two ordered parents.
- Fresh run, latest-run, pull-request and protected-main checks immediately before GitHub's SHA-guarded squash endpoint, followed by an actual closed/merged PR confirmation.

Forks, drafts, ambiguous associations, missing/skipped jobs, changed attempts, stale bases and unsupported protection leave the candidate open. The same policy applies to Cargo, npm and Actions changes, including majors.

## Continue CI and publication

A successful native-token merge does not itself start push-triggered workflows. The continuation therefore requests the existing main CI with `expected_head_sha` and the existing release workflow with `source_sha`. Both inputs identify the exact confirmed merge, and the source must still be current protected `main` immediately before dispatch. A newer main supersedes the request.

Existing successful, failed, cancelled or pending runs for that exact source are retained rather than dispatched twice. Retry a failed original run to reuse its verified source and artifacts. Publication remains inside the maintained release workflow, including its source checks, platform verification, existing scoped release App, atomic version commit/tag, immutable packages and GitHub Release. The controller issues no manual publication or arbitrary-ref release command.
