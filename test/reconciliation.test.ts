import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.ts";
import { createController, runController, workerStatus } from "../src/controller.ts";
import type { GitHubReader, PullRequestState } from "../src/github-api.ts";
import { createReconciler } from "../src/reconcile.ts";
import { WorkflowStore } from "../src/store.ts";
import type { CheckEvidence } from "../src/workflow.ts";
import { crashAfterSession } from "./fixtures/execution.ts";
import { headA, headB, openPull } from "./fixtures/github.ts";

const first = { repository: "owner/one", pullRequest: 1, installationId: 1 };
const second = { repository: "owner/two", pullRequest: 2, installationId: 2 };
const repositories = [first, second].map(({ repository, installationId }) => ({
  repository,
  installationId,
}));

let root: string;
let path: string;
let store: WorkflowStore;
let reader: GitHubReader;
let abort: AbortController;
let reportError: ReturnType<typeof vi.fn<(message: string) => void>>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "switchyard-b2-"));
  path = join(root, "state.sqlite");
  store = new WorkflowStore(path);
  abort = new AbortController();
  reportError = vi.fn();
  reader = {
    completeReconciliation: vi.fn(),
    listOpenPullRequests: vi.fn(async ({ repository }) =>
      [first, second]
        .filter((target) => target.repository === repository)
        .map((target) => target.pullRequest),
    ),
    readPullRequest: vi.fn(async ({ repository }) => openPull(repository)),
    readChecks: vi.fn<GitHubReader["readChecks"]>(async (_target, sha) => [
      { sha, name: "CI", outcome: "passed" },
    ]),
  };
});

afterEach(() => {
  abort.abort();
  store.close();
  rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});

function makeController() {
  return createController({
    store,
    repositories,
    github: reader,
    reconcile: createReconciler(store, reader, ({ repository }) =>
      repository === first.repository ? ["CI"] : null,
    ),
    signal: abort.signal,
    reportError,
  });
}

function get(target = first) {
  return store.findWorkflow(target.repository, target.pullRequest);
}

function run(
  controller: ReturnType<typeof createController>,
  onceOnly = true,
  log = vi.fn<(entry: Record<string, unknown>) => void>(),
) {
  return runController({
    controller,
    store,
    repositories,
    signal: abort.signal,
    onceOnly,
    reconcileIntervalMs: 60_000,
    log,
  });
}

describe("shared reconciliation", () => {
  it("discovers in multiple enabled repositories and converges across startup, periodic, hints and an operator run", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const controller = makeController();
    const startup = Promise.withResolvers<void>();
    const periodic = Promise.withResolvers<void>();
    const notified = Promise.withResolvers<void>();
    let passes = 0;
    let head = headA;
    let listed = [1];
    vi.mocked(reader.listOpenPullRequests).mockImplementation(async ({ repository }) =>
      repository === first.repository ? listed : [2],
    );
    vi.mocked(reader.readPullRequest).mockImplementation(async ({ repository }) =>
      openPull(repository, { headSha: repository === first.repository ? head : headA }),
    );
    const background = run(
      controller,
      false,
      vi.fn((entry) => {
        if (entry.event !== "reconciliation_finished") return;
        [startup, periodic, notified][passes++]?.resolve();
      }),
    );
    try {
      await startup.promise;
      const id = get()!.id;
      expect(workerStatus(store)).toMatchObject({ state: "running", lastPassSucceeded: true });
      expect(get()).toMatchObject({ headSha: headA, requiredChecks: ["CI"] });
      expect(get(second)).toMatchObject({ headSha: headA, requiredChecks: null });
      head = headB;
      listed = [1, 3, 3];
      await vi.advanceTimersByTimeAsync(60_000);
      await periodic.promise;
      expect(get()).toMatchObject({ id, headSha: headB });
      expect(store.listWorkflows(first.repository).map(({ id }) => id)).toEqual([
        id,
        "owner/one#3",
      ]);
      const expected = workerStatus(store).pullRequests;
      controller.notify({ ...first, pullRequest: null });
      await notified.promise;
      expect(workerStatus(store).pullRequests).toEqual(expected);
      abort.abort();
      await background;
      abort = new AbortController();
      expect(await run(makeController())).toBe(true);
      expect(workerStatus(store)).toMatchObject({
        state: "stopped",
        lastPassSucceeded: true,
        pullRequests: expected,
      });
    } finally {
      abort.abort();
      await background;
    }
  });

  it("separates partial discovery and individual failures from successful observations", async () => {
    const controller = makeController();
    expect(await run(controller)).toBe(true);
    const id = get()!.id;
    vi.mocked(reader.listOpenPullRequests)
      .mockRejectedValueOnce(new Error("Incomplete page"))
      .mockResolvedValueOnce([2, 4, 5]);
    vi.mocked(reader.readPullRequest).mockImplementation(async ({ repository, pullRequest }) => {
      if (pullRequest === 1) return openPull(repository, { state: "closed" });
      if (pullRequest === 4) throw new Error("PR unavailable");
      return openPull(repository);
    });
    expect(await run(controller)).toBe(false);
    expect(get()).toMatchObject({ id, state: "stopped", githubStatus: "closed", checks: [] });
    expect(get(second)?.state).toBe("awaiting_review");
    expect(store.listWorkflows(second.repository).map(({ id }) => id)).toEqual([
      "owner/two#2",
      "owner/two#5",
    ]);
    expect(reportError.mock.calls.flat()).toEqual([
      "owner/one: Incomplete page",
      "owner/two#4: PR unavailable",
    ]);
    vi.mocked(reader.listOpenPullRequests).mockResolvedValue([]);
    vi.mocked(reader.readPullRequest).mockImplementation(async ({ repository }) =>
      openPull(repository),
    );
    expect(await run(controller)).toBe(true);
    expect(get()).toMatchObject({ id, state: "awaiting_review", githubStatus: "eligible" });
  });

  it("does not enroll drafts, forks or merged PRs, and observes merge on a tracked PR absent from discovery", async () => {
    vi.mocked(reader.listOpenPullRequests).mockResolvedValue([1, 3, 4, 5, 6]);
    vi.mocked(reader.readPullRequest).mockImplementation(async ({ repository, pullRequest }) => {
      if (pullRequest === 3) return openPull(repository, { draft: true });
      if (pullRequest === 4) return openPull(repository, { headRepository: "someone/fork" });
      if (pullRequest === 5) return openPull(repository, { headRepository: null });
      if (pullRequest === 6) return openPull(repository, { state: "closed", merged: true });
      return openPull(repository);
    });
    const controller = makeController();
    expect(await run(controller)).toBe(true);
    expect(store.listWorkflows(first.repository)).toEqual([get()]);
    const id = get()!.id;
    vi.mocked(reader.listOpenPullRequests).mockResolvedValue([]);
    vi.mocked(reader.readPullRequest).mockImplementation(async ({ repository }) =>
      openPull(repository, { state: "closed", merged: true }),
    );
    expect(await run(controller)).toBe(true);
    expect(get()).toMatchObject({ id, state: "stopped", githubStatus: "merged", checks: [] });
    expect(store.transitions(id)).toContainEqual(expect.objectContaining({ to: "stopped" }));
  });

  it.each(["head", "draft", "fork", "closed", "merged"] as const)(
    "never applies old passing checks across a %s change during observation",
    async (change) => {
      const reconcile = createReconciler(store, reader);
      await reconcile(first);
      const id = get()!.id;
      const changes: Record<typeof change, Partial<PullRequestState>> = {
        head: { headSha: headB },
        draft: { draft: true },
        fork: { headRepository: "another/fork" },
        closed: { state: "closed" },
        merged: { state: "closed", merged: true },
      };
      const latest = openPull(first.repository, changes[change]);
      vi.mocked(reader.readPullRequest)
        .mockResolvedValueOnce(openPull(first.repository))
        .mockResolvedValue(latest);
      if (change === "head") {
        await expect(reconcile(first)).rejects.toThrow(/head changed/);
        expect(get()).toMatchObject({ id, headSha: headB, checks: [] });
      } else {
        await reconcile(first);
        expect(get()).toMatchObject({ id, state: "stopped", githubStatus: change, checks: [] });

        const unknown = { ...first, pullRequest: 9 };
        vi.mocked(reader.readPullRequest).mockResolvedValueOnce(openPull(first.repository));
        await reconcile(unknown);
        expect(get(unknown)).toBeNull();
      }
      using db = new DatabaseSync(path, { readOnly: true });
      expect(
        db.prepare("SELECT sha, outcome FROM check_snapshots WHERE workflow_id=?").all(id),
      ).toEqual([{ sha: headA, outcome: "passed" }]);
    },
  );

  it.each(["failed", "pending"] as const)(
    "preserves newer same-head %s CI across SQLite connections",
    async (outcome) => {
      const reconcile = createReconciler(store, reader);
      await reconcile(first);
      const other = new WorkflowStore(path);
      const entered = Promise.withResolvers<void>();
      const response = Promise.withResolvers<PullRequestState>();
      const snapshot = openPull(first.repository);
      const delayedReader = {
        ...reader,
        readPullRequest: vi
          .fn<GitHubReader["readPullRequest"]>()
          .mockResolvedValueOnce(snapshot)
          .mockImplementationOnce(() => {
            entered.resolve();
            return response.promise;
          }),
      };
      const delayed = createReconciler(other, delayedReader)(first);
      const superseded = expect(delayed).rejects.toThrow(/superseded this observation/);
      try {
        await entered.promise;
        vi.mocked(reader.readChecks).mockResolvedValue([{ name: "CI", sha: headA, outcome }]);
        await reconcile(first);
      } finally {
        response.resolve(snapshot);
        try {
          await superseded;
        } finally {
          other.close();
        }
      }
      expect(get()).toMatchObject({
        headSha: headA,
        checks: [{ name: "CI", sha: headA, outcome }],
      });
    },
  );

  it.each(["stop", "escalate"] as const)(
    "preserves a durable operator %s across closure, reopen and a new head",
    async (type) => {
      const reconcile = createReconciler(store, reader);
      await reconcile(first);
      const id = get()!.id;
      vi.mocked(reader.readPullRequest).mockResolvedValue(
        openPull(first.repository, { state: "closed" }),
      );
      await reconcile(first);
      store.transition(id, { type, reason: "Operator hold" });
      store.close();
      store = new WorkflowStore(path);
      vi.mocked(reader.readPullRequest).mockResolvedValue(
        openPull(first.repository, { headSha: headB }),
      );
      vi.mocked(reader.readChecks).mockClear();
      await createReconciler(store, reader)(first);
      expect(get()).toMatchObject({
        id,
        state: type === "stop" ? "stopped" : "escalated",
        githubStatus: "eligible",
        headSha: headB,
        escalationReason: "Operator hold",
        checks: [],
      });
      expect(reader.readChecks).not.toHaveBeenCalled();
    },
  );

  it.each(["CI", "final PR read"] as const)(
    "clears current checks when the %s fails",
    async (read) => {
      const reconcile = createReconciler(store, reader);
      await reconcile(first);
      expect(get()?.checks).toHaveLength(1);
      if (read === "CI")
        vi.mocked(reader.readChecks).mockRejectedValueOnce(new Error("read failed"));
      else
        vi.mocked(reader.readPullRequest)
          .mockResolvedValueOnce(openPull(first.repository))
          .mockRejectedValueOnce(new Error("read failed"));
      await expect(reconcile(first)).rejects.toThrow("read failed");
      expect(get()).toMatchObject({ state: "awaiting_review", headSha: headA, checks: [] });
    },
  );

  it("recovers a lost native owner at startup and keeps its execution held across PR reopening", async () => {
    expect(await run(makeController())).toBe(true);
    vi.mocked(reader.readPullRequest).mockImplementation(async ({ repository }) =>
      openPull(repository, { state: "closed" }),
    );
    expect(await run(makeController())).toBe(true);
    const id = get()!.id;
    const interrupted = crashAfterSession(path);
    expect(interrupted.signal, interrupted.stderr).toBe("SIGKILL");
    store.close();
    store = new WorkflowStore(path);
    vi.mocked(reader.readPullRequest).mockImplementation(async ({ repository }) =>
      openPull(repository, { headSha: headB }),
    );
    expect(await run(makeController())).toBe(true);
    expect(get()).toMatchObject({ id, state: "awaiting_review", headSha: headB });
    expect(store.agentExecutions().get("interrupted")).toMatchObject({
      status: "unknown",
      reason: expect.stringContaining("owner exited"),
    });
    expect(reportError).toHaveBeenCalledWith(
      expect.stringContaining("Recovered 1 agent execution"),
    );
  });

  it("drains an in-flight CI result without writing it or starting another target", async () => {
    const entered = Promise.withResolvers<void>();
    const inFlight = Promise.withResolvers<CheckEvidence[]>();
    vi.mocked(reader.readChecks).mockImplementationOnce(() => {
      entered.resolve();
      return inFlight.promise;
    });
    const background = run(makeController(), false);
    try {
      await entered.promise;
      abort.abort();
      expect(workerStatus(store)).toMatchObject({ state: "running" });
      expect(reader.readPullRequest).toHaveBeenCalledTimes(1);
    } finally {
      abort.abort();
      inFlight.resolve([{ name: "CI", sha: headA, outcome: "passed" }]);
      await background;
    }
    expect(reader.listOpenPullRequests).toHaveBeenCalledTimes(1);
    expect(reader.readPullRequest).toHaveBeenCalledTimes(1);
    expect(get()).toBeNull();
    expect(workerStatus(store)).toMatchObject({ state: "stopped", lastPassSucceeded: false });
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "drains an in-flight discovery request when the CLI receives %s",
    async (signal) => {
      const configPath = join(root, "config.json");
      writeFileSync(configPath, JSON.stringify({ repositories }));
      const keyPath = join(root, "app.pem");
      const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
      writeFileSync(keyPath, privateKey.export({ format: "pem", type: "pkcs8" }));
      const mockPath = join(root, "github.mjs");
      writeFileSync(
        mockPath,
        `
        import { once } from "node:events";
        globalThis.fetch = async (url) => {
          if (url.pathname.endsWith("/access_tokens"))
            return Response.json({token:"fixture", expires_at:"2099-01-01T00:00:00Z"});
          if (!url.pathname.endsWith("/pulls")) throw new Error("Unexpected detail request");
          const interrupted = once(process, ${JSON.stringify(signal)});
          console.log(JSON.stringify({event:"fixture_read_started"}));
          await interrupted;
          console.log(JSON.stringify({event:"fixture_read_finished"}));
          return Response.json([{number:1}]);
        };
      `,
      );
      const child = spawn(process.execPath, ["--import", mockPath, "src/main.ts", configPath], {
        detached: true,
        stdio: ["ignore", "pipe", "inherit"],
        env: {
          ...process.env,
          GITHUB_WEBHOOK_SECRET: "",
          SWITCHYARD_DB_PATH: path,
          GITHUB_APP_CLIENT_ID: "fixture",
          GITHUB_APP_PRIVATE_KEY_PATH: keyPath,
        },
      });
      const exited = once(child, "exit");
      const events = [];
      for await (const line of createInterface({ input: child.stdout })) {
        const entry = JSON.parse(line);
        events.push(entry);
        if (entry.event === "fixture_read_started") process.kill(-child.pid!, signal);
      }
      expect(await exited).toEqual([0, null]);
      expect(events).toContainEqual({ event: "fixture_read_finished" });
      expect(events).toContainEqual(
        expect.objectContaining({ event: "worker_stopped", interrupted: true }),
      );
      expect(workerStatus(store)).toMatchObject({ state: "stopped", pullRequests: [] });
    },
  );

  it("blocks a competing reconciler and takes over after a live owner disappears", async () => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
        import { WorkflowStore } from "./src/store.ts";
        const db = new WorkflowStore(process.argv[1]);
        console.log(JSON.stringify(db.claimWorker([], 10000, new Date().toISOString()).record));
        process.stdin.resume();
      `,
        path,
      ],
      { stdio: ["pipe", "pipe", "inherit"] },
    );
    const closed = once(child, "close");
    const output = createInterface({ input: child.stdout });
    try {
      const [line] = await once(output, "line");
      const previous = JSON.parse(String(line));
      expect(workerStatus(store)).toMatchObject({ state: "running", pid: child.pid });
      await expect(run(makeController())).rejects.toThrow(/already owns/);
      expect(reader.listOpenPullRequests).not.toHaveBeenCalled();
      child.stdin.end();
      await closed;
      expect(workerStatus(store)).toMatchObject({ state: "interrupted" });
      const log = vi.fn();
      expect(await run(makeController(), true, log)).toBe(true);
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "worker_started",
          interruptedRun: previous.id,
        }),
      );
      expect(workerStatus(store)).toMatchObject({ state: "stopped", pid: process.pid });
    } finally {
      output.close();
      child.stdin.end();
      await closed;
    }
  });
});

describe("repository configuration", () => {
  it("normalizes repository and check keys and defaults to periodic discovery", () => {
    const configPath = join(root, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        repositories: [{ repository: "Owner/One", installationId: 1 }, repositories[1]],
        requiredChecks: { "OWNER/ONE": ["CI"] },
      }),
    );
    expect(loadConfig(configPath)).toEqual({
      repositories,
      reconcileIntervalMs: 60_000,
      requiredChecks: new Map([["owner/one", ["CI"]]]),
    });
  });

  it.each([
    { repositories: [] },
    { repositories: [{ ...first, installationId: 0 }] },
    { repositories: [{ ...first, pullRequests: [1] }] },
    { repositories: [repositories[0], { repository: "OWNER/ONE", installationId: 9 }] },
    { requiredChecks: { "owner/one#1": ["CI"] } },
    { requiredChecks: { "owner/unknown": ["CI"] } },
    { requiredChecks: { "owner/one": ["CI"], "Owner/One": ["CI"] } },
    { requiredChecks: { "owner/one": [] } },
    { requiredChecks: { "owner/one": ["CI", "CI"] } },
    { reconcileIntervalMs: 0 },
    { reconcileIntervalMs: -1 },
    { reconcileIntervalMs: 2_147_483_648 },
  ])("rejects invalid configuration %j", (overrides) => {
    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify({ repositories, ...overrides }));
    expect(() => loadConfig(configPath)).toThrow();
  });
});
