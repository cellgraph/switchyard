# ADR-0006: Orchestrate through native tools

- Status: Accepted architectural direction, including the execution counting rule approved in Plan 003.
- Date: 2026-11-25
- Original baseline: `e0b10d6`, the merge of PR #21

## Context

The early all-local workflow made it possible to test durable coordination and exact-head evidence. A durable webhook inbox, filesystem checkpoints, native runtime fingerprints, per-step approval gates and controller-owned publication addressed uncertainty in that implementation. The operator reviews following PR #21 and the acceptance of this ADR established a smaller responsibility for Switchyard. GitHub and the native runtimes can establish the outcomes needed for coordination. When they cannot, Switchyard can ask an operator to inspect the situation.

## Decisions

### Product and execution boundaries

Switchyard is a software development orchestrator. Its first workflow is PR review and revision. Future workflows may execute multi-step implementation plans and coordinate initial development, review cycles, testing and acceptance. Agent execution, native session management, placement, execution history and operator operations are independent of PR policy. Sessions and attempts can exist without a PR. The PR workflow can become a step of a larger software development workflow. Implement concrete software development workflows as needed. A generic workflow engine, workflow language, plugin framework and speculative abstractions are outside scope.

Switchyard coordinates partial participation. Humans and independently started agents can open PRs, push changes and address findings. Those events are normal inputs to GitHub reconciliation. Use a known and available Implementer session when one exists. A fresh native session can continue the work using repository, PR and assignment context. Ordinary GitHub reconciliation and conservative recovery handle concurrency and ambiguity.

Run a persistent VM controller with SQLite. Place agent assignments explicitly on configured persistent, trusted environments such as the Mac mini or a cloud VM. Configuration can specify the environment, runtime and invocation context, repository location, model and native profile where applicable. An unavailable placement waits. The operator prepares and configures hosts, software, clones, dependencies, credentials, permissions and Git. Switchyard reports failures. Provisioning, comprehensive environment verification or repair, ephemeral environments, capability negotiation, dynamic scheduling, load balancing, automatic failover and session portability are outside scope.

### Native agent interfaces and records

The official Codex SDK and native Claude Code CLI are the first adapters. Keep the narrow start and resume contract. Adapters submit a prompt with an optional structured response schema, report the native session ID and execution outcome, and request cancellation where supported. Native tools, permissions and results can vary by provider. The execution subsystem is independent of software development workflow policy. Concrete workflows own assignment semantics, lifecycle and result validation. They supply assignment identifiers and execution inputs. A shared assignment entity or table requires a demonstrated need from a concrete workflow.

Introduce named agent configurations when concrete placement and role requirements emerge in Phases C and D. A configuration can specify how Switchyard communicates with an agent, including the mechanism, placement, runtime, model and invocation context.

Logical agent identity identifies an agent in the workflow. Native session identity refers to a runtime conversation. Execution identity identifies one dispatch attempt. External identity governs how actions are attributed and authorized in systems such as GitHub. Native authentication, credentials, authorization, subscriptions, billing and external identity management belong to the execution environment and its operator. Authentication failures follow ordinary execution outcome handling. Identity provisioning and credential management stay outside Switchyard. Revisit attribution and appropriately scoped access during distributed execution and autonomous role design.

Native agents and their execution environments own worktree creation, selection, use and cleanup as well as checkout and validation activity. Switchyard may pass a working directory or other invocation context when the native interface needs it. It uses Git and GitHub evidence where relevant to workflow decisions. It has no worktree management, recursive checkpoints, filesystem identity checks, ignored-file tracking or checkout attestation. Supported native session interfaces replace internal database inspection, transcript hashing, configuration fingerprints and exact-version continuation gates.

Record native sessions separately from individual execution attempts. Sessions can serve multiple assignments, and roles can maintain independent sessions within a workflow. Store native session IDs, assignment IDs, placement and execution context, timestamps, status and decision-relevant outcomes. Preserve substantive prompts, responses, streams and transcripts in the native environments. SQLite explains decisions through coordination metadata, evidence references and history.

Retain five execution states: `running`, `not_started`, `completed`, `failed` and `unknown`. A new state requires a demonstrated, distinct coordination decision.

### GitHub and the first workflow

Use authenticated GitHub webhooks as transient signals. A shared reconciliation path handles notifications, startup, periodic sweeps and operator requests. GitHub is authoritative for PR lifecycle, heads, substantive reviews and required CI observations. Durable workflow state, execution attempts and explicit initiation requests support recovery and deduplication. The durable webhook inbox and per-delivery replay are superseded.

The controller's GitHub integration is read-only. Agents use their native credentials and tools for PR creation, review and disposition publication, issue creation, responses, commits and pushes. Agents retrieve substantive review content directly from GitHub. The controller retains references and metadata needed for decisions. Controller-owned staging, validation, publication and synchronization are superseded.

Automatically enroll open, non-draft, same-repository PRs in explicitly enabled repositories, regardless of author. Drafts wait, external forks are excluded, and close or merge terminates the active workflow. Also support explicit initiation. Switchyard dispatches its configured independent Reviewer. The automatic Codex GitHub integration, external review markers and multiple review sources are outside the first workflow.

The Reviewer publishes to GitHub and returns structured exact-head completion metadata. The independent Adjudicator assigns accept, reject, defer or escalate, publishes its reasoning and returns structured disposition references. It creates a GitHub issue referencing each deferred finding. Routine adjudication proceeds autonomously. The controller validates the structured outcomes and corroborates relevant GitHub evidence before advancing. Natural-language conclusions and custom markers are unnecessary.

Handoff requires completed review of the current head, no unresolved blocking findings, and passing required CI for that head. A clean review is sufficient, and a completed review whose findings were all rejected or deferred qualifies without another review of unchanged code. Unresolved accepted findings and escalated findings block handoff. Missing, incomplete, stale or unverified review evidence cannot establish readiness. Head changes invalidate prior readiness evidence. Switchyard never merges a PR automatically.

Unresolved accepted findings and failed required CI can trigger the same Implementer role. Combine them when practical. The default allowance is three Reviewer rounds and three Implementer revisions. Review-driven and CI-driven revisions share the revision allowance. Assignments consume their slot when they start. Known non-execution retries reuse the reserved slot, and adjudication uses no additional review slot. New heads, restarts and ordinary resumes preserve both allowances. Escalate before dispatch when additional capacity is required, including when a revision would require a subsequent review and no review slot remains. The operator can explicitly grant additional execution. [Plan 003](../plans/003-architectural-simplification.md#accepted-execution-counting-rule) records the accepted counting and recovery details.

### Recovery, remote execution and operator control

Prefer reconciliation from authoritative evidence where practical. Retry known non-execution within workflow limits. When uncertainty remains, pause for operator-directed recovery. An assisting agent can inspect Switchyard, native runtimes, Git and GitHub through supported interfaces. A timeout, disconnect or new PR head alone cannot justify replay.

External evidence may establish that a workflow reached its objective while the native execution outcome remains unknown. Preserve that distinction and keep protections against duplicate work and unsafe continuation while execution may still be ongoing. Native session abandonment may become an operator fallback if it preserves those protections. Learn from actual operating problems before adding recovery mechanisms. Comprehensive provider-specific recovery is outside scope.

Investigate Superlogical Rex before selecting the distributed execution implementation. The spike can establish that Rex replaces the existing worker, supplies primitives for a thinner worker, or is unsuitable. If unsuitable, reassess the existing HTTP protocol against explicit placement, outcome reporting and conservative recovery. This decision gates distributed implementation and leaves local execution and GitHub reconciliation work free to proceed.

Start with a documented CLI for workflow listing and inspection, attention status and reasons, explicit initiation, operator direction, additional execution grants, resume and stop. Provide machine-readable output where useful. Outstanding attention requests live in durable workflow state. Defer MCP until an access requirement justifies it. Proactive notification is a deployment investigation. A shared attention service or messaging bridge belongs outside Switchyard.

## Prior decisions superseded

Earlier records preserve the reasons for the original implementation. This ADR also replaces its own earlier explicit-clean readiness requirement, tentative webhook-inbox decision and Plan 002 launch proposal.

| Record                                                                                                | Superseded requirements                                                                                                                                                                                                           | Retained direction                                                                                             |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| [ADR-0001 — Local controller and agent boundary](0001-local-controller-and-agent-boundary.md)         | Durable inbox, all-local and Codex-only architecture, controller-managed worktrees, versioned external review markers and explicit-clean-only readiness.                                                                          | SQLite, a narrow agent boundary, offline development, exact-head evidence and human merge.                     |
| [ADR-0002 — Local session and worktree identity](0002-local-worker-session-and-worktree-identity.md)  | Controller worktrees and exclusive checkout ownership, identity and content checkpoints, provider-internal verification, pinned continuation, one workflow-bound session, explicit turn authorization and controller push policy. | Opaque native session references, execution history, relevant Git evidence and conservative recovery.          |
| [ADR-0003 — Durable review evidence and publication](0003-durable-review-evidence-and-publication.md) | Permanent finding text and reasons in SQLite, mandatory operator triage, imported Codex markers, and controller publication and synchronization.                                                                                  | Stable review and finding references, exact-head evidence, durable decisions and controller-owned transitions. |
| [ADR-0004 — Local Claude Code provider](0004-local-claude-code-provider.md)                           | Key helper, prescribed tools and policies, runtime and transcript bindings, mandatory edit scopes, controller validation and publication, and orchestration cost tracking.                                                        | Native Claude execution, explicit provider and model selection, and observable outcomes.                       |
| [ADR-0004 — Remote agent turns](0004-remote-agent-turns.md)                                           | Capability matching, per-turn operator requests and authorization, filesystem and session verification, remote review-only restriction and a mandated lease protocol.                                                             | Explicit trusted placement, execution lifecycle and outcome reporting, and pausing on uncertainty.             |
| [ADR-0005 — Trusted execution environments](0005-trusted-execution-environments.md)                   | Controller worktree management and checkout verification, approved paths and separate publication approvals, prescribed lease mechanics and the Plan 002 rollout.                                                                 | Operator control of native environments, exact-head evidence, bounded execution and independent review.        |

## Consequences

Temporary loss of obsolete functionality is accepted during implementation while the repository remains buildable and testable. Remove the controller-owned fix pipeline early. Before deploying the replacement, archive the old SQLite database and preserve native sessions, clones and worktrees independently. Start from a fresh database. Legacy migrations, compatibility layers and parallel legacy execution paths are unnecessary.

[Plan 003](../plans/003-architectural-simplification.md) replaces the remaining PR-loop work in [Plan 001](../plans/001-pr-review-loop.md) and the authentication subsystem proposed in [Plan 002](../plans/002-claude-code-authentication.md). The [architecture overview](../architecture.md#current-implementation) records existing behavior and its operating guides until the replacement ships.
