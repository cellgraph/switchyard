# Local agent sessions

Start by reconciling the PR through the existing GitHub App configuration so the workflow and its current head appear in the Switchyard database. Use a trusted clone of that repository, a dedicated worktree root outside Git checkouts, and a persistent Codex home that this controller owns. Sign in to Codex in that home or make `OPENAI_API_KEY` available to the controller. Configured credentials must have access to the requested model.

Submit an explicit turn to the database used for GitHub reconciliation. Use absolute paths, the current full PR head SHA, and a semantic workflow branch. For an initial turn, use the recorded PR head for both SHAs. For a follow-up, use the latest recorded PR head and the local head returned by the previous turn. Follow-ups use a new operation ID and the same checkout, Codex home, and model. Keep request files private and omit secrets from prompts.

```json
{
  "operationId": "pr-42-first-turn",
  "workflowId": "owner/repo#42",
  "repositoryDirectory": "/absolute/path/to/repo",
  "worktreeRoot": "/absolute/path/to/worktrees",
  "codexHome": "/absolute/path/to/codex-home",
  "model": "MODEL_AVAILABLE_TO_YOUR_ACCOUNT",
  "branch": "feat/workflow-42",
  "expectedPullRequestHead": "FULL_PR_HEAD_SHA",
  "expectedHead": "FULL_LOCAL_HEAD_SHA",
  "prompt": "Inspect the implementation and summarize what needs to change."
}
```

```sh
export SWITCHYARD_DB_PATH=/absolute/path/to/switchyard.sqlite
npm start -- --agent-turn /absolute/path/to/request.json
npm start -- --agent-status pr-42-first-turn
```

Reusing an operation ID with the same content returns the durable record or dispatches a still-authorized `requested` turn. The command exits with an error if the result requires attention. For a successful continuation, the database retains local and PR heads, the checkout and provider identifiers, a checkpoint of the checkout and Codex session file, and the observed changed paths. SQLite records the turn outcome and sanitized error reason. Codex retains the transcript in its own home.

The GitHub controller automatically recovers when it starts. For a CLI-only run, use `npm start -- --recover` after the previous controller process has stopped. This also recovers the webhook inbox. If an operation becomes unknown, inspect the operation record, Codex processes and rollout, and checkout before making any manual decision. Treat a held session as unavailable. Phase 3B provides no reset or force-resume command. Leave the worktree and Codex files intact while investigating.

Use the workflow checkout and Codex thread exclusively through Switchyard. The checkout checkpoint supports up to 10,000 entries and 64 MiB of content, including ignored files. The rollout checkpoint supports files up to 64 MiB. Exceeding either limit or changing the checkout, thread, runtime configuration, or SDK/CLI version requires inspection. The evidence check is local and assumes the checkout and Codex home are on a trusted filesystem.

## Verification

The ordinary test suite exercises schema upgrades, duplicate operation claims across SQLite connections, head and checkout changes, missing or incompatible runtime and session bindings, and child-process termination at dispatch, execution, and just before outcome persistence.

The live acceptance test uses a temporary repository, SQLite database, and Codex home. It starts two separate Node.js controller invocations with recovery between them. The first turn edits the checkout and remembers a token. The second turn writes the token using the original thread and dirty checkout. It verifies the original thread ID and checkout identity, and the clean primary checkout. The test passed on macOS with Codex SDK and CLI `0.171.0` using `gpt-6.2-sol`. Routine CI skips it.

```sh
SWITCHYARD_CODEX_SMOKE=1 \
  SWITCHYARD_SMOKE_MODEL=MODEL_AVAILABLE_TO_YOUR_ACCOUNT \
  npm test -- test/codex-resume.smoke.test.ts
```

Set `OPENAI_API_KEY` in the environment or provide `SWITCHYARD_SMOKE_AUTH_FILE` pointing to an existing Codex `auth.json`. The smoke test copies that file into the private temporary home and removes the home afterward. The test does not exercise live Codex interruption, credential expiry mid-turn, or a live GitHub-driven fix.
