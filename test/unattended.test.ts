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
import { createGitHubReader, type GitHubReader } from "../src/github-api.ts";
import { createGitHubAppClient, GitHubTransientError } from "../src/github-app.ts";
import { WorkflowStore } from "../src/store.ts";
import { runUnattended, workerStatus } from "../src/unattended.ts";
import reviewFixture from "./fixtures/codex-pr51.json" with { type: "json" };

const first = { repository: "owner/one", pullRequest: 1, installationId: 1 };
const second = { repository: "owner/two", pullRequest: 2, installationId: 2 };
const targets = [first, second];
const oldHead = "a".repeat(40);
const newHead = "b".repeat(40);
const interval = 10_000;

describe("unattended polling", () => {
  let root: string;
  let path: string;
  let store: WorkflowStore;
  let reader: GitHubReader;
  let stop: AbortController;
  let now: number;
  let log: ReturnType<typeof vi.fn<(entry: Record<string, unknown>) => void>>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "switchyard-unattended-"));
    path = join(root, "controller.sqlite");
    store = new WorkflowStore(path);
    reader = {
      completeReconciliation: vi.fn(),
      readPullRequest: vi.fn<GitHubReader["readPullRequest"]>(async () => ({
        state: "open",
        headSha: oldHead,
      })),
      readChecks: vi.fn(async () => []),
      readReviewInputs: vi.fn(async () => ({ reviews: [], reviewComments: [], issueComments: [] })),
    };
    stop = new AbortController();
    now = 1_000;
    log = vi.fn();
  });

  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  function worker(
    wait: (ms: number) => void,
    overrides?: Partial<Parameters<typeof runUnattended>[0]>,
  ) {
    return runUnattended({
      store,
      config: { targets, requiredChecks: new Map(), reconcileIntervalMs: interval },
      reader,
      signal: stop.signal,
      now: () => now,
      log,
      async wait(ms) {
        now += ms;
        wait(ms);
      },
      ...overrides,
    });
  }

  it("polls configured PRs repeatedly and persists the last run and both PRs", async () => {
    let waits = 0;
    await worker((ms) => {
      expect(ms).toBe(interval);
      if (++waits === 2) stop.abort();
    });
    expect(reader.completeReconciliation).toHaveBeenCalledTimes(4);
    expect(workerStatus(store)).toMatchObject({
      state: "stopped",
      lastPollSucceeded: true,
      pollIntervalMs: interval,
      lastPollFinishedAt: new Date(11_000).toISOString(),
      pullRequests: [
        { pullRequest: 1, headSha: oldHead, state: "awaiting_review" },
        { pullRequest: 2, headSha: oldHead, state: "awaiting_review" },
      ],
    });
  });

  it("backs off a transient target error while continuing to reconcile other PRs", async () => {
    vi.mocked(reader.readPullRequest).mockRejectedValueOnce(
      new GitHubTransientError("secret-detail"),
    );
    let waits = 0;
    await worker(() => {
      if (++waits === 4) stop.abort();
    });
    expect(
      vi.mocked(reader.completeReconciliation).mock.calls.map(([target]) => target.pullRequest),
    ).toEqual([2, 2, 2, 1, 2]);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "reconciliation",
        pullRequest: 1,
        outcome: "github_transient",
      }),
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret-detail");
    expect(workerStatus(store)).toMatchObject({ state: "stopped", lastPollSucceeded: true });
  });

  it("discards stale evidence when the head changes during unattended polling", async () => {
    vi.mocked(reader.readPullRequest)
      .mockResolvedValueOnce({ state: "open", headSha: oldHead })
      .mockResolvedValueOnce({ state: "open", headSha: newHead });
    await worker(() => stop.abort());
    expect(store.findWorkflow(first.repository, 1)).toMatchObject({
      headSha: newHead,
      review: null,
      checks: [],
    });
    expect(store.findWorkflow(second.repository, 2)).not.toBeNull();
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "reconciliation",
        pullRequest: 1,
        outcome: "observation_changed",
      }),
    );
  });

  it("finishes an in-flight read and starts no new target after shutdown", async () => {
    vi.mocked(reader.readPullRequest).mockImplementationOnce(async () => {
      stop.abort();
      return { state: "open", headSha: oldHead };
    });
    await worker(() => {
      throw new Error("Shutdown must skip the polling delay.");
    });
    expect(reader.readChecks).not.toHaveBeenCalled();
    expect(reader.readReviewInputs).not.toHaveBeenCalled();
    expect(reader.completeReconciliation).not.toHaveBeenCalled();
    expect(workerStatus(store)).toMatchObject({
      state: "stopped",
      pullRequests: [{ state: "unobserved" }, { state: "unobserved" }],
    });
  });

  function app(fetcher: typeof fetch) {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    return createGitHubReader(
      createGitHubAppClient({
        clientId: "test",
        privateKey: privateKey.export({ format: "pem", type: "pkcs8" }),
        fetcher,
        now: () => now,
        retryDeadlines: store.reconciliationRetries(),
      }),
    );
  }

  it.each(["initial read", "first page"])(
    "drains the real REST queue during the %s",
    async (point) => {
      const reads: string[] = [];
      reader = app(async (input, options) => {
        const url = new URL(String(input));
        reads.push(url.pathname + url.search);
        if (options?.method === "POST")
          return Response.json({ token: "fixture", expires_at: new Date(now + 3_600_000) });
        if (url.pathname.endsWith("/pulls/1")) {
          if (point === "initial read") stop.abort();
          return Response.json({ number: 1, head: { sha: oldHead }, state: "open" });
        }
        stop.abort();
        return Response.json(
          { check_runs: [] },
          {
            headers: { link: '<https://api.github.com/next>; rel="next"' },
          },
        );
      });
      await worker(() => {
        throw new Error("Unexpected wait.");
      });
      expect(reads).toHaveLength(point === "initial read" ? 2 : 3);
      expect(reads).not.toContainEqual(expect.stringMatching(/page=2|pulls\/2/));
      expect(workerStatus(store)).toMatchObject({
        lastPollFinishedAt: null,
        pullRequests: [{ state: "unobserved" }, { state: "unobserved" }],
      });
      expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "poll_interrupted" }));
    },
  );

  it("backs off repeated token 401s across repositories in the installation and across restarts", async () => {
    const requests: string[] = [];
    const shared = { ...second, installationId: first.installationId };
    const unaffected = { repository: "owner/three", pullRequest: 3, installationId: 3 };
    const fetcher: typeof fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      requests.push(path);
      if (path.includes("/installations/1/"))
        return new Response("sensitive response", { status: 401 });
      if (path.includes("/installations/3/"))
        return Response.json({ token: "redacted", expires_at: new Date(now + 3_600_000) });
      return Response.json({ number: 3, head: { sha: oldHead }, state: "closed" });
    };
    const config = {
      targets: [first, shared, unaffected],
      requiredChecks: new Map(),
      reconcileIntervalMs: interval,
    };
    reader = app(fetcher);
    await worker(() => stop.abort(), { config });
    expect(requests.filter((request) => request.includes("/installations/1/"))).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "target_failed",
        outcome: "github_authentication",
        httpStatus: 401,
        installationId: 1,
        retryAt: 301_000,
      }),
    );
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/sensitive response|redacted/);
    expect(store.findWorkflow(unaffected.repository, 3)).not.toBeNull();

    store.close();
    store = new WorkflowStore(path);
    stop = new AbortController();
    reader = app(fetcher);
    await worker(() => stop.abort(), { config });
    expect(requests.filter((request) => request.includes("/installations/1/"))).toHaveLength(1);
    now = 301_000;
    stop = new AbortController();
    await worker(() => stop.abort(), { config });
    expect(requests.filter((request) => request.includes("/installations/1/"))).toHaveLength(2);
  });

  it("observes required checks and findings without dispatching agent work", async () => {
    const { clean, reviewed, ...inputs } = reviewFixture;
    vi.mocked(reader.readPullRequest).mockImplementation(async ({ pullRequest }) => ({
      state: "open",
      headSha: pullRequest === 1 ? reviewed : clean,
    }));
    vi.mocked(reader.readReviewInputs).mockResolvedValue(inputs);
    vi.mocked(reader.readChecks).mockImplementation(async (_target, sha) => [
      { name: "CI", outcome: "passed", sha },
    ]);
    await worker(() => stop.abort(), {
      config: {
        targets,
        requiredChecks: new Map([
          ["owner/one#1", ["CI"]],
          ["owner/two#2", ["CI"]],
        ]),
        reconcileIntervalMs: interval,
      },
    });
    expect(workerStatus(store).pullRequests).toMatchObject([
      { state: "review_findings", attention: "review_findings" },
      { state: "ready_for_human" },
    ]);
    expect(store.findWorkflow(first.repository, 1)).toMatchObject({
      requiredChecks: ["CI"],
      checks: [{ name: "CI", outcome: "passed", sha: reviewed }],
    });
    using db = new DatabaseSync(path, { readOnly: true });
    expect(db.prepare("SELECT COUNT(*) AS count FROM agent_executions").get()?.count).toBe(0);
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "drains the CLI on foreground process-group %s without interrupting an in-flight child",
    async (signal) => {
      const configPath = join(root, "config.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          repositories: [{ repository: "owner/one", installationId: 1, pullRequests: [1] }],
        }),
      );
      const keyPath = join(root, "app.pem");
      const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
      writeFileSync(keyPath, privateKey.export({ format: "pem", type: "pkcs8" }));
      const mockPath = join(root, "github.mjs");
      writeFileSync(
        mockPath,
        `
        import { spawn } from "node:child_process";
        import { once } from "node:events";
        globalThis.fetch = async (url) => {
          if (url.pathname.endsWith("/access_tokens"))
            return Response.json({token:"fixture", expires_at:"2099-01-01T00:00:00Z"}, {status:201});
          const active = spawn(process.execPath, ["-e", "process.stdin.resume()"], {stdio:["pipe", "ignore", "inherit"]});
          const exit = once(active, "close");
          process.once("disconnect", () => active.stdin.end());
          console.log(JSON.stringify({event:"fixture_child_started"}));
          const [code, signal] = await exit;
          console.log(JSON.stringify({event:"fixture_child_finished", code, signal}));
          return Response.json({number:1, state:"closed", head:{sha:"${oldHead}"}});
        };
      `,
      );
      const launcher = spawn(
        process.execPath,
        ["--import", mockPath, "src/main.ts", "--worker", configPath],
        {
          detached: true,
          stdio: ["ignore", "pipe", "inherit"],
          env: {
            ...process.env,
            SWITCHYARD_DB_PATH: path,
            GITHUB_APP_CLIENT_ID: "fixture",
            GITHUB_APP_PRIVATE_KEY_PATH: keyPath,
          },
        },
      );
      const exited = once(launcher, "exit");
      const events = [];
      for await (const line of createInterface({ input: launcher.stdout })) {
        const entry = JSON.parse(line);
        events.push(entry);
        if (entry.event === "fixture_child_started") process.kill(-launcher.pid!, signal);
      }
      expect(await exited).toEqual([0, null]);
      expect(events).toContainEqual({ event: "fixture_child_finished", code: 0, signal: null });
      expect(events).toContainEqual(expect.objectContaining({ event: "poll_interrupted" }));
      expect(workerStatus(store)).toMatchObject({ state: "stopped" });
    },
  );

  it("blocks a competing process, then takes over after its owner exits without cleanup", async () => {
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
      await expect(worker(() => stop.abort())).rejects.toThrow(/already owns/);
      expect(reader.readPullRequest).not.toHaveBeenCalled();
      child.stdin.end();
      await closed;
      expect(workerStatus(store)).toMatchObject({ state: "interrupted" });
      await worker(() => stop.abort());
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

  it("accepts per-PR required checks and rejects invalid entries", () => {
    const configPath = join(root, "config.json");
    const repositories = targets.map(({ repository, installationId, pullRequest }) => ({
      repository,
      installationId,
      pullRequests: [pullRequest],
    }));
    const load = (requiredChecks?: unknown) => {
      writeFileSync(configPath, JSON.stringify({ repositories, requiredChecks }));
      return loadConfig(configPath);
    };
    expect(load().requiredChecks.size).toBe(0);
    expect(load({ "owner/one#1": ["CI"] }).requiredChecks).toEqual(
      new Map([["owner/one#1", ["CI"]]]),
    );
    expect(() => load({ "owner/one#9": ["CI"] })).toThrow(/configured/);
    for (const names of [[], [""], ["CI", "CI"], ["CI", 1]])
      expect(() => load({ "owner/one#1": names })).toThrow(/unique names/);
  });
});
