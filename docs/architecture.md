# Switchyard architecture (initial proposal)

This document describes the smallest architecture that supports the first Codex/GitHub pull request loop while leaving a path to other agents and remote workers. The decisions here are recorded in [ADR-0001](adr/0001-local-controller-and-agent-boundary.md); unresolved assumptions are explicit so the first implementation can verify them.

## Components

```text
GitHub App webhook ──▶ webhook inbox ──▶ SQLite workflow controller
                                             │
                           ┌─────────────────┴──────────────────┐
                           │                                    │
                    GitHub adapter                     local worker
                    (read PR/reviews/checks)        Git worktree + Codex SDK
                           │                                    │
                           └────────── durable state ───────────┘
```

- **Controller:** owns workflow state, policy, timers/reconciliation, cycle limits, and decisions about whether to resume, wait, escalate, or mark ready for human review. It is a single local Node.js process in the first version.
- **GitHub adapter:** verifies and records webhook deliveries, reads current PR/review/check state through GitHub App credentials, and normalizes GitHub-specific data. It is the only boundary that understands GitHub payloads and the observed Codex review comment format.
- **Worker:** checks out and manages a dedicated Git worktree and invokes Codex. It reports progress/results to the controller. In the first version it runs in process on the same macOS machine; the interface will not assume that forever.
- **Agent adapter:** starts or resumes an implementation session and streams its turn result. Codex is the only implementation. Keep the session ID opaque and vendor-specific in storage. A future Claude Code adapter may implement the same narrow capabilities without shaping the first version around a lowest common denominator.
- **SQLite:** stores workflow state, inbound webhook receipts, external operation records, session identifiers, cycle counts, head SHAs, review snapshots, and CI status snapshots. WAL mode and bounded transactions are appropriate for a single controller.

No message broker or distributed scheduler is needed. A durable local work queue/operation table can be claimed by the local worker. Persist intent before invoking a non-transactional API or agent action and record its outcome afterward; after a crash, reconcile unknown operations instead of blindly repeating them.

## Workflow states

One workflow row has one of these states:

| State             | Meaning and allowed next action                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `awaiting_review` | A PR head SHA is recorded. Wait for a review completion signal or reconcile GitHub state.                                                               |
| `review_running`  | A recognized Codex review for that head is visibly in progress. Wait; do not start another fix.                                                         |
| `fixing`          | Findings for the current reviewed SHA were delivered to the implementation session, which may edit its worktree.                                        |
| `validating`      | The agent turn ended; run the configured validation and inspect the resulting diff before push.                                                         |
| `ready_for_human` | Latest head has an explicit clean review for the same SHA and all configured required checks pass. Human decides what happens next.                     |
| `escalated`       | Cycle limit, ambiguous review, unsafe change, merge conflict, unavailable session, repeated infrastructure failure, or judgment call requires a person. |
| `stopped`         | User or external lifecycle action stopped/closed the workflow. No automatic restart.                                                                    |

State transitions are performed by controller code and recorded with the triggering event/reason. A later `synchronize` event changes the tracked head and invalidates prior review and CI evidence before returning to `awaiting_review`. An agent cannot set `ready_for_human`; only controller policy can.

## Review completion and findings

### Observed Codex behavior

In `cellgraph/cellgraph` PR #51, the connected GitHub timeline showed a top-level PR conversation comment authored by `chatgpt-codex-connector[bot]`. One HTML comment contains a compact `codex-review-state:v1` marker and JSON. The marker includes `code_review.commit_sha`, `status`, `has_any_findings`, and `has_unresolved_findings`. The same comment was updated in place: its timestamps changed and its marker advanced to a later commit. The timeline also showed separate review submissions with a `codex-review-receipt:v1` marker and “Reviewed commit” text, plus line comments ending in `<!-- codex-code-review-finding:v1 -->`. A clean review summary had `status: completed`, both finding flags false, and a commit SHA.

This is observed product behavior, not a documented or guaranteed Codex/GitHub API. Keep parsing behind a `CodexReviewAdapter` and version the parser. Store the original comment/review ID, author, marker version, parsed commit SHA, status, booleans, timestamps, and parse outcome. Treat unknown versions, malformed JSON, missing fields, multiple conflicting summaries, and unknown status values as indeterminate.

### Event handling and fallback

GitHub identifies `pull_request_review`, `pull_request_review_comment`, and `issue_comment` as separate event families. A PR summary comment is an issue comment; inline findings are review comments; a submitted Codex review is a review event. Subscribe to the relevant events and PR lifecycle events such as `opened`, `reopened`, `synchronize`, and `closed`. Validate `X-Hub-Signature-256` against the raw request body using constant-time comparison, persist the unique `X-GitHub-Delivery` identifier, return quickly, and process asynchronously from the durable inbox. GitHub recommends validating webhook signatures; duplicate deliveries must be harmless.

Events are notifications, not the final source of truth. On receipt and periodic reconciliation, fetch the current PR head and relevant comments/reviews. A review is complete only when a recognized completion signal refers to the exact current head SHA. Finding text comes from marker-tagged inline comments and review body entries retrieved from GitHub; it is untrusted task input and is passed to the implementation session with clear framing. A comment with no findings is not enough to mark clean.

If the structured state marker is absent, malformed, or unknown, the adapter may recognize a supported Codex review receipt and independently fetch the associated review comments, but it must not infer “clean” from absence of inline comments, a thumbs-up reaction, or a completed-looking CI run. Until a documented/verified fallback can prove completion and head identity, record `indeterminate` and escalate or wait for operator action. An explicit manual refresh can retry the adapter after it is updated. Polling current comments/reviews is the recovery path for dropped webhooks; it does not weaken the explicit-completion rule.

### Reaching a clean ready state

GitHub check runs and legacy commit statuses are separate APIs. Read both for the current commit, and decide which checks are required from repository configuration rather than hardcoding “all green” or treating no checks as success. A required check that is missing, pending, failing, or associated with a different SHA prevents readiness. Verify how required checks/rulesets are configured during setup. Avoid creating a Switchyard check run in the first milestone; observing required status checks is sufficient.

## Persistence and recovery

Minimum durable records are:

- workflow identity, PR identity, current state, current head SHA, cycle count, timestamps, last error, and escalation reason;
- webhook delivery ID and processing status, uniquely keyed for deduplication;
- agent session ID, worktree path, last successful turn, operation intent, and last known Codex CLI/SDK version;
- review summary snapshots and exact source comment/review IDs, keyed to commit SHA;
- check/status snapshots keyed to commit SHA;
- append-only transition/operation history sufficient to explain why the controller acted.

On startup, recover unprocessed webhook inbox rows, reconcile in-flight operations, verify the worktree and session persistence path still exist, and refresh GitHub state. Never replay an agent turn simply because its completion record is missing; inspect the session/worktree and require an explicit recovery rule or escalate. Use SQLite migrations from the first schema version.

## Codex session and workspace lifecycle

The official TypeScript SDK wraps the Codex CLI. It exposes `startThread()`, repeated `thread.run()` calls, `resumeThread(threadId)`, and streamed events. Its README says threads are persisted under `~/.codex/sessions`. Switchyard should store the opaque thread ID and preserve the configured Codex home directory, CLI installation/version, and session files across controller restarts. The first implementation must prove continuation from a fresh process, after an interrupted turn, and with a stable worktree path before declaring recovery reliable.

Create one Git worktree per workflow so an agent cannot change the user's checkout or collide with another workflow. Verify clean start, exact target branch/commit, generated diffs, commit/push outcome, and worktree cleanup rules. Keep credentials out of the agent's repository and prompts where possible, constrain filesystem/network permissions, and require an explicit controller decision before pushing. The user asked the original implementation session be resumed; if the persisted thread cannot safely attach to a new worktree, escalate instead of silently switching execution context.

## GitHub integration

Use a GitHub App, not a user-wide personal token. Initial permissions should be reviewed against the exact endpoints used: repository metadata read, pull requests read, issues read for conversation comments, checks/statuses read, and contents read only if needed to resolve the base/head or fetch code. Add contents write only if implementation workflow needs to push through the App; prefer the developer's existing Git credential path for the local first milestone if that is more manageable. Webhook events should be minimized to PR lifecycle, review, review-comment, issue-comment, and check/status updates needed for reconciliation. Re-check App permissions with a live test install before relying on them.

GitHub requires a publicly reachable webhook URL for live deliveries. Keep local development free of required paid services: test signature validation and workflow handling with saved/fixture deliveries, and offer polling/manual sync for local runs. A tunnel may be documented as an optional developer convenience, not a required runtime dependency. Before deployment, decide where the webhook endpoint is hosted and how it authenticates to the local worker; that is outside the initial local milestone.

## Branch policy and human handoff

Live settings were inspected with `gh` on 2026-11-15. The repository has no rulesets (`gh api repos/cellgraph/switchyard/rulesets` returned `[]`), and the `main` branch-protection endpoint returned “Branch not protected.” No settings were changed.

Recommend a ruleset for `main` that requires pull requests and the `Quality checks` CI status, which runs formatting, lint, type checking, and tests. Enable automatic Codex review for the repository in Codex's GitHub settings. The observed Codex integration publishes a summary comment, not a GitHub status check, so do not configure a required Codex check unless the integration later exposes an enforceable status. Do not require owner approval for every PR by default, and do not reduce any protections already present when applying this recommendation elsewhere. `ready_for_human` only means Switchyard has satisfied its automation gate; it does not approve or merge the PR.

## References and open questions

- The [Codex TypeScript SDK README](https://github.com/openai/codex/blob/main/sdk/typescript/README.md) documents session resume, local session persistence, streaming, working directory controls, and environment configuration.
- GitHub documents [webhook event families](https://docs.github.com/en/webhooks/webhook-events-and-payloads), [signature validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries), [pull request review resources](https://docs.github.com/en/rest/pulls/reviews), [check runs](https://docs.github.com/en/rest/checks/runs), and [commit statuses](https://docs.github.com/en/rest/commits/statuses).
- Verify the exact webhook action emitted when the Codex persistent summary comment is edited, delivery ordering, and whether Codex emits any independent check/status signal for completion. The public event docs define issue-comment events, but they do not document Codex's private marker.
- Determine if one Codex thread can be resumed with the same context after a restarted controller while the worktree path remains stable, and how interrupted/unknown turns are identified.
- Determine the least-privilege GitHub App permission set for reading review threads, checks, and PR code, and the most practical macOS authentication model for pushing.
- Confirm whether “required checks” should be derived from branch protection/rulesets, supplied in local configuration, or both. Fail closed if the set cannot be determined.
- Define supported manual actions for ambiguous reviews, conflicts, agent auth expiry, failed pushes, and worktree recovery.
