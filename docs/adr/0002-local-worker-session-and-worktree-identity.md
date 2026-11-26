# ADR-0002: Bind local agent sessions to workflow worktrees

- Status: Accepted for Phases 3A and 3B
- Supersession: [ADR-0006](0006-orchestrate-through-native-tools.md) supersedes parts of this record. See its prior decisions table for details.
- Date: 2026-11-20

## Context

The local worker needs to resume a Codex session in the same checkout while the controller retains ownership of state transitions. A path on disk, an agent's final response, and an SDK resume request each provide insufficient evidence on their own.

## Decisions

1. Keep Git worktree management separate from the provider adapter. Derive the local path from the full workflow ID under an operator-owned root, so existing IDs such as `owner/repo#7` work without becoming path components. Bind the checkout to the configured repository's Git common directory and require a registered linked worktree on the expected semantic branch and exact commit. Attach an existing local branch only if its tip matches and no checkout occupies it. Refuse conflicting or occupied paths and in-progress Git operations. Leave worktrees in place for inspection.
2. Return an opaque provider session reference from the adapter once the SDK identifies the session. Pair it with the verified worktree identity, including the linked checkout's administrative Git directory and its filesystem identity. Check that binding on resume and every turn, even when a replacement checkout has the same path, branch, and commit. Require a matching provider session event, an explicit terminal completion event, and successful stream completion before reporting success.
3. Report turn outcome and post-turn Git evidence separately. Reject assume-unchanged and skip-worktree index entries before relying on Git status, and include gitlink changes even when repository settings ignore submodules. A model response, including structured JSON, is agent output. The worker guards against overlapping turns in its own process and holds the worktree for inspection when execution is interrupted or unknown or post-turn Git inspection fails.
4. Use the version-pinned SDK and bundled CLI with an explicit model and Codex home, a small inherited environment, and scoped sandbox settings. Use a trusted local repository and Codex profile. Linked worktrees share Git metadata, so the worker disables checkout hooks and the Codex sandbox constrains where agent commands can write. Keep approval, push, and persistence decisions with the controller.

5. Use the existing SQLite tables to associate one session binding and a history of agent operations with each workflow. Require an explicit local request and claim it conditionally before touching Git or starting the agent. Persist the expected checkout location before Git can create it. Recheck authorization after preflight at SDK launch and again before applying the result to the workflow. Record the final evidence and workflow transition in one transaction.
6. After restart, allow continuation only from a recorded successful turn and an exact runtime, worktree, and session checkpoint match. Record an outstanding claim as unknown once the OS confirms its recorded local owner has exited. A live or unverified owner retains the claim. A worktree snapshot is evidence of content at a point in time. It cannot establish whether Codex ran or whether an external side effect occurred.

## Consequences

The worker reports checkout and turn evidence without owning SQLite or workflow state. The selected rollout path comes from the pinned CLI’s state database and is checked before and after resumption. The runtime fingerprint covers system and user configuration files and managed startup requirements. Binding the checkout content and rollout file conservatively rejects manual edits, moved profiles, provider upgrades, and oversized checkpoints. The checkout and provider thread are reserved for Switchyard. A separate GitHub poller on the same host can start during a turn. Recovery preserves any agent claim whose owner may still be live.

An undispatched request can be resubmitted with the same ID and inputs. A claimed operation with no committed outcome is held even if the crash occurred before launch. This preserves the dispatch invariant without inferring whether anything ran. A future remote worker will need a protocol to attest runtime and checkout identity and to recover or fence an existing worker before it can claim work.
