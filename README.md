# Switchyard

Switchyard coordinates coding agents through the lifecycle of a software change. Its first workflow is GitHub PR review and revision. Switchyard never merges a pull request.

## First milestone

The accepted design dispatches independent review for eligible PRs in enabled repositories. Agents adjudicate findings and revise the PR when findings or failed required CI need action. Switchyard hands off for human acceptance when review is complete, no blocking findings remain, and required CI passes for the current PR head.

A persistent VM controller uses SQLite and reads GitHub state. Authenticated webhooks and periodic reconciliation keep it current. Agents run through native Codex and Claude Code interfaces on configured, trusted hosts. The operator manages the environments, and agents handle worktrees, validation, commits, pushes and review publication.

## Status and setup

[ADR-0006](docs/adr/0006-orchestrate-through-native-tools.md) records the accepted architecture, and [Plan 003](docs/plans/003-architectural-simplification.md) defines the pending implementation. For the existing behavior and commands, see the [architecture overview](docs/architecture.md#current-implementation-after-pr-21), [GitHub App setup guide](docs/github-app.md), [bounded fixes](docs/fix-loop.md) and [unattended controller](docs/unattended.md).

## Development environment

- Node.js 26 LTS (see `.node-version`).
- npm, pinned by `packageManager` in `package.json`.
- TypeScript with strict checking.

Install dependencies with `npm ci`. Run `npm run format:check`, `npm run lint`, `npm run typecheck`, and `npm test`. `npm run format` applies formatting. CI runs the same checks. The webhook and REST fixtures run offline.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) before making changes. Use semantic commit messages, work on feature branches, and submit pull requests to `main`. Implementation PRs need independent automated Codex review and passing CI.

Switchyard is licensed under the [MIT License](LICENSE).
