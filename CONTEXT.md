# Switchyard project context

This document records durable product direction and scope. Architecture rationale belongs in numbered records under `docs/adr/`. Implementation work belongs in numbered plans under `docs/plans/`.

## Vision

Switchyard is a software development orchestrator. Its first workflow is PR review and revision. Future workflows can execute multi-step implementation plans and coordinate initial development, review cycles, testing and acceptance. The PR workflow can be a step in a larger development workflow. Keep execution, sessions, placement, history and operator operations independent of PR policy so they can support assignments with or without a PR.

## First milestone

Automatically enroll open, non-draft, same-repository GitHub PRs in explicitly enabled repositories regardless of author. Also support explicit initiation. Drafts wait until ready, external forks are excluded, and close or merge terminates the active workflow. Humans and independently initiated agents can create or revise PRs throughout the workflow.

Switchyard dispatches an independent Reviewer. An independent Adjudicator evaluates findings, and unresolved accepted findings or failed required CI can trigger bounded Implementer revisions. Agents publish reviews and disposition reasoning on GitHub, create issues for deferred work, and perform implementation, validation, commits and pushes. They can continue a known native session or start a new one with the relevant context.

Handoff for human acceptance requires completed review of the current head, no unresolved blocking findings and passing required CI for that head. A completed review with all findings rejected or deferred can satisfy the review gate on unchanged code. Accepted unresolved and escalated findings block handoff. Missing, incomplete or stale evidence cannot establish readiness. Head changes invalidate prior readiness evidence. Switchyard never merges a PR automatically.

## Engineering principles

- Prefer the simplest solution that satisfies a demonstrated orchestration requirement. Use native tools and concrete software development workflows.
- Keep transitions deterministic and observable. Persist workflow state, separate sessions and execution attempts, decisions and evidence references. Keep substantive review content on GitHub and native session history in the runtime.
- Use a read-only GitHub integration and reconcile on authenticated webhooks, startup, periodic sweeps and operator requests through one path. GitHub observations and validated structured agent results inform the workflow.
- Give native agents and their environments responsibility for worktrees and source changes. Give the operator responsibility for preconfigured hosts and native credentials, permissions and billing.
- Reconcile established outcomes, retry known non-execution within workflow limits, and pause on uncertainty. Bound autonomous review and revision. Require an explicit operator grant for additional execution.
- Make workflows and outstanding operator decisions legible to humans and agents through a documented CLI.

## Deployment direction

Use a persistent TypeScript and Node.js controller on a VM with SQLite. Configure explicit execution placement on trusted local or remote hosts, including runtime, repository context and model or native profile where appropriate. The official Codex SDK and native Claude Code CLI are the first agent interfaces. Retain local development with fixtures or explicit reconciliation.

[ADR-0006](docs/adr/0006-orchestrate-through-native-tools.md) records the accepted decisions and superseded requirements. [Plan 003](docs/plans/003-architectural-simplification.md) defines the implementation and acceptance work. The [architecture overview](docs/architecture.md) describes the current implementation.

## Repository conventions

- Shared, agent-agnostic instructions are in `AGENTS.md`. `CLAUDE.md` is a compatibility pointer.
- Record product context in `CONTEXT.md`, decisions in sequential `docs/adr/NNNN-*.md` records and implementation plans in sequential `docs/plans/NNN-*.md` files.
- Use semantic commits and branches. Send changes to `main` through a PR.
- CI checks formatting, linting, types and tests. Implementation PRs receive independent automated Codex review.
- Keep pull requests required for merge. Repository-owner approval is optional by default.
- Dependabot updates npm dependencies and GitHub Actions.

## Outside current scope

Automatic merge, broader workflow implementation, a generic workflow engine, a workflow definition language, a plugin framework, dynamic scheduling, ephemeral execution environments, session migration, multitenant execution and a hosted product UI are outside current scope.
