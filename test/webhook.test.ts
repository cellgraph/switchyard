import { createHmac } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createController, runController } from "../src/controller.ts";
import type { GitHubReader, PullRequestState } from "../src/github-api.ts";
import { GitHubTransientError } from "../src/github-app.ts";
import { createReconciler } from "../src/reconcile.ts";
import { WorkflowStore } from "../src/store.ts";
import { createWebhookServer } from "../src/webhook.ts";
import { headA, headB, openPull } from "./fixtures/github.ts";

type Fixture = { id: string; event: string; payload: Record<string, unknown> };
const fixtures = JSON.parse(
  readFileSync(new URL("./fixtures/github-webhooks.json", import.meta.url), "utf8"),
) as Record<string, Fixture>;
const secret = "fixture-only-webhook-secret";
const target = { repository: "owner/repo", pullRequest: 7, installationId: 42 };

let store: WorkflowStore;
let server: ReturnType<typeof createWebhookServer>;
let endpoint: string;
let state: PullRequestState;
let github: GitHubReader;
let controller: ReturnType<typeof createController>;
let notify: ReturnType<typeof vi.fn<typeof controller.notify>>;
let abort: AbortController;

beforeEach(async () => {
  store = new WorkflowStore();
  abort = new AbortController();
  state = openPull(target.repository);
  github = {
    completeReconciliation: vi.fn(),
    listOpenPullRequests: vi.fn(async () => [target.pullRequest]),
    readPullRequest: vi.fn(async () => ({ ...state })),
    readChecks: vi.fn<GitHubReader["readChecks"]>(async (_target, sha) => [
      { name: "CI", sha, outcome: "passed" },
    ]),
  };
  controller = createController({
    store,
    repositories: [target],
    github,
    reconcile: createReconciler(store, github),
    reportError: vi.fn(),
    signal: abort.signal,
    now: () => Date.now(),
  });
  notify = vi.fn(controller.notify);
  server = createWebhookServer({ secret, notify, reportError: vi.fn(), maxBodyBytes: 4096 });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture server address.");
  endpoint = `http://127.0.0.1:${address.port}/webhooks/github`;
});

afterEach(async () => {
  abort.abort();
  await controller.runPass();
  server.close();
  await once(server, "close");
  store.close();
});

function send(
  key: string,
  options: {
    id?: string | null;
    signature?: string | null;
    event?: string;
    body?: string;
    payload?: Record<string, unknown>;
  } = {},
): Promise<Response> {
  const { id, event, payload } = fixtures[key]!;
  // Sign the original bytes, including whitespace that reserialization would change.
  const body = options.body ?? JSON.stringify({ ...payload, ...options.payload }, null, 2) + "\n";
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const headers = new Headers({ "x-github-event": options.event ?? event });
  if (options.id !== null) headers.set("x-github-delivery", options.id ?? id);
  if (options.signature !== null)
    headers.set("x-hub-signature-256", options.signature ?? signature);
  return fetch(endpoint, { method: "POST", headers, body });
}

function workflow() {
  return store.findWorkflow(target.repository, target.pullRequest);
}

describe("authenticated transient GitHub notifications", () => {
  it("rejects invalid signatures, delivery and event headers, bodies and routing fields", async () => {
    const errors = [
      [{ signature: null }, 401],
      [{ signature: "sha256=abcd" }, 401],
      [{ signature: `sha256=${"0".repeat(64)}` }, 401],
      [{ id: null }, 400],
      [{ id: "invalid" }, 400],
      [{ event: "invalid-event" }, 400],
      [{ body: "{broken" }, 400],
      [{ body: "[]" }, 400],
      [{ payload: { repository: { full_name: "../repo" } } }, 400],
      [{ payload: { installation: { id: 0 } } }, 400],
      [{ payload: { number: "7" } }, 400],
      [{ body: JSON.stringify({ padding: "x".repeat(4096) }) }, 413],
    ] as const;
    for (const [options, status] of errors)
      expect((await send("opened", options)).status).toBe(status);
    expect((await fetch(endpoint)).status).toBe(405);
    expect((await fetch(`${endpoint}/unknown`, { method: "POST" })).status).toBe(404);
    expect(notify).not.toHaveBeenCalled();
    expect(github.readPullRequest).not.toHaveBeenCalled();
  });

  it("acknowledges while reconciliation is blocked and coalesces repeated hints", async () => {
    const waiting = Promise.withResolvers<PullRequestState>();
    const entered = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    let passes = 0;
    vi.mocked(github.readPullRequest).mockImplementationOnce(() => {
      entered.resolve();
      return waiting.promise;
    });
    const run = runController({
      controller,
      store,
      repositories: [target],
      onceOnly: false,
      reconcileIntervalMs: 60_000,
      signal: abort.signal,
      log(entry) {
        if (entry.event === "reconciliation_finished" && ++passes === 2) finished.resolve();
      },
    });
    try {
      await entered.promise;
      expect((await send("opened")).status).toBe(202);
      expect((await send("opened")).status).toBe(202);
      expect((await send("synchronize")).status).toBe(202);
      expect(workflow()).toBeNull();
      waiting.resolve({ ...state });
      await finished.promise;
      expect(github.listOpenPullRequests).toHaveBeenCalledTimes(1);
      expect(github.readPullRequest).toHaveBeenCalledTimes(4);
      expect(store.listWorkflows(target.repository)).toHaveLength(1);
      expect(workflow()?.id).toBe("owner/repo#7");
    } finally {
      waiting.resolve({ ...state });
      abort.abort();
      await run;
    }
  });

  it("recovers a transient discovery failure on the periodic sweep with webhooks enabled", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const interval = 60_000;
    const outcomes: unknown[] = [];
    vi.mocked(github.listOpenPullRequests).mockRejectedValueOnce(
      new GitHubTransientError("Discovery temporarily unavailable", {
        retryAt: Date.now() + 30_000,
      }),
    );
    const run = runController({
      controller,
      store,
      repositories: [target],
      onceOnly: false,
      reconcileIntervalMs: interval,
      signal: abort.signal,
      log(entry) {
        if (entry.event === "reconciliation_finished") outcomes.push(entry.succeeded);
      },
    });
    try {
      await vi.advanceTimersByTimeAsync(interval - 1);
      expect(outcomes).toEqual([false]);
      expect(github.listOpenPullRequests).toHaveBeenCalledTimes(1);
      expect(workflow()).toBeNull();

      await vi.advanceTimersByTimeAsync(1);
      expect(outcomes).toEqual([false, true]);
      expect(github.listOpenPullRequests).toHaveBeenCalledTimes(2);
      expect(workflow()).toMatchObject({ state: "awaiting_review", headSha: headA });
      expect(notify).not.toHaveBeenCalled();
    } finally {
      abort.abort();
      await run;
      vi.useRealTimers();
    }
  });

  it("uses current lifecycle and head despite stale or out-of-order payloads", async () => {
    state = openPull(target.repository, { headSha: headB, draft: true });
    expect((await send("opened")).status).toBe(202);
    await controller.runPass();
    expect(workflow()).toBeNull();

    state.draft = false;
    expect((await send("opened", { payload: { action: "ready_for_review" } })).status).toBe(202);
    await controller.runPass();
    expect(workflow()).toMatchObject({ state: "awaiting_review", headSha: headB });
    const id = workflow()!.id;

    state.draft = true;
    expect((await send("opened", { payload: { action: "converted_to_draft" } })).status).toBe(202);
    await controller.runPass();
    expect(workflow()).toMatchObject({ id, state: "stopped", githubStatus: "draft", checks: [] });

    state = openPull(target.repository, { state: "closed" });
    expect((await send("reopened")).status).toBe(202);
    await controller.runPass();
    expect(workflow()).toMatchObject({
      id,
      state: "stopped",
      githubStatus: "closed",
      headSha: headA,
    });

    state = openPull(target.repository, { headSha: headB });
    expect((await send("closed")).status).toBe(202);
    await controller.runPass();
    expect(workflow()).toMatchObject({
      id,
      state: "awaiting_review",
      githubStatus: "eligible",
      headSha: headB,
    });
  });

  it.each(["review", "reviewComment", "issueComment", "check", "suite", "status"])(
    "routes supported %s notifications using only repository and PR hints",
    async (fixture) => {
      expect((await send(fixture)).status).toBe(202);
      expect(workflow()).toBeNull();
      await controller.runPass();
      const isCI = ["check", "suite", "status"].includes(fixture);
      expect(notify).toHaveBeenCalledExactlyOnceWith({ ...target, pullRequest: isCI ? null : 7 });
      expect(github.listOpenPullRequests).toHaveBeenCalledTimes(isCI ? 1 : 0);
      expect(workflow()).toMatchObject({ state: "awaiting_review", requiredChecks: null });
      expect(store.reviews().list(workflow()!.id)).toEqual([]);
    },
  );

  it("routes a check associated with one PR without listing the repository", async () => {
    expect(
      (await send("check", { payload: { check_run: { pull_requests: [{ number: 7 }] } } })).status,
    ).toBe(202);
    await controller.runPass();
    expect(notify).toHaveBeenCalledExactlyOnceWith(target);
    expect(github.listOpenPullRequests).not.toHaveBeenCalled();
    expect(workflow()?.headSha).toBe(headA);
  });

  it("ignores valid notifications for other installations, repositories and ordinary issues", async () => {
    expect((await send("opened", { payload: { installation: { id: 43 } } })).status).toBe(202);
    expect(
      (await send("opened", { payload: { repository: { full_name: "another/repo" } } })).status,
    ).toBe(202);
    expect((await send("status", { payload: { installation: { id: 43 } } })).status).toBe(202);
    expect((await send("issueComment", { payload: { issue: { number: 7 } } })).status).toBe(202);
    await controller.runPass();
    expect(github.readPullRequest).not.toHaveBeenCalled();
    expect(github.listOpenPullRequests).not.toHaveBeenCalled();
    expect(workflow()).toBeNull();
  });

  it("keeps a PR-specific hint when a coalesced repository listing omits the PR", async () => {
    vi.mocked(github.listOpenPullRequests).mockResolvedValueOnce([]);
    expect((await send("status")).status).toBe(202);
    expect((await send("opened")).status).toBe(202);
    await controller.runPass();
    expect(workflow()).toMatchObject({ state: "awaiting_review", headSha: headA });
  });
});
