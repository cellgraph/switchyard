import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowStore } from "../src/store.js";
import { InvalidTransitionError, type Workflow } from "../src/workflow.js";

let dir: string | undefined;
let store: WorkflowStore | undefined;
afterEach(() => {
  store?.close();
  store = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function fixture(): Workflow {
  return {
    id: "wf-1",
    identity: { repository: "owner/repo", pullRequest: 7 },
    state: "awaiting_review",
    headSha: "abc",
    requiredChecks: null,
    review: null,
    checks: [],
    fixCycles: 0,
    escalationReason: null,
  };
}

function memoryStore(): WorkflowStore {
  store = new WorkflowStore();
  store.createWorkflow(fixture());
  return store;
}

describe("workflow state and durable store", () => {
  it("requires clean review and every configured passing check for the current SHA", () => {
    const db = memoryStore();
    db.transition("wf-1", {
      type: "review_received",
      evidence: { sha: "abc", outcome: "completed_clean" },
    });
    expect(db.getWorkflow("wf-1")?.state).toBe("awaiting_review");
    for (const outcome of ["pending", "failed", "unknown"] as const) {
      db.transition("wf-1", {
        type: "checks_received",
        evidence: [
          { name: "lint", sha: "abc", outcome: "passed" },
          { name: "tests", sha: "abc", outcome },
        ],
        configuredNames: ["lint", "tests"],
      });
      expect(db.getWorkflow("wf-1")?.state).toBe("awaiting_review");
    }
    db.transition("wf-1", {
      type: "checks_received",
      evidence: [{ name: "lint", sha: "abc", outcome: "passed" }],
      configuredNames: ["lint", "tests"],
    });
    expect(db.getWorkflow("wf-1")?.state).toBe("awaiting_review");
    expect(db.getWorkflow("wf-1")?.state).toBe("awaiting_review");
    db.transition("wf-1", {
      type: "checks_received",
      evidence: [
        { name: "lint", sha: "abc", outcome: "passed" },
        { name: "tests", sha: "abc", outcome: "passed" },
      ],
      configuredNames: ["lint", "tests"],
    });
    expect(db.getWorkflow("wf-1")?.state).toBe("ready_for_human");
    expect(db.transitions("wf-1").at(-1)).toMatchObject({
      to: "ready_for_human",
      reason: "checks_received for abc: lint=passed, tests=passed",
      headSha: "abc",
    });
  });

  it("rejects stale review and check evidence, and invalidates evidence on a new head", () => {
    const db = memoryStore();
    expect(() =>
      db.transition("wf-1", {
        type: "review_received",
        evidence: { sha: "old", outcome: "completed_clean" },
      }),
    ).toThrow(InvalidTransitionError);
    expect(() =>
      db.transition("wf-1", {
        type: "checks_received",
        evidence: [{ name: "ci", sha: "old", outcome: "passed" }],
        configuredNames: ["ci"],
      }),
    ).toThrow(InvalidTransitionError);
    db.transition("wf-1", {
      type: "review_received",
      evidence: { sha: "abc", outcome: "completed_clean" },
    });
    db.transition("wf-1", {
      type: "checks_received",
      evidence: [{ name: "ci", sha: "abc", outcome: "passed" }],
      configuredNames: ["ci"],
    });
    db.transition("wf-1", { type: "head_changed", sha: "def" });
    expect(db.getWorkflow("wf-1")).toMatchObject({
      state: "awaiting_review",
      headSha: "def",
      review: null,
      checks: [],
    });
  });

  it("deduplicates webhook deliveries and processes a delivery only once", () => {
    const db = memoryStore();
    expect(db.receiveDelivery("delivery-1", { action: "opened" }, "wf-1")).toBe(true);
    expect(db.receiveDelivery("delivery-1", { action: "changed" }, "wf-1")).toBe(false);
    let calls = 0;
    expect(
      db.processDelivery("delivery-1", () => {
        calls += 1;
      }),
    ).toBe(true);
    expect(
      db.processDelivery("delivery-1", () => {
        calls += 1;
      }),
    ).toBe(false);
    expect(calls).toBe(1);
  });

  it("escalates after three unsuccessful fix cycles", () => {
    const db = memoryStore();
    for (let i = 0; i < 3; i += 1) {
      db.transition("wf-1", {
        type: "review_received",
        evidence: { sha: "abc", outcome: "completed_with_findings" },
      });
      db.transition("wf-1", { type: "validation_started" });
      db.transition("wf-1", { type: "cycle_finished", outcome: "unsuccessful" });
      if (i < 2) db.transition("wf-1", { type: "review_started" });
    }
    expect(db.getWorkflow("wf-1")).toMatchObject({ state: "escalated", fixCycles: 3 });
    expect(() => db.transition("wf-1", { type: "fix_started" })).toThrow(InvalidTransitionError);
  });

  it("recovers processing deliveries and marks uncertain operations ambiguous without replay", () => {
    dir = mkdtempSync(join(tmpdir(), "switchyard-"));
    const path = join(dir, "state.sqlite");
    store = new WorkflowStore(path);
    store.createWorkflow(fixture());
    store.receiveDelivery("delivery-2", { action: "review" }, "wf-1");
    expect(store.claimDelivery("delivery-2")).toBe(true);
    expect(store.createOperation("op-1", "wf-1", "agent_turn", { prompt: "fix" })).toBe(true);
    store.close();
    store = new WorkflowStore(path);
    expect(store.recover()).toEqual({ deliveries: 1, ambiguousOperations: 1 });
    expect(store.pendingDeliveries()).toHaveLength(1);
    expect(store.getWorkflow("wf-1")?.state).toBe("escalated");
    expect(store.createOperation("op-1", "wf-1", "agent_turn", { prompt: "fix" })).toBe(false);
    expect(store.transitions("wf-1").at(-1)?.reason).toBe(
      "An external operation has an ambiguous outcome after restart.",
    );
  });
});
