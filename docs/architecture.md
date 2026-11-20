# Switchyard architecture

This document describes the smallest architecture that supports the first Codex/GitHub pull request loop while leaving a path to other agents and remote workers. The decisions here are recorded in [ADR-0001](adr/0001-local-controller-and-agent-boundary.md); unresolved assumptions are explicit so they can be verified in later phases.

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
- **Webhook receiver:** validates the signature over raw bytes and records the delivery ID and routing hint in the SQLite inbox before responding.
- **GitHub adapter:** reads current PR, review, comment, check run, and status data through read-only GitHub App credentials. It provides the GitHub-specific inputs for the future review adapter.
- **Worker:** checks out and manages a dedicated Git worktree and invokes Codex. It reports progress/results to the controller. In the first version it runs in process on the same macOS machine; the interface will not assume that forever.
- **Agent adapter:** starts or resumes an implementation session and streams its turn result. Codex is the only implementation. Keep the session ID opaque and vendor-specific in storage. A future Claude Code adapter may implement the same narrow capabilities without shaping the first version around a lowest common denominator.
- **SQLite:** stores workflow state, inbound webhook receipts, external operation records, session identifiers, cycle counts, head SHAs, review snapshots, and CI status snapshots. WAL mode and bounded transactions are appropriate for a single controller.

The controller claims agent operations through SQLite and calls the local worker in process. The worker receives one operation ID and checkout target, and returns evidence through a provider-neutral interface.

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
| `stopped`         | An operator stopped the workflow or GitHub closed the PR. A GitHub reopen can resume a workflow stopped by the closure.                                 |

State transitions are performed by controller code and recorded with the triggering event/reason. Reconciliation after a `synchronize` event reads the current GitHub head. A changed head invalidates prior review and CI evidence before returning to `awaiting_review`. If a head-change notification arrives while validation is active, preserve `validating` until the controller records that cycle's outcome, then wait for review of the new head. Persist the validation-start SHA to order review and push events safely. An agent cannot set `ready_for_human`; only controller policy can.

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

Phase 1 implements the controller-owned state model and local SQLite store in `src/workflow.ts` and `src/store.ts`; see [the state model and recovery notes](state-model.md). Schema migrations are versioned from the initial schema. State plus transition history and evidence snapshots are written in one transaction. Delivery IDs are unique, and operations persist intent before an external side effect. Startup recovery requeues interrupted inbox processing. It escalates workflows with unresolved external operations that may have acted before the restart.

Minimum durable records are:

- workflow identity, PR identity, current state, current head SHA, cycle count, timestamps, last error, and escalation reason;
- webhook delivery ID and processing status, uniquely keyed for deduplication;
- agent session ID, worktree path, last successful turn, operation intent, and last known Codex CLI/SDK version;
- review summary snapshots and exact source comment/review IDs, keyed to commit SHA;
- check/status snapshots keyed to commit SHA;
- append-only transition/operation history sufficient to explain why the controller acted.

## Durable local agent sessions

Phase 3B extends the existing SQLite `agent_sessions`, `worktrees`, and `operations` tables. A workflow has one local agent session binding and a history of turn operations. A binding identifies the provider and model, the exact SDK and bundled CLI versions, the Codex home and runtime fingerprint, the provider thread ID, the linked Git checkout, and the initial and most recently observed local commit. The PR head used to authorize a turn is recorded separately from the expected and observed local head.

The controller accepts explicit local requests with a stable operation ID, the workflow and branch, both expected heads, a local execution configuration, and a prompt. SQLite stores a digest of the prompt and requested configuration. The caller supplies the same request again to dispatch an undispatched operation. A reused ID with changed input is a conflict. Only one unresolved agent operation can exist per workflow. Phase 3B polling and webhook handlers continue to observe GitHub. They never authorize a turn.

| Operation status        | How the controller handles it                                                                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `requested`             | The controller has recorded the request. The same request may be supplied again after restart, subject to the current workflow authorization.                                              |
| `dispatching`           | SQLite has granted one claim. The controller probes the local runtime and checks compatibility with the saved binding.                                                                     |
| `running`               | The worker may have touched Git or invoked Codex. The expected checkout location is saved before creation, and observed checkout and thread identities are saved as they become available. |
| `completed`             | There is a confirmed turn outcome, or authorization expired before dispatch and the record explains that no turn was launched. Known failures hold the session and escalate the workflow.  |
| `interrupted`           | The worker observed a cancellation. It can have partial effects, so the session is held.                                                                                                   |
| `unknown`               | The worker lost the outcome or its local owner exited after a claim but before the final transaction. The session is held even if Git appears clean.                                       |
| `manual_reconciliation` | Required evidence is missing or incompatible, or workflow authorization changed after dispatch. The operation and session are retained for inspection.                                     |

After checkout and session preflight, the controller records a transactional authorization check for the current workflow revision immediately before SDK launch. Operation evidence, the session binding, and the resulting workflow transition are committed together. A successful standalone turn leaves the workflow in `awaiting_review`. A successful `fixing` turn can enter `validating` only with findings and a checkout for the currently recorded PR head. Reconciliation that changes the PR head or closes and reopens the PR invalidates earlier authorization. A completed agent turn never makes a PR ready for merge.

The local worker checks the Git common directory, registered checkout, branch and exact local head. It compares Git status and index entries, including the distinction between intent-to-add and staged additions, and a bounded content checkpoint that covers tracked, untracked, and ignored files. This lets Switchyard preserve previously recorded edits across a restart and detect new changes even when the Git status paths are identical. Codex continuation requires the same readable rollout selected by the pinned CLI’s state database for the recorded thread and working directory. After a successful turn the worker checks that the selected rollout still has the same identity. The runtime fingerprint includes system and user configuration files and managed startup requirements. Missing or changed checkouts, rollout files, configuration, or runtime versions hold the session. A fresh start refuses an existing workflow checkout without a binding. See [ADR-0002](adr/0002-local-worker-session-and-worktree-identity.md).

Startup recovery checks the process ID recorded with each agent claim. Live owners retain their claims through outcome commit. Recovery holds a claim for inspection after the OS confirms its owner has exited. An interrupted claim can leave a Codex subprocess or Git effects for an operator to inspect. Phase 3B does not guess the result, adopt an unproven session, reset a held session, or clean up its worktree. See the [local operations guide](agent-sessions.md) for commands and verification.

## GitHub integration

Phase 2 uses the Phase 1 SQLite inbox and workflow store. The receiver checks the request, stores a minimal reconciliation hint, and returns after the durable insert. A serial controller pass claims due rows and processes them independently of HTTP. Webhook and periodic triggers both use the same reconciler and can share one observation of a PR within a pass. If the PR head moves during the evidence reads, the reconciler records the newly observed head and retries without saving stale evidence.

The local configuration selects the PRs to track under each App installation. See the [GitHub App setup guide](github-app.md) for the read-only permission set, subscriptions, optional webhook delivery, fixture tests, and polling/manual refresh. Phase 2 reads review inputs and collects exact-head check evidence. The review parser and required-check discovery are deferred to their planned phases.

## Branch policy and human handoff

See the [GitHub App setup guide](github-app.md#offline-development-and-live-verification) for the rules observed on `main` during Phase 2.

Recommend a ruleset for `main` that requires pull requests and the `Quality checks` CI status, which runs formatting, lint, type checking, and tests. Enable automatic Codex review for the repository in Codex's GitHub settings. The observed Codex integration publishes a summary comment, not a GitHub status check, so do not configure a required Codex check unless the integration later exposes an enforceable status. Do not require owner approval for every PR by default, and do not reduce any protections already present when applying this recommendation elsewhere. `ready_for_human` only means Switchyard has satisfied its automation gate; it does not approve or merge the PR.

## References and open questions

- The [Codex TypeScript SDK README](https://github.com/openai/codex/blob/main/sdk/typescript/README.md) documents session resume, local session persistence, streaming, working directory controls, and environment configuration.
- GitHub documents [webhook event families](https://docs.github.com/en/webhooks/webhook-events-and-payloads), [signature validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries), [pull request review resources](https://docs.github.com/en/rest/pulls/reviews), [check runs](https://docs.github.com/en/rest/checks/runs), and [commit statuses](https://docs.github.com/en/rest/commits/statuses).
- Verify the exact webhook action emitted when the Codex persistent summary comment is edited, delivery ordering, and whether Codex emits any independent check/status signal for completion. The public event docs define issue-comment events, but they do not document Codex's private marker.
- Determine if one Codex thread can be resumed with the same context after a restarted controller while the worktree path remains stable, and how interrupted/unknown turns are identified.
- Determine the least-privilege GitHub App permission set for reading review threads, checks, and PR code, and the most practical macOS authentication model for pushing.
- Confirm whether “required checks” should be derived from branch protection/rulesets, supplied in local configuration, or both. Fail closed if the set cannot be determined.
- Define operator actions that can resolve held operations after investigation. Phase 3B supports inspection and escalation.
