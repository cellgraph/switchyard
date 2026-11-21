import type { WorkflowStore } from "../../src/store.ts";

export const head = "a".repeat(40);
export const nextHead = "b".repeat(40);
export const target = { repository: "owner/repo", pullRequest: 1, installationId: 5 };
export const workflowId = "owner/repo#1";
export const reviewStart = {
  id: "review-1",
  workflowId,
  headSha: head,
  purpose: "independent code review",
  reviewer: {
    agent: "independent-reviewer",
    provider: "codex",
    model: "configured-model",
    configurationId: "config-v1",
    executionId: "external-run-12",
  },
};
export const finding = {
  title: "Persist the retry claim",
  explanation: "A restart can lose the retry claim after sending a request.",
  severity: "P2",
  path: "src/worker.ts",
  startLine: 4,
  endLine: 9,
  evidence: "The restart path loses the recorded attempt.",
  recommendation: "Store the claim before sending.",
  confidence: 0.9,
};
export const clean = {
  headSha: head,
  status: "completed",
  evidence: "Reviewer confirmed completion.",
  findings: [],
};

export function createWorkflow(store: WorkflowStore) {
  store.createWorkflow({
    id: workflowId,
    identity: { repository: target.repository, pullRequest: target.pullRequest },
    state: "awaiting_review",
    headSha: head,
    requiredChecks: null,
    review: null,
    checks: [],
    fixCycles: 0,
    cycleAwaitingReview: false,
    validationHeadSha: null,
    escalationReason: null,
  });
}
