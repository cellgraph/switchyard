# Operating approved plan executions

Switchyard executes one active plan per repository in increment order. Each initial Implementer turn publishes a single PR. The existing Phase D workflow coordinates independent review, adjudication, revisions and exact-head CI. Switchyard reports readiness for human acceptance and advances after GitHub reports the merge. The GitHub App remains read-only.

## Approve repository scope

Commit the plan under `docs/plans/` and inspect the exact revision before approval. Use the following heading structure. The bodies of the numbered sections define executable scope. Put common requirements inside each applicable increment. Other sections provide background for people reading the plan.

```markdown
# Plan title

## Increments

### 1. First independently reviewable increment

Describe the scope, constraints and validation for this PR.

### 2. Second independently reviewable increment

Describe the scope, constraints and validation after the first PR merges.
```

Use consecutive numbers starting at 1. Approvals support UTF-8 Markdown up to 64 KiB and 50 increments. Switchyard reads the file and verifies its blob at the supplied 40-character commit SHA. It records the extracted scope, exact commit, path, blob SHA, approval time and the repository's current default branch as the plan's PR target. Reapproving the same repository, path and revision returns the same execution. To change scope, stop the prior execution and approve a new revision. The prior execution and any associated PR remain in its history. Resume an existing stopped revision only after the replacement is stopped or complete.

Use the same configuration, App credentials and `SWITCHYARD_DB_PATH` as the running controller. Approval requires [Phase D PR coordination](autonomous-pr-workflow.md#configure-a-repository) for the repository. The existing read permissions cover the additional GitHub reads. The controller uses the configured Rex Implementer identity. The agent creates its worktree based on the current default branch, checks that it includes the preceding merge when applicable, validates the work, signs commits and publishes the PR to the reserved branch. CLI writes use access to the controller's local state and configuration as the operator authority.

## Inspect and operate

Commands after `npm start --silent --` return JSON. Approval and operator actions take effect during the next full reconciliation sweep.

| Command                                                                          | Effect                                                                                                                                                                                           |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `plan approve OWNER/REPO docs/plans/PLAN.md COMMIT_SHA CONFIG.json`              | Records approval and queues execution.                                                                                                                                                           |
| `plan list`                                                                      | Shows executions and the current increment, PR and Phase D state.                                                                                                                                |
| `plan inspect PLAN_ID`                                                           | Shows approved scope, assignments, native execution references, PRs, merge evidence and operator history.                                                                                        |
| `plan attention`                                                                 | Lists plan holds, Phase D attention requests and PRs ready for human acceptance, including the handoff head SHA.                                                                                 |
| `plan direction PLAN_ID "direction"`                                             | Records guidance for a new initial assignment for the current increment, within the approved scope.                                                                                              |
| `plan direction PLAN_ID --retry ASSIGNMENT_ID "reason for additional execution"` | Authorizes a fresh initial assignment if the original outcome is confirmed terminal and its reserved branch has no PR. Also permits recovery after the bound on confirmed non-execution retries. |
| `plan direction PLAN_ID --associate ASSIGNMENT_ID PR_NUMBER HEAD_SHA "evidence"` | Identifies a publication from a held assignment for Switchyard to verify. Supply the signed published commit SHA.                                                                                |
| `plan stop PLAN_ID "reason"`                                                     | Stops new plan and associated Phase D dispatch. GitHub and native side effects from already-authorized turns can still arrive.                                                                   |
| `plan resume PLAN_ID "reason"`                                                   | Removes the plan hold and reconciles the original execution and GitHub evidence before further work.                                                                                             |

For Phase D decisions and additional review or revision allowance, use `workflow inspect`, `workflow direction`, `workflow grant` and `workflow resume` on the associated PR. Use `plan resume` for a plan-level hold. The initial implementation has one authorized assignment per increment. Retries confirmed to have never started reuse the assignment, with up to three attempts before escalation. An explicit `--retry` and resume can authorize a replacement after known execution failure or a decision. A grant leaves the approved scope and Phase D allowances intact.

Inspect the original execution with `agent inspect EXECUTION_ID` after a disconnect. An uncertain execution keeps its claim. Restore its correlated result or record an association once the correlated Rex block is confirmed exited. Switchyard verifies the PR's repository, reserved branch, approved base, configured author and signed publication. A head change during publication is acceptable if GitHub confirms the signed commit remains in the PR. An explicit operator association can resolve conflicting branch candidates. Switchyard keeps the native claim and operator evidence in history and verifies the selected PR independently. A PR closed without merge must be reopened before the plan can advance. A merged PR without a Phase D handoff on the merged head holds the plan for operator review. Inspect the merged work before approving any remaining scope separately.

Continue to inspect the exact PR head and Phase D workflow before merging in GitHub. GitHub reconciliation records the PR number, merged head, merge commit, time and merge actor. A completed increment remains in execution history.

## Live self-hosting acceptance

Run this procedure only after the Phase E release has been separately authorized and the operator has identified and approved a real Switchyard follow-up plan with at least two independently reviewable increments. Record the plan path, full commit SHA and the operator's authorization before starting. Plan 003 defines this acceptance work. The follow-up's substantive product scope comes from the operator-approved artifact.

1. Record the reviewed Phase E candidate SHA, controller and executor revisions, database path, configured role names and GitHub identities, and required GitHub check. Verify that one controller on `switchyard-controller.exe.xyz` coordinates `cellgraph/switchyard` using the existing Rex placements on `switchyard-agent.exe.xyz`. Before an authorized schema upgrade, archive the closed Phase D database and preserve the matching checkout and configuration for rollback. Phase E adds its tables to schema 22 in place. The Phase D binary requires its original schema 22 database.
2. Run `plan approve cellgraph/switchyard APPROVED_PLAN_PATH APPROVED_PLAN_SHA CONFIG.json`. Save its JSON, and use `plan inspect PLAN_ID` to record the approval and first assignment. Verify that the approval matches the intended repository revision and that exactly one initial Implementer turn starts.
3. Record the first PR, signed publication head, execution ID and native session reference. Confirm that Phase D enrolls the PR and coordinates its roles and exact-head checks without manual prompt transfer. If an attention request appears, follow its recorded action and retain the original execution references.
4. Wait for `plan attention` to report human acceptance. Verify that the head, completed review and required checks agree in `workflow inspect 'cellgraph/switchyard#NUMBER'` and GitHub. The operator reviews and merges. Confirm that Switchyard records the merge before dispatching increment 2 and that its prompt uses the originally approved second scope.
5. Repeat acceptance and merge for the remaining PRs. Record the final `plan inspect` output, the merged heads and the execution and allowance histories. Verify that the execution reaches `completed` and remains complete across subsequent sweeps.
6. If restart recovery is in the live acceptance scope, agree on a controller restart window and capture the outstanding execution and PR state before restarting. Verify that the same IDs are reconciled and no second Implementer launch occurs for the same assignment.

The offline suite exercises the controller wiring with real SQLite and Phase D transitions, along with fixture GitHub and Rex evidence. It covers exact-revision approval, two sequential merges, restart, ambiguity and operator controls. Live Phase E acceptance still requires a separately approved follow-up revision, an authorized deployment and observed GitHub and Rex outcomes.
