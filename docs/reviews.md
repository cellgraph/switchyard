# Durable reviews and finding decisions

GitHub is the collaboration interface. SQLite is the authority for review runs, finding identities, and operator decisions. Webhook and polling reconciliation use the same reader and check the PR head again after fetching evidence.

## Review sources and completion

The versioned Codex adapter recognizes the code-review section of the GitHub connector's v1 summary. An explicit completed flag and two false finding flags for the exact PR SHA establish a clean review. A findings verdict requires matching inline findings. A submitted v1 receipt can establish a positive findings verdict when the inline comments link to that review and their original commits match. A receipt alone cannot prove a clean review. A supported running marker opens an in-progress run. A newer edit of the same summary can complete it. Previously captured inline findings on the same head cannot be borrowed into the new run. The security section has its own scope and does not establish a code-review verdict.

The adapter stores source IDs, decoded flags, and completion or rejection evidence. It uses the comments' original commit and original line fields because GitHub can remap a comment to a newer SHA. If exact-head source findings change after capture, the controller preserves the original finding identities and clears the projected verdict. An operator can record a new review. The sanitized fixture in `test/fixtures/codex-pr51.json` preserves the shapes observed in Cellgraph PR #51. That PR shows a summary edited in place, submitted receipts, and remapped and outdated inline comments. The timeline confirms the edit, while actual webhook deliveries were unavailable. GitHub defines the corresponding `issue_comment.edited`, `pull_request_review.submitted`, and `pull_request_review_comment` events, which all trigger a fresh read.

An operator can explicitly open a run for an independent reviewer and import a structured result. The reviewer runs in GitHub or out of band. The Phase 3B local session is reserved for implementation under ADR-0002. Its worktree, provider thread, and claim recovery are unchanged. An external execution ID is an opaque reference for inspection. Codex on GitHub does not report its model or runtime configuration, so the record identifies the adapter version and leaves those fields unknown.

## Operator commands

Use the same `SWITCHYARD_DB_PATH` as the controller. All commands return JSON on success. Refresh the workflow with `--once` or the running controller before starting a run or recording a finding action. These local commands check against the latest PR head recorded in SQLite.

| Command after `npm start --`          | Purpose                                                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `--review-start START.json`           | Record the run ID, independent reviewer, and current exact head before execution.                                   |
| `--review-finish RUN_ID RESULT.json`  | Record a terminal result and any validated findings in one transaction.                                             |
| `--review-status WORKFLOW_ID`         | Show all runs, projected verdict, finding history, pending decision IDs, actionable finding IDs, and GitHub status. |
| `--review-act ACTION.json`            | Append a disposition or resolution for one finding.                                                                 |
| `--review-sync CONFIG.json SYNC.json` | Publish or reconcile one finding comment or disposition reply using the existing GitHub App config.                 |

Example start input

```json
{
  "id": "review-42",
  "workflowId": "owner/repo#7",
  "headSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "purpose": "independent code review",
  "reviewer": {
    "agent": "independent-reviewer",
    "provider": "codex",
    "model": "configured-model",
    "configurationId": "local-profile-v1",
    "executionId": "external-job-42"
  }
}
```

Example completed result

```json
{
  "headSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "status": "completed",
  "evidence": "Independent review job 42 reported completion for this commit.",
  "findings": [
    {
      "severity": "P2",
      "title": "Persist the retry claim",
      "explanation": "A restart can lose the retry claim.",
      "path": "src/worker.ts",
      "startLine": 4,
      "endLine": 9,
      "side": "RIGHT",
      "evidence": "The caller writes the claim after dispatch.",
      "recommendation": "Store the claim before dispatch.",
      "confidence": 0.9
    }
  ]
}
```

Use an explicit empty `findings` array for a completed clean review. Use `failed`, `interrupted`, or `unknown` with the original `headSha` and a nonempty `error` for incomplete execution. Findings use priorities P0 through P3. Locations, evidence, recommendation, and confidence are optional. An end line without a start line denotes a single line. A path without lines denotes a file-level finding. The default diff side is `RIGHT`. Results are limited to 100 findings with bounded fields and repository-relative paths.

Each run references its workflow and exact SHA. The workflow's projected review links back to the run. Starting an operator run reserves the projection for that source on the current head and clears any previous verdict. A changed head or closed or escalated workflow invalidates that run's authority. Late outcomes remain inspectable, even if the PR later returns to the same SHA. Interrupted controller processes preserve externally launched reviews as `running` until the operator reports a confirmed result or records an unknown outcome. Switchyard has no evidence of whether that external reviewer is still running.

## Finding decisions and resolution

Findings have stable IDs and an append-only action history. Use a caller-generated action ID and the current recorded workflow head. To build on a prior action, include its ID as `previousActionId`. Repeating the same action ID and payload returns the saved action. Changing its payload or acting against an outdated history fails.

```json
{
  "id": "triage-42",
  "findingId": "finding-id-from-review-status",
  "headSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "action": "accepted",
  "actor": "operator-login",
  "rationale": "Reproduced the failure during restart."
}
```

The first disposition may be `accepted`, `deferred`, or `rejected`. A deferred or rejected finding may be reconsidered with a new action ID and rationale. An accepted open finding stays actionable until the operator records `fixed` with verification or explicitly records `superseded`. Either closed state can be `reopened` with a rationale. Reopening retains the disposition, so a previously accepted finding becomes actionable again. Decisions applied to older findings use the current head for the action and preserve the original reviewed head on the run.

## GitHub synchronization and recovery

Use `{"findingId":"…","mode":"publish"}` for a root comment. Add `"actionId":"…"` to publish a previously recorded disposition as a reply to that finding's root. An already imported Codex inline finding has a root comment and can receive replies directly. Each command writes at most one comment. Normal polling and reconciliation request read-only tokens. Publication requires the App's **Pull requests: Read and write** permission and the installation's acceptance of the permission update. [GitHub review comment API](https://docs.github.com/en/rest/pulls/comments)

A new root requires an open PR at the exact reviewed SHA and a valid diff or file anchor. An unanchored finding stays in SQLite with a blocked publication. A reply requires a visible original root on an open PR and can refer to a historical finding. Explicit `"mode":"reconcile"` reads comment evidence and also records the GitHub thread ID and its resolved and outdated flags when available. These flags are external observations. They cannot change a finding's disposition or resolution. Switchyard uses no thread mutation. [GitHub review thread fields](https://docs.github.com/en/graphql/reference/pulls#pullrequestreviewthread)

| Publication state | Meaning and recovery                                                                                                                                                                                                                               |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pending`         | Intent, responsible App bot, and exact body are durable. No dispatch was claimed. `publish` can claim it after reading the PR comments.                                                                                                            |
| `writing`         | A process claimed the only attempt, and the write outcome may be unknown. `reconcile` can adopt one matching App-authored comment with the expected body, parent or original anchor, and unique marker. An absent match never authorizes a replay. |
| `rejected`        | GitHub definitively rejected the write, or preflight stopped it before sending. After correcting the cause or waiting out GitHub’s backoff, use `publish` to reconcile before claiming a new attempt.                                              |
| `published`       | The comment ID is durable. A missing, edited, or conflicting comment is reported as evidence and is never recreated automatically.                                                                                                                 |
| `blocked`         | This finding cannot be published as a review comment with its recorded location. Its evidence and decisions remain available in SQLite.                                                                                                            |

A process can exit before sending the request or after GitHub has accepted it. GitHub exposes no idempotency key for this write. No matching comment after a crash is insufficient to distinguish those cases, so the claim stays held for investigation. Thread lookup failures are recorded separately from comment publication. Phase 5 can use the projected run ID, selected SHA, and accepted open finding IDs when preparing a fix cycle and recheck that evidence at dispatch.
