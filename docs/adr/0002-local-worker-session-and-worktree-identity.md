# ADR-0002: Bind local agent sessions to workflow worktrees

- Status: Proposed for Phase 3A
- Date: 2026-11-20

## Context

The local worker needs to resume a Codex session in the same checkout while the controller retains ownership of state transitions. A path on disk, an agent's final response, and an SDK resume request each provide insufficient evidence on their own.

## Decisions

1. Keep Git worktree management separate from the provider adapter. Derive the local path from the full workflow ID under an operator-owned root, so existing IDs such as `owner/repo#7` work without becoming path components. Bind the checkout to the configured repository's Git common directory and require a registered linked worktree on the expected semantic branch and exact commit. Attach an existing local branch only if its tip matches and no checkout occupies it. Refuse conflicting or occupied paths and in-progress Git operations. Leave worktrees in place for inspection.
2. Return an opaque provider session reference from the adapter once the SDK identifies the session. Pair it with the verified worktree identity, including the linked checkout's administrative Git directory and its filesystem identity. Check that binding on resume and every turn, even when a replacement checkout has the same path, branch, and commit. Require a matching provider session event, an explicit terminal completion event, and successful stream completion before reporting success.
3. Report turn outcome and post-turn Git evidence separately. Reject assume-unchanged index entries before relying on Git status, and include gitlink changes even when repository settings ignore submodules. A model response, including structured JSON, is agent output. The worker guards against overlapping turns in its own process and holds the worktree for inspection when execution is interrupted or unknown or post-turn Git inspection fails.
4. Use the version-pinned SDK and bundled CLI with an explicit model and Codex home, a small inherited environment, and scoped sandbox settings. Use a trusted local repository and Codex profile. Linked worktrees share Git metadata, so the worker disables checkout hooks and the Codex sandbox constrains where agent commands can write. Keep approval, push, and persistence decisions with the controller.

## Consequences

The worker returns evidence without changing SQLite. Its guards apply to a single worker instance and do not coordinate other processes. Phase 3B will persist the session binding and runtime identity and decide how to resume or escalate when evidence is missing. A future remote worker can own its repository paths and provider references under the same controller and worker responsibilities.
