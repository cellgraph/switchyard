# Contributing

Switchyard is an open-source project. Before proposing implementation changes, read `AGENTS.md`, `CONTEXT.md`, and the relevant plan and ADRs.

## Workflow

1. Create a feature branch from `main`.
2. Make a focused change and add tests for behavior and failure recovery.
3. Run `npm run format:check`, `npm run lint`, `npm run typecheck`, and `npm test`.
4. Use a semantic commit message and open a pull request to `main`.
5. Allow the independent Codex review and CI checks to complete. Resolve findings and keep evidence tied to the latest commit.

Pull requests are required for merging. The intended independent review does not imply requiring repository-owner approval on every pull request. Do not weaken repository security settings to make automation pass. No contribution author or automation should merge a Switchyard PR as part of the review/fix workflow.

## Development conventions

Use Node.js 26 LTS and npm as recorded in `.node-version` and `package.json`. Install with `npm install`. The documented format, lint, typecheck, and test commands are the CI contract. Update the lockfile whenever dependencies change.

Keep product decisions in `CONTEXT.md` and rationale in sequential ADRs under `docs/adr/`. Implementation plans live in `docs/plans/` and use sequential numbers beginning with `001`.
