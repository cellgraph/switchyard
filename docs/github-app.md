# GitHub App and local reconciliation

Switchyard uses a read-only GitHub App to discover PRs in enabled repositories and observe their current lifecycle and exact-head CI. The same reconciler runs at startup, after authenticated notifications, on the configured interval, and on operator request.

## Register and install the App

1. Register a private GitHub App with the repository permissions below. Leave account and organization permissions unset.
2. Generate an App private key, store the PEM outside the repository with file mode `0600`, and record the App's **Client ID**. Install the App on the repositories you intend to enable. The numeric installation ID appears at the end of the installation settings URL.
3. For webhooks, set a reachable HTTPS URL ending in `/webhooks/github`. Forward it to the loopback receiver with the original JSON bytes and GitHub headers. Keep TLS verification enabled. Use the same high-entropy webhook secret in the App and the worker.
4. Subscribe to Pull request, Check run, Check suite and Status for lifecycle and CI notifications. Review and comment subscriptions are optional observation signals.

| Repository permission | Access             | REST reads                                                                    | Webhook subscriptions                                          |
| --------------------- | ------------------ | ----------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Metadata              | Read (automatic)   | Repository identity                                                           |                                                                |
| Pull requests         | Read               | List PRs, read PR details, reviews, review comments and conversation comments | Pull request, Pull request review, Pull request review comment |
| Issues                | Read if subscribed |                                                                               | Issue comment                                                  |
| Checks                | Read               | Check runs for the current head SHA                                           | Check run, Check suite                                         |
| Commit statuses       | Read               | Combined status for the current head SHA                                      | Status                                                         |

The client scopes each installation token to a single repository with Pull requests, Checks and Commit statuses read. It refreshes the cached token before expiration or after GitHub rejects a REST credential. GitHub supplies Metadata read automatically. At cutover, reduce any existing PR write grant to read and remove other repository write grants. Agents publish using their own GitHub identities. [GitHub App token scoping](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app) · [GitHub webhook events](https://docs.github.com/en/webhooks/webhook-events-and-payloads)

## Configure enabled repositories

List each enabled repository once with its GitHub App installation ID. Multiple repositories may share an installation. Repository names and required-check keys are normalized to lowercase.

```json
{
  "reconcileIntervalMs": 60000,
  "repositories": [
    { "repository": "owner/repo", "installationId": 123456 },
    { "repository": "owner/tools", "installationId": 123456 }
  ],
  "requiredChecks": {
    "owner/repo": ["Quality checks"]
  }
}
```

The optional `requiredChecks` map uses enabled `owner/repo` keys and nonempty lists of unique check names. Missing configuration remains unknown. The worker records CI observations even for repositories without a required-check list. A shared name across producers and skipped, neutral or unrecognized check results remain unknown. Ruleset discovery, check producer identity and handoff policy are Phase D work.

Each sweep lists open PRs with pagination. An individual PR read determines whether the PR is open, non-draft and from its base repository. Authors can be people, bots or agents. Drafts wait until ready, and fork PRs are excluded. Previously tracked PRs are read individually even when absent from the open list, so the worker can observe closure, merge, reopening and eligibility changes. Periodic sweeps omit already confirmed merges unless a candidate or explicit hint names the PR. A failed listing is reported, and the worker continues individual reads for tracked and explicitly hinted PRs when GitHub allows them. [List pull requests](https://docs.github.com/en/rest/pulls/pulls#list-pull-requests) · [Workflow state and lifecycle](state-model.md)

## Run the controller

Supply the App client ID and PEM path through the environment. Use a fresh database path. The default is `switchyard.sqlite` in the working directory.

```sh
export GITHUB_APP_CLIENT_ID=your-app-client-id
export GITHUB_APP_PRIVATE_KEY_PATH=/path/to/private-key.pem
export SWITCHYARD_DB_PATH=/path/to/switchyard.sqlite
npm start -- /path/to/switchyard.json
```

Set `GITHUB_WEBHOOK_SECRET` from your secret store to enable the receiver on `127.0.0.1`. The optional `SWITCHYARD_WEBHOOK_PORT` defaults to `3000`. Webhook intake is optional. The default reconciliation interval is 60 seconds. Set `reconcileIntervalMs` to `0` for continuous operation driven by webhooks after startup. In that mode, another notification, an operator sweep or a restart can recover a missed or deferred observation.

Use `npm start -- --worker-status` to inspect the worker and its tracked workflows. Stop the continuous worker before running `npm start -- --once /path/to/switchyard.json` against the same database. One-off mode performs a full sweep using the same policy. See the [operating guide](unattended.md).

### Webhook signals and recovery

The receiver validates headers, payloads and signatures and acknowledges valid requests with HTTP `202`. It uses only the repository, installation and optional PR number to request observation. PR opened, reopened, synchronize, closed, ready for review and converted to draft actions can signal one PR. Review and PR comment events can signal the same refresh. A check run or suite that names one PR can signal that PR. Other check events and commit status events signal a repository sweep. Notifications outside enabled repository and installation scope are ignored.

Acknowledgement means the request passed validation. The worker coalesces hints in memory and keeps signals that arrive during a running pass for the next pass. It reads the current PR lifecycle, head and CI from GitHub to converge after duplicate, delayed or out-of-order notifications. There are no stored webhook bodies, delivery IDs, receipts or processing outcomes. Startup and periodic sweeps recover missed notifications and cover observations deferred by API failures. For a live receiver check, inspect GitHub's delivery result and then check the worker's pass and PR status.

## Rate limits and retries

The client serializes reads per installation. Primary quota exhaustion defers that installation, including when a successful response reports zero remaining quota. Authentication rejection defers it for five minutes. Secondary throttling pauses API requests across the worker. The secondary wait starts at one minute and doubles on consecutive throttles, subject to longer GitHub deadlines. A full successful discovery or PR observation clears its own secondary streak. Disabled repositories, held workflows, confirmed merges and omitted untracked candidates lose below-limit retry ownership. The GitHub cooldown still applies.

SQLite retains rate-limit deadlines and scoped retry metadata across restart. A GitHub `Retry-After` can defer a token exchange for a repository, a discovery listing, one PR's reads or a shared CI endpoint at one commit. Transient failures and changing heads without a GitHub deadline get a 30-second cooldown. Upcoming signals or sweeps can retry after the deadline. Errors include the affected repository or PR and any known deadline.

After five secondary throttles, the pause persists across restarts and requires operator action. Stop the worker and run `npm start -- --resume-github` against the same database. This clears the operator pause and preserves the last cooldown. Start the worker again to reconcile. [GitHub REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#exceeding-the-rate-limit)

## Verification

Run `npm test` without App credentials. Offline fixtures sign notifications, send them to a loopback server and exercise the read-only REST client with a generated RSA key. A live App grant and receiver check remains part of deployment verification. Use a fresh SQLite path and run `--once` against an installed App to check discovery and compare tracked heads and check results with GitHub. The production GraphQL review thread integration is gated pending Phase D corroboration requirements and credential and rate-limit verification. [Plan 003 integration gates](plans/003-architectural-simplification.md#remaining-implementation-choices)
