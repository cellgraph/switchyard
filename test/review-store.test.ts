import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkflowStore } from "../src/store.ts";
import {
  clean,
  createWorkflow,
  finding,
  head,
  nextHead,
  reviewStart,
  workflowId,
} from "./fixtures/review.ts";

let directory: string;
let path: string;
let store: WorkflowStore;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "switchyard-review-"));
  path = join(directory, "switchyard.sqlite");
  store = new WorkflowStore(path);
  createWorkflow(store);
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("durable review runs", () => {
  it("upgrades the Phase 3B schema without backfilling unsupported review completion", () => {
    store.transition(workflowId, { type: "review_started" });
    store.close();
    using raw = new DatabaseSync(path);
    raw.exec(`
      DROP TABLE fix_cycles; DROP TABLE review_publications; DROP TABLE finding_actions;
      DROP TABLE review_findings; DROP TABLE review_runs;
      DELETE FROM schema_migrations WHERE version>=10;
    `);
    store = new WorkflowStore(path);
    expect(store.getWorkflow(workflowId)?.state).toBe("review_running");
    expect(store.reviews().inspect(workflowId).runs).toEqual([]);
    expect(store.reviews().start(reviewStart).status).toBe("running");
    expect(raw.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({
      version: 12,
    });
  });

  it("distinguishes a running review from an explicitly clean review after restart", () => {
    const start = store.reviews().start(reviewStart);
    expect(store.reviews().start(reviewStart)).toEqual(start);
    expect(() => store.reviews().start({ ...reviewStart, purpose: "different" })).toThrow(
      /different request/,
    );
    expect(store.reviews().inspect(workflowId).runs[0]).toMatchObject({
      status: "running",
      completed_at: null,
      findings: [],
    });
    expect(store.getWorkflow(workflowId)?.review?.outcome).toBe("in_progress");

    store.close();
    store = new WorkflowStore(path);
    store.recover();
    expect(store.getWorkflow(workflowId)?.state).toBe("review_running");
    expect(() => store.reviews().finish(start.id, { ...clean, headSha: nextHead })).toThrow(
      /original reviewed head/,
    );
    const result = store.reviews().finish(start.id, clean);
    expect(store.reviews().finish(start.id, clean)).toEqual(result);
    expect(() => store.reviews().finish(start.id, { ...clean, findings: [finding] })).toThrow(
      /different outcome/,
    );
    expect(store.getWorkflow(workflowId)?.review).toEqual({
      sha: head,
      outcome: "completed_clean",
      runId: reviewStart.id,
    });
    expect(store.getWorkflow(workflowId)?.state).toBe("awaiting_review");
    store.transition(workflowId, {
      type: "checks_received",
      evidence: [{ name: "CI", sha: head, outcome: "passed" }],
      configuredNames: ["CI"],
    });
    expect(store.getWorkflow(workflowId)?.state).toBe("ready_for_human");
  });

  it.each(["failed", "interrupted", "unknown"])(
    "keeps a recorded %s outcome outside the clean gate",
    (status) => {
      store.transition(workflowId, {
        type: "checks_received",
        evidence: [{ name: "CI", sha: head, outcome: "passed" }],
        configuredNames: ["CI"],
      });
      store.reviews().start(reviewStart);
      store
        .reviews()
        .finish(reviewStart.id, { headSha: head, status, error: "No confirmed result." });
      expect(store.getWorkflow(workflowId)).toMatchObject({
        state: "awaiting_review",
        review: null,
      });
      expect(store.reviews().inspect(workflowId).runs[0]).toMatchObject({
        status,
        error: "No confirmed result.",
        findings: [],
      });
      expect(store.reviews().start({ ...reviewStart, id: "review-2" }).status).toBe("running");
    },
  );

  it.each([
    { title: "" },
    { explanation: "x".repeat(8001) },
    { severity: "urgent" },
    { path: "../worker.ts" },
    { path: "/worker.ts" },
    { path: "C:\\worker.ts" },
    { path: null },
    { startLine: 10 },
    { endLine: -1 },
    { endLine: 2 ** 32 },
    { confidence: 1.1 },
  ])("rejects invalid structured findings atomically (%j)", (invalid) => {
    store.reviews().start(reviewStart);
    expect(() =>
      store
        .reviews()
        .finish(reviewStart.id, { ...clean, findings: [finding, { ...finding, ...invalid }] }),
    ).toThrow();
    expect(store.reviews().inspect(workflowId).runs[0]).toMatchObject({
      status: "running",
      findings: [],
    });
  });

  it("rejects absent finding arrays, missing evidence, and excessive and duplicate findings", () => {
    store.reviews().start(reviewStart);
    for (const input of [
      { ...clean, findings: undefined },
      { ...clean, evidence: "" },
      { ...clean, findings: [finding, finding] },
      { ...clean, findings: Array(101).fill(finding) },
    ]) {
      expect(() => store.reviews().finish(reviewStart.id, input)).toThrow();
    }
    expect(store.getWorkflow(workflowId)?.review?.outcome).toBe("in_progress");
  });

  it("leaves a contradictory terminal result open for a later confirmed outcome", () => {
    const reviews = store.reviews();
    reviews.start(reviewStart);
    expect(() =>
      reviews.finish(reviewStart.id, {
        ...clean,
        error: "Reviewer process timed out before returning a result.",
      }),
    ).toThrow(/completed review cannot attach an execution error/);
    expect(() =>
      reviews.finish(reviewStart.id, {
        status: "unknown",
        headSha: head,
        error: "Timed out.",
        evidence: "Finished.",
      }),
    ).toThrow(/completion evidence/);
    expect(reviews.inspect(workflowId)).toMatchObject({
      projectedReview: { outcome: "in_progress" },
      runs: [{ status: "running", completed_at: null, findings: [] }],
    });
    expect(reviews.finish(reviewStart.id, clean).status).toBe("completed");
    expect(store.getWorkflow(workflowId)?.review?.outcome).toBe("completed_clean");
  });

  it("rolls back the run, first finding, and verdict if inserting a later finding fails", () => {
    store.reviews().start(reviewStart);
    using raw = new DatabaseSync(path);
    raw.exec(`CREATE TRIGGER reject_test_finding BEFORE INSERT ON review_findings
      WHEN json_extract(new.content,'$.title')='Cannot insert'
      BEGIN SELECT RAISE(ABORT, 'Test persistence failure'); END;`);
    expect(() =>
      store.reviews().finish(reviewStart.id, {
        ...clean,
        findings: [finding, { ...finding, title: "Cannot insert" }],
      }),
    ).toThrow(/Test persistence failure/);
    expect(store.reviews().inspect(workflowId).runs[0]).toMatchObject({
      status: "running",
      findings: [],
    });
    expect(store.getWorkflow(workflowId)?.review?.outcome).toBe("in_progress");
  });

  it("retains stale completion and findings without authorizing a fix after an ABA head change", () => {
    store.reviews().start(reviewStart);
    store.transition(workflowId, { type: "head_changed", sha: nextHead });
    expect(() => store.reviews().start({ ...reviewStart, id: "incorrect-head" })).toThrow(
      /current head/,
    );
    store.reviews().start({ ...reviewStart, id: "review-2", headSha: nextHead });
    store.reviews().finish("review-2", { ...clean, headSha: nextHead });
    store.transition(workflowId, { type: "head_changed", sha: head });
    store.reviews().finish(reviewStart.id, { ...clean, findings: [finding] });
    expect(store.getWorkflow(workflowId)).toMatchObject({ review: null, state: "awaiting_review" });
    expect(() => store.transition(workflowId, { type: "fix_started" })).toThrow(/awaiting_review/);
    expect(store.reviews().inspect(workflowId).runs).toMatchObject([
      { head_sha: head, status: "completed", eligible: 0, findings: [{ content: finding }] },
      { head_sha: nextHead, status: "completed", eligible: 0, findings: [] },
    ]);
  });

  it("retains a result after escalation and leaves the workflow escalated", () => {
    store.reviews().start(reviewStart);
    store.transition(workflowId, { type: "escalate", reason: "Operator investigation" });
    store.reviews().finish(reviewStart.id, { ...clean, findings: [finding] });
    expect(store.reviews().inspect(workflowId)).toMatchObject({
      state: "escalated",
      projectedReview: { outcome: "in_progress" },
      runs: [{ status: "completed", eligible: 0, findings: [{ content: finding }] }],
    });
  });

  it("tracks independent dispositions, guarded updates, and resolution history", () => {
    const reviews = store.reviews();
    reviews.start(reviewStart);
    reviews.finish(reviewStart.id, {
      ...clean,
      findings: [finding, { ...finding, title: "Preserve input" }],
    });
    const initial = reviews.inspect(workflowId);
    const [first, second] = initial.runs[0]!.findings;
    expect(initial.pendingDispositions).toEqual([first!.id, second!.id]);
    expect(first!.id).not.toBe(second!.id);
    const accept = {
      id: "accept-first",
      findingId: first!.id,
      headSha: head,
      action: "accepted",
      actor: "operator",
      rationale: "Reproduced in tests.",
    };
    const accepted = reviews.act(accept);
    expect(reviews.act(accept)).toEqual(accepted);
    expect(() => reviews.act({ ...accept, rationale: "Changed" })).toThrow(/different decision/);
    expect(() => reviews.act({ ...accept, id: "conflict", action: "deferred" })).toThrow(
      /latest action ID/,
    );
    expect(() =>
      reviews.act({ ...accept, id: "conflict", action: "deferred", previousActionId: accept.id }),
    ).toThrow(/requires a verified fix/);
    expect(() =>
      reviews.act({ ...accept, id: "invalid", action: "reopened", previousActionId: accept.id }),
    ).toThrow(/current state/);
    const defer = { ...accept, id: "defer-second", findingId: second!.id, action: "deferred" };
    reviews.act(defer);
    reviews.act({
      ...defer,
      id: "reject-second",
      action: "rejected",
      previousActionId: defer.id,
      rationale: "The path is unreachable.",
    });

    store.transition(workflowId, { type: "head_changed", sha: nextHead });
    expect(() =>
      reviews.act({ ...accept, id: "fix-first", action: "fixed", previousActionId: accept.id }),
    ).toThrow(/current workflow head/);
    reviews.act({
      ...accept,
      id: "fix-first",
      headSha: nextHead,
      action: "fixed",
      previousActionId: accept.id,
      rationale: "Verified with test retry-7.",
    });
    expect(reviews.inspect(workflowId).actionableFindings).toEqual([]);
    reviews.act({
      ...accept,
      id: "reopen-first",
      headSha: nextHead,
      action: "reopened",
      previousActionId: "fix-first",
      rationale: "Reproduced again.",
    });
    expect(reviews.inspect(workflowId).actionableFindings).toEqual([first!.id]);
    reviews.act({
      ...accept,
      id: "supersede-first",
      headSha: nextHead,
      action: "superseded",
      previousActionId: "reopen-first",
      rationale: "Covered by a replacement finding.",
    });
    const final = reviews.inspect(workflowId);
    expect(final.pendingDispositions).toEqual([]);
    expect(final.actionableFindings).toEqual([]);
    expect(final.runs[0]!.findings).toMatchObject([
      {
        id: first!.id,
        state: "superseded",
        disposition: { action: "accepted" },
        history: [
          { action: "accepted" },
          { action: "fixed" },
          { action: "reopened" },
          { action: "superseded" },
        ],
      },
      {
        id: second!.id,
        state: "open",
        disposition: { action: "rejected" },
        history: [{ action: "deferred" }, { action: "rejected" }],
      },
    ]);
  });

  it("records and inspects a run across separate CLI processes", () => {
    const startPath = join(directory, "start.json");
    const resultPath = join(directory, "result.json");
    writeFileSync(startPath, JSON.stringify(reviewStart));
    writeFileSync(resultPath, JSON.stringify(clean));
    const cli = (...args: string[]) => {
      const result = spawnSync(process.execPath, ["src/main.ts", ...args], {
        encoding: "utf8",
        env: { ...process.env, SWITCHYARD_DB_PATH: path },
      });
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(result.stdout) as unknown;
    };
    expect(cli("--review-start", startPath)).toMatchObject({ status: "running" });
    expect(cli("--review-finish", reviewStart.id, resultPath)).toMatchObject({
      status: "completed",
    });
    expect(cli("--review-status", workflowId)).toMatchObject({
      projectedReview: { outcome: "completed_clean" },
    });
  });
});
