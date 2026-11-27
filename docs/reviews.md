# Review evidence and inspection

Phase B1 removes automatic Codex review ingestion and controller-authored review and disposition comments. Review and comment webhooks remain observation signals for configured PRs. The controller refreshes lifecycle and CI from GitHub. It does not read review bodies during reconciliation.

GitHub holds reviews, individual findings, disposition reasoning and issue content. The SQLite evidence store records structured metadata for later review corroboration:

- A review has a local ID, a workflow association and the full reviewed head SHA. It records a clean, findings or incomplete outcome. A completed review includes a native GitHub review ID, a completion timestamp and an explicit list of finding references, empty for a clean outcome.
- A finding refers to a GitHub review comment within the owning workflow's PR. A comment ID can belong to only one recorded review per workflow, across all heads. A finding can have an accept, reject, defer or escalate disposition and a reference to the GitHub comment containing the published reasoning. A deferral has a GitHub repository and issue number. A repeated write of the same normalized disposition is harmless. Changes require the expected prior disposition, with `null` for the first write.
- An accepted finding can include `claimedResolvingHeadSha`, an uncorroborated reference to a commit that may resolve it. The claim alone cannot clear a blocker. The store preserves metadata for prior heads independently of current lifecycle or CI.

The B1 store accepts structured references as metadata. The controller has no review corroboration or readiness transition in this increment. Agent-owned publication, identity and reference verification, and enforcement of the handoff policy follow the accepted design. [ADR-0006](adr/0006-orchestrate-through-native-tools.md#github-and-the-first-workflow)

Set `SWITCHYARD_DB_PATH` to the controller's database to inspect the recorded metadata.

```sh
npm start -- --review-status owner/repo#7
```

The command returns the current recorded SHA and any review metadata, including entries for earlier heads. Ordinary B1 reconciliation leaves the list empty. The former start, finish, action and synchronization commands are retired.

The automatic Codex integration can still independently review Switchyard's development PRs. The observed marker protocol, imported-text model and controller publication design are historical. [ADR-0003](adr/0003-durable-review-evidence-and-publication.md) · [Plan 001](plans/001-pr-review-loop.md)
