# Workflow state and recovery

Phase B2 records GitHub lifecycle and eligibility separately from workflow state. A workflow keeps its repository and PR identity through head changes, draft transitions, closure and reopen.

| State             | Meaning                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| `awaiting_review` | The PR is open, non-draft and from its base repository. It can receive current-head CI observations. |
| `escalated`       | A durable operator hold records a reason that requires inspection.                                   |
| `stopped`         | GitHub reported a draft, fork, closure or merge, or the operator recorded a stop reason.             |

The `githubStatus` field reports `eligible`, `draft`, `fork`, `closed` or `merged`. A PR that becomes eligible again can resume observation under its existing workflow ID. Explicit operator stops and escalations retain their reason through later GitHub observations. Held workflows can record lifecycle and head changes while remaining inactive.

Transitions record their reason and head SHA. Head changes, eligibility loss and holds clear current CI evidence. An individual PR read establishes the head for evidence collection. A final PR read confirms lifecycle, eligibility and the head before reconciliation applies checks or activates a workflow. SQLite observation generations prevent older observations from overwriting newer ones, including overlapping observations of the same head. Historical check snapshots and exact-head review references remain inspectable after the current evidence changes.

Phase B2 observes current state and evidence. Review corroboration, autonomous assignments and handoff policy arrive in Phase D. See the [review evidence guide](reviews.md) and [Plan 003](plans/003-architectural-simplification.md).

## SQLite baseline

Point `SWITCHYARD_DB_PATH` at an unused or empty file. The store uses application ID `SWYD` and schema version 20. It rejects incompatible and foreign databases before persistent modification. Archiving the deployed database and opening a fresh one are Phase D cutover work.

SQLite retains workflow identity and history, check snapshots, GitHub observation generations and retry state, review metadata, and native session and execution records. The delivery inbox and replay state were removed. Startup and periodic sweeps recover missed notifications by reading current GitHub state. On restart, live local owners retain their claims. Local claims with lost owners become unknown. For Rex attempts, the controller retrieves the recorded attempt's files and observes the correlated block when available. A valid final file can resolve a held attempt. Missing or conflicting evidence keeps the assignment and session held. See [execution recovery](agent-sessions.md#recovery).
