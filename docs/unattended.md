# Operating the reconciliation worker

The worker discovers pull requests in enabled repositories and observes eligible PRs and their exact-head CI. Run it with or without an authenticated webhook receiver using the same command. The GitHub App guide describes the installation, [repository configuration](github-app.md#configure-enabled-repositories) and [retry behavior](github-app.md#rate-limits-and-retries).

## Run and inspect

Use a [fresh SQLite path](state-model.md#sqlite-baseline). Set the App client ID and private key path in the environment. Supply `GITHUB_WEBHOOK_SECRET` to enable the receiver. Without a secret the worker runs on startup and at the configured interval.

```sh
export SWITCHYARD_DB_PATH=/absolute/path/to/switchyard-dev.sqlite
export GITHUB_APP_CLIENT_ID=YOUR_APP_CLIENT_ID
export GITHUB_APP_PRIVATE_KEY_PATH=/absolute/path/to/github-app.pem
npm start -- /absolute/path/to/config.json
```

Use the same database path in a second terminal to inspect the worker and its tracked PRs. The JSON output includes the enabled repositories, process state, last pass timestamps and success, current PR heads and GitHub status, and operator holds. Worker logs report pass outcomes and repository or PR errors. Review references have their own inspection command.

```sh
npm start -- --worker-status
npm start -- --review-status owner/repo#7
```

Stop the continuous worker before running a one-off sweep against the same database. The command exits with a failure status if a discovery or observation fails or is deferred. Other successful updates from the same pass are retained.

```sh
npm start -- --once /absolute/path/to/config.json
```

## Stop and restart

Press Ctrl-C or send SIGINT or SIGTERM to the worker PID. Shutdown allows a sent request to settle, including any rate-limit headers, and skips queued reads, later pages and unstarted targets. The worker records its stop in SQLite. A second reconciliation process cannot claim the database while the recorded worker is live. A replacement can claim it after the owner exits.

Restart runs a full sweep and rediscovers work missed while the process was stopped. SQLite preserves GitHub retry deadlines and operator holds. Native recovery marks execution claims with lost owners as uncertain and keeps their sessions held for inspection. Local assignments use the separate [agent CLI](agent-sessions.md).
