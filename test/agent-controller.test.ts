import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentAdapter, AgentSession } from "../src/agent.ts";
import { createAgentController } from "../src/agent-controller.ts";
import type { AgentOperationWorker, AgentSessionCheckpoint } from "../src/agent-operation.ts";
import { codexConfigFingerprint, codexSessionCheckpoint } from "../src/codex-runtime.ts";
import { createController } from "../src/controller.ts";
import { createLocalAgentExecution } from "../src/local-agent-execution.ts";
import { WorkflowStore } from "../src/store.ts";
import { createWorktreeManager } from "../src/worktree.ts";
import { agentRepository, git } from "./fixtures/agent-repository.ts";
import { removeDurableAgentMigration } from "./fixtures/legacy-schema.ts";

const runtime = {
  provider: "fixture",
  model: "fixture-model",
  sdkVersion: "1",
  cliVersion: "1",
  home: "/fixture",
  configuration: "policy",
};
const reference = { provider: runtime.provider, id: "fixture-thread" };

describe("durable agent controller", () => {
  let fixture: ReturnType<typeof agentRepository>;
  let store: WorkflowStore;
  let requests: AgentOperationWorker;
  let runTurn: ReturnType<typeof vi.fn<AgentSession["runTurn"]>>;
  let startSession: ReturnType<typeof vi.fn<AgentAdapter["startSession"]>>;
  let resumeSession: ReturnType<typeof vi.fn<AgentAdapter["resumeSession"]>>;
  let sessionCheckpoint: ReturnType<
    typeof vi.fn<(id: string, path: string) => AgentSessionCheckpoint>
  >;

  beforeEach(() => {
    fixture = agentRepository();
    store = new WorkflowStore(fixture.db);
    store.createWorkflow(fixture.workflow);
    runTurn = vi.fn(async () => ({ outcome: "completed", response: "untrusted output" }));
    startSession = vi.fn(({ workingDirectory }: { workingDirectory: string }) => ({
      reference,
      runTurn: async (turn: Parameters<AgentSession["runTurn"]>[0]) => {
        turn.onEvent?.({ kind: "session_started", provider: reference.provider, data: {} });
        writeFileSync(join(workingDirectory, "tracked.txt"), "agent edit");
        return runTurn(turn);
      },
    }));
    resumeSession = vi.fn(() => ({ reference, runTurn }));
    sessionCheckpoint = vi.fn(() => ({ identity: "rollout", digest: "session-witness" }));
    requests = worker();
  });

  afterEach(() => {
    store.close();
    rmSync(fixture.root, { recursive: true, force: true });
  });

  function worker(): AgentOperationWorker {
    return {
      configurationId: "fixture-config",
      runtime: () => runtime,
      ...createLocalAgentExecution(
        createWorktreeManager({
          repositoryDirectory: fixture.repo,
          worktreeRoot: fixture.worktrees,
        }),
        { startSession, resumeSession },
        sessionCheckpoint,
      ),
    };
  }

  function reopen(): void {
    store.close();
    store = new WorkflowStore(fixture.db);
    requests = worker();
  }

  function followUp() {
    return { ...fixture.request, operationId: "follow-up", prompt: "Continue in place." };
  }

  async function start() {
    const controller = createAgentController(store, requests);
    const first = await controller.runTurn(fixture.request);
    expect(first).toMatchObject({ status: "completed", error: null });
    expect(first.evidence?.reference?.agent).toEqual(reference);
    return first.evidence!.reference!.worktree.path;
  }

  it("upgrades the Phase 2 schema while retaining existing rows and legacy operation recovery", () => {
    store.createOperation("legacy", fixture.workflow.id, "agent_turn", { value: "preserve" });
    store.close();
    const db = new DatabaseSync(fixture.db);
    removeDurableAgentMigration(db);
    db.prepare(
      "INSERT INTO agent_sessions (workflow_id, session_id) VALUES (?, 'legacy-thread')",
    ).run(fixture.workflow.id);
    db.close();
    store = new WorkflowStore(fixture.db);
    expect(store.getWorkflow(fixture.workflow.id)).toEqual(fixture.workflow);
    expect(store.agentOperations().session(fixture.workflow.id)).toBeNull();
    expect(store.recover().ambiguousOperations).toBe(1);
    const reader = new DatabaseSync(fixture.db);
    expect(reader.prepare("SELECT session_id FROM agent_sessions").get()?.session_id).toBe(
      "legacy-thread",
    );
    expect(
      reader.prepare("SELECT input FROM operations WHERE operation_id='legacy'").get()?.input,
    ).toBe('{"value":"preserve"}');
    reader.close();
  });

  it("reports pre-ownership claims for inspection and preserves their unresolved state", () => {
    const controller = createAgentController(store, requests);
    const { operationId } = controller.request(fixture.request).intent;
    store.agentOperations().claim(operationId);
    store.agentOperations().start(operationId, runtime);
    const db = new DatabaseSync(fixture.db);
    try {
      db.prepare("UPDATE operations SET owner_pid=NULL WHERE operation_id=?").run(operationId);
    } finally {
      db.close();
    }
    reopen();
    expect(store.recover()).toEqual({
      deliveries: 0,
      ambiguousOperations: 0,
      unverifiedAgentOperations: [operationId],
    });
    expect(store.agentOperations().get(operationId)?.status).toBe("running");
    expect(() => createAgentController(store, requests).request(followUp())).toThrow(
      "unresolved agent operation",
    );
    expect(startSession).not.toHaveBeenCalled();
  });

  it("holds a preview session with a checkpoint that predates verified rollout selection", async () => {
    await start();
    const db = new DatabaseSync(fixture.db);
    try {
      db.prepare(
        "UPDATE agent_sessions SET execution=json_set(execution, '$.checkpoint.session', 'legacy-digest') WHERE workflow_id=?",
      ).run(fixture.workflow.id);
    } finally {
      db.close();
    }
    reopen();
    expect(await createAgentController(store, requests).runTurn(followUp())).toMatchObject({
      status: "manual_reconciliation",
      error: "The saved checkpoint predates verified rollout selection and requires inspection.",
    });
    expect(resumeSession).not.toHaveBeenCalled();
  });

  it("leaves an undispatched request retryable across restart and fails closed on a conflicting request", async () => {
    const controller = createAgentController(store, requests);
    expect(controller.request(fixture.request).status).toBe("requested");
    expect(store.agentOperations().session(fixture.workflow.id)).toBeNull();
    expect(startSession).not.toHaveBeenCalled();
    reopen();
    expect(store.recover().ambiguousOperations).toBe(0);
    const restarted = createAgentController(store, requests);
    expect(() => restarted.request({ ...fixture.request, prompt: "different" })).toThrow(
      "different request",
    );
    expect(() =>
      createAgentController(store, { ...requests, configurationId: "different" }).request(
        fixture.request,
      ),
    ).toThrow("different request");
    expect(() => restarted.request(followUp())).toThrow("unresolved agent operation");
    await start();
    const binding = store.agentOperations().session(fixture.workflow.id);
    expect(binding).toMatchObject({
      initialOperationId: fixture.request.operationId,
      lastOperationId: fixture.request.operationId,
      status: "active",
      baseHead: fixture.request.expectedHead,
      runtime,
    });
    const result = await restarted.runTurn(fixture.request);
    expect(result.status).toBe("completed");
    expect(result.intent).not.toHaveProperty("prompt");
    expect(startSession).toHaveBeenCalledTimes(1);
  });

  it("excludes duplicate dispatch and preserves the outcome when a second process runs startup recovery", async () => {
    let complete!: (result: Awaited<ReturnType<AgentSession["runTurn"]>>) => void;
    runTurn.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const first = createAgentController(store, requests).runTurn(fixture.request);
    const secondStore = new WorkflowStore(fixture.db);
    try {
      const second = createAgentController(secondStore, worker());
      expect(await second.runTurn(fixture.request)).toMatchObject({ status: "running" });
      expect(() => second.request(followUp())).toThrow("unresolved agent operation");
      expect(
        secondStore.agentOperations().get(fixture.request.operationId)?.evidence?.reference?.agent,
      ).toEqual(reference);
      const recovery = spawnSync(process.execPath, ["src/main.ts", "--recover"], {
        env: { ...process.env, SWITCHYARD_DB_PATH: fixture.db },
        encoding: "utf8",
      });
      expect(recovery.stderr).toBe("");
      expect(recovery.status).toBe(0);
      expect(JSON.parse(recovery.stdout)).toEqual({ deliveries: 0, ambiguousOperations: 0 });
      expect(secondStore.agentOperations().get(fixture.request.operationId)?.status).toBe(
        "running",
      );
      complete({ outcome: "completed", response: "done" });
      expect(await first).toMatchObject({
        status: "completed",
        evidence: { agent: { outcome: "completed" }, workspace: { changedPaths: ["tracked.txt"] } },
      });
      expect(runTurn).toHaveBeenCalledTimes(1);
    } finally {
      secondStore.close();
    }
  });

  it("recovers an owner that exits after the poller starts without resetting the webhook inbox", async () => {
    const script = `
      import { WorkflowStore } from "./src/store.ts";
      const [db, intent, runtime] = process.argv.slice(1);
      const operations = new WorkflowStore(db).agentOperations();
      const { operationId } = operations.request(JSON.parse(intent)).intent;
      operations.claim(operationId);
      operations.start(operationId, JSON.parse(runtime));
      process.send("ready");
      setInterval(() => {}, 1000);
    `;
    const request = fixture.request;
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        script,
        fixture.db,
        JSON.stringify({
          ...request,
          configurationId: "fixture-config",
          promptDigest: "fixture-digest",
        }),
        JSON.stringify(runtime),
      ],
      { stdio: ["ignore", "ignore", "inherit", "ipc"] },
    );
    const exited = once(child, "exit");
    const reportError = vi.fn();
    const poller = createController({
      store,
      targets: [],
      reconcile: vi.fn(),
      reportError,
      reconcileIntervalMs: 0,
    });
    try {
      const [message] = await Promise.race([once(child, "message"), exited]);
      expect(message).toBe("ready");
      expect(store.recover().ambiguousOperations).toBe(0);
      expect(await poller.runPass()).toBe(true);
      expect(store.agentOperations().get(request.operationId)?.status).toBe("running");

      store.receiveDelivery("processing-fixture", {});
      expect(store.claimDelivery("processing-fixture")).toBe(true);
      child.kill("SIGKILL");
      await exited;
      expect(await poller.runPass()).toBe(true);
      expect(store.agentOperations().get(request.operationId)?.status).toBe("unknown");
      expect(store.getWorkflow(fixture.workflow.id)?.state).toBe("escalated");
      expect(store.deliveryStatus("processing-fixture")?.status).toBe("processing");
      expect(reportError).toHaveBeenCalledOnce();
    } finally {
      child.kill("SIGKILL");
      await exited;
    }
  });

  it("invalidates undispatched requests after a close and reopen even at the same head", async () => {
    const controller = createAgentController(store, requests);
    controller.request(fixture.request);
    for (const state of ["closed", "open"] as const)
      store.transition(fixture.workflow.id, {
        type: "github_pull_request",
        state,
        sha: fixture.workflow.headSha,
      });
    expect(await controller.runTurn(fixture.request)).toMatchObject({
      status: "completed",
      error: "Workflow authorization changed before dispatch.",
    });
    expect(startSession).not.toHaveBeenCalled();
    await expect(controller.runTurn(followUp())).resolves.toMatchObject({
      status: "completed",
      error: null,
    });
  });

  it("records the validated same-session continuation and moves an exact-head fix to validating", async () => {
    const path = await start();
    reopen();
    expect(store.recover().ambiguousOperations).toBe(0);
    store.transition(fixture.workflow.id, {
      type: "review_received",
      evidence: { sha: fixture.workflow.headSha, outcome: "completed_with_findings" },
    });
    const second = await createAgentController(store, requests).runTurn(followUp());
    expect(second).toMatchObject({ status: "completed", error: null });
    expect(second.evidence?.reference?.worktree.path).toBe(path);
    expect(resumeSession).toHaveBeenCalledWith({ workingDirectory: path }, reference);
    expect(store.getWorkflow(fixture.workflow.id)).toMatchObject({
      state: "validating",
      validationHeadSha: fixture.workflow.headSha,
    });
    expect(store.agentOperations().session(fixture.workflow.id)?.lastOperationId).toBe("follow-up");
  });

  it.each([
    [
      "modified bytes at the same dirty path",
      (path: string) => writeFileSync(join(path, "tracked.txt"), "different edit"),
      "Worktree changed",
    ],
    [
      "missing checkout",
      (path: string) => git(path, "worktree", "remove", "--force", path),
      "registered repository",
    ],
    [
      "replacement at the same path and head",
      (path: string) => {
        git(path, "worktree", "remove", "--force", path);
        git(fixture.repo, "worktree", "add", path, fixture.request.branch);
      },
      "different linked checkout",
    ],
    [
      "branch mismatch",
      (path: string) => git(path, "switch", "-c", "feat/different"),
      "different branch",
    ],
    [
      "head mismatch",
      (path: string) =>
        git(
          path,
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit",
          "--allow-empty",
          "-m",
          "move head",
        ),
      "different commit",
    ],
  ])("holds a continuation after %s", async (_case, mutate, error) => {
    const path = await start();
    mutate(path);
    reopen();
    const second = await createAgentController(store, requests).runTurn(followUp());
    expect(second.status).toBe("manual_reconciliation");
    expect(second.error).toContain(error);
    expect(resumeSession).not.toHaveBeenCalled();
    expect(store.agentOperations().session(fixture.workflow.id)?.status).toBe("held");
    expect(store.getWorkflow(fixture.workflow.id)?.state).toBe("escalated");
  });

  it.each(["missing session", "changed session", "runtime mismatch", "missing credentials"])(
    "holds a continuation after %s before dispatching Codex",
    async (scenario) => {
      await start();
      reopen();
      if (scenario === "missing session")
        sessionCheckpoint.mockImplementationOnce(() => {
          throw new Error("Codex session is missing.");
        });
      if (scenario === "changed session")
        sessionCheckpoint.mockReturnValueOnce({ identity: "rollout", digest: "different-witness" });
      if (scenario === "runtime mismatch")
        requests.runtime = () => ({ ...runtime, cliVersion: "2" });
      if (scenario === "missing credentials")
        requests.runtime = () => {
          throw new Error("Codex credentials are missing or inaccessible.");
        };
      const second = await createAgentController(store, requests).runTurn(followUp());
      expect(second.status).toBe("manual_reconciliation");
      expect(second.error).toMatch(/missing|changed|incompatible/);
      expect(startSession).toHaveBeenCalledTimes(1);
      expect(resumeSession).not.toHaveBeenCalled();
    },
  );

  it.each(["interrupted", "unknown", "failed"] as const)(
    "records %s evidence and blocks a clean-looking retry",
    async (outcome) => {
      runTurn.mockResolvedValueOnce({ outcome, reason: "No safe continuation." });
      const operation = await createAgentController(store, requests).runTurn(fixture.request);
      expect(operation.status).toBe(outcome === "failed" ? "completed" : outcome);
      expect(operation.evidence).toMatchObject({
        reference: { agent: reference },
        agent: { outcome },
        workspace: { head: fixture.request.expectedHead, changedPaths: ["tracked.txt"] },
      });
      reopen();
      expect((await createAgentController(store, requests).runTurn(fixture.request)).status).toBe(
        operation.status,
      );
      expect(() => createAgentController(store, requests).request(followUp())).toThrow(
        "not eligible",
      );
    },
  );

  it("rejects launch authorization revoked by another connection during resume preflight", async () => {
    await start();
    const reconciler = new WorkflowStore(fixture.db);
    try {
      sessionCheckpoint.mockImplementationOnce(() => {
        reconciler.transition(fixture.workflow.id, { type: "head_changed", sha: "a".repeat(40) });
        return { identity: "rollout", digest: "session-witness" };
      });
      const second = await createAgentController(store, requests).runTurn(followUp());
      expect(second).toMatchObject({
        status: "manual_reconciliation",
        error: "Workflow authorization changed before the agent launched.",
      });
      expect(second.evidence).not.toHaveProperty("launchAuthorizedAt");
      expect(resumeSession).not.toHaveBeenCalled();
      expect(runTurn).toHaveBeenCalledTimes(1);
    } finally {
      reconciler.close();
    }
  });

  it("rejects staging an empty intent-to-add file between turns", async () => {
    runTurn.mockImplementationOnce(async () => {
      const path = startSession.mock.calls[0]![0].workingDirectory;
      writeFileSync(join(path, "empty.txt"), "");
      git(path, "add", "-N", "empty.txt");
      return { outcome: "completed", response: "done" };
    });
    const path = await start();
    const originalIndexEntries = git(path, "ls-files", "--stage");
    git(path, "add", "empty.txt");
    expect(git(path, "ls-files", "--stage")).toBe(originalIndexEntries);
    expect(await createAgentController(store, requests).runTurn(followUp())).toMatchObject({
      status: "manual_reconciliation",
      error: "Worktree changed since the previous agent operation.",
    });
    expect(resumeSession).not.toHaveBeenCalled();
  });

  it("rejects a changed system-level model provider before continuation", async () => {
    const system = join(fixture.root, "system-codex");
    mkdirSync(system);
    const file = join(system, "config.toml");
    writeFileSync(file, 'model_provider = "original"');
    const configuration = () => codexConfigFingerprint(fixture.root, system);
    requests.runtime = () => ({ ...runtime, configuration: configuration() });
    await start();
    writeFileSync(file, 'model_provider = "replacement"');
    expect(await createAgentController(store, requests).runTurn(followUp())).toMatchObject({
      status: "manual_reconciliation",
      error: "Recorded agent runtime or session is incompatible with continuation.",
    });
    expect(resumeSession).not.toHaveBeenCalled();
  });

  it.each(["before launch", "after launch"])(
    "holds when the state database selects a different rollout %s",
    async (when) => {
      const threadId = "00000000-0000-4000-8000-000000000001";
      const home = join(fixture.root, "codex");
      mkdirSync(home);
      const state = new DatabaseSync(join(home, "state_5.sqlite"));
      try {
        state.exec(
          "CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT, archived INTEGER)",
        );
        const selectRollout = state.prepare("INSERT OR REPLACE INTO threads VALUES (?, ?, 0)");
        let secondPath: string;
        sessionCheckpoint.mockImplementationOnce((_id, workingDirectory) => {
          function createRollout(day: string) {
            const directory = join(home, "sessions", "2026", "11", day);
            mkdirSync(directory, { recursive: true });
            const path = join(directory, `rollout-2026-11-${day}-${threadId}.jsonl`);
            writeFileSync(
              path,
              JSON.stringify({
                type: "session_meta",
                payload: { id: threadId, cwd: workingDirectory },
              }) + "\n",
            );
            return path;
          }
          const firstPath = createRollout("19");
          secondPath = createRollout("20");
          selectRollout.run(threadId, firstPath);
          return codexSessionCheckpoint(home, threadId, workingDirectory);
        });
        await start();
        sessionCheckpoint.mockImplementation((_id, directory) =>
          codexSessionCheckpoint(home, threadId, directory),
        );
        if (when === "before launch") selectRollout.run(threadId, secondPath!);
        else
          runTurn.mockImplementationOnce(async () => {
            selectRollout.run(threadId, secondPath!);
            return { outcome: "completed", response: "done" };
          });
        expect(await createAgentController(store, requests).runTurn(followUp())).toMatchObject({
          status: "manual_reconciliation",
          error:
            when === "before launch"
              ? "Agent session changed since the previous operation."
              : "Codex selected a different rollout during the turn.",
        });
        expect(runTurn).toHaveBeenCalledTimes(when === "before launch" ? 1 : 2);
        expect(store.agentOperations().session(fixture.workflow.id)?.status).toBe("held");
      } finally {
        state.close();
      }
    },
  );

  it("does not advance a fix to validation when the PR changes during execution", async () => {
    await start();
    store.transition(fixture.workflow.id, {
      type: "review_received",
      evidence: { sha: fixture.workflow.headSha, outcome: "completed_with_findings" },
    });
    runTurn.mockImplementationOnce(async () => {
      store.transition(fixture.workflow.id, { type: "head_changed", sha: "a".repeat(40) });
      return { outcome: "completed", response: "done" };
    });
    const second = await createAgentController(store, requests).runTurn(followUp());
    expect(second.status).toBe("manual_reconciliation");
    expect(second.error).toContain("authorization changed");
    expect(store.getWorkflow(fixture.workflow.id)).toMatchObject({
      state: "escalated",
      validationHeadSha: null,
      headSha: "a".repeat(40),
    });
  });

  it.each(["dispatching", "checkout", "running", "returned"] as const)(
    "never repeats an operation when a child process dies at the %s boundary",
    async (boundary) => {
      const marker = join(fixture.root, "external-side-effect");
      const script = `
        import { writeFileSync } from "node:fs";
        import { createAgentController } from "./src/agent-controller.ts";
        import { WorkflowStore } from "./src/store.ts";
        import { createWorktreeManager } from "./src/worktree.ts";
        import { createLocalAgentExecution } from "./src/local-agent-execution.ts";
        const [db, request, runtime, boundary, marker, repositoryDirectory, worktreeRoot] = process.argv.slice(1);
        const store = new WorkflowStore(db);
        if (boundary === "returned") {
          const repo = store.agentOperations();
          repo.finish = () => process.kill(process.pid, "SIGKILL");
          store.agentOperations = () => repo;
        }
        const controller = createAgentController(store, {
          configurationId: "fixture-config",
          runtime() {
            if (boundary === "dispatching") process.kill(process.pid, "SIGKILL");
            return JSON.parse(runtime);
          },
          async execute(input) {
            if (boundary === "checkout") {
              const manager = createWorktreeManager({repositoryDirectory, worktreeRoot});
              const unavailable = () => { throw new Error("Unexpected agent launch."); };
              const worker = createLocalAgentExecution(manager, {
                startSession: () => ({ reference: null, runTurn: unavailable }),
                resumeSession: unavailable,
              }, unavailable);
              return worker.execute({
                ...input,
                recordWorkspace: () => process.kill(process.pid, "SIGKILL"),
              });
            }
            writeFileSync(marker, "external side effect");
            if (boundary === "running") process.kill(process.pid, "SIGKILL");
            return { agent: { outcome: "completed" } };
          },
        });
        await controller.runTurn(JSON.parse(request));
      `;
      const child = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          script,
          fixture.db,
          JSON.stringify(fixture.request),
          JSON.stringify(runtime),
          boundary,
          marker,
          fixture.repo,
          fixture.worktrees,
        ],
        { encoding: "utf8" },
      );
      expect(child.stderr).toBe("");
      expect(child.signal).toBe("SIGKILL");
      expect(Boolean(lstatSync(marker, { throwIfNoEntry: false }))).toBe(
        boundary === "running" || boundary === "returned",
      );
      reopen();
      expect(store.recover().ambiguousOperations).toBe(1);
      const operation = store.agentOperations().get(fixture.request.operationId);
      expect(operation?.status).toBe("unknown");
      if (boundary === "checkout") {
        const locator = operation?.evidence?.expectedWorktree;
        expect(locator).toMatchObject({
          branch: fixture.request.branch,
          workflowId: fixture.workflow.id,
        });
        expect(operation?.evidence?.worktree).toBeUndefined();
        expect(lstatSync(locator!.path).isDirectory()).toBe(true);
        expect(git(locator!.path, "rev-parse", "HEAD")).toBe(fixture.workflow.headSha);
      }
      expect(store.agentOperations().session(fixture.workflow.id)?.status).toBe("held");
      expect(store.getWorkflow(fixture.workflow.id)?.state).toBe("escalated");
      expect(store.recover().ambiguousOperations).toBe(0);
      expect((await createAgentController(store, requests).runTurn(fixture.request)).status).toBe(
        "unknown",
      );
      expect(startSession).not.toHaveBeenCalled();
    },
  );
});
