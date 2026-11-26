# Bounded PR fixes

**Implementation status.** This guide describes the existing implementation. [ADR-0006](adr/0006-orchestrate-through-native-tools.md) records the accepted architecture, and [Plan 003](plans/003-architectural-simplification.md) describes the pending replacement.

Run the controller from a stable checkout. Use a trusted local clone of the PR repository, a dedicated worktree root outside every checkout, a persistent agent profile, and the same SQLite database for all commands. Switchyard edits a separate linked checkout. The PR head commit must already be available in the clone. Fetch the PR branch before the first dispatch if needed.

Use the GitHub App reader documented in [GitHub setup](github-app.md). Publication uses your existing SSH credentials for the canonical GitHub repository. Set up SSH access and Git commit identity before authorizing publication. This version supports a PR whose source branch belongs to the same GitHub repository and differs from the default branch. Choose a separate local branch name. Use repositories and PRs whose validation code you trust. Validation runs local executables with the candidate checkout as their working directory and a minimal environment. Those executables have the operating system privileges of the controller account.

## Configuration

Add a `fix` object to a GitHub configuration targeting exactly one PR. Use exact names from the GitHub checks and commit statuses. Duplicate names from different producers, missing checks, and unknown outcomes block readiness.

```json
{
  "repositories": [
    {
      "repository": "owner/repo",
      "installationId": 123,
      "pullRequests": [42]
    }
  ],
  "fix": {
    "repositoryDirectory": "/absolute/path/to/repo",
    "worktreeRoot": "/absolute/path/to/fix-worktrees",
    "codexHome": "/absolute/path/to/codex-home",
    "model": "MODEL_AVAILABLE_TO_YOUR_ACCOUNT",
    "localBranch": "fix/switchyard-pr-42",
    "allowedPaths": ["src/", "test/"],
    "requiredChecks": ["Quality checks"],
    "validation": [
      { "id": "format", "argv": ["npm", "run", "format:check"] },
      { "id": "lint", "argv": ["npm", "run", "lint"] },
      { "id": "types", "argv": ["npm", "run", "typecheck"] },
      { "id": "test", "argv": ["npm", "test"] },
      { "id": "diff", "argv": ["git", "diff", "--cached", "--check"] }
    ],
    "maxCycles": 3,
    "maxOperationAttempts": 2,
    "maxValidationRetries": 1,
    "agentTimeoutMs": 900000,
    "validationTimeoutMs": 300000
  }
}
```

The example uses Codex. Set the [Claude Code provider fields](claude-code.md) in the same fix entry to use Claude Code. The cycle snapshots the provider settings when authorized.

The five numeric settings show their defaults. The cycle limit is between one and three per workflow, with one authorized cycle per reviewed SHA. The attempt limit also caps validation attempts and repeated GitHub head confirmation reads. An agent launch or push has one attempt once the outcome could be uncertain. Validation alone can retry a recorded failure against the same candidate. The command timeout applies per validation command. An optional `maxTotalTokens` caps provider-reported input plus output tokens across fix turns. Providers report usage on turn completion, so this limit can hold publication after a turn overshoots and block a subsequent turn. It cannot interrupt a turn at the exact token count. Missing usage holds the workflow when a budget is configured.

Allowed paths are literal files or directory prefixes ending in `/`. Narrow the scope to the expected fix and its tests, then inspect the actual staged diff before approving publication. Repository-defined validation commands run in the configured order directly with the listed arguments. Set up dependencies outside the candidate checkout when possible so package installation, generated files, and test caches do not alter the sealed checkout. Codex can start with a small ignored symlink to preinstalled dependencies. Claude Code requires a link-free checkout. Ignored inputs must match the pre-turn baseline. The controller holds candidates created before baseline verification was recorded. The worktree manager includes ignored files in its 10,000-entry and 64 MiB limits. Validation that changes checkout content or the index invalidates the candidate. Status JSON retains up to 8 KiB of combined output per command. Keep secrets out of validation arguments and output.

## Operating the loop

1. Advance to reconcile GitHub and inspect the current review. The same command bootstraps a new workflow. Import an independent completed review if you are using an out-of-band reviewer. Use [the review commands](reviews.md) to disposition new findings.
2. Advance again to propose a fix. Inspect the exact head, review run, selected findings, rationale, path scope, and limits. Approve the cycle ID from the JSON.
3. Advance to run the agent and validation. The agent can open a new session or resume a matching active session. Inspect the validation evidence in status and the staged changes with `git diff --cached` in the recorded worktree.
4. Approve publication using that cycle ID. Advance to create one commit and attempt a normal fast-forward push against the authorized PR branch.
5. Advance to reconcile the remote branch and GitHub head. Keep the normal polling controller running or advance again to observe a subsequent review and required checks. New findings return to operator triage. A clean exact-head review with passing configured checks hands the PR to a human. A failed required check on the clean reviewed publication escalates on the next advance.

```sh
export SWITCHYARD_DB_PATH=/absolute/path/to/switchyard.sqlite
npm start -- --fix-advance 'owner/repo#42' /absolute/path/to/config.json
npm start -- --fix-status 'owner/repo#42'
npm start -- --fix-authorize 'owner/repo#42' CYCLE_ID
npm start -- --fix-advance 'owner/repo#42' /absolute/path/to/config.json
npm start -- --fix-publish 'owner/repo#42' CYCLE_ID
npm start -- --fix-advance 'owner/repo#42' /absolute/path/to/config.json
```

All fix commands emit JSON containing the workflow, cycle history, active operation and session when available, validation, and next action. `--fix-authorize` and `--fix-publish` only record approvals. Each advance can reconcile and make a bounded step. Polling and CLI advances use the approved check list during an active cycle. Once publication is confirmed, both use the current configured check list. The reconcile-only CLI observes GitHub. The [unattended worker](unattended.md) can also advance explicitly authorized work. An independent reviewer supplies review evidence in both modes. The repository's automatic reviewer or an operator-directed independent reviewer produces the next review. Historical findings keep their decisions and can be marked fixed by the operator after inspecting the publication and subsequent review.

## Recovery

Use the same database, clone, worktree root, and provider profile after restart. Run `--fix-advance` to resume a safely recoverable step. A live local process retains its claim. A terminated agent or validation owner with uncertain effects requires operator inspection. Inspect the reported session and worktree before acting. A completed validation can survive restart because the staged tree and checkout checkpoint are durable.

The controller writes the commit object, records the SHA, and then compare-and-swaps the expected local branch. The commit must have the validated tree and a single parent equal to the original PR SHA. A normal push publishes exactly that SHA to one ref. Its pre-push check compares the server's advertised ref against the authorized parent. Git's receive protocol checks the old ref again when applying the update. The controller claims dispatch after local Git preflight. If dispatch has already been claimed, changes to the authorizing review's dispositions and workflow stop requests report the outstanding push. Git or GitHub uncertainty leaves a durable publication intent. Each GitHub reconciliation uses a durable observation generation per PR so a delayed pass cannot overwrite a newer head, review, or checks. Recovery requires both Git's advertised ref and GitHub's open PR to confirm the expected commit. An old or unexpected remote ref never authorizes a second push.

If a cycle escalates, preserve the records and inspect its evidence. The controller provides no override for an uncertain agent or push. Close or externally update the PR only after resolving the outstanding effects, using the normal repository workflow.
