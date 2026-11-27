# Switchyard

Switchyard coordinates coding agents through the lifecycle of a software change. Its first workflow is GitHub PR review and revision. Switchyard never merges a pull request.

## First milestone

The accepted design dispatches independent review for eligible PRs in enabled repositories. Agents adjudicate findings and revise the PR when findings or failed required CI need action. Switchyard hands off for human acceptance when review is complete, no blocking findings remain, and required CI passes for the current PR head.

A persistent VM controller uses SQLite and reads GitHub state. Authenticated webhooks and periodic reconciliation keep it current. Agents run through native Codex and Claude Code interfaces on configured, trusted hosts. The operator manages the environments, and agents handle worktrees, validation, commits, pushes and review publication.

## Status and setup

Phase B1 observes the lifecycle and exact-head CI of explicitly configured GitHub PRs through startup, polling, manual refresh and authenticated webhooks backed by the SQLite inbox. The GitHub App requests read-only installation tokens. Automatic Codex review ingestion and controller publication have been retired. SQLite can hold structured review and finding references, and review-driven handoff is temporarily unavailable. See the [GitHub App guide](docs/github-app.md), [unattended polling](docs/unattended.md) and [review evidence guide](docs/reviews.md).

Phase B2 replaces delivery processing with transient webhook signals and adds repository-level discovery and eligibility. Autonomous Reviewer, Adjudicator and Implementer assignments come later. The standalone [agent CLI](docs/agent-sessions.md) supports explicit local Codex and Claude Code assignments independent of a PR. The [native execution verification report](docs/native-execution-verification.md) records the results and the Codex SDK gate for long-lived dispatch.

[ADR-0006](docs/adr/0006-orchestrate-through-native-tools.md) records the accepted architecture, [Plan 003](docs/plans/003-architectural-simplification.md) sequences implementation, and the [architecture overview](docs/architecture.md#current-implementation) describes current behavior.

Development and testing use a fresh SQLite database. Deployment cutover is planned for Phase D. See the [state model](docs/state-model.md#sqlite-baseline).

## Development environment

- Node.js 26 LTS (see `.node-version`).
- npm, pinned by `packageManager` in `package.json`.
- TypeScript with strict checking.

Install dependencies with `npm ci`. Run `npm run format:check`, `npm run lint`, `npm run typecheck`, and `npm test`. `npm run format` applies formatting. CI runs the same checks. The webhook and REST fixtures run offline.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) before making changes. Use semantic commit messages, work on feature branches, and submit pull requests to `main`. Implementation PRs need independent automated Codex review and passing CI.

Switchyard is licensed under the [MIT License](LICENSE).
