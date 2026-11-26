# Switchyard

Switchyard coordinates coding agents through the lifecycle of a software change. Its first milestone automates the Codex review and fix loop for GitHub pull requests: it waits for a review of the exact PR head, resumes the implementation session when that review has actionable findings, and stops for human approval when review and required checks are clean. Switchyard never merges a pull request.

## Scope and trust

Switchyard coordinates workflows on trusted, operator-controlled hosts. The accepted deployment uses a persistent VM controller with SQLite and configured local or remote workers. The operator manages host permissions and credentials. Agents use native runtimes for sessions and handle implementation, validation, commits, pushes, and review publication.

## First milestone

The first workflow coordinates independent review and bounded fix cycles for GitHub PRs. It uses GitHub webhooks to trigger reconciliation, attaches review and CI evidence to the exact PR head, and hands off to a human once that head has an explicit clean review and passing required checks. Missing review comments never establish a clean review.

## Status

[ADR-0006](docs/adr/0006-orchestrate-through-native-tools.md) records the accepted architecture after PR #21. The [architecture overview](docs/architecture.md#current-implementation-after-pr-21) describes the shipped behavior, including the durable webhook inbox, controller-owned validation and publication, and remote standalone review turns. The remaining work in [Plan 001](docs/plans/001-pr-review-loop.md) and the proposal in [Plan 002](docs/plans/002-claude-code-authentication.md) need revision.

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
