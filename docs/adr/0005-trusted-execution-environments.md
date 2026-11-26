# ADR-0005: Trust operator-controlled execution environments

- Status: Accepted architectural direction. Implementation pending operator approval of [Plan 002](../plans/002-claude-code-authentication.md).
- Supersession: [ADR-0006](0006-orchestrate-through-native-tools.md) supersedes parts of this record. See its prior decisions table for details.
- Date: 2026-11-24

## Context

Switchyard is a personal orchestration tool. The original Claude adapter prescribed an entire runtime profile. That coupled native subscription login to unrelated launch restrictions and made the presence of a managed settings file block execution. The controller needs reliable evidence about a turn and its checkout. The operator already controls the hosts and can configure the native providers there.

## Decision

- Switchyard owns durable workflow coordination, agent/model/worker selection, worktrees and session affinity, execution lifecycle and cancellation, recovery, and result and checkout verification. It owns operator authorization and publication for actions it performs. Exact-head review and CI evidence, finding dispositions, bounded fix cycles, leases and fencing remain part of the orchestration contract.
- The operator provisions trusted hosts and native runtimes. The host and runtime own provider authentication and credentials, sandbox and filesystem permissions, network and shell access, tools, hooks, MCP, other extensions, and managed policies. Use native controls when they solve a concrete execution need. Keep orchestration checks that prove identity, protocol compatibility, and operation outcomes.
- Tell the agent to leave the checkout unchanged on review turns. Require a matching checkout identity and exact head, unchanged checkout evidence, and a valid result before accepting the review. Reject unexpected changes or unverifiable evidence and hold the affected work for inspection. Fix candidates still require approved paths, validation, and separate authorization for controller publication.
- Use the existing repository/provider/model worker placement and single-delivery lease protocol. Workers are trusted to report their observations faithfully. Multitenant execution, generalized task requirements, policy engines, capability negotiation, and worker attestation are outside this design.

## Consequences

A checkout comparison observes the final state. It cannot detect every temporary write or prevent or undo side effects outside the checkout, such as network requests, file writes elsewhere, commits pushed independently, or actions by remote extensions. Process cancellation applies to the process group Switchyard starts. The operator must configure the environment to limit actions or background work outside that group. Controller publication approvals govern only the controller's actions. Agents can use any independent permission the operator gives them.

This supersedes the launcher policy in the [Claude adapter ADR](0004-local-claude-code-provider.md) and the adapter-enforced review policy in the [remote worker ADR](0004-remote-agent-turns.md). [Plan 002](../plans/002-claude-code-authentication.md) stages the behavior change. The operating guides describe the current adapters until that work ships.
