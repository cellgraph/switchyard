import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, parseFixConfig } from "../src/config.ts";
import type { GitHubReader } from "../src/github-api.ts";
import { GitHubTransientError } from "../src/github-app.ts";
import { WorkflowStore } from "../src/store.ts";
import { runUnattended, workerStatus } from "../src/unattended.ts";

const first = { repository: "owner/one", pullRequest: 1, installationId: 1 };
const second = { repository: "owner/two", pullRequest: 2, installationId: 2 };
const targets = [first, second];
const oldHead = "a".repeat(40);
const newHead = "b".repeat(40);
const interval = 10_000;

function exampleFix(root: string) {
  return parseFixConfig({
    repositoryDirectory: root,
    worktreeRoot: root,
    codexHome: root,
    model: "fixture",
    localBranch: "fix/one",
    allowedPaths: ["src/"],
    requiredChecks: ["CI"],
    validation: [{ id: "test", argv: ["npm", "test"] }],
  });
}

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
      config: { targets, fixes: new Map(), reconcileIntervalMs: interval },
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

  it("defers advancement when the head changes during evidence collection", async () => {
    const advance = vi.fn();
    const fixes = new Map([["owner/one#1", exampleFix(root)]]);
    vi.mocked(reader.readPullRequest)
      .mockResolvedValueOnce({ state: "open", headSha: oldHead })
      .mockResolvedValueOnce({ state: "open", headSha: newHead });
    await worker(() => stop.abort(), {
      config: { targets, fixes, reconcileIntervalMs: interval },
      advance,
    });
    expect(advance).not.toHaveBeenCalled();
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

  it("finishes an in-flight read and starts neither advancement nor another target after shutdown", async () => {
    vi.mocked(reader.readPullRequest).mockImplementationOnce(async () => {
      stop.abort();
      return { state: "open", headSha: oldHead };
    });
    const advance = vi.fn();
    await worker(
      () => {
        throw new Error("Shutdown must skip the polling delay.");
      },
      {
        advance,
        config: {
          targets,
          fixes: new Map([["owner/one#1", exampleFix(root)]]),
          reconcileIntervalMs: interval,
        },
      },
    );
    expect(advance).not.toHaveBeenCalled();
    expect(reader.completeReconciliation).toHaveBeenCalledWith(first);
    expect(reader.completeReconciliation).not.toHaveBeenCalledWith(second);
    expect(workerStatus(store)).toMatchObject({
      state: "stopped",
      pullRequests: [{ state: "awaiting_review" }, { state: "unobserved" }],
    });
  });

  it("identifies invalid checkout configuration and keeps polling the other PRs", async () => {
    await worker(() => stop.abort(), {
      config: {
        targets,
        fixes: new Map([["owner/one#1", exampleFix(root)]]),
        reconcileIntervalMs: interval,
      },
    });
    expect(reader.completeReconciliation).toHaveBeenCalledWith(first);
    expect(reader.completeReconciliation).toHaveBeenCalledWith(second);
    expect(store.findWorkflow(second.repository, 2)).not.toBeNull();
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "target_failed",
        stage: "fix_advance",
        pullRequest: 1,
        outcome: "repository_checkout_unavailable",
        detail: expect.stringContaining("repositoryDirectory"),
      }),
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain(root);
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

  it("accepts per-PR fix config, preserves the single-PR form, and rejects out-of-scope settings", () => {
    const configPath = join(root, "config.json");
    const fix = exampleFix(root);
    const repository = (target: typeof first) => ({
      repository: target.repository,
      installationId: target.installationId,
      pullRequests: [target.pullRequest],
    });
    const load = (config: object) => {
      writeFileSync(configPath, JSON.stringify(config));
      return loadConfig(configPath);
    };
    expect(
      load({ repositories: targets.map(repository), fixes: { "owner/one#1": fix } }).fixes,
    ).toEqual(new Map([["owner/one#1", expect.objectContaining(fix)]]));
    expect(load({ repositories: [repository(first)], fix }).fixes.size).toBe(1);
    expect(() =>
      load({ repositories: targets.map(repository), fixes: { "owner/one#9": fix } }),
    ).toThrow(/configured/);
  });
});
