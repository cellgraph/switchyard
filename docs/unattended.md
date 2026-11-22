# Unattended controller

Run the worker on one host from a stable Switchyard checkout. Give it a persistent SQLite database, trusted clones of the monitored repositories, a dedicated root for fix worktrees, and a persistent Codex profile. Keep these paths separate from Switchyard's own development worktrees. Use the [GitHub App reader](github-app.md) and the [Phase 5 agent and publication setup](fix-loop.md).

## Configuration

List the repositories, App installation IDs, and exact PR numbers to monitor. The worker polls immediately at startup and waits `reconcileIntervalMs` (default 60,000) after each pass. Set a positive interval in worker mode. Targets are processed in configuration order. A bounded agent turn or validation on an earlier target can delay later targets and the next pass.

Use the optional `fixes` map to enable Phase 5 advancement for selected PRs. Each key is a configured lowercase `owner/repo#PR`. An entry uses the same settings as the [single-PR fix configuration](fix-loop.md), including validation command arguments and required check names. For a configuration with one PR, the existing top-level `fix` form also works. Give each PR in a shared clone a distinct local fix branch. A monitored PR without a fix entry is observed only. Keep the fix entry present while an authorized cycle needs to run. The worker uses the saved cycle settings until that cycle finishes or escalates.

```json
{
  "reconcileIntervalMs": 60000,
  "repositories": [
    { "repository": "owner/repo", "installationId": 123, "pullRequests": [42, 43] },
    { "repository": "owner/tools", "installationId": 456, "pullRequests": [7] }
  ],
  "fixes": {
    "owner/repo#42": {
      "repositoryDirectory": "/absolute/path/to/repo-clone",
      "worktreeRoot": "/absolute/path/to/fix-worktrees",
      "codexHome": "/absolute/path/to/codex-home",
      "model": "MODEL_AVAILABLE_TO_YOUR_ACCOUNT",
      "localBranch": "fix/switchyard-pr-42",
      "allowedPaths": ["src/", "test/"],
      "requiredChecks": ["Quality checks"],
      "validation": [{ "id": "test", "argv": ["npm", "test"] }],
      "maxCycles": 3,
      "maxOperationAttempts": 2,
      "maxValidationRetries": 1,
      "agentTimeoutMs": 900000,
      "validationTimeoutMs": 300000
    }
  }
}
```

The operational settings in the example show the Phase 5 defaults. `validationTimeoutMs` is per command. Each Git invocation has a 60-second timeout and GitHub API requests use a 10-second timeout. Transient GitHub errors and rate limits use the existing persisted retry deadlines. Use a local filesystem for SQLite and share the same `SWITCHYARD_DB_PATH` with operator commands. Keep Git credentials, the GitHub App private key, and the Codex profile outside the configuration file. Fetch a newly reviewed PR head into the configured clone before authorizing its first dispatch, and prepare validation dependencies before starting a turn.

## Run and inspect

```sh
export SWITCHYARD_DB_PATH=/absolute/path/to/switchyard.sqlite
export GITHUB_APP_CLIENT_ID=YOUR_APP_CLIENT_ID
export GITHUB_APP_PRIVATE_KEY_PATH=/absolute/path/to/github-app.pem
npm ci
node src/main.ts --worker /absolute/path/to/config.json
```

In a second terminal with the same database path:

```sh
node src/main.ts --worker-status
node src/main.ts --fix-status 'owner/repo#42'
node src/main.ts --fix-authorize 'owner/repo#42' CYCLE_ID
node src/main.ts --fix-publish 'owner/repo#42' CYCLE_ID
```

Use the [review commands](reviews.md) to disposition findings. Inspect the proposed cycle before authorizing agent execution. Inspect the staged diff and validation before authorizing publication separately. Each approval records the exact cycle ID, and the worker rechecks the review and PR head as it advances. A clean review and passing configured checks must still match the published head before human merge review.

Worker stdout emits one JSON object per event. Poll outcomes, repository and PR states, cycle IDs, agent/validation/push results, and requests for operator attention can be filtered without exposing agent output or validation diagnostics. `--worker-status` requires no GitHub credentials. It reads the last run, its configured scope, poll timestamps, and current PR states from SQLite. During a poll, the last started timestamp can be newer than the last finished timestamp. Use `--fix-status` for the stored evidence and escalation reason. PRs closed by GitHub remain in the scope and can be observed if reopened. Escalated or manually stopped workflows remain held.

## Stop and restart

Press Ctrl-C in the launch terminal or send SIGINT or SIGTERM to the launcher or the worker PID shown in status. The launcher keeps terminal signals away from the worker subprocess group and requests a drain. The worker stops taking new targets and drains a claimed operation within its existing time limits. A completed agent turn can leave validation for the next start. An already claimed push is allowed to finish and its return is recorded before shutdown. After a forced stop, use the same database and persistent paths. The worker recovers dead agent owners, reconciles GitHub before advancing a cycle, and confirms uncertain push attempts from Git and GitHub. Uncertain agent, validation, or push effects can require operator inspection. A push with a recorded intent is never dispatched again.

One unattended worker owns a SQLite database on the host. A duplicate invocation exits while the recorded PID is live. Restart takes over after the owner exits. PID reuse can conservatively hold a claim until that PID is gone. Phase 5 operation claims also protect against concurrent manual advances. Use separate databases only for disjoint scopes. This worker mode uses polling only. The existing webhook receiver and reconcile-only CLI modes are available separately.
