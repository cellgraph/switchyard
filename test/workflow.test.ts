import { afterEach, describe, expect, it } from "vitest";
import { WorkflowStore } from "../src/store.js";
import { InvalidTransitionError, type Workflow } from "../src/workflow.js";

let store: WorkflowStore | undefined;
afterEach(() => {
  store?.close();
  store = undefined;
});

function fixture(): Workflow {
  return {
    id: "wf-1",
    identity: { repository: "owner/repo", pullRequest: 7 },
    state: "awaiting_review",
    headSha: "abc",
    requiredChecks: null,
    checks: [],
    escalationReason: null,
  };
}

function memoryStore(): WorkflowStore {
  store = new WorkflowStore();
  store.createWorkflow(fixture());
  return store;
}

describe("workflow state and durable store", () => {
  it("records configured checks and history while leaving a passing head awaiting review", () => {
    const db = memoryStore();
    db.transition("wf-1", {
      type: "checks_received",
      evidence: [
        { name: "lint", sha: "abc", outcome: "passed" },
        { name: "tests", sha: "abc", outcome: "passed" },
      ],
      configuredNames: ["lint", "tests"],
    });
    expect(db.getWorkflow("wf-1")).toMatchObject({
      state: "awaiting_review",
      requiredChecks: ["lint", "tests"],
    });
    expect(db.transitions("wf-1").at(-1)).toMatchObject({
      to: "awaiting_review",
      reason: "checks_received for abc: lint=passed, tests=passed",
      headSha: "abc",
    });
  });

  it("rejects stale check evidence and clears current evidence on a new head", () => {
    const db = memoryStore();
    expect(() =>
      db.transition("wf-1", {
        type: "checks_received",
        evidence: [{ name: "ci", sha: "old", outcome: "passed" }],
        configuredNames: ["ci"],
      }),
    ).toThrow(InvalidTransitionError);
    db.transition("wf-1", {
      type: "checks_received",
      evidence: [{ name: "ci", sha: "abc", outcome: "passed" }],
      configuredNames: ["ci"],
    });
    db.transition("wf-1", { type: "head_changed", sha: "def" });
    expect(db.getWorkflow("wf-1")).toMatchObject({
      state: "awaiting_review",
      headSha: "def",
      checks: [],
    });
  });
});
