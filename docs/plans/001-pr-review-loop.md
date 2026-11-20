# Plan 001: Codex GitHub PR review/fix loop

## Goal

Implement the first Switchyard workflow from a Codex implementation session with a pushed GitHub PR to a human-ready handoff. Record all state durably, resume the same Codex thread, associate every review and check with the exact PR head SHA, and never merge. After three unsuccessful fix/review cycles or an explicit judgment call, stop and escalate.

## Constraints

- Use TypeScript, Node.js 26 LTS, npm, the OpenAI Codex TypeScript SDK, a GitHub App, SQLite, and Git worktrees.
- Keep the controller and worker logically separate but run locally in one process on macOS.
- Keep review-marker parsing behind a versioned adapter. Unknown formats cannot produce a clean result.
- No external queue, hosted database, required paid service, or automatic merge.
- Implementation PRs use feature branches, semantic commits, independent automated Codex review, and CI checks.

## Phase 1: State model and local development foundation

1. Define TypeScript domain types for workflow states, transitions, review verdicts (`completed_with_findings`, `completed_clean`, `in_progress`, `indeterminate`), cycle outcomes, and exact GitHub PR/head identities.
2. Create the SQLite schema and migrations for workflows, transition history, webhook inbox, review snapshots, check snapshots, agent sessions, worktrees, and pending operations. Add uniqueness for GitHub delivery IDs and clear transaction boundaries.
3. Implement a deterministic controller transition function. Invalid transitions return explicit errors. Head changes invalidate review and check evidence. An agent cannot set `ready_for_human`.
4. Add startup recovery for inbox items and in-flight operations with a documented `unknown` outcome that escalates rather than replaying a potentially completed agent turn.

### Acceptance criteria

- Replaying the same webhook delivery has no duplicate state change or agent action.
- Every transition records its cause and current head SHA.
- A stale review, missing review, pending/failing check, or unknown required-check set cannot result in `ready_for_human`.
- Restart recovery is covered by tests for pending webhook delivery and ambiguous operation state.
- Migrations can create a fresh database and upgrade from the previous schema.

## Phase 2: GitHub App and webhook inbox

1. Choose and document the minimum repository permissions and events after exercising all required endpoints: PR lifecycle, `pull_request_review`, `pull_request_review_comment`, `issue_comment`, and check/status updates as needed.
2. Implement GitHub App authentication and installation-token refresh; do not persist installation tokens longer than needed.
3. Validate the raw request body against `X-Hub-Signature-256` with constant-time comparison. Require and persist `X-GitHub-Delivery`; reject invalid signatures and deduplicate valid deliveries.
4. Acknowledge valid deliveries quickly and enqueue them in SQLite. Process inbox items outside the HTTP request path.
5. Reconcile GitHub state after deliveries and on a configurable local interval so dropped events are recoverable.
6. Provide saved fixture payloads or a developer fixture command. Live webhook tunnels are optional only.

### Acceptance criteria

- Invalid/missing signature is rejected before workflow mutation.
- Repeated deliveries are harmless; an inbox item that fails can retry and is observable.
- `synchronize`, close/reopen, review, comment edit, check, and delivery-out-of-order fixtures produce deterministic state.
- Local development and the test suite work without an internet connection or external paid service.
- The GitHub App permissions and manual setup steps are documented; actual repository rules are inspected with `gh` before any proposed configuration changes.

## Phase 3: Codex session and isolated worktree

1. Add a narrow `AgentAdapter` with start, resume, turn, interrupt/unknown outcome, and streamed progress capabilities. Implement Codex only using `@openai/codex-sdk`.
2. Persist the Codex thread ID, SDK/CLI version, Codex home location, worktree path, base/head commit, and operation ID before/after side effects.
3. Create one Git worktree per workflow. Validate its repository and branch/commit before running the SDK. Use scoped Codex sandbox settings and a controlled environment.
4. Resume a saved thread after restarting the controller and route it back to the same worktree. If session files are gone or path/context mismatch, escalate.
5. Capture structured turn events, final response, exit/failure status, and changed files without treating agent text as authoritative workflow state.

Phase 3A implements the agent adapter, Git worktree checks, and local worker composition from items 1, 3, and 5. It covers in-process start and resume, turn evidence, and failure handling without connecting agent execution to the controller polling loop.

Phase 3B implements durable session bindings, operation claims and outcomes, restart recovery, and explicit controller-authorized local turns. The gated live smoke test resumed the same SDK thread and dirty checkout across separate processes and verified that the second turn retained context from the first. Held sessions remain available for inspection. See the [local operations guide](../agent-sessions.md).

### Phase 3B implementation sequence

1. Extend the existing operation, session, and worktree tables. Persist an explicit request, a conditional dispatch claim, and running state before any worker side effect. Persist the outcome and its workflow transition together.
2. Route explicit local turns through the controller. Check workflow state and PR head when requesting, claiming, and finishing. A successful fix may enter validation. A standalone turn while awaiting review leaves that state intact. Polling and webhook reconciliation do not authorize turns.
3. Validate the persisted runtime, session artifact, checkout, and content before a continuation. Resume only after a successful recorded operation. Leave undispatched requests available to the caller. Hold dispatch claims and running operations with missing outcomes for inspection.
4. Verify the persistence and crash boundaries offline, then run a gated live smoke test with two separate controller processes.

### Acceptance criteria

- An SDK thread starts in a dedicated worktree and a follow-up turn edits only that worktree.
- A fresh Node.js process resumes the saved thread ID after restart with Codex session files preserved.
- An interrupted/unknown turn is not blindly repeated; recovery is explicit and covered by tests.
- Missing credentials, missing CLI, missing session files, permission denials, and worktree conflicts are visible failures with safe escalation.
- User checkout remains untouched and worktree cleanup cannot remove an active or uncommitted workflow.

## Phase 4: Codex review adapter and findings

GitHub is the collaboration interface. Switchyard is the workflow authority. Persist review runs, individual findings, dispositions, and resulting workflow decisions in Switchyard. Link the corresponding GitHub comments and reviews as communication artifacts and sources of evidence.

1. Save sanitized real examples from Cellgraph PR #51 as parser fixtures, retaining representative marker versions, comment edits, clean and finding summaries, review receipts, and inline findings.
2. Implement a versioned `CodexReviewAdapter` for the observed summary marker, receipt, and inline finding markers. Store parser outcomes and source IDs.
3. Discover summary comments by supported author and marker, but do not assume one particular timeline event always carries the final state. Fetch current PR/review/comment data after notifications.
4. Verify the current head SHA and explicit completion fields before generating a review verdict. Match inline findings to their reviewed SHA/source review where available and preserve file/line context.
5. Add a fallback detector for supported review-receipt formats. If it cannot prove review completion and the commit reviewed, return `indeterminate`; never use missing comments or a reaction as clean evidence.

### Acceptance criteria

- Parser tests cover valid v1, multiple code/security fields, malformed/partial JSON, unknown version, missing SHA, non-boolean flags, edited-in-place summary, duplicates, stale commit, and conflicting summaries.
- A valid clean summary for the exact current head yields `completed_clean`; a valid findings summary plus marker-tagged review comments yields `completed_with_findings`.
- An absent or unsupported marker, a review for another SHA, or missing completion fields never yields a clean verdict.
- Webhook-triggered and polling reconciliation paths converge on the same persisted review state.
- Integration investigation records which event actions are actually emitted for Codex summary-comment creation/edit and inline comments.

## Phase 5: Review/fix loop, checks, and escalation

1. On a completed finding review, persist the exact findings and a fix-cycle record before resuming the original session.
2. Prompt the session to assess each finding, implement valid corrections, run repository-appropriate tests, commit, and push. It must report invalid findings or judgment calls for escalation.
3. Inspect the resulting diff and Git state. Reject unsafe changes, wrong branch/head, failed validation, or push errors; do not begin another review wait until push is confirmed and the new SHA is known.
4. Wait for review and required checks for the new head. Fetch current reviews, check runs, legacy statuses, and repository protection/ruleset requirements. A missing configured check set is an error/indeterminate state.
5. Increment a bounded cycle count. On three unsuccessful cycles, repeated infrastructure failure, ambiguous review, or human judgment request, transition to `escalated` with reason and evidence.
6. Mark `ready_for_human` only when exact-head review is explicitly clean and every configured required check has passed for that SHA. Do not call a merge API.

### Acceptance criteria

- The same finding delivered twice triggers at most one cycle for that reviewed SHA.
- Invalid findings can be rejected by the agent but cause escalation with explanation, not a silent no-op.
- Three unsuccessful cycles stop further automatic agent invocation.
- New head commit immediately invalidates old review/check evidence.
- Missing checks, no check data, pending checks, and failed checks all prevent readiness.
- A clean exact-head review with passing required checks reaches `ready_for_human`; no automatic merge or PR approval occurs.
- Manual stop, PR close, agent error, push failure, merge conflict, and explicit human-judgment escalation are observable and recoverable.

## Phase 6: Operations, security, and release checklist

1. Document configuration, App setup, macOS startup/shutdown, SQLite backup/migration, Codex auth, data retention, troubleshooting, and safe reset/recovery.
2. Set up an optional local webhook forwarding recipe and polling/manual refresh mode. Do not require an always-on public service for local development.
3. Audit token storage, webhook verification, raw payload retention, logs, agent filesystem/network access, repository selection, and push authorization.
4. Inspect current GitHub rules with `gh`; recommend pull-request-required protection and required CI/review checks without owner approval by default. Do not weaken existing settings.
5. Confirm automated review workflow, Dependabot, CI, docs, license, and contribution path work for outside contributors.

### Acceptance criteria

- A contributor can install the documented toolchain, run all quality commands, and process fixture events without paid services.
- Setup manual identifies every credential, webhook permission, event, and manual repository setting.
- Logs explain why a workflow waited, advanced, retried, or escalated without logging secrets or full sensitive payloads.
- The happy path, duplicate delivery, dropped-event reconciliation, stale review, malformed marker, cycle exhaustion, restart recovery, and no-merge handoff are exercised end to end.
- A human can identify and resume or stop every nonterminal workflow from documented commands/status output.

## Initial implementation order

Start with Phase 1 domain/state tests and SQLite migrations, then Phase 4 parser fixtures/adapter contract in parallel only after capturing PR #51 evidence. Implement webhook receipt before wiring the Codex SDK. This sequence tests the most consequential safety rules before allowing an agent to modify or push a repository.
