# GitHub App and local reconciliation

This guide describes Phase B1. Phase B2 will replace the durable webhook inbox and add discovery in explicitly enabled repositories. [ADR-0006](adr/0006-orchestrate-through-native-tools.md) · [Plan 003](plans/003-architectural-simplification.md#phase-b--establish-read-only-github-reconciliation)

Switchyard tracks PR numbers explicitly selected in a local configuration. The controller uses GitHub's current PR state after receiving a webhook and on every configured polling interval. It records lifecycle changes and exact-head check evidence in SQLite. Review submissions, inline comments and PR conversation comments can trigger the same refresh. Routine observation leaves review evidence and readiness untouched. [Review evidence](reviews.md)

## Register and install the App

1. In GitHub, register a private GitHub App and choose the repository permissions below. Grant Issues read for live Issue comment delivery. Leave account and organization permissions unset.
2. Generate an App private key, keep the PEM outside the repository with file mode `0600`, and record the App's **Client ID**. Install the App on only the repositories you intend to track. The numeric installation ID appears at the end of the installation settings URL.
3. For live delivery, enable the App webhook and use a reachable HTTPS URL ending in `/webhooks/github`. Forward it to the loopback receiver and preserve the original JSON bytes and GitHub headers. Keep TLS verification enabled. Generate a high-entropy webhook secret and set the same value in the App and the controller. Polling works with the App webhook disabled.
4. For live delivery, select PR and CI events from the table. Review and comment events are optional refresh signals. Verify delivery results in the App's **Advanced** settings and use **Redeliver** for receipts that failed before reaching SQLite.

| Repository permission | Access                          | REST reads                                                                                                            | Webhook subscriptions                                          |
| --------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Metadata              | Read (automatic)                | Repository identity                                                                                                   |                                                                |
| Pull requests         | Read                            | `GET /pulls/{number}`, `GET /pulls/{number}/reviews`, `GET /pulls/{number}/comments`, `GET /issues/{number}/comments` | Pull request, Pull request review, Pull request review comment |
| Issues                | Read for issue comment delivery |                                                                                                                       | Issue comment                                                  |
| Checks                | Read                            | `GET /commits/{sha}/check-runs?filter=latest`                                                                         | Check run, Check suite                                         |
| Commit statuses       | Read                            | `GET /commits/{sha}/status`                                                                                           | Status                                                         |

The REST paths are relative to `/repos/{owner}/{repo}`. The client requests each installation token for a single repository with Pull requests, Checks and Commit statuses read. GitHub grants Metadata read automatically. The App needs Issues read if it subscribes to `issue_comment`. Pull requests read covers REST reads of PR conversation comments. The client caches tokens in memory and refreshes them before expiration or after GitHub rejects a REST credential. Its POST operations exchange a signed App JWT for an installation token or execute a fixed read-only GraphQL thread query. [GitHub App token scoping](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app) · [Issue comment webhook requirements](https://docs.github.com/en/webhooks/webhook-events-and-payloads#issue_comment) · [Conversation comment permissions](https://docs.github.com/en/rest/issues/comments#list-issue-comments)

At deployment cutover, reduce any existing Pull requests write grant to **Read-only** and remove other repository write grants. Keep the read permissions in the table and approve any pending installation permission change before verifying reads. Agents publish under their own configured GitHub identities.

## Run the controller

Save a local JSON configuration with the repository, App installation ID, and PRs to track. Multiple repositories can share one App installation.

```json
{
  "reconcileIntervalMs": 60000,
  "repositories": [
    {
      "repository": "owner/repo",
      "installationId": 123456,
      "pullRequests": [7, 12]
    }
  ],
  "requiredChecks": { "owner/repo#7": ["Quality checks"] }
}
```

Each `requiredChecks` key names a configured `owner/repo#PR` in lowercase. A PR without configured required checks still records CI observations. Configured check names do not enable handoff in B1.

Supply credentials through the environment. Set `GITHUB_WEBHOOK_SECRET` from your secret store to enable the loopback receiver. The optional `SWITCHYARD_WEBHOOK_PORT` defaults to `3000`. The optional `SWITCHYARD_DB_PATH` defaults to `switchyard.sqlite` in the working directory. Use a fresh path for this implementation. See the [SQLite baseline](state-model.md#sqlite-baseline).

```sh
export GITHUB_APP_CLIENT_ID=your-app-client-id
export GITHUB_APP_PRIVATE_KEY_PATH=/path/to/private-key.pem
npm start -- /path/to/switchyard.json
```

The receiver binds to `127.0.0.1`. A local tunnel or reverse proxy is optional for live delivery. With the webhook secret unset, the controller runs in polling mode. The startup sweep includes every configured PR, even if its opening delivery was missed. Set `reconcileIntervalMs` to `0` to disable periodic sweeps. A head change or a transient GitHub failure during startup reconciliation is retried after 30 seconds or a later GitHub deadline. SQLite preserves retry deadlines across restarts. Startup sweeps, periodic sweeps, and inbox deliveries all honor them. A delivery that targets several PRs waits until each of its active targets is eligible. For a manual refresh, stop the long-running controller and run `npm start -- --once /path/to/switchyard.json` to process a batch of due deliveries and refresh the configured PRs. If a cooldown defers the manual refresh, the command reports the deadline or the need to resume an operator pause. Use a single controller per SQLite file.

When a transient response includes `Retry-After`, the GitHub client records the deadline before releasing the request queue. A token exchange defers exchanges for the same repository and installation. An API read defers the affected PR's remaining reads, including the final lifecycle read. A check-runs or commit-status deadline also defers all pages of that endpoint for other PRs at the same commit in the same repository and installation. If the PR closes or reopens during the cooldown, reconciliation sees its current state when GitHub reads resume.

The inbox stores delivery IDs and versioned routing hints without raw webhook bodies or comment text. A valid delivery gets HTTP `202` once SQLite records its receipt. The controller logs delivery failures with the ID and retries them after 30 seconds or a later GitHub backoff deadline. Primary API backoff applies to the affected installation. A successful API read that reports zero remaining quota records the reset and still returns its data. Requests for each installation run serially so queued reads can honor the reset before sending another request. An operator stop prevents queued reads from being sent for that workflow. An already-sent read can settle and record rate-limit headers before the delivery finishes. [GitHub REST API guidance on concurrent requests](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#avoid-concurrent-requests) Secondary API backoff pauses requests across the client. SQLite preserves both deadlines across restarts, and the startup sweep respects them before exchanging tokens or reading PRs. Restart also requeues interrupted inbox processing and preserves scheduled retries. You can inspect recent delivery attempts with a read-only SQLite query.

```sh
sqlite3 -readonly switchyard.sqlite \
  'SELECT delivery_id, status, attempts, error, datetime(retry_at / 1000, "unixepoch") AS retry_utc FROM deliveries ORDER BY received_at DESC LIMIT 20;'
```

Consecutive secondary throttling doubles the wait from one minute and honors longer GitHub retry windows. A successful reconciliation clears its PR retry count, including successful reconciliation after closure or a head change. It can also clear a token-exchange retry for the same repository. An unfinished or failed reconciliation preserves the count. The controller retires counts below the retry limit for untracked PRs and terminal workflows before each pass and when a secondary throttle arrives. A late throttle from a workflow that stopped in flight still sets a cooldown. Only an active retry owner can advance the attempt count. A pause that already requires operator action stays in effect. After five throttled attempts, API requests stay paused across restarts. Deliveries that need GitHub keep their inbox status and attempt counts until the operator resumes and the cooldown expires. Deliveries that require no GitHub work can still finish. Stop the controller and run `npm start -- --resume-github` using the same `SWITCHYARD_DB_PATH` to resume. The command clears the retry limit and preserves the last backoff deadline. It uses the local SQLite file without making GitHub requests. [GitHub REST API rate-limit guidance](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#exceeding-the-rate-limit)

Check run, check suite, and commit status events refresh the configured PRs in their repository. A check event may have an empty PR list, including for fork cases. Switchyard fetches the check run and status lists for the authoritative PR head in the configured base repository, and missing records remain missing. A shared check name across producers, a skipped or neutral run, or unrecognized evidence is recorded as unknown if returned. Repository ruleset discovery and required-check producer identity remain open in [Plan 003](plans/003-architectural-simplification.md#remaining-implementation-choices).

## Offline development and live verification

After installing the pinned dependencies, run `npm test` without App credentials or an internet connection. The fixture suite signs saved payloads and sends them to a loopback receiver. The REST suite uses an in-process fake GitHub transport and a generated RSA test key. The focused command is `npm test -- test/webhook.test.ts test/github-api.test.ts`.

In Phase 2, all six repository REST read endpoints were exercised on Switchyard PR #6 with existing `gh` credentials. App token issuance, the App's actual repository grants, and GitHub-to-receiver delivery still require live verification with an installed App. To verify an installation, run a manual refresh for a known open PR and inspect the workflow and check evidence in SQLite. For webhook verification, redeliver a GitHub event, confirm the delivery shows `202` in GitHub, and confirm the same delivery ID has one processed inbox row.

A historical Phase 3A smoke test used the local fixtures to verify RS256 App JWT signing, repository-scoped token requests, token replacement and refresh, signed webhook receipts, deduplication, and reconciliation. It also checked that the `--once` command reports missing App credentials. No App client ID, private-key path, or installation configuration was available for the run.

To finish the live polling check, use an App installed on the intended repository with the read grants above. Use a config containing that installation's numeric ID and a known open PR with check activity. Supply the App client ID and PEM path and run the following with an unused SQLite path in a private directory.

```sh
SWITCHYARD_DB_PATH=/private/path/app-smoke.sqlite npm start -- --once /private/path/switchyard.json
sqlite3 -readonly /private/path/app-smoke.sqlite \
  'SELECT repository, pull_request, state, head_sha FROM workflows;'
sqlite3 -readonly /private/path/app-smoke.sqlite \
  'SELECT c.name, c.sha, c.outcome FROM check_snapshots AS c
   JOIN workflows AS w ON c.workflow_id = w.id AND c.sha = w.head_sha;'
```

Confirm the command exits successfully and the workflow matches the configured repository, PR, and current GitHub head SHA. Compare the recorded check evidence with the selected PR at that SHA. If the command reports a cooldown or a head change during the read, retry once the deadline passes. The polling check requires no webhook secret or tunnel. Any live delivery check is optional for local development.

On November 19, 2026, `gh api repos/cellgraph/switchyard/rules/branches/main` showed an active ruleset requiring pull requests and signed commits and blocking deletions and non-fast-forward updates. The rules response listed no required status check or approving review count. Phase 2 requires no rules changes.
