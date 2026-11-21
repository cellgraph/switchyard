import { describe, expect, it, vi } from "vitest";
import { observeCodexReview } from "../src/codex-review.ts";
import type { GitHubReader, PullRequestState } from "../src/github-api.ts";
import { createReconciler } from "../src/reconcile.ts";
import { WorkflowStore } from "../src/store.ts";
import fixture from "./fixtures/codex-pr51.json" with { type: "json" };
import { createWorkflow, target, workflowId } from "./fixtures/review.ts";

const { clean, reviewed, ...inputs } = fixture;
const summary = inputs.issueComments[0]!;
const code = (sha: string, any: boolean) => ({
  commit_sha: sha,
  status: "completed",
  has_any_findings: any,
  has_unresolved_findings: any,
});
const withCode = (code_review: unknown) => ({
  ...summary,
  body: `<!-- codex-review-state:v1 ${JSON.stringify({ code_review, security_review: code(clean, true) })} -->`,
});

describe("Codex review marker evidence", () => {
  it("detects the edited exact-head clean summary without adopting old line comments", () => {
    expect(observeCodexReview(clean, inputs)).toMatchObject({ findings: [] });
    expect(
      observeCodexReview(clean, { ...inputs, issueComments: [withCode(code(clean, false))] }),
    ).toMatchObject({ findings: [] });
    expect(observeCodexReview("c".repeat(40), inputs)).toBeNull();
  });

  it("uses a positive receipt and its source comment anchors, even after comment remapping", () => {
    expect(observeCodexReview(reviewed, inputs)).toMatchObject({
      findings: [
        { commentId: 10, content: { startLine: 19, endLine: 21, severity: "P2" } },
        { commentId: 11, content: { endLine: 631, severity: "P2" } },
      ],
    });
    const withFindings = { ...inputs, issueComments: [withCode(code(reviewed, true))] };
    expect(observeCodexReview(reviewed, withFindings)).toMatchObject({
      findings: [{ commentId: 10 }, { commentId: 11 }],
    });
    expect(observeCodexReview(reviewed, { ...withFindings, reviewComments: [] })).toHaveProperty(
      "error",
    );
    expect(observeCodexReview(reviewed, { ...inputs, reviewComments: [] })).toHaveProperty(
      "error",
      "Receipt alone cannot prove a clean review.",
    );
  });

  it.each([
    summary.body.replace("v1", "v2"),
    '<!-- codex-review-state:v1 {"code_review":{ -->',
    withCode({ ...code(clean, false), commit_sha: null }).body,
    withCode({ ...code(clean, false), has_any_findings: "false" }).body,
    withCode({ ...code(clean, false), has_unresolved_findings: undefined }).body,
    withCode({ ...code(clean, false), status: "running" }).body,
  ])("fails closed on malformed or incomplete markers", (body) => {
    expect(
      observeCodexReview(clean, { ...inputs, issueComments: [{ ...summary, body }] }),
    ).toMatchObject({ error: expect.any(String) });
  });

  it("deduplicates duplicated fetch records and rejects conflicting or spoofed evidence", () => {
    expect(
      observeCodexReview(clean, { ...inputs, issueComments: [summary, summary] }),
    ).toMatchObject({ findings: [] });
    expect(
      observeCodexReview(clean, {
        ...inputs,
        issueComments: [summary, { ...withCode(code(clean, true)), id: 6 }],
      }),
    ).toHaveProperty("error");
    expect(
      observeCodexReview(clean, {
        ...inputs,
        issueComments: [{ ...summary, user: { login: "human" } }],
      }),
    ).toBeNull();
    expect(
      observeCodexReview(reviewed, {
        ...inputs,
        reviewComments: [...inputs.reviewComments, inputs.reviewComments[0]],
      }),
    ).toMatchObject({ findings: [{ commentId: 10 }, { commentId: 11 }] });
    const conflicting = { ...inputs.reviewComments[0], original_commit_id: clean };
    expect(
      observeCodexReview(reviewed, { ...inputs, reviewComments: [conflicting] }),
    ).toHaveProperty("error");
  });

  it("reconciles idempotently, retains rejected parser evidence, and recovers valid inputs", async () => {
    const store = new WorkflowStore();
    try {
      createWorkflow(store);
      const reader: GitHubReader = {
        readPullRequest: vi.fn(async () => ({ state: "open" as const, headSha: clean })),
        readChecks: vi.fn(async () => []),
        readReviewInputs: vi.fn(async () => inputs),
        completeReconciliation: vi.fn(),
      };
      const reconcile = createReconciler(store, reader);
      await reconcile(target);
      await reconcile(target);
      expect(store.reviews().inspect(workflowId)).toMatchObject({
        projectedReview: { outcome: "completed_clean" },
        runs: [{ status: "completed" }],
      });
      vi.mocked(reader.readReviewInputs).mockResolvedValueOnce({
        ...inputs,
        issueComments: [{ ...summary, body: summary.body.replace("v1", "v2") }],
      });
      await reconcile(target);
      expect(store.reviews().inspect(workflowId)).toMatchObject({
        projectedReview: null,
        runs: [{ status: "completed" }, { status: "indeterminate", error: expect.any(String) }],
      });
      await reconcile(target);
      expect(store.reviews().inspect(workflowId)).toMatchObject({
        projectedReview: { outcome: "completed_clean" },
        runs: [{ status: "completed" }, { status: "indeterminate" }],
      });
    } finally {
      store.close();
    }
  });

  it("records a running Codex marker and completes that run only after a newer edit", async () => {
    const store = new WorkflowStore();
    try {
      createWorkflow(store);
      const running = withCode({
        ...code(clean, false),
        status: "running",
        has_any_findings: null,
        has_unresolved_findings: null,
      });
      const reader: GitHubReader = {
        readPullRequest: vi.fn(async () => ({ state: "open" as const, headSha: clean })),
        readChecks: vi.fn(async () => []),
        readReviewInputs: vi.fn(async () => ({ ...inputs, issueComments: [running] })),
        completeReconciliation: vi.fn(),
      };
      const reconcile = createReconciler(store, reader);
      await reconcile(target);
      const first = store.reviews().inspect(workflowId);
      const runId = first.runs[0]!.id;
      expect(first).toMatchObject({
        state: "review_running",
        projectedReview: { runId, outcome: "in_progress" },
        runs: [{ id: runId, status: "running", completed_at: null }],
      });
      vi.mocked(reader.readReviewInputs).mockResolvedValueOnce(inputs);
      await reconcile(target);
      expect(store.reviews().inspect(workflowId).projectedReview).toBeNull();
      vi.mocked(reader.readReviewInputs).mockResolvedValueOnce({
        ...inputs,
        issueComments: [{ ...summary, updated_at: "2026-01-02T00:01:00Z" }],
      });
      await reconcile(target);
      expect(store.reviews().inspect(workflowId)).toMatchObject({
        projectedReview: { runId, outcome: "completed_clean" },
        runs: [
          { id: runId, status: "completed", findings: [], start_evidence: expect.any(String) },
        ],
      });
      await reconcile(target);
      expect(store.reviews().inspect(workflowId).projectedReview).toMatchObject({
        runId,
        outcome: "completed_clean",
      });
    } finally {
      store.close();
    }
  });

  it("discards old-head evidence when GitHub changes during reconciliation", async () => {
    const store = new WorkflowStore();
    try {
      createWorkflow(store);
      const reader: GitHubReader = {
        readPullRequest: vi
          .fn<() => Promise<PullRequestState>>()
          .mockResolvedValueOnce({ state: "open" as const, headSha: clean })
          .mockResolvedValueOnce({ state: "open", headSha: reviewed }),
        readChecks: vi.fn(async () => []),
        readReviewInputs: vi.fn(async () => inputs),
        completeReconciliation: vi.fn(),
      };
      await expect(createReconciler(store, reader)(target)).rejects.toThrow(/head changed/);
      expect(store.reviews().inspect(workflowId)).toMatchObject({
        headSha: reviewed,
        projectedReview: null,
        runs: [],
      });
    } finally {
      store.close();
    }
  });
});
