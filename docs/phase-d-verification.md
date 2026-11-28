# Phase D live verification

## Candidate and fixture

The November 27, 2026 verification used PR #32 head `a089e451d25556fe0aa254f55a5a400baf934da7` on both existing VMs. The `switchyard` account on `switchyard-controller.exe.xyz` used an isolated configuration under `/var/lib/switchyard/phase-d-verification/`. It reached the `exedev` account on `switchyard-agent.exe.xyz` through Rex preview.25 over SSH. Both candidate checkouts used Node.js 26.13.1 and the locked npm dependencies. The agent VM's Codex profile reported a native ChatGPT login. The production controller and its SQLite database were excluded from the run.

The [disposable fixture PR](https://github.com/cellgraph/switchyard-phase-d-fixture/pull/1) was open at `8f4396b3cc770cd454e78520b08381e653984872`. The required `Fixture quality` check from GitHub Actions App `15368` had failed on that exact head. [Baseline check](https://github.com/cellgraph/switchyard-phase-d-fixture/actions/runs/46041245250/job/140649222405)

## Installation preflight

GitHub identified the fixture repository on Switchyard App installation `184845506`. The initial App registration and installation both reported Checks, Metadata, Pull requests and Commit statuses with read access. The request for a fixture-scoped token with the full workflow evidence permissions returned HTTP 422, `The permissions requested are not granted to this installation.` The autonomous controller requires Contents read access for signed commit verification and Issues read access for deferral evidence. [App operating guide](github-app.md) · [Installation](https://github.com/organizations/cellgraph/settings/installations/184845506)

After the permissions update, the candidate obtained a fixture-scoped token and read the open PR listing, the exact PR head, reviews, review comments, issues, the commit, Check Runs and commit statuses. PR #1 was the sole open PR. GitHub still reported the expected failing Check Run from App `15368` on `8f4396b3cc770cd454e78520b08381e653984872`.

## Model-free checks

- A startup sweep using observation-only configuration and fresh `observation.sqlite` discovered PR #1 without a queued initiation. It enrolled the PR as `eligible` and `awaiting_review`, then recorded `Fixture quality=failed` on the baseline SHA. The worker exited cleanly. No workflow assignments or operator events were recorded, and both allowances showed `0/3` reserved or used.
- A model-free attempt used the corrected candidate to launch a real Rex block in a dedicated session. A separate controller process recovered the completed result and reread the same verified evidence.
- Formatting, lint, type checking and all 224 tests passed on the agent VM at the candidate SHA. GitHub verified the candidate signature and passed `Quality checks` on the same SHA. [Candidate commit](https://github.com/cellgraph/switchyard/commit/a089e451d25556fe0aa254f55a5a400baf934da7) · [Candidate checks](https://github.com/cellgraph/switchyard/actions/runs/46078751106/job/140772537768)

## Live acceptance

The autonomous runner used a fresh `workflow.sqlite`, the fixture as its only repository, a dedicated Rex session, a 15-second polling interval and the default three review and three revision slots. Its first sweep discovered and enrolled PR #1 as `eligible` and `awaiting_review`, recorded the failing exact-head check, and dispatched the Reviewer without an explicit initiation.

The first Reviewer reproduced the failure and published its review on the assigned head. It cited an older inline comment instead of publishing a root finding in its own review, then returned `outcome: findings` with an empty `findingIds` array. Switchyard recorded the Rex execution as `completed` and held the workflow as `escalated` because the result did not describe corroboratable findings. The original review consumed one round. [First review](https://github.com/cellgraph/switchyard-phase-d-fixture/pull/1#pullrequestreview-6094540114) · [Earlier inline comment](https://github.com/cellgraph/switchyard-phase-d-fixture/pull/1#discussion_r4722130544)

The focused fix clarified that only findings explicitly carried into the assignment by Switchyard are exempt from new inline publication. It also made the requirement for a root inline finding ID explicit when reporting `findings`. The regression test exercises the dispatched prompt and verifies that a finding attached to another review cannot advance the workflow. The fix was staged on both VMs. [Reviewer fix](https://github.com/cellgraph/switchyard/commit/04d1b832ab909f912a32d2a0875758ee83ffff21)

Recovery used `workflow direction --abandon` for the completed assignment and `workflow resume` after staging the fix. The second controller process reopened the same SQLite database. The initial assignment stayed in history as superseded and its review slot remained consumed. A fresh Reviewer published the empty-input regression as a root inline finding on the original head, and Switchyard corroborated it and dispatched the Adjudicator. [Second review](https://github.com/cellgraph/switchyard-phase-d-fixture/pull/1#pullrequestreview-6094553286) · [Inline finding](https://github.com/cellgraph/switchyard-phase-d-fixture/pull/1#discussion_r4724573980)

The Adjudicator independently reproduced the failing test and published `Decision: accept` as a direct reply. Switchyard corroborated the disposition and dispatched one Implementer assignment with both finding `4724573980` and the failed `Fixture quality` check. [Accepted disposition](https://github.com/cellgraph/switchyard-phase-d-fixture/pull/1#discussion_r4724576216)

The Implementer restored the zero initial accumulator and pushed `4a098523c68e73c99828b83a662357f330bd4d99` directly atop the assigned head. GitHub verified the signature and linked the committer to the configured Implementer account. Switchyard observed the new head. GitHub Actions App `15368` reported `Fixture quality` passing on that exact SHA. [Signed revision](https://github.com/cellgraph/switchyard-phase-d-fixture/commit/4a098523c68e73c99828b83a662357f330bd4d99) · [Passing fixture check](https://github.com/cellgraph/switchyard-phase-d-fixture/actions/runs/46087112880/job/140799160944)

A fresh Reviewer ran the fixture tests on `4a098523c68e73c99828b83a662357f330bd4d99` and published a `clean` review that explicitly marked finding `4724573980` resolved. Switchyard corroborated the revision, review and passing check. It transitioned from `awaiting_review` to `ready` with `githubStatus: eligible` and no outstanding attention. The fixture PR stayed open for human acceptance. [Final review](https://github.com/cellgraph/switchyard-phase-d-fixture/pull/1#pullrequestreview-6094561924)

Readiness persisted across four more successful sweeps and after the isolated worker stopped. The production controller reported the same active PID and start timestamp before and after the run.

## Execution and allowance evidence

All five Rex executions reached `completed` in distinct native Codex sessions using the staged ChatGPT subscription profile. The Adjudicator used no additional review slot. The final counters were `3/3` review rounds and `1/3` revisions, with no grants. The only operator events were abandonment of the first assignment and resume after staging the fix. Switchyard supplied the prompts and references for each assignment.

| Assignment               | Execution ID                           | Claimed to completed on Nov. 27 (Central) |
| ------------------------ | -------------------------------------- | ----------------------------------------- |
| Initial Reviewer         | `213d50f3-397b-4c9d-a158-32c2f6fc7dfb` | 18:12:19–18:12:49                         |
| Replacement Reviewer     | `c6c6969c-f9fc-47e2-9ace-5b83d70c656f` | 18:15:54–18:16:24                         |
| Adjudicator              | `0744c0de-62a4-4484-9d2b-6f72cae7cbd5` | 18:16:25–18:17:09                         |
| Implementer              | `ffbd91fd-f683-4bad-86b4-bff8da669d35` | 18:17:10–18:18:09                         |
| Reviewer on the new head | `e445bfaf-464a-4915-bbc1-f93b3bab3889` | 18:18:10–18:18:39                         |

On `04d1b83`, formatting, lint, type checking and all 225 tests passed. A separate native Codex review of the fix completed with no actionable findings and reported all 57 PR workflow tests passing. GitHub verified the fix signature and passed `Quality checks` on the fix SHA. [Fix checks](https://github.com/cellgraph/switchyard/actions/runs/46086877975/job/140798404618)
