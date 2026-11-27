# Phase D live verification

## Candidate and fixture

The November 27, 2026 verification used PR #32 head `a089e451d25556fe0aa254f55a5a400baf934da7` on both existing VMs. The `switchyard` account on `switchyard-controller.exe.xyz` used an isolated configuration under `/var/lib/switchyard/phase-d-verification/`. It reached the `exedev` account on `switchyard-agent.exe.xyz` through Rex preview.25 over SSH. Both candidate checkouts used Node.js 26.13.1 and the locked npm dependencies. The agent VM's Codex profile reported a native ChatGPT login. The production controller and its SQLite database were excluded from the run.

The [disposable fixture PR](https://github.com/cellgraph/switchyard-phase-d-fixture/pull/1) was open at `8f4396b3cc770cd454e78520b08381e653984872`. The required `Fixture quality` check from GitHub Actions App `15368` had failed on that exact head. [Baseline check](https://github.com/cellgraph/switchyard-phase-d-fixture/actions/runs/46041245250/job/140649222405)

## Installation preflight

GitHub identified the fixture repository on Switchyard App installation `184845506`. The initial App registration and installation both reported Checks, Metadata, Pull requests and Commit statuses with read access. The request for a fixture-scoped token with the full workflow evidence permissions returned HTTP 422, `The permissions requested are not granted to this installation.` The autonomous controller requires Contents read access for signed commit verification and Issues read access for deferral evidence. [App operating guide](github-app.md) · [Installation](https://github.com/organizations/cellgraph/settings/installations/184845506)

## Model-free checks

- A startup sweep using observation-only configuration and fresh `observation.sqlite` discovered PR #1 without a queued initiation. It enrolled the PR as `eligible` and `awaiting_review`, then recorded `Fixture quality=failed` on the baseline SHA. The worker exited cleanly. No workflow assignments or operator events were recorded, and both allowances showed `0/3` reserved or used.
- A model-free attempt used the corrected candidate to launch a real Rex block in a dedicated session. A separate controller process recovered the completed result and reread the same verified evidence.
- Formatting, lint, type checking and all 224 tests passed on the agent VM at the candidate SHA. GitHub verified the candidate signature and passed `Quality checks` on the same SHA. [Candidate commit](https://github.com/cellgraph/switchyard/commit/a089e451d25556fe0aa254f55a5a400baf934da7) · [Candidate checks](https://github.com/cellgraph/switchyard/actions/runs/46078751106/job/140772537768)

## Readiness at the end of preflight

Live acceptance remains blocked on the App grants. The isolated runner is staged with the fixture as its only repository, a dedicated Rex session, a 15-second polling interval and the default three review and three revision slots. The autonomous runner stayed stopped and made no model requests. The fixture PR remained open at its original head, with no review, disposition or revision published by this run. The observation-only workflow remains `awaiting_review`, with both allowances unused and failing CI on its current head.

After the App registration and installation reflect Contents and Issues read access, repeat the fixture-scoped token preflight and run the autonomous configuration against a separate fresh SQLite path. The production service kept the same active PID and start timestamp throughout preflight.
