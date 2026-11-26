# ADR-0003: Own review evidence and decisions in SQLite

- Status: Accepted for Phase 4
- Supersession: [ADR-0006](0006-orchestrate-through-native-tools.md) supersedes parts of this record. See its prior decisions table for details.
- Date: 2026-11-20

## Context

GitHub notifications can arrive late or out of order. Codex can update one summary comment across commits, and GitHub can reposition inline comments as the diff changes. An App can also lose the response after GitHub has accepted a comment. None of those external behaviors is sufficient to recover Switchyard's workflow or reconstruct an operator's decisions.

## Decisions

1. Store review runs against exact workflow and PR heads. Commit the terminal result, validated findings, and applicable workflow verdict together. Keep historical or interrupted runs inspectable. Bind the existing workflow projection to the evidence run and invalidate its authority when the head changes.
2. Maintain separate append-only triage and resolution actions under stable finding IDs. Require operator rationale and an expected previous action. Agent and GitHub data can supply evidence. The controller applies the transitions.
3. Import Codex reviews via the versioned GitHub evidence adapter. Accept structured results for independent operator-managed reviews without opening a second local agent lifecycle. ADR-0002 still governs the local implementation session.
4. Use a separate publication record for each root comment and disposition reply. Commit intent and the attempt claim before POST. Reconcile against a trusted App identity, immutable body marker, and original anchor or parent. Keep ambiguous attempts held when GitHub cannot prove their outcome. A thread observation cannot apply a decision.

## Consequences

Review findings and decisions survive escalation, restart, and deleted GitHub comments. Unsupported GitHub evidence can require a fresh operator review. An ambiguous write with no visible match can require manual investigation indefinitely. The system needs write scope only for the explicit publication command. Phase 5 can consume reviewed-head and actionable-finding evidence without guessing from comment counts or resolution flags.
