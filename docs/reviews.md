# Review evidence and inspection

Phase B1 retired automatic Codex review ingestion and controller-authored review and disposition comments. In B2, review and PR comment webhooks signal lifecycle and CI observation through the same read-only reconciler used for discovery. Agents will retrieve and publish substantive review content in Phase D.

GitHub holds reviews, individual findings, disposition reasoning and issue content. The SQLite evidence store records structured metadata for later review corroboration:

- A review has a local ID, a workflow association and the full reviewed head SHA. It records a clean, findings or incomplete outcome. A completed review includes a native GitHub review ID, a completion timestamp and an explicit list of finding references, empty for a clean outcome.
- A finding refers to a GitHub review comment within the owning workflow's PR. A comment ID can belong to only one recorded review per workflow, across all heads. A finding can have an accept, reject, defer or escalate disposition and a reference to the GitHub comment containing the published reasoning. A deferral has a GitHub repository and issue number. A repeated write of the same normalized disposition is harmless. Changes require the expected prior disposition, with `null` for the first write.
- An accepted finding can include `claimedResolvingHeadSha`, an uncorroborated reference to a commit that may resolve it. The claim alone cannot clear a blocker. The store preserves metadata for prior heads independently of current lifecycle or CI.

The store accepts structured references as metadata. Phase D adds agent-owned publication, identity and reference corroboration, and handoff policy. [ADR-0006](adr/0006-orchestrate-through-native-tools.md#github-and-the-first-workflow)

Set `SWITCHYARD_DB_PATH` to the controller's database to inspect the recorded metadata.

```sh
npm start -- --review-status owner/repo#7
```

The command returns the current recorded SHA and any review metadata, including entries for earlier heads. Ordinary B2 reconciliation records lifecycle and CI. Review references recorded separately remain inspectable even after closure or reopening.

The automatic Codex integration can still independently review Switchyard's development PRs. The observed marker protocol, imported-text model and controller publication design are historical. [ADR-0003](adr/0003-durable-review-evidence-and-publication.md) · [Plan 001](plans/001-pr-review-loop.md)
