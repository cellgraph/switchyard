# Operating autonomous PR workflows

Switchyard enrolls an open, non-draft, same-repository PR in a repository with PR coordination enabled. PR authors can be people or automation. The controller observes GitHub through a read-only App. Named native agents own reviews, adjudication, issues, source changes, validation, signed commits and pushes. The GitHub PR remains open for human acceptance.

## Configure a repository

Use one controller on the provisioned controller VM under the `switchyard` account. Prepare the agent VM under `exedev` as described in the [native execution guide](agent-sessions.md#rex-placement-on-linux). Native login, tool permissions, network access, checkout access and SSH signing belong to the execution account. Use a dedicated Rex session with an agent-owned private state directory. Start from a checkout of the trusted base branch and let each agent manage its assignment worktree. Keep the role entries distinct in the named agent file. They can use the same Rex endpoint and runtime account. Switchyard uses separate native review and adjudication sessions and can continue a known Implementer session on the same placement.

Add `prWorkflows` to the normal controller config to enable dispatch. `agentsFile` is relative to the controller config file. The following example assumes a prepared `agents.json` with named Rex placements for the three entries.

```json
{
  "reconcileIntervalMs": 30000,
  "repositories": [{ "repository": "owner/repo", "installationId": 1234 }],
  "requiredChecks": {
    "owner/repo": ["Quality checks"]
  },
  "agentsFile": "agents.json",
  "prWorkflows": {
    "owner/repo": {
      "reviewer": { "agent": "remote-reviewer", "githubUserId": 101 },
      "adjudicator": { "agent": "remote-adjudicator", "githubUserId": 102 },
      "implementer": { "agent": "remote-implementer", "githubUserId": 103 },
      "checkApps": { "Quality checks": 15368 }
    }
  }
}
```

Use numeric GitHub account IDs from `gh api users/LOGIN --jq .id`. Each identity needs the GitHub access its role uses. The configured Implementer must be the linked committer on the GitHub commit. Get check App IDs from `gh api repos/OWNER/REPO/commits/SHA/check-runs`. Provide a required check name and App ID for every required Check Run. A missing or ambiguous run holds readiness. Commit statuses alone cannot satisfy an App-pinned check. Repositories without a `prWorkflows` entry retain GitHub observation.

Repository-scoped installation tokens for PR coordination request read access to Pull requests, Checks, Commit statuses, Issues and Contents. Install the App on each enabled repository and approve those permissions on the installation. Issues support deferred findings. Contents supports GitHub verification of signed revisions. See the [GitHub App operating guide](github-app.md). The controller uses REST for these reads.

Keep the configuration and SQLite state private. Configure each placement's native permissions and GitHub credentials for its task. Use the existing subscription logins. A model's result supplies references for verification. It confers no authority to change workflow state or grant execution. Autonomous dispatch is sequential. Reconciliation continues while a native turn runs and checks outstanding Rex attempts before assigning another PR. Run continuous polling to pick up changes and progress through assignments. Webhooks can reduce latency.

## Inspect and direct a workflow

Run these commands against the controller's SQLite path. Quote ids containing `#`. The commands print JSON for use by humans or agents.

| Command after `npm start --silent --`                                                                  | Effect                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workflow list`                                                                                        | Lists observed workflows, lifecycle, readiness, remaining capacity and queued explicit requests.                                                                                   |
| `workflow attention`                                                                                   | Lists operator holds with the reason, evidence references and requested action.                                                                                                    |
| `workflow inspect 'owner/repo#12'`                                                                     | Shows the exact current head, checks, review references, assignments, executions and history.                                                                                      |
| `workflow initiate 'owner/repo#12' /path/to/controller.json`                                           | Queues an idempotent explicit request under the same eligibility policy as discovery.                                                                                              |
| `workflow direction 'owner/repo#12' "Confirm the contract for the disputed finding"`                   | Records direction for a future assignment. A new direction permits re-adjudicating an escalated finding after resume.                                                              |
| `workflow grant 'owner/repo#12' 1 0 "Review a further revision"`                                       | Adds the specified review and revision capacity, in that order.                                                                                                                    |
| `workflow resume 'owner/repo#12' "Evidence inspected"`                                                 | Removes the operator hold. The next eligible reconciliation rechecks GitHub and the original execution.                                                                            |
| `workflow stop 'owner/repo#12' "Operator hold"`                                                        | Prevents subsequent dispatch and preserves the hold across restart and head changes.                                                                                               |
| `workflow direction 'owner/repo#12' --abandon EXECUTION_ID "Terminal turn and side effects inspected"` | Closes a held, confirmed terminal assignment with uncorroborated publication evidence. The original attempt still consumes its slot. Resume separately to permit a new assignment. |

CLI initiation and operator changes take effect by the next sweep. After staging, Switchyard rechecks GitHub eligibility and the operator hold before authorizing Rex. A running assignment can continue across controller shutdown and is reconciled on restart. Use `agent inspect EXECUTION_ID` to inspect an already-authorized execution and `agent cancel EXECUTION_ID` to request its interruption. An interrupted attempt can retain side effects. Uncertain attempts keep their slot and cannot be abandoned through the workflow CLI. Restore the original Rex evidence and resume to reevaluate the same attempt. A remote execution confirmed to have never started can retry under its original assignment after a delay.

The default limits are three Reviewer rounds and three Implementer revisions. Review corrections and required CI failures share the revision limit. A revision requires an available subsequent review round. Pending CI can settle before a combined fix is assigned. Grant and resume explicitly when further execution is needed. GitHub closure stops coordination and reopening can reactivate the existing workflow. Operator holds remain effective. GitHub merge is recorded as an observed terminal state.

## Verify handoff evidence

The Reviewer submits a review on the exact head and returns its numeric REST ID and all root inline finding IDs. The review states its outcome and identifies any previously accepted finding independently verified as fixed. The Adjudicator publishes each decision and its reasoning as a direct inline reply. For a deferral the reply references a same-repository issue that links to the finding. The Implementer publishes a verified signed commit directly atop the assigned head. A changed head requires exact-head review and checks. Older accepted findings remain blocking until a current-head review verifies their resolution.

Inspect `state: "ready"` with `githubStatus: "eligible"` and the matching `headSha` before accepting a PR. Each successful reconciliation rechecks applicable review and disposition publications. Changed or missing evidence revokes readiness. A missing native result triggers recovery from the correlated Rex record. Only normalized claims, GitHub references and evidence hashes are saved in controller SQLite. Use native sessions to inspect transcripts.

## Cutover and rollback

Use a disposable repository, an isolated controller config and a fresh SQLite path to verify a candidate on the two VMs. Test the exact candidate checkout and dependencies on both machines, with a dedicated Rex session and private state directory. Keep the production service and database outside this run. Observe a ready fixture PR with passing checks and leave it open.

Production cutover requires separate operator authorization. Record the deployed Git commit, service configuration, environment and database paths before starting.

1. Prepare the reviewed Switchyard checkout, pinned Node and locked npm dependencies on both machines. Test controller-to-Rex connectivity and scoped App reads. Confirm the expected repository, role IDs and required Check Runs.
2. Stop the existing service and verify its worker has exited. Archive the closed SQLite database together with any WAL and SHM files. Preserve the existing service definition, config and runnable checkout for rollback.
3. Preserve native profiles and sessions, repository clones and worktrees, and Rex attempt evidence separately. Select a fresh, empty SQLite path. Schema 22 requires a fresh database.
4. Point the service at the reviewed checkout, fresh database and new config. Start one controller. Check startup, repository discovery, worker status and one representative exact-head observation. Confirm the new process runs under the `switchyard` account and is the only authoritative controller. Check documentation and scope before enabling additional repositories.
5. For rollback, stop the replacement and archive its database. Inspect outstanding Rex executions and any GitHub writes before enabling the old controller again. Preserve unresolved execution references for operator investigation. Restore the original checkout, config and archived database together, then verify service health and repository observation.

Proactive notifications are optional. The workflow attention queue and CLI provide the operating interface.
