# Switchyard architecture

[ADR-0006](adr/0006-orchestrate-through-native-tools.md) records the accepted architecture. [Plan 003](plans/003-architectural-simplification.md) sequences the replacement. The operating guides describe the implementation after Phase A2.

## Accepted direction

A persistent TypeScript controller on a VM uses SQLite for workflow state, execution records and operator decisions. Execution and session management, explicit placement, history and operator operations are reusable by software development workflows that may have no PR. The first workflow applies concrete PR review and revision policy.

- **GitHub observation.** Authenticated webhooks signal that state may have changed. Startup, notifications, periodic sweeps and explicit operator requests share one read-only reconciler. GitHub owns PR state, review content and CI results. Durable initiation and execution records prevent duplicate work. Webhook deliveries are transient.
- **Native execution.** The Codex SDK and Claude Code CLI start or continue native sessions in persistent, trusted environments configured by the operator. The controller supplies assignment prompts and optional response schemas and handles results and cancellation where supported. A session can serve multiple execution attempts. Switchyard stores enough metadata and references to explain decisions. Native runtimes retain conversation history, and agents and hosts manage worktrees and Git.
- **PR workflow.** Enabled repositories automatically enroll open, non-draft, same-repository PRs, including those created by people and independent agents. Switchyard dispatches the Reviewer, Adjudicator and Implementer as needed. Agents publish reviews and dispositions, create issues for deferred findings, and implement, validate, commit and push revisions. The controller verifies structured metadata against GitHub. Required CI failures and accepted findings use the same bounded revision path.
- **Handoff and recovery.** Require completed review and passing required CI at the current head, with no unresolved blocking findings. Rejected or deferred findings can satisfy the review gate on unchanged code. A new head invalidates earlier readiness evidence. Reconcile established outcomes, retry known non-execution within limits, and pause on uncertainty. The CLI exposes durable attention requests and operator controls. Merge remains a human decision.
- **Placement.** Roles run where configured. An unavailable host waits. The Rex spike in Plan 003 precedes the remote transport choice. Fixtures and local execution support local development.

## Current implementation

| Area                      | Available behavior                                                                                                                                                                                                                                                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub observation        | Signed webhooks, the SQLite inbox, startup and periodic sweeps, and manual reconciliation observe configured PRs. The unattended worker polls only. See [GitHub App setup](github-app.md) and [unattended polling](unattended.md).                                                      |
| Readiness and state       | An explicit clean review and passing configured checks must match the current head. Prior unresolved findings can still block readiness after a head change. Reconciliation guards against superseded observations and preserves operator stops. See the [state model](state-model.md). |
| Explicit native execution | The Codex SDK and Claude Code CLI start or continue sessions from a configured local working directory and accept optional response schemas. Assignments run independently of PR observation. See [local execution](agent-sessions.md).                                                 |
| Review content            | SQLite retains review runs, findings and disposition history. Explicit review-comment synchronization remains available pending Phase B. See [review operations](reviews.md).                                                                                                           |

### Local execution and persistence

A session records the provider, local placement, working directory, optional model and native config directory, and the native ID once the runtime reports it. Each execution attempt records its own ID and assignment ID, refers to one session, and records its claim, terminal status and diagnostic when applicable. A session can serve several assignments. Independent sessions can run in the same database, including without any PR records.

Switchyard commits an execution's intent and claim in one SQLite transaction before invoking an adapter, and commits its terminal status before returning the result. The execution record provides durable deduplication. A new attempt for the same assignment requires known non-execution of earlier attempts. A running or uncertain execution prevents concurrent use of its session. A lost owner becomes uncertain. The runtime retains the conversation, and response content returns to the requesting caller. The [local CLI guide](agent-sessions.md) documents inspection and recovery.

A2 replaced the affected persistence alongside the native adapters because the earlier persistence encoded their worktree, runtime and authorization contracts. The [HTTP worker](distributed-workers.md) depended on these contracts and has been retired. The SQLite baseline retains the GitHub inbox, exact-head review and CI evidence, findings and workflow history.

Phase A still requires live verification of native start, continuation after restart and outcome reporting. Phase B replaces the GitHub observation and review integration. Phase C investigates Rex before choosing remote placement and transport. Phase D implements autonomous role dispatch, execution limits, the operator CLI and deployment cutover.

### Review evidence

The current Codex adapter recognizes versioned GitHub review evidence. The observed Codex integration can update a single PR conversation comment across heads using a `codex-review-state:v1` marker, and can post independent receipts and marked inline findings. This is observed behavior, so an unknown or ambiguous marker needs additional evidence or operator attention. GitHub review text remains untrusted input. See the [review evidence guide](reviews.md#review-sources-and-completion).
