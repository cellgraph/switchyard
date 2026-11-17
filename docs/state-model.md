# Phase 1 state model and recovery

The controller owns transitions among `awaiting_review`, `review_running`, `fixing`, `validating`, `ready_for_human`, `escalated`, and `stopped`. Transition commands take explicit evidence and persist the resulting state and an append-only reason/head-SHA record together. Agent output is not a transition command.

Readiness requires an explicit `completed_clean` review for the current head, a known non-empty configured required-check set, and a passing snapshot for every configured check at that exact SHA. Missing, stale, pending, failed, unknown, or indeterminate evidence fails closed. A new head clears current review and check evidence. Three unsuccessful fix cycles escalate the workflow.

SQLite migrations are tracked in `schema_migrations`. Webhook delivery IDs are unique. A delivery left `processing` at restart returns to `pending`; handlers must use durable operation IDs for any external side effect because the process may have acted before it recorded completion. Pending operations at restart become `ambiguous`, are never replayed automatically, and cause their workflows to escalate. An operator or later reconciliation policy can resolve them explicitly. No state transition approves or merges a pull request.

The current store uses Node.js `node:sqlite` and synchronous bounded transactions for the single local controller. GitHub payload interpretation and external APIs are not part of this phase.
