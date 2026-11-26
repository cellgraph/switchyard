# ADR-0001: Local controller, durable state, and narrow agent boundary

- Original status: Accepted for the first milestone
- Current status: The original milestone inbox, worktree ownership, external review markers and explicit-clean gate were superseded by [ADR-0006](0006-orchestrate-through-native-tools.md#prior-decisions-superseded).
- Date: 2026-11-15

## Context

Switchyard should first automate the Codex review/fix loop for GitHub PRs on a macOS development machine. It must survive process restarts, associate every review with an exact commit SHA, and stop for human judgment after at most three unsuccessful cycles. Longer term it may coordinate different agents on local machines and remote Linux workers, but those use cases do not yet justify distributed infrastructure.

The official Codex TypeScript SDK drives the Codex CLI, supports thread resumption by opaque ID, and documents persisted sessions in the local Codex home directory. The observed `codex-review-state:v1` marker in Cellgraph PR #51 is useful for detecting review completion but is not documented as a stable public API.

## Decisions

1. Use one Node.js controller process and SQLite for the first milestone. Add a durable webhook inbox and operation records so duplicate deliveries and restarts can be recovered without a broker.
2. Run a local worker in the same process and isolate each workflow in a Git worktree. Keep the controller/worker contract separate from GitHub and Codex APIs so remote execution can be considered later.
3. Implement only a Codex agent adapter. Keep its thread ID opaque and do not prematurely normalize vendor-specific capabilities. Define only the start/resume/turn-result operations needed by the first workflow.
4. Isolate Codex review parsing in a versioned GitHub adapter. Require an explicit completed signal and an exact match between review SHA and current PR head. Indeterminate data waits or escalates; no comments never means clean.
5. Make PR readiness a controller-owned state gated by an explicit clean review and passing configured required checks for the current head. Never merge automatically.
6. Keep live GitHub webhook delivery optional for local development. Fixture deliveries, local polling, and manual sync support development without requiring paid infrastructure. Deployment of a reachable webhook receiver is a later setup decision.

## Consequences and tradeoffs

- SQLite plus a durable inbox and reconciliation are simple for one host and recoverable, but do not allow concurrent controllers on different machines. A remote worker will need a defined lease/claim protocol before it can be added.
- Persisted Codex threads do not by themselves prove that an in-progress side effect or worktree is safe to replay. The controller must record intent and inspect session/worktree state; ambiguous work escalates.
- Codex's private marker can change. Versioned parsing and a fail-closed unknown state avoid false success at the cost of occasional manual intervention.
- A local GitHub App webhook requires inbound reachability for live events. Polling/manual sync is less immediate but keeps local setup independent of a hosted service.
- A narrow agent boundary avoids building a speculative multi-provider runtime but may need revision when a second adapter is implemented.

## Revisit when

- A second agent implementation requires capabilities the boundary cannot express.
- A worker must run on a separate host, requiring remote authentication, leases, and transport.
- A local SQLite controller has demonstrated contention, availability, or scale limits.
- Codex publishes a supported review completion API that replaces marker parsing.
