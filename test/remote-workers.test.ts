import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAgentController } from "../src/agent-controller.ts";
import type { AgentAdapter } from "../src/agent.ts";
import { createLocalAgentExecution } from "../src/local-agent-execution.ts";
import { createRemoteServer, remoteClient } from "../src/remote-http.ts";
import { remoteLeaseMs, type Capabilities, type RemoteTask } from "../src/remote-protocol.ts";
import { runRemoteWorker, type RemoteProfile } from "../src/remote-worker.ts";
import { WorkflowStore } from "../src/store.ts";
import { createWorktreeManager } from "../src/worktree.ts";
import { agentRepository } from "./fixtures/agent-repository.ts";

const codex = { provider: "codex", model: "codex-fixture" } as const;
const claude = { provider: "claude-code", model: "claude-fixture" } as const;
const token = "f".repeat(64);
const spareToken = "4".repeat(64);
const signature = (value: string) => createHash("sha256").update(value).digest();
const checkpoint = { identity: "fake-transcript", digest: "b".repeat(64) };

let fixture: ReturnType<typeof agentRepository>;
let store: WorkflowStore;
let now: number;
let openServer: Server | undefined;
const remote = () => store.remoteWorkers(() => now);

function runtime(profile = codex as typeof codex | typeof claude) {
  return {
    ...profile,
    sdkVersion: "1",
    cliVersion: "1",
    home: "/worker/profile",
    configuration: "fixture",
  };
}

function caps(profile = codex as typeof codex | typeof claude): Capabilities {
  return {
    platform: "darwin",
    architecture: "arm64",
    concurrency: 1,
    isolation: "linked-worktree",
    sandbox: "read-only",
    profiles: [{ ...profile, repository: "owner/repo" }],
  };
}

function workspace(task: RemoteTask) {
  return {
    path: "/worker/checkout",
    repository: "/worker/repo/.git",
    workflowId: task.intent.workflowId,
    branch: task.intent.branch,
  };
}

function enqueue(profile = codex as typeof codex | typeof claude, ms = 90_000) {
  return remote().enqueue(fixture.request, profile, ms);
}

function assign(profile = codex as typeof codex | typeof claude) {
  enqueue(profile);
  remote().register("mac", caps(profile));
  const instance = randomUUID();
  const task = remote().claim("mac", instance)!;
  const key = { instance, fence: task.fence, operationId: task.intent.operationId };
  const location = workspace(task);
  const checkout = { ...location, checkoutIdentity: "checkout-id" };
  const evidence = {
    agent: { outcome: "completed" as const },
    reference: { agent: { provider: profile.provider, id: "thread" }, worktree: checkout },
    workspace: { head: task.intent.expectedHead, changedPaths: [] },
    checkpoint: { workspace: "1".repeat(64), session: checkpoint },
  };
  return { task, key, location, checkout, evidence };
}

async function listen() {
  const server = createRemoteServer(
    remote(),
    new Map([
      ["mac", signature(token)],
      ["other", signature(spareToken)],
    ]),
    (error) => {
      throw error;
    },
  );
  openServer = server;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return new URL("http://127.0.0.1:" + (server.address() as AddressInfo).port);
}

async function stopServer() {
  if (!openServer) return;
  const closed = once(openServer, "close");
  openServer.close();
  openServer.closeAllConnections();
  await closed;
  openServer = undefined;
}

beforeEach(() => {
  fixture = agentRepository();
  store = new WorkflowStore(fixture.db);
  store.createWorkflow(fixture.workflow);
  now = Date.now();
});

afterEach(async () => {
  await stopServer();
  store.close();
  rmSync(fixture.root, { recursive: true, force: true });
});

it("authenticates registered principals and rejects token reuse across worker IDs", async () => {
  const url = await listen();
  const mac = remoteClient(url, "mac", token);
  const impersonator = remoteClient(url, "other", token);
  await expect(impersonator("register", { capabilities: caps() })).rejects.toMatchObject({
    status: 401,
  });
  await expect(mac("claim", { instance: randomUUID() })).rejects.toMatchObject({ status: 409 });
  await expect(
    mac("register", { capabilities: { ...caps(), concurrency: 2 } }),
  ).rejects.toMatchObject({ status: 400 });
  await expect(mac("register", { capabilities: caps() })).resolves.toEqual({ registered: true });
  expect(remote().status().workers).toMatchObject([
    { id: "mac", online: true, capabilities: caps() },
  ]);
  enqueue();
  const instance = randomUUID();
  const { task } = await mac<{ task: RemoteTask }>("claim", { instance });
  expect(task.intent.remote).toMatchObject(codex);
  const other = remoteClient(url, "other", spareToken);
  await other("register", { capabilities: caps() });
  await expect(
    other("renew", { instance, operationId: task.intent.operationId, fence: task.fence }),
  ).rejects.toMatchObject({ status: 409 });
});

it("waits for matching model, provider and repository and claims only once", () => {
  enqueue(claude);
  remote().register("codex", caps());
  remote().register("wrong", {
    ...caps(claude),
    profiles: [
      { ...claude, repository: "owner/other" },
      { ...claude, repository: "owner/repo", model: "another-model" },
    ],
  });
  expect(remote().claim("codex", randomUUID())).toBeNull();
  expect(remote().claim("wrong", randomUUID())).toBeNull();
  expect(remote().status().turns[0]).toMatchObject({ waitingForCapacity: true });
  remote().register("claude", caps(claude));
  const instance = randomUUID();
  expect(remote().claim("claude", instance)?.intent.remote).toMatchObject(claude);
  expect(remote().claim("claude", instance)).toBeNull();
  expect(remote().claim("claude", randomUUID())).toBeNull();
  expect(enqueue(claude).status).toBe("dispatching");
  expect(() => enqueue(codex)).toThrow("different request");
  expect(remote().status().turns[0]).toMatchObject({
    workerId: "claude",
    waitingForCapacity: false,
  });
});

it("renews a lease across a controller restart and commits terminal evidence only once", () => {
  const { key, location, checkout, evidence } = assign();
  expect(remote().start("mac", key, runtime(), location)).toBe(true);
  expect(remote().launch("mac", key, checkout)).toBe(true);
  expect(() => remote().launch("mac", key, checkout)).toThrow("already granted");
  now += 20_000;
  expect(remote().renew("mac", key, evidence.reference)).toBe(true);
  store.close();
  store = new WorkflowStore(fixture.db);
  expect(store.recover().unverifiedAgentOperations).toBeUndefined();
  expect(store.agentOperations().get(key.operationId)?.evidence?.reference).toEqual(
    evidence.reference,
  );
  now += 20_000;
  expect(remote().renew("mac", key)).toBe(true);
  expect(remote().complete("mac", key, evidence)).toEqual({ status: "completed", error: false });
  expect(remote().complete("mac", key, evidence)).toBe("duplicate");
  expect(remote().complete("mac", key, { ...evidence, error: "conflicting" })).toBe("conflict");
  expect(store.agentOperations().session(fixture.workflow.id)).toMatchObject({
    status: "active",
    remoteWorkerId: "mac",
  });
  const next = { ...fixture.request, operationId: "follow-up" };
  remote().enqueue(next, codex, 90_000);
  remote().register("other", caps());
  expect(remote().claim("other", randomUUID())).toBeNull();
  expect(remote().claim("mac", randomUUID())?.previous?.lastOperationId).toBe(key.operationId);
});

it("fences a restarted worker and retains late evidence without replay after disconnection", () => {
  const { key, location, checkout, evidence } = assign();
  expect(remote().start("mac", key, runtime(), location)).toBe(true);
  expect(remote().launch("mac", key, checkout)).toBe(true);
  const restarted = randomUUID();
  remote().register("mac", caps());
  expect(remote().claim("mac", restarted)).toBeNull();
  expect(() => remote().renew("mac", { ...key, instance: restarted })).toThrow("fence");
  expect(() => remote().complete("mac", { ...key, fence: randomUUID() }, evidence)).toThrow(
    "fence",
  );
  now += remoteLeaseMs;
  expect(remote().renew("mac", key)).toBe(false);
  remote().expire();
  expect(remote().status()).toMatchObject({
    workers: [{ id: "mac", online: true, quarantined: true }],
    turns: [{ status: "unknown", disposition: "expired", lateEvidence: null }],
  });
  expect(remote().complete("mac", key, evidence)).toBe("expired");
  expect(remote().status().turns[0]).toMatchObject({ status: "unknown", lateEvidence: evidence });
  expect(store.getWorkflow(fixture.workflow.id)?.state).toBe("escalated");
  expect(store.agentOperations().session(fixture.workflow.id)?.status).toBe("held");
  expect(enqueue().status).toBe("unknown");
  expect(remote().claim("mac", restarted)).toBeNull();
});

it("caps renewal at the execution deadline and holds even a claim lost before launch", () => {
  enqueue(codex, 10_000);
  remote().register("mac", caps());
  const instance = randomUUID();
  const task = remote().claim("mac", instance)!;
  const key = { instance, fence: task.fence, operationId: task.intent.operationId };
  now += 9_000;
  expect(remote().renew("mac", key)).toBe(true);
  now += 1000;
  remote().expire();
  expect(remote().status().turns[0]).toMatchObject({
    status: "unknown",
    error: expect.stringContaining("deadline"),
  });
  expect(remote().start("mac", key, runtime(), workspace(task))).toBe(false);
});

it("requires explicit authorization and rechecks it at launch and completion", () => {
  remote().register("mac", caps());
  expect(remote().claim("mac", randomUUID())).toBeNull();
  expect(() =>
    remote().enqueue(
      { ...fixture.request, expectedPullRequestHead: "a".repeat(40) },
      codex,
      90_000,
    ),
  ).toThrow("heads must match");
  const { key, location, checkout, evidence } = assign();
  expect(remote().start("mac", key, runtime(), location)).toBe(true);
  store.transition(fixture.workflow.id, { type: "head_changed", sha: "a".repeat(40) });
  expect(() => remote().launch("mac", key, checkout)).toThrow("authorization changed");
  expect(remote().complete("mac", key, evidence)).toEqual({ status: "unknown", error: true });
  expect(store.agentOperations().session(fixture.workflow.id)?.status).toBe("held");
});

it("holds out-of-scope completion and preserves the distinction for a known failure", () => {
  const { key, location, checkout, evidence } = assign();
  expect(remote().start("mac", key, runtime(), location)).toBe(true);
  expect(remote().launch("mac", key, checkout)).toBe(true);
  expect(
    remote().complete("mac", key, {
      ...evidence,
      workspace: { ...evidence.workspace, changedPaths: ["tracked.txt"] },
    }),
  ).toEqual({ status: "manual_reconciliation", error: true });
  expect(store.agentOperations().session(fixture.workflow.id)?.status).toBe("held");
});

it("records a known provider failure without permitting another turn on the held session", () => {
  const { key, location, checkout } = assign();
  expect(remote().start("mac", key, runtime(), location)).toBe(true);
  expect(remote().launch("mac", key, checkout)).toBe(true);
  expect(
    remote().complete("mac", key, {
      agent: { outcome: "failed", reason: "Provider refused the request." },
    }),
  ).toEqual({ status: "completed", error: true });
  expect(store.agentOperations().session(fixture.workflow.id)?.status).toBe("held");
});

it.each([codex, claude])(
  "executes a $provider turn across HTTP in the existing isolated worktree",
  async (selected) => {
    const url = await listen();
    const manager = createWorktreeManager({
      repositoryDirectory: fixture.repo,
      worktreeRoot: fixture.worktrees,
    });
    const runTurn = vi.fn(async () => ({
      outcome: "completed" as const,
      response: "Read-only observation.",
    }));
    const session = { reference: { provider: selected.provider, id: "provider-session" }, runTurn };
    const agent: AgentAdapter = { startSession: () => session, resumeSession: () => session };
    const profile: RemoteProfile = {
      ...selected,
      repository: "owner/repo",
      locate: manager.locate,
      worker: {
        runtime: () => runtime(selected),
        configurationId: "fake-worker",
        ...createLocalAgentExecution(manager, agent, () => checkpoint, true),
      },
    };
    enqueue(selected);
    expect(store.agentOperations().claim(fixture.request.operationId)).toBeNull();
    const abort = new AbortController();
    const client = remoteClient(url, "mac", token);
    let resultRequests = 0;
    const log = vi.fn();
    const task = runRemoteWorker({
      capabilities: caps(selected),
      profiles: [profile],
      signal: abort.signal,
      async request<T>(action: string, body: unknown) {
        const result = await client<T>(action, body);
        if (action === "complete" && ++resultRequests === 1)
          throw new Error("Lost completion reply.");
        return result;
      },
      log(event) {
        log(event);
        if (event.event === "remote_completion") abort.abort();
      },
      pollMs: 5,
    });
    try {
      await vi.waitFor(() =>
        expect(log).toHaveBeenCalledWith(
          expect.objectContaining({ event: "remote_completion", result: "duplicate" }),
        ),
      );
    } finally {
      abort.abort();
      await task;
    }
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(store.agentOperations().get(fixture.request.operationId)).toMatchObject({
      status: "completed",
      error: null,
      evidence: {
        workspace: { head: fixture.request.expectedHead, changedPaths: [] },
      },
    });
    await expect(
      createAgentController(store, profile.worker).runTurn({
        ...fixture.request,
        operationId: "local-follow-up",
      }),
    ).rejects.toThrow("different execution location");
  },
);
