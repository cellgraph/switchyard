# Workflow state and recovery

This guide describes Phase A2. [ADR-0006](adr/0006-orchestrate-through-native-tools.md) records the accepted architecture, and [Plan 003](plans/003-architectural-simplification.md) sequences the remaining work.

| State             | Meaning                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------- |
| `awaiting_review` | The workflow is waiting for evidence or a resolution that allows handoff.                               |
| `review_running`  | A review of the current head is in progress.                                                            |
| `review_findings` | A review of the current head completed with findings. Observation and review commands remain available. |
| `ready_for_human` | Current review and CI evidence meet the handoff conditions.                                             |
| `escalated`       | An uncertain outcome or another issue requires operator inspection.                                     |
| `stopped`         | The PR closed or an operator stopped the workflow.                                                      |

Transitions record their reason and head SHA alongside the updated workflow. Handoff requires explicit clean review and passing checks from a configured, nonempty check set for the exact current head. Pending and accepted open findings from projected reviews block readiness until resolved, including across head changes. A changed head clears the current review and CI projection. Late results from superseded runs remain historical. Reopening a blocking finding can revoke readiness. Merge remains a human decision.

A closed PR stops the workflow and clears its current evidence. An observed reopen returns an existing configured workflow stopped by GitHub to observation. Operator stops and escalations persist across reconciliation and GitHub reopen. GitHub observation does not dispatch agent execution.

## SQLite baseline

Use a fresh database by pointing `SWITCHYARD_DB_PATH` at an unused or empty file. The store uses application ID `SWYD` and schema version 17. It rejects incompatible databases before modifying them. Deployment cutover and archiving the production database belong to Phase D.

SQLite retains workflow and evidence history, webhook receipts, GitHub retry state, review and finding records, review-comment synchronization, native session references, and standalone execution attempts. Webhook delivery IDs are unique. On restart, interrupted inbox processing returns to the queue. Execution claims with live local owners remain in flight. Lost owners leave the assignment and its session held for inspection. See [local execution recovery](agent-sessions.md#recovery).
