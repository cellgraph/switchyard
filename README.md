# Switchyard

Switchyard coordinates coding agents through the lifecycle of a software change. Its first milestone automates the Codex review and fix loop for GitHub pull requests: it waits for a review of the exact PR head, resumes the implementation session when that review has actionable findings, and stops for human approval when review and required checks are clean. Switchyard never merges a pull request.

The longer-term project is a small orchestration system that can coordinate different coding agents and local or remote execution workers. The first implementation stays focused on one agent, GitHub, and a local macOS controller.

## First milestone

Given a pull request produced by a Codex implementation session, Switchyard will:

1. Receive GitHub webhook deliveries and record them durably and idempotently.
2. Detect a completed Codex review and associate it with the current PR head SHA.
3. Send actionable findings to the original Codex session in its isolated Git worktree.
4. Record each fix cycle, validation result, commit SHA, and review outcome.
5. Stop after three unsuccessful review/fix cycles or when human judgment is needed.
6. Mark the workflow ready for human approval only after a clean review for the current head and required CI checks pass.

No review comments is not evidence of a completed clean review. A new head commit invalidates prior review and CI evidence. There is no automatic merge path.

## Status

The local workflow store, GitHub App integration, durable local agent sessions, and durable review evidence are implemented. See the [review operations guide](docs/reviews.md) for review runs, finding decisions, and GitHub synchronization. See the [local agent session guide](docs/agent-sessions.md) for running and recovering a Codex turn. See the [distributed worker guide](docs/distributed-workers.md) for remote read-only turns with Codex or Claude Code. See [CONTEXT.md](CONTEXT.md), [the architecture](docs/architecture.md), [ADR-0001](docs/adr/0001-local-controller-and-agent-boundary.md), and [implementation plan 001](docs/plans/001-pr-review-loop.md) for the current decisions and next steps.

## Development environment

- Node.js 26 LTS (see `.node-version`; the Codex SDK itself supports Node.js 18+).
- npm, pinned by `packageManager` in `package.json`; commit `package-lock.json` when dependencies are first installed.
- TypeScript with strict checking.

Install dependencies with `npm ci`. Run `npm run format:check`, `npm run lint`, `npm run typecheck`, and `npm test`. `npm run format` applies formatting. CI runs the same commands. The webhook and REST fixtures run offline.

## GitHub setup

See the [GitHub App setup guide](docs/github-app.md) for the permissions, webhook subscriptions, and commands for polling or live delivery. Enable automatic Codex code review in Codex's GitHub settings for independent implementation review.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) before making changes. Use semantic commit messages, work on feature branches, and submit pull requests to `main`. Implementation pull requests should receive an independent automated Codex review and pass formatting, lint, type, and test checks. Human approval is not required by default; repository settings should preserve the intended independent review workflow.

Switchyard is licensed under the [MIT License](LICENSE).

For the controller-owned review, validation, and publication workflow, see [Bounded PR fixes](docs/fix-loop.md).

To monitor configured PRs and advance authorized work automatically, see [Unattended controller](docs/unattended.md).
