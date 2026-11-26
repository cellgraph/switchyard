import { createHmac } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createController } from "../src/controller.ts";
import type { GitHubReader, PullRequestState } from "../src/github-api.ts";
import { GitHubRateLimitError } from "../src/github-app.ts";
import { createReconciler } from "../src/reconcile.ts";
import { WorkflowStore } from "../src/store.ts";
import { createWebhookServer } from "../src/webhook.ts";
import type { CheckEvidence } from "../src/workflow.ts";
import codexReview from "./fixtures/codex-pr51.json" with { type: "json" };

type Fixture = { id: string; event: string; payload: Record<string, unknown> };
const fixtures = JSON.parse(
  readFileSync(new URL("./fixtures/github-webhooks.json", import.meta.url), "utf8"),
) as Record<string, Fixture>;
const secret = "fixture-only-webhook-secret";
const headA = "a".repeat(40);
const headB = "b".repeat(40);
const target = { repository: "owner/repo", pullRequest: 7, installationId: 42 };

let dir: string;
let store: WorkflowStore;
let server: ReturnType<typeof createWebhookServer>;
let endpoint: string;
let dbPath: string;
let now: number;
let state: PullRequestState;
let checkOutcome: CheckEvidence["outcome"];
let github: GitHubReader;
let reportError: ReturnType<typeof vi.fn<(message: string) => void>>;

async function startReceiver(maxBodyBytes?: number): Promise<void> {
  server = createWebhookServer({
    secret,
    store,
    reportError,
    ...(maxBodyBytes === undefined ? {} : { maxBodyBytes }),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture server address");
  endpoint = `http://127.0.0.1:${address.port}/webhooks/github`;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "switchyard-github-"));
  dbPath = join(dir, "state.sqlite");
  store = new WorkflowStore(dbPath);
  now = 100_000;
  state = { state: "open", headSha: headA };
  checkOutcome = "passed";
  reportError = vi.fn();
  github = {
    completeReconciliation: vi.fn(),
    readPullRequest: vi.fn(async () => ({ ...state })),
    readChecks: vi.fn(async (_target, sha) => [{ name: "CI", sha, outcome: checkOutcome }]),
    readReviewInputs: vi.fn(async () => ({
      reviews: [{ state: "APPROVED", commit_id: state.headSha }],
      reviewComments: [],
      issueComments: [{ body: "all clean", updated_at: "2026-01-01T00:00:00Z" }],
    })),
  };
  await startReceiver();
});

afterEach(async () => {
  server.close();
  await once(server, "close");
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function send(
  key: string,
  options: { id?: string | null; signature?: string | null; body?: string } = {},
): Promise<Response> {
  const { id, event, payload } = fixtures[key]!;
  // Formatting the JSON makes the signed bytes differ from its reserialization.
  const body = options.body ?? JSON.stringify(payload, null, 2) + "\n";
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const headers = new Headers({ "x-github-event": event });
  if (options.id !== null) headers.set("x-github-delivery", options.id ?? id);
  if (options.signature !== null)
    headers.set("x-hub-signature-256", options.signature ?? signature);
  return fetch(endpoint, { method: "POST", headers, body });
}

function controller(interval = 0) {
  return createController({
    store,
    targets: [target],
    reconcile: createReconciler(store, github),
    reportError,
    reconcileIntervalMs: interval,
    now: () => now,
  });
}

function workflow() {
  return store.findWorkflow(target.repository, target.pullRequest);
}

describe("GitHub webhook intake and reconciliation", () => {
  it("rejects bad signatures, delivery IDs, and bodies before writing any records", async () => {
    const invalid = [
      [{ signature: null }, 401],
      [{ signature: "sha256=abcd" }, 401],
      [{ signature: `sha256=${"0".repeat(64)}` }, 401],
      [{ id: null }, 400],
      [{ id: "not-a-guid" }, 400],
      [{ body: "{ broken" }, 400],
      [{ body: "null" }, 400],
      [{ body: '{"action":"opened","number":0}' }, 400],
    ] as const;
    for (const [options, expected] of invalid)
      expect((await send("opened", options)).status).toBe(expected);
    expect(store.pendingDeliveries()).toEqual([]);
    expect(workflow()).toBeNull();
    expect(github.readPullRequest).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("returns a retryable HTTP error on SQLite failure and limits the body", async () => {
    server.close();
    await once(server, "close");
    await startReceiver(100);
    expect((await send("opened")).status).toBe(413);
    expect(store.pendingDeliveries()).toEqual([]);
    vi.spyOn(store, "receiveDelivery").mockImplementationOnce(() => {
      throw new Error("do not log raw storage error");
    });
    expect((await send("opened", { body: "{}" })).status).toBe(503);
    expect(reportError).toHaveBeenCalledWith(
      "Unable to receive or persist a GitHub webhook delivery.",
    );
  });

  it("acknowledges before performing GitHub reads and deduplicates delivery IDs", async () => {
    const { runPass } = controller();
    await runPass();
    vi.clearAllMocks();
    state.headSha = headB;
    const { id } = fixtures.synchronize!;
    expect((await send("synchronize")).status).toBe(202);
    expect((await send("opened", { id: id.toUpperCase() })).status).toBe(202);
    expect(workflow()?.headSha).toBe(headA);
    expect(github.readPullRequest).not.toHaveBeenCalled();
    expect(store.pendingDeliveries()).toEqual([
      { deliveryId: id, workflowId: null, payload: { githubWebhookVersion: 1, hint: target } },
    ]);
    await runPass();
    expect(workflow()?.headSha).toBe(headB);
    expect(github.readPullRequest).toHaveBeenCalledTimes(2);
    expect((await send("synchronize")).status).toBe(202);
    await runPass();
    expect(github.readPullRequest).toHaveBeenCalledTimes(2);
    expect(store.deliveryStatus(id)).toMatchObject({ status: "processed", attempts: 1 });
  });

  it("observes current state for stale lifecycle events and handles close then reopen", async () => {
    const { runPass } = controller();
    await send("opened");
    await runPass();
    const id = workflow()!.id;
    store.transition(id, {
      type: "review_received",
      evidence: { sha: headA, outcome: "completed_clean" },
    });
    state = { state: "closed", headSha: headB };
    await send("closed");
    await runPass();
    expect(workflow()).toMatchObject({
      state: "stopped",
      closedByGitHub: true,
      headSha: headB,
      review: null,
      checks: [],
    });

    state = { state: "open", headSha: headB };
    await send("reopened");
    await runPass();
    expect(workflow()).toMatchObject({ state: "awaiting_review", headSha: headB, review: null });
    expect(workflow()?.closedByGitHub).toBeUndefined();

    const transitions = store.transitions(id);
    await send("closed", { id: "fa217d36-a510-11ee-9eb4-000000000100" });
    await send("opened", { id: "fa217d36-a510-11ee-9eb4-000000000101" });
    vi.clearAllMocks();
    await runPass();
    expect(workflow()?.headSha).toBe(headB);
    expect(store.transitions(id)).toEqual(transitions);
    expect(github.readPullRequest).toHaveBeenCalledTimes(2);
  });

  it.each(["review", "reviewComment", "issueComment", "check", "suite", "status"])(
    "reads current reviews and exact-head checks for %s without deriving a verdict",
    async (event) => {
      const { runPass } = controller();
      await runPass();
      state.headSha = headB;
      checkOutcome = "failed";
      vi.clearAllMocks();
      expect((await send(event)).status).toBe(202);
      await runPass();
      expect(github.readReviewInputs).toHaveBeenCalledWith(target, undefined);
      expect(github.readChecks).toHaveBeenCalledWith(target, headB, undefined);
      expect(workflow()).toMatchObject({
        headSha: headB,
        state: "awaiting_review",
        review: null,
        requiredChecks: null,
        checks: [{ name: "CI", sha: headB, outcome: "failed" }],
      });
    },
  );

  it("converges on durable review evidence after a summary edit and a poll", async () => {
    const { runPass } = controller(1000);
    await runPass();
    vi.mocked(github.readReviewInputs).mockResolvedValue(codexReview);
    const payload = { ...fixtures.issueComment!.payload, action: "edited" };
    expect((await send("issueComment", { body: JSON.stringify(payload) })).status).toBe(202);
    await runPass();
    const captured = store.reviews().inspect(workflow()!.id);
    expect(captured).toMatchObject({
      projectedReview: { sha: headA, outcome: "completed_clean", runId: expect.any(String) },
      runs: [{ status: "completed", findings: [] }],
    });
    now += 1000;
    await runPass();
    expect(store.reviews().inspect(workflow()!.id)).toEqual(captured);
  });

  it("ignores ordinary issues, untracked PRs, and unexpected installations", async () => {
    const { runPass } = controller();
    await runPass();
    vi.clearAllMocks();
    const { payload } = fixtures.opened!;
    expect((await send("ordinaryIssue")).status).toBe(202);
    expect((await send("opened", { body: JSON.stringify({ ...payload, number: 8 }) })).status).toBe(
      202,
    );
    expect(
      (
        await send("review", {
          body: JSON.stringify({ ...fixtures.review!.payload, installation: { id: 43 } }),
        })
      ).status,
    ).toBe(202);
    await runPass();
    expect(github.readPullRequest).not.toHaveBeenCalled();
    expect(store.pendingDeliveries()).toHaveLength(0);
  });

  it("retries an observable failure after restart and the durable retry delay", async () => {
    const { runPass } = controller();
    await runPass();
    checkOutcome = "pending";
    vi.mocked(github.readChecks).mockRejectedValueOnce(new Error("GitHub API unavailable"));
    await send("check");
    const id = fixtures.check!.id;
    expect(await runPass()).toBe(false);
    expect(store.deliveryStatus(id)).toMatchObject({
      status: "failed",
      attempts: 1,
      error: expect.stringContaining("GitHub API unavailable"),
      retryAt: now + 30_000,
    });
    expect(workflow()?.checks).toEqual([]);
    expect(reportError).toHaveBeenCalledWith(expect.stringContaining(id));

    store.close();
    store = new WorkflowStore(dbPath);
    expect(store.recover()).toEqual({ deliveries: 0, ambiguousOperations: 0 });
    const restarted = controller();
    now += 29_999;
    await restarted.runPass();
    expect(store.deliveryStatus(id)).toMatchObject({ status: "failed", attempts: 1 });
    now++;
    await restarted.runPass();
    expect(store.deliveryStatus(id)).toMatchObject({
      status: "processed",
      attempts: 2,
      error: null,
      retryAt: null,
    });
    expect(workflow()?.checks).toEqual([{ name: "CI", sha: headA, outcome: "pending" }]);
  });

  it("persists a GitHub retry window longer than the default inbox delay", async () => {
    const { runPass } = controller();
    await runPass();
    const retryAt = now + 60_000;
    vi.mocked(github.readPullRequest).mockRejectedValueOnce(new GitHubRateLimitError(retryAt, 403));
    await send("status");
    const id = fixtures.status!.id;
    expect(await runPass()).toBe(false);
    expect(store.deliveryStatus(id)).toMatchObject({ status: "failed", attempts: 1, retryAt });
    now += 30_000;
    await runPass();
    expect(store.deliveryStatus(id)).toMatchObject({ status: "failed", attempts: 1, retryAt });
    now = retryAt;
    await runPass();
    expect(store.deliveryStatus(id)).toMatchObject({ status: "processed", attempts: 2 });
  });

  it("polls for missed opens, synchronizations, closures and reopens without replaying an operator stop", async () => {
    const { runPass } = controller(5_000);
    await runPass();
    expect(workflow()?.headSha).toBe(headA);
    state = { state: "closed", headSha: headB };
    now += 4_999;
    await runPass();
    expect(workflow()?.headSha).toBe(headA);
    now++;
    await runPass();
    expect(workflow()).toMatchObject({ headSha: headB, state: "stopped", closedByGitHub: true });
    store.close();
    store = new WorkflowStore(dbPath);
    state.state = "open";
    const restarted = controller(5_000);
    await restarted.runPass();
    expect(workflow()?.state).toBe("awaiting_review");
    store.transition(workflow()!.id, { type: "stop", reason: "Operator stop" });
    now += 5_000;
    await restarted.runPass();
    expect(workflow()).toMatchObject({ state: "stopped", escalationReason: "Operator stop" });
    expect(workflow()?.closedByGitHub).toBeUndefined();
  });

  it("discards a snapshot when the PR changes during the API reads", async () => {
    const { runPass } = controller();
    await runPass();
    vi.mocked(github.readReviewInputs).mockImplementationOnce(async () => {
      state.headSha = headB;
      return { reviews: [], reviewComments: [], issueComments: [] };
    });
    await send("review");
    expect(await runPass()).toBe(false);
    expect(workflow()).toMatchObject({ headSha: headB, checks: [], review: null });
    expect(store.deliveryStatus(fixtures.review!.id)?.error).toContain("head changed");
  });

  it("honors an operator stop issued while GitHub has closed the PR", async () => {
    const { runPass } = controller();
    await runPass();
    const id = workflow()!.id;
    state.state = "closed";
    await send("closed");
    await runPass();
    expect(workflow()).toMatchObject({ state: "stopped", closedByGitHub: true });

    store.transition(id, { type: "stop", reason: "Operator stop while closed" });
    store.close();
    store = new WorkflowStore(dbPath);
    store.recover();
    state.state = "open";
    await createReconciler(store, github)(target);
    expect(workflow()).toMatchObject({
      state: "stopped",
      escalationReason: "Operator stop while closed",
    });
    expect(workflow()?.closedByGitHub).toBeUndefined();
  });

  it("escalates an ambiguous operation across a close, restart, and reopen", async () => {
    const { runPass } = controller();
    await runPass();
    const id = workflow()!.id;
    store.createOperation("operation-1", id, "agent_turn", {});
    state.state = "closed";
    await send("closed");
    await runPass();
    expect(workflow()).toMatchObject({ state: "stopped", closedByGitHub: true });

    store.close();
    store = new WorkflowStore(dbPath);
    expect(store.recover()).toEqual({ deliveries: 0, ambiguousOperations: 1 });
    state.state = "open";
    await createReconciler(store, github)(target);
    expect(workflow()).toMatchObject({
      state: "escalated",
      escalationReason: "An external operation has an ambiguous outcome after restart.",
    });
    expect(workflow()?.closedByGitHub).toBeUndefined();
  });

  it("blocks reopening until a pending operation has a known outcome", async () => {
    const { runPass } = controller();
    await runPass();
    const id = workflow()!.id;
    store.createOperation("operation-1", id, "agent_turn", {});
    state.state = "closed";
    await send("closed");
    await runPass();

    state.state = "open";
    const reconcile = createReconciler(store, github);
    await expect(reconcile(target)).rejects.toThrow("external operation is pending");
    expect(workflow()).toMatchObject({ state: "stopped", closedByGitHub: true });

    store.finishOperation("operation-1", "ambiguous");
    state.headSha = headB;
    await reconcile(target);
    expect(workflow()).toMatchObject({
      state: "escalated",
      headSha: headB,
      review: null,
      checks: [],
      escalationReason: "An external operation has an ambiguous outcome.",
    });
    expect(store.transitions(id).at(-1)).toMatchObject({
      from: "stopped",
      to: "escalated",
      headSha: headB,
    });
  });

  it("fails closed when a review input read fails for a previously ready head", async () => {
    const { runPass } = controller();
    await runPass();
    const id = workflow()!.id;
    store.transition(id, {
      type: "review_received",
      evidence: { sha: headA, outcome: "completed_clean" },
    });
    store.transition(id, {
      type: "checks_received",
      configuredNames: ["CI"],
      evidence: [{ name: "CI", sha: headA, outcome: "passed" }],
    });
    expect(workflow()?.state).toBe("ready_for_human");
    vi.mocked(github.readReviewInputs).mockRejectedValueOnce(
      new Error("Review inputs unavailable"),
    );
    await send("issueComment");
    expect(await runPass()).toBe(false);
    expect(workflow()).toMatchObject({ state: "awaiting_review", headSha: headA, checks: [] });
  });

  it("reconciles pending and interrupted linked and unlinked deliveries after restart", async () => {
    await controller().runPass();
    const workflowId = workflow()!.id;
    store.close();
    const db = new DatabaseSync(dbPath);
    const insert = db.prepare(
      "INSERT INTO deliveries (delivery_id, workflow_id, payload, status, received_at) VALUES (?, ?, ?, ?, ?)",
    );
    insert.run(
      "linked-review",
      workflowId,
      '{"action":"review"}',
      "processing",
      new Date(now).toISOString(),
    );
    insert.run(
      "unlinked-open",
      null,
      '{"action":"opened"}',
      "pending",
      new Date(now).toISOString(),
    );
    insert.run("opaque-delivery", null, "null", "pending", new Date(now).toISOString());
    db.close();
    store = new WorkflowStore(dbPath);
    expect(store.recover()).toEqual({ deliveries: 1, ambiguousOperations: 0 });
    const deliveryIds = ["linked-review", "unlinked-open", "opaque-delivery"];
    expect(store.dueDeliveryIds(now, 25)).toEqual(deliveryIds);
    state.headSha = headB;
    const { runPass } = controller();
    vi.mocked(github.readPullRequest).mockRejectedValueOnce(
      new Error("GitHub unavailable at startup"),
    );
    expect(await runPass()).toBe(false);
    expect(store.deliveryStatus("opaque-delivery")).toMatchObject({
      status: "failed",
      retryAt: now + 30_000,
    });
    now += 30_000;
    expect(await runPass()).toBe(true);
    expect(workflow()).toMatchObject({
      headSha: headB,
      state: "awaiting_review",
      review: null,
    });
    for (const id of deliveryIds)
      expect(store.deliveryStatus(id)).toMatchObject({
        status: "processed",
        attempts: 2,
        error: null,
      });
  });

  it("uses the linked workflow to route a payload after the startup sweep", async () => {
    const reconcile = vi.fn(createReconciler(store, github));
    const { runPass } = createController({
      store,
      targets: [target, { ...target, pullRequest: 8 }],
      reconcile,
      reportError,
      reconcileIntervalMs: 0,
      now: () => now,
    });
    await runPass();
    reconcile.mockClear();
    store.receiveDelivery("linked-review", { action: "review" }, workflow()!.id);
    expect(await runPass()).toBe(true);
    expect(reconcile.mock.calls).toEqual([[target]]);
  });

  it("retires retry counts when an operator stops a workflow between passes", async () => {
    const { runPass } = controller();
    await runPass();
    const rateLimits = store.githubRateLimits();
    const retryAt = now + 120_000;
    const previous = {
      retryAt,
      throttledAttempts: 4,
      retryRequest: "pr:42:owner/repo:7",
    };
    rateLimits.set("secondary", previous);
    await runPass();
    expect(rateLimits.get("secondary")).toEqual(previous);
    store.transition(workflow()!.id, { type: "stop", reason: "Operator stopped tracking this PR" });
    await runPass();
    expect(rateLimits.get("secondary")).toEqual({
      retryAt,
      throttledAttempts: 0,
      retryRequest: null,
    });
  });

  it("records a late closure without clearing a rate limit hit earlier in the pass", async () => {
    vi.mocked(github.readPullRequest)
      .mockResolvedValueOnce({ state: "open", headSha: headA })
      .mockResolvedValueOnce({ state: "closed", headSha: headA });
    vi.mocked(github.readChecks).mockRejectedValueOnce(new GitHubRateLimitError(now + 60_000));
    await createReconciler(store, github)(target);
    expect(workflow()).toMatchObject({ state: "stopped", closedByGitHub: true });
    expect(github.completeReconciliation).not.toHaveBeenCalled();
  });
});
