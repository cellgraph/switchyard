# Workflow state and recovery

This guide describes Phase B1. [ADR-0006](adr/0006-orchestrate-through-native-tools.md) records the accepted architecture, and [Plan 003](plans/003-architectural-simplification.md) sequences the remaining work.

| State             | Meaning                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------- |
| `awaiting_review` | The configured PR is open and can receive current-head CI observations. Review-driven handoff is unavailable in B1. |
| `escalated`       | A recorded escalation requires operator inspection.                                                                 |
| `stopped`         | GitHub closed the PR or an operator stopped the workflow.                                                           |

Transitions record their reason and head SHA alongside the updated workflow. A head change or PR closure clears current CI evidence. A final lifecycle read must confirm the head before reconciliation saves checks, and a newer observation supersedes earlier in-flight reads even at the same SHA. Prior check snapshots and exact-head review metadata remain available for inspection. Passing CI does not advance a workflow to handoff in B1. [Review evidence](reviews.md)

An observed reopen returns an existing configured workflow stopped by GitHub to observation. Operator stops and escalations persist across reconciliation and GitHub reopen. GitHub observation does not dispatch agent execution. Merge remains a human decision.

## SQLite baseline

Use a fresh database by pointing `SWITCHYARD_DB_PATH` at an unused or empty file. The store uses application ID `SWYD` and schema version 18. It rejects incompatible databases before modifying them. Deployment cutover and archiving the production database belong to Phase D.

SQLite retains workflow identity and history, webhook receipts, GitHub observation and retry state, check snapshots, review metadata, native session references and standalone execution attempts. On restart, interrupted inbox processing returns to the queue. Execution claims with live local owners remain in flight. Lost owners leave the assignment and its session held for inspection. [Local execution recovery](agent-sessions.md#recovery)
