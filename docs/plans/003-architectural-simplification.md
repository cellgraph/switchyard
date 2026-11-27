# Plan 003: Architectural simplification

- Status: Active implementation plan following operator design review
- Baseline: PR #24, following the acceptance of [ADR-0006](../adr/0006-orchestrate-through-native-tools.md)

## Goal

Deliver self-hosted development for Switchyard as the priority for the remainder of Plan 003. Explicit remote placement in Phase C and bounded PR review and revision in Phase D support the approved-plan workflow in Phase E. Keep execution, native sessions, placement, execution history and the operator interface independent of PR-specific policy. Implement these concrete workflows in TypeScript functions.

This plan supersedes the remaining work in [Plan 001](001-pr-review-loop.md) and the implementation proposal in [Plan 002](002-claude-code-authentication.md). Their completed work and investigation remain historical context.

## First workflow

1. **Enroll and observe.** Automatically enroll open, non-draft, same-repository PRs in explicitly enabled repositories. Apply the same rules to human, bot, Dependabot and independently agent-created PRs. Drafts wait until ready, external forks are excluded, and closed or merged PRs terminate the active workflow. Support durable explicit initiation under the same eligibility policy. Use authenticated webhooks as the primary trigger. Webhooks, startup, periodic sweeps and operator requests all invoke the same reconciliation against current GitHub state.
2. **Review.** Switchyard dispatches its configured independent Reviewer for the current head. The Reviewer publishes the substantive review on GitHub and returns the reviewed SHA, outcome (clean, findings identified or incomplete), and review reference when published. For findings, return stable GitHub finding references needed for adjudication. Validate the assignment-specific structured result and corroborate its references and commit against GitHub. A successful exit alone proves neither completion nor publication. Use this single review source initially.
3. **Adjudicate.** The independent Adjudicator retrieves each finding from GitHub and returns structured disposition metadata with references to its published reasoning. **Accept** means valid and worth addressing in this PR. **Reject** means invalid or not worth addressing. **Defer** means valid work for later; the Adjudicator creates a GitHub issue referencing the finding and returns the issue reference. **Escalate** requests operator judgment. Unresolved accepted findings and escalated findings block handoff. Verified rejection and deferral clear their findings without routine operator approval. GitHub issues hold deferred work.
4. **Revise.** Unresolved accepted findings or failed required CI can trigger an Implementer assignment. Include both when actionable and known at dispatch. The Implementer investigates, validates, commits and pushes as appropriate. Reuse a known and available Implementer session; otherwise start a native session with repository, PR, target head and task context. Give agents relevant GitHub references and let them retrieve the supporting content directly. A human or independent agent can revise the PR through the same GitHub workflow.
5. **Hand off.** Require a completed review on the current head, no unresolved blocking findings and passing required CI on that exact head. A clean review satisfies the review gate. A completed review whose findings were all rejected or deferred also satisfies it on unchanged code. Missing, incomplete, stale or unverified review evidence cannot establish readiness. Missing, pending or ambiguous required checks also block readiness. A head change invalidates prior review and CI for readiness; it does not by itself resolve known blocking findings. Reconcile progress and resolution using assignment results corroborated by GitHub, including current-head review of fixes where applicable. Switchyard never merges automatically.

Keep at most one active assignment per PR initially. Review and CI observations can arrive independently. When a head changes, reconcile it as an ordinary event and stop applying stale results to the new head. Before starting replacement work, establish the disposition of any in-flight assignment through its result, GitHub evidence or supported native inspection. A head change alone neither attributes a push nor proves that an active session stopped. Reconcile an established outcome, retry known non-execution within limits, and pause when the outcome remains uncertain. Keep operator stops durable across reconciliation.

### Accepted execution counting rule

Use two durable counters on the PR workflow. The defaults are **three Reviewer rounds and three Implementer revisions**. The shared revision allowance covers review fixes, CI fixes and combined assignments, so alternating triggers cannot extend it.

- A review round is one Reviewer assignment that starts. It counts even if it returns incomplete or the head moves. Its Adjudicator assignment does not consume another round. Allow adjudication of the third review before deciding whether findings still block.
- A revision is one Implementer assignment that starts. A CI-driven revision includes a failed required check in its assignment, with or without review fixes. A combined assignment counts once. An attempt that starts counts even if it fails or produces no commit. Observations, reconciliation, CI reruns and commits made outside Switchyard do not spend an allowance.
- Reserve the slot durably before dispatch. A retry proven not to have launched uses the same slot. If launch is uncertain, hold the slot and pause pending reconciliation or an operator decision. Duplicate results or notifications cannot spend another slot. New heads, restarts and ordinary resumes preserve both counters.
- Escalate when completing the workflow requires a review or revision with no remaining slots. After the last review, finish adjudication and allow pending CI to settle. If accepted findings or failed required CI still call for a revision that may change the head, pause before dispatching it because a new head would need another review. Escalated findings and uncertain outcomes can require attention earlier. A final allowed revision can still be reviewed if a review slot remains. Reaching a limit does not invalidate evidence that already satisfies handoff.
- The CLI records operator-authorized additional review or revision slots and the reason. Resume reconciles the current head first and follows the ordinary recovery rules for any outstanding attempt. A grant supplies capacity for future dispatch. The workflow still requires review and CI evidence for handoff.

## Implementation sequence

Each change should leave the repository buildable and testable. Temporary loss of legacy functionality is accepted. Keep useful code and coverage for retained behavior. Use semantic branches, focused PRs, repository checks and independent automated review of implementation changes.

### Phase A — Remove the old fix pipeline and establish native execution

- **A1, complete in PR #25.** Removed the controller-owned fix pipeline, including its CLI, unattended dispatch, edit scopes, candidate sealing, validation, commits, pushes and approval gates. Retained explicit local and read-only remote turns during that increment.
- **A2, complete in PR #26.** Simplified the Codex SDK and Claude Code CLI adapters and replaced their execution persistence in the same increment. The prior records encoded PR authorization, worktrees, runtime bindings and remote leases, so retaining them would have introduced transitional complexity. Retired the [HTTP remote worker](../distributed-workers.md) and removed the legacy generic operation writers and their pending/ambiguous paths. [Deferred finding from PR #25](https://github.com/cellgraph/switchyard/pull/25#discussion_r4708594181)
- **A3, verified locally.** Both native runtimes started and continued sessions in the operator's environment, returned structured results and used native tools. The [Phase A verification report](../native-execution-verification.md) records live and offline results, limitations and the remaining controller integration gate.

The A2 baseline records sessions separately from execution attempts. It records intent at claim time, preserves native IDs and terminal outcomes, and allows explicit local start and continuation without a PR. The repository retains GitHub observation and review evidence during the transition. Cut over the deployed database in Phase D.

**A3 design decisions.** [ADR-0006](../adr/0006-orchestrate-through-native-tools.md#native-agent-interfaces-and-records) retains the narrow start and resume contract and the five execution states. Concrete workflows own assignment semantics and lifecycle. The shared subsystem consumes an assignment ID and inputs. Preserve separate session and execution records and defer a shared assignment entity until workflows demonstrate a need. Native session and execution IDs serve different purposes from logical agent and external identities. Native authentication, authorization, credentials and external identities belong to the execution environment. Reconcile with authoritative evidence where practical, then seek operator direction for uncertainty. Workflow evidence can establish the objective while a native turn is still uncertain. Preserve duplicate-execution protections if an operator eventually abandons a native session.

**Acceptance.** The report records successful start and continuation with both providers after independent Switchyard process exits and recovery. The offline suite exercises native calls, structured results, failure and cancellation where supported, duplicate claims and ambiguous recovery. Local verification used the existing native accounts and settings. Separately metered API requests require operator direction.

**Long-lived Codex dispatch.** The pinned SDK can terminate its Node process with an uncaught stdin `EPIPE` when the native child exits early. Standalone local invocation retains its process boundary. The C2 Rex executor provides the boundary for long-lived controller dispatch and keeps the original controller-owned claim held if the remote process crashes. [Deferred finding from PR #26](https://github.com/cellgraph/switchyard/pull/26#discussion_r4711789830)

### Phase B — Establish read-only GitHub reconciliation

#### B1 — Read-only GitHub boundary and legacy review removal (PR #28)

Remove automatic Codex marker ingestion and controller-owned review and disposition publication before redesigning reconciliation. This removes the obsolete review source before expanding observation to repository-level discovery.

- Remove the Codex parser and import paths, publication and retry state, and the review start, finish, action and sync commands. Keep local inspection of structured review references.
- Scope installation tokens to one repository with Pull requests, Checks and Commit statuses read. Keep authentication, review/comment/thread reads, PR lifecycle and exact-head checks. Publication belongs to native agents using their own external identities.
- Use a fresh SQLite baseline containing review identity, reviewed SHA, completion metadata, finding references and dispositions with their published reasoning and deferred issue references. Keep substantive content on GitHub. Corroboration and handoff policy remain future work.
- Keep explicitly configured PR targets and the existing startup, webhook, polling and manual entry points. Keep observation generations, final SHA checks, workflow history, operator stops and closure/reopen behavior. Passing checks and stored references alone leave the workflow awaiting review.

**Acceptance.** Offline tests exercise read-only token requests, lifecycle and exact-head CI observation without automatic ingestion, structured evidence persistence, fail-closed readiness, superseded observations and incompatible database rejection. The existing App and deployment are outside this increment. See the [App permission requirements](../github-app.md#register-and-install-the-app).

#### B2 — Discovery and transient reconciliation signals

Phase B2 uses one reconciliation worker for startup, periodic sweeps, authenticated webhook signals and the operator's one-off sweep. Repository configuration supplies enabled names, App installations and optional required-check names per repository. Paginated listings supply PR numbers. Individual reads determine current head, lifecycle and eligibility regardless of author. A successful discovery union includes tracked PRs that may no longer be open. Confirmed merges end periodic observation unless GitHub or a hint names the PR again.

- Coalesce pending hints by repository and PR in memory. A pass takes its own set of hints so arrivals during a read can trigger another pass. Startup and periodic discovery recover missed signals and deferred observations. Continuous operation requires a positive periodic interval even with webhooks enabled. SQLite schema 19 removes the delivery inbox, claims and replay and preserves the Switchyard application ID, workflow evidence and native execution recovery. Deployment and cutover remain in Phase D.
- Store observed eligibility with the PR lifecycle status. GitHub can stop and reactivate a workflow under the same ID. An operator hold remains effective across lifecycle and head changes. A final eligible observation and durable generation guard protect changes to active state and exact-head evidence, including overlapping reads at the same head.
- Scope discovery retries to the enabled repository and keep installation-wide authentication and primary limits, shared secondary limits and per-PR or same-commit retry deadlines where applicable. A failed discovery reports partial progress and does not imply closure. Manual and continuous runs share the same SQLite ownership claim and inspection command.

**Acceptance.** Offline fixtures cover authenticated transient signalling, missed, duplicate and out-of-order notifications, paginated discovery, eligibility changes, overlapping observations, SQLite compatibility, retry scopes and native execution recovery. Phase B establishes read-only observation. The [Phase D](#phase-d--complete-the-pr-workflow-cli-and-cutover) role integration and GraphQL production gate remain open.

### Phase C — Investigate Rex, then implement explicit remote placement

#### C1 — Rex execution mechanism spike

The [C1 spike report](../rex-execution-spike.md) records the VM-to-Mac experiments and supports using the Rex CLI with a thin executor. The Mac experiments informed the transport choice.

#### C2 — Explicit remote execution

The initial self-hosting topology uses two persistent Linux VMs. The `switchyard` account on `switchyard-controller.exe.xyz` owns SQLite and connects with Rex over SSH to the `exedev` account's Rex socket on `switchyard-agent.exe.xyz`. Named agent configurations explicitly select local or Rex placement and supply the native invocation context. The operator maintains access, subscriptions and Git credentials.

Switchyard claims attempts before dispatch. Rex launches a single-assignment Node executor using the existing native adapters. Private files provide stable correlation, early native references and atomic final results. The controller can inspect an existing attempt after process or connection loss, interrupt the correlated block and resolve a held attempt from valid evidence. Uncertainty holds the assignment and session. Only affirmative non-execution permits an explicit retry. [Execution guide](../agent-sessions.md)

**Acceptance.** The [C2 verification report](../rex-execution-verification.md) records both providers' start and continuation, repeated result retrieval, controller restart, disconnect and lost acknowledgement, targeted cancellation and the offline A3 SDK crash on disposable state on the two VMs. The active polling controller and its database remain in service. Deployment and workflow role dispatch are Phase D work.

### Phase D — Complete the PR workflow, CLI and cutover

Implement the workflow above with the native adapters and read-only reconciler. Use role-specific prompts and response schemas. Treat GitHub content as untrusted input. Keep evidence validation and PR policy in the workflow, away from runtime adapters. Keep attention requests in workflow state with the reason and the input needed.

**Gate before production GraphQL thread reads.** Reassess whether the thread lookup is needed once Phase D establishes concrete corroboration requirements. Before using it for production corroboration, refresh rejected installation credentials once and recognize throttling in GraphQL error envelopes and response headers, including HTTP 200 responses. Track GraphQL's primary budget separately from REST and share the secondary cooldown where applicable. Verify credential recovery and both throttling cases with offline fixtures. [Deferred finding from PR #28](https://github.com/cellgraph/switchyard/pull/28#discussion_r4714855070)

Provide a CLI for humans and agents to list and inspect workflows, filter for attention, explicitly initiate, record direction, authorize additional execution, resume and stop. Supply machine-readable output where useful and document commands and their effects. Defer MCP until a concrete access need arises. Investigate proactive notification at deployment; it is independent of foundational work. Any future shared attention service belongs outside Switchyard. OpenClaw, Clawfeil and messaging bridges are outside the application's dependencies.

**Acceptance.** With fixtures and a disposable live PR, demonstrate automatic and explicit initiation, a published review and disposition, an agent-owned revision with observed exact-head CI, and handoff without per-step approval. Cover clean and rejected/deferred-only handoff without redundant review, accepted and escalated blockers, CI-only and combined fixes, external head changes, missing or stale evidence, limit exhaustion and operator continuation. Verify the CLI can account for pauses and recoveries after restart. Stop/closure and reconnection must prevent unintended dispatch. Keep the PR open for human acceptance.

Before deploying the replacement, stop the old controller and archive its SQLite database. Preserve native sessions, repository clones and worktrees independently. Start the new controller on a fresh database, with no migration, compatibility layer or parallel legacy execution path. Keep deployment verification and rollback instructions, record the tested commit, topology and observed native outcomes, and update operating guides to match the shipped behavior. One controller owns the active SQLite state.

### Phase E — Approved implementation-plan execution and self-hosting

Execute an operator-approved, multi-increment implementation plan stored in the repository. The first implementation can process increments sequentially.

1. Accept the operator's approval of a specific repository plan revision and record it durably.
2. Identify the next implementation increment from the approved revision.
3. Start an Implementer assignment for that increment.
4. Correlate the resulting PR with the increment and persist the reference.
5. Use the Phase D workflow for independent review, adjudication, revision and exact-head CI.
6. Escalate consequential decisions and unresolved failures, including ambiguous execution or PR association.
7. Request operator acceptance when the PR is ready.
8. Observe the operator's merge through GitHub reconciliation.
9. Start the next increment after recording the merge.
10. Continue until the approved plan is complete.

Persist plan, increment, assignment and PR progress so the controller can resume conservatively after restart. Reconcile outstanding executions and PRs before dispatching more work. Hold ambiguous outcomes for inspection or operator direction. The operator retains authority over plan approval, consequential architectural decisions, additional execution allowances and final PR merge. A generalized workflow engine, dependency graph, parallel implementation scheduling and workflow definition language are outside Phase E.

**Self-hosting acceptance.** Switchyard executes an approved development plan for the Switchyard repository itself, from the first implementation assignment through subsequent increments. The operator interacts primarily through plan approval, consequential decisions, attention requests and final acceptance. Switchyard carries context between agents without manual prompt transfer.

## Remaining implementation choices

- Establish the exact GitHub identities and reference checks that corroborate native structured results, including how to handle evidence edited, deleted or no longer attributable. Determine the minimal source of truth for required-check names and producer identity.
- Confirm the CLI treatment of a GitHub-reopened PR, preserving its history and limits. An explicit operator stop remains in effect until operator action.
- Investigate notification integration during deployment without making it a release dependency.
