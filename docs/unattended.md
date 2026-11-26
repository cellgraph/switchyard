# Unattended polling

The unattended worker observes configured GitHub PRs. It refreshes workflow, review and CI evidence and reports when a finding or workflow state needs attention. See the [GitHub App guide](github-app.md) for authentication and the [architecture overview](architecture.md#current-implementation) for the current execution paths.

## Configuration

List repositories, App installation IDs and exact PR numbers. The worker polls at startup and waits `reconcileIntervalMs` after each pass. The default is 60,000 ms. Worker mode requires a positive interval and processes targets in configuration order.

```json
{
  "reconcileIntervalMs": 60000,
  "repositories": [
    { "repository": "owner/repo", "installationId": 123, "pullRequests": [42, 43] },
    { "repository": "owner/tools", "installationId": 456, "pullRequests": [7] }
  ],
  "requiredChecks": {
    "owner/repo#42": ["Quality checks"]
  }
}
```

The optional `requiredChecks` map uses configured lowercase `owner/repo#PR` keys and nonempty lists of unique check names. A PR without an entry still has CI evidence recorded and remains ineligible for handoff. Keep the App private key outside the configuration file.

## Run and inspect

```sh
export SWITCHYARD_DB_PATH=/absolute/path/to/switchyard-dev.sqlite
export GITHUB_APP_CLIENT_ID=YOUR_APP_CLIENT_ID
export GITHUB_APP_PRIVATE_KEY_PATH=/absolute/path/to/github-app.pem
npm start -- --worker /absolute/path/to/config.json
```

Use a [fresh SQLite path](state-model.md#sqlite-baseline). In a second terminal with the same path, run `npm start -- --worker-status` to inspect the last run, poll timestamps, PR heads and review outcomes. Use [review commands](reviews.md) for evidence and finding details. Worker stdout emits JSON events for poll outcomes, changes to PR state and requests for operator attention.

## Stop and restart

Press Ctrl-C or send SIGINT or SIGTERM to the launcher or worker PID shown in status. The worker drains active GitHub reads and skips queued reads and later pages. A duplicate worker exits while the recorded owner is live. A replacement can claim the database after the owner exits. GitHub retry deadlines persist across restarts. A rejected credential pauses requests for its installation for five minutes. The worker logs the installation ID and retry deadline.

This mode uses polling only. Use the [GitHub App controller](github-app.md#run-the-controller) for webhook intake or a manual refresh. Use the [local execution CLI](agent-sessions.md) to run an explicit assignment.
