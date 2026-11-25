# Switchyard project context

This document records durable product direction and scope. Architecture rationale belongs in numbered records under `docs/adr/`; implementation work belongs in numbered plans under `docs/plans/`.

## Vision

Switchyard coordinates specialized coding agents through implementation, validation, review, revision, and acceptance. The initial use case is automating the Codex pull request review/fix loop for GitHub repositories. The broader goal is to coordinate agents across local machines and cloud VMs for workflows that may not use pull requests.

## First milestone scope

The initial workflow begins with a Codex implementation session that has pushed a GitHub pull request. GitHub triggers an independent Codex code review. Switchyard waits for an explicit review completion signal for the current PR head, sends actionable findings to the original implementation session, and records validation and push results. This repeats until the latest commit has a clean review and required checks pass, or the workflow stops for human judgment. Three unsuccessful fix cycles are the maximum.

Switchyard never automatically merges a pull request. The first milestone supports Codex only, GitHub only, SQLite durable state, Git worktrees, and a local macOS controller. No cloud service, queue, distributed scheduler, or general-purpose workflow engine is required for local development.

## Engineering principles

- Keep transitions deterministic and observable; use agents for code and reasoning, not routine state transitions.
- Persist workflow state before and after external side effects, make webhook handling idempotent, and provide recovery after process restarts.
- Attach all review and CI evidence to exact commit SHAs.
- Never infer a clean review from missing comments, missing review records, or elapsed time.
- Let the operator provision credentials and permissions on trusted execution hosts. Keep workflow authorization and evidence checks in Switchyard. See [ADR-0005](docs/adr/0005-trusted-execution-environments.md).
- Keep controller and worker responsibilities logically separate, while using one process and local worker initially.
- Extend the agent boundary when a supported provider or workflow demonstrates the need.
- Prefer concrete implementations, functions, explicit errors, and comments that explain why.

## Initial technology direction

TypeScript and Node.js; the official OpenAI Codex TypeScript SDK; GitHub App and webhooks; SQLite; Git worktrees; macOS for initial deployment. The first durable agent session uses the Codex SDK's persisted thread and `resumeThread()` support. Session files, the SDK/CLI version, and worktree lifetime are part of the recovery contract and need verification in the first implementation.

For local checks, use a current Active LTS Node.js release. At initialization, Node.js 26 is the current LTS release; the Codex SDK requires Node.js 18 or newer. See the [Node.js release schedule](https://nodejs.org/en/about/previous-releases) and the [Codex TypeScript SDK README](https://github.com/openai/codex/blob/main/sdk/typescript/README.md).

## Repository conventions

- Shared, agent-agnostic instructions: `AGENTS.md`; `CLAUDE.md` is a compatibility pointer.
- Product context: `CONTEXT.md`.
- Sequential architecture decision records: `docs/adr/NNNN-*.md`.
- Sequential implementation plans: `docs/plans/NNN-*.md`, beginning with `001`.
- Semantic commit messages; feature branches and PRs to `main`.
- CI checks formatting, linting, types, and tests. Implementation PRs receive independent automated Codex review.
- Keep pull requests required for merge. Do not require repository-owner approval on every PR by default.
- Dependabot updates npm dependencies and GitHub Actions.

## Not in the first milestone

Claude Code execution, Linux or exe.dev workers, remote controller/worker deployment, automatic merge, arbitrary workflow graphs, distributed queues, hosted product UI, broad agent autonomy, and non-PR workflows. Keep the worker boundary clear enough to add remote execution later, but defer its protocol and deployment until there is a demonstrated need.
