# Review guidance and evidence

## Risk-based review

Aim for software that is reliable and maintainable enough for its expected use. Reviewers establish whether a defect exists. Adjudicators decide whether the defect warrants correction before acceptance. A technically valid finding can be nonblocking.

Assess findings in light of the actual operating environment, expected usage and trust boundaries. Weigh four factors together.

- **Likelihood.** How realistically could the triggering conditions occur?
- **Impact.** What happens if they occur?
- **Recoverability.** How easily can operators detect, contain and correct the problem?
- **Correction cost.** What implementation and maintenance complexity would the fix introduce, and is that cost proportionate to the risk?

Prefer simple, coherent invariants that cover related cases. Add special-case protection when the operational risk justifies the complexity.

### Reviewer responsibilities

Report concrete, actionable defects with consequential effects. Explain the plausible trigger, the consequence and the behavior that needs correction. Distinguish correctness defects from optional improvements. Avoid speculative hardening and obscure scenarios with negligible practical impact.

### Adjudicator responsibilities

Independently evaluate the evidence and explain how the risk and correction cost support the disposition.

- **Accept** findings that warrant correction before acceptance.
- **Reject** unsupported or immaterial findings.
- **Defer** worthwhile, nonblocking improvements.
- **Escalate** consequential tradeoffs that require operator judgment.

### Review progression

Start with a comprehensive review. After a revision, generally focus on verifying corrections, checking affected invariants and looking for regressions. A substantial revision or a material architectural change may warrant a broader review. Report newly discovered consequential defects even late in the review cycle. Each revised head still needs its own review evidence.

## Review evidence and inspection

Phase B1 retired automatic Codex review ingestion and controller-authored review and disposition comments. In B2, review and PR comment webhooks signal lifecycle and CI observation through the same read-only reconciler used for discovery. Named agents retrieve and publish substantive review and disposition content through the [autonomous workflow](autonomous-pr-workflow.md).

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
