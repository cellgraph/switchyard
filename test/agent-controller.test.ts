import { spawnSync } from "node:child_process";
import { lstatSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentAdapter, AgentSession } from "../src/agent.ts";
import { createAgentController } from "../src/agent-controller.ts";
import type { AgentOperationWorker } from "../src/agent-operation.ts";
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
  let sessionCheckpoint: ReturnType<typeof vi.fn<(id: string, path: string) => string>>;

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
    sessionCheckpoint = vi.fn(() => "session-witness");
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

  it("excludes duplicate dispatch across independent SQLite connections while a turn is in flight", async () => {
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
      complete({ outcome: "completed", response: "done" });
      expect((await first).status).toBe("completed");
      expect(runTurn).toHaveBeenCalledTimes(1);
    } finally {
      secondStore.close();
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
        sessionCheckpoint.mockReturnValueOnce("different-witness");
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

  it.each(["dispatching", "running", "returned"] as const)(
    "never repeats an operation when a child process dies at the %s boundary",
    async (boundary) => {
      const marker = join(fixture.root, "external-side-effect");
      const script = `
        import { writeFileSync } from "node:fs";
        import { createAgentController } from "./src/agent-controller.ts";
        import { WorkflowStore } from "./src/store.ts";
        const [db, request, runtime, boundary, marker] = process.argv.slice(1);
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
          async execute() {
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
        ],
        { encoding: "utf8" },
      );
      expect(child.stderr).toBe("");
      expect(child.signal).toBe("SIGKILL");
      expect(Boolean(lstatSync(marker, { throwIfNoEntry: false }))).toBe(
        boundary !== "dispatching",
      );
      reopen();
      expect(store.recover().ambiguousOperations).toBe(1);
      expect(store.agentOperations().get(fixture.request.operationId)?.status).toBe("unknown");
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
