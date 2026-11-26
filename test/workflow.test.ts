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

  it("deduplicates webhook deliveries and processes a delivery only once", async () => {
    const db = memoryStore();
    expect(db.receiveDelivery("delivery-1", { action: "opened" }, "wf-1")).toBe(true);
    expect(db.receiveDelivery("delivery-1", { action: "changed" }, "wf-1")).toBe(false);
    let calls = 0;
    expect(
      await db.processDelivery("delivery-1", () => {
        calls += 1;
      }),
    ).toBe(true);
    expect(
      await db.processDelivery("delivery-1", () => {
        calls += 1;
      }),
    ).toBe(false);
    expect(calls).toBe(1);
  });

  it("makes a failed delivery visible and retryable", async () => {
    const db = memoryStore();
    db.receiveDelivery("delivery-retry", { action: "review" }, "wf-1");
    await expect(
      db.processDelivery("delivery-retry", async () => {
        await Promise.resolve();
        throw new Error("temporary failure");
      }),
    ).rejects.toThrow("temporary failure");
    expect(db.pendingDeliveries()).toHaveLength(1);
    let calls = 0;
    expect(
      await db.processDelivery("delivery-retry", () => {
        calls += 1;
      }),
    ).toBe(true);
    expect(calls).toBe(1);
  });

  it("recovers interrupted processing without losing the delivery", () => {
    dir = mkdtempSync(join(tmpdir(), "switchyard-"));
    const path = join(dir, "state.sqlite");
    store = new WorkflowStore(path);
    store.createWorkflow(fixture());
    store.receiveDelivery("delivery-2", { action: "review" }, "wf-1");
    expect(store.claimDelivery("delivery-2")).toBe(true);
    store.close();
    store = new WorkflowStore(path);
    expect(store.recover()).toEqual({ deliveries: 1, unknownExecutions: 0 });
    expect(store.pendingDeliveries()).toHaveLength(1);
  });
});
