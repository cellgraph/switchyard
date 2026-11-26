# Switchyard project context

This document records durable product direction and scope. Architecture rationale belongs in numbered records under `docs/adr/`; implementation work belongs in numbered plans under `docs/plans/`.

## Vision

Switchyard coordinates specialized coding agents through implementation, validation, review, revision, and acceptance. The initial use case is automating the Codex pull request review/fix loop for GitHub repositories. The broader goal is to coordinate agents across local machines and cloud VMs for workflows that may not use pull requests.

## First milestone scope

The initial use case covers GitHub pull requests produced by a Codex implementation session. Switchyard coordinates independent review, sends actionable findings to the implementation session, and observes validation and publication. The workflow ends when the current head has an explicit clean review and passing required checks, or when its stopping rules call for human judgment. The initial loop allows at most three unsuccessful fix cycles. Switchyard never automatically merges a pull request.

Workflows can start automatically under configured policy or through an explicit operator request. Once started, they proceed under workflow rules until completion or a decision requires operator judgment.

## Engineering principles

- Prefer the simplest solution that satisfies a demonstrated orchestration requirement. Use native interfaces and distinguish product requirements from architecture choices, development expedients, and assumptions.
- Keep transitions deterministic and observable. Persist workflow state, execution outcomes, and enough history to explain decisions.
- Associate review and CI evidence with the exact PR head SHA. Require explicit evidence of a clean review.
- Use Git and GitHub for source state, GitHub for review content, and native agent runtimes for session management.
- Give agents responsibility for implementation, validation, commits, push, and review publication. Give the operator responsibility for credentials, permissions, and native runtime controls on trusted hosts.
- Reconcile established outcomes, retry known non-execution within workflow limits, and pause on uncertainty.
- Prefer concrete implementations, functions, explicit errors, and comments that explain why.

## Deployment direction

Use a persistent TypeScript and Node.js controller on a VM with SQLite for durable workflow state. Configure agent placement on local or remote hosts, including worker, provider, model, and native runtime profile. GitHub webhooks are the primary GitHub trigger. Local development can use local execution and fixture, periodic, or explicit reconciliation.

[ADR-0006](docs/adr/0006-orchestrate-through-native-tools.md) records the accepted direction and superseded decisions. The [architecture overview](docs/architecture.md) distinguishes that direction from the current implementation.

## Repository conventions

- Shared, agent-agnostic instructions: `AGENTS.md`; `CLAUDE.md` is a compatibility pointer.
- Product context: `CONTEXT.md`.
- Sequential architecture decision records: `docs/adr/NNNN-*.md`.
- Sequential implementation plans: `docs/plans/NNN-*.md`, beginning with `001`.
- Semantic commit messages; feature branches and PRs to `main`.
- CI checks formatting, linting, types, and tests. Implementation PRs receive independent automated Codex review.
- Keep pull requests required for merge. Do not require repository-owner approval on every PR by default.
- Dependabot updates npm dependencies and GitHub Actions.

## Outside current scope

Automatic merge, a general-purpose workflow definition language, dynamic worker scheduling, multitenant execution, and a hosted product UI are outside current scope.
