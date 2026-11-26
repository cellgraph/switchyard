import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAgentController } from "../src/agent-controller.ts";
import type { AgentResult, AgentTurn } from "../src/agent.ts";
import { WorkflowStore } from "../src/store.ts";
import { crashAfterSession, executionContext as context } from "./fixtures/execution.ts";

const assignment = { id: "first", assignmentId: "assignment-1", context, prompt: "private prompt" };
const success = {
  outcome: "completed",
  response: "private response",
  structuredOutput: { ok: true },
} as const;
const sqliteError = (errcode: number) =>
  Object.assign(new Error("fixture SQLite failure"), { code: "ERR_SQLITE_ERROR", errcode });
let dir: string;
let path: string;
let store: WorkflowStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "switchyard-agent-"));
  path = join(dir, "state.sqlite");
  store = new WorkflowStore(path);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

it("commits intent before dispatch, records the native session early and persists just the terminal metadata", async () => {
  const executions = store.agentExecutions();
  const other = new WorkflowStore(path);
  try {
    const inspect = other.agentExecutions();
    const execute = createAgentController(executions, () => ({
      async start(turn) {
        const record = inspect.get(assignment.id);
        expect(record).toMatchObject({ assignmentId: assignment.assignmentId, status: "running" });
        expect(inspect.session(record!.sessionId)).toMatchObject({ context, nativeId: null });
        expect(turn.prompt).toBe(assignment.prompt);
        turn.onSession("native-id");
        expect(inspect.session(record!.sessionId)?.nativeId).toBe("native-id");
        expect(inspect.recover()).toBe(0);
        return success;
      },
      resume: vi.fn(),
    })).execute;
    const run = await execute(assignment);
    expect(run).toMatchObject({
      execution: { status: "completed", reason: null, finishedAt: expect.any(String) },
      session: { nativeId: "native-id", context, placement: "local" },
      result: success,
    });
    expect(inspect.get(assignment.id)).toEqual(run.execution);
    using db = new DatabaseSync(path, { readOnly: true });
    const stored = JSON.stringify([
      db.prepare("SELECT * FROM agent_executions").all(),
      db.prepare("SELECT * FROM agent_sessions").all(),
    ]);
    for (const content of [assignment.prompt, success.response, "structuredOutput"])
      expect(stored).not.toContain(content);
    expect(db.prepare("SELECT COUNT(*) AS total FROM workflows").get()?.total).toBe(0);
  } finally {
    other.close();
  }
});

it("continues an explicit session across attempts while keeping other sessions independent", async () => {
  const start = vi.fn(async (turn: AgentTurn) => {
    turn.onSession("native-" + turn.prompt);
    return success;
  });
  const resume = vi.fn(async (id: string, turn: AgentTurn) => {
    turn.onSession(id);
    return success;
  });
  const execute = createAgentController(store.agentExecutions(), () => ({ start, resume })).execute;
  const first = await execute({ ...assignment, prompt: "one" });
  const independent = await execute({
    ...assignment,
    id: "independent",
    assignmentId: "assignment-2",
    prompt: "two",
  });
  const continued = await execute({
    id: "continuation",
    assignmentId: "assignment-3",
    sessionId: first.session.id,
    prompt: "continue",
  });
  expect(start).toHaveBeenCalledTimes(2);
  expect(resume).toHaveBeenCalledExactlyOnceWith(
    "native-one",
    expect.objectContaining({ prompt: "continue" }),
  );
  expect(continued.session).toEqual(first.session);
  expect(independent.session).toMatchObject({ nativeId: "native-two" });
  expect(independent.session.id).not.toBe(continued.session.id);
  expect(store.agentExecutions().get("first")).toEqual(first.execution);
});

it("claims an execution only once across connections and rejects concurrent reuse of its assignment and session", async () => {
  const other = new WorkflowStore(path);
  try {
    const started = Promise.withResolvers<string>();
    const finish = Promise.withResolvers<AgentResult>();
    const adapter = {
      start: vi.fn(async (turn: AgentTurn) => {
        turn.onSession("native-id");
        started.resolve(store.agentExecutions().get(assignment.id)!.sessionId);
        return finish.promise;
      }),
      resume: vi.fn(),
    };
    const run = createAgentController(store.agentExecutions(), () => adapter).execute(assignment);
    try {
      const sessionId = await started.promise;
      const execute = createAgentController(other.agentExecutions(), () => adapter).execute;
      const duplicate = await execute({ ...assignment, prompt: "duplicate cannot dispatch" });
      expect(duplicate).toMatchObject({
        execution: { status: "running" },
        session: { id: sessionId },
      });
      expect(duplicate).not.toHaveProperty("result");
      expect(adapter.start).toHaveBeenCalledTimes(1);
      await expect(execute({ ...assignment, assignmentId: "different" })).rejects.toThrow(
        "different assignment",
      );
      await expect(execute({ ...assignment, id: "another-attempt" })).rejects.toThrow(
        "already has",
      );
      await expect(
        execute({ id: "other", assignmentId: "other", sessionId, prompt: "continue" }),
      ).rejects.toThrow("unresolved execution");
      expect(adapter.resume).not.toHaveBeenCalled();
    } finally {
      finish.resolve(success);
      await run;
    }
  } finally {
    other.close();
  }
});

it("permits a fresh attempt for the same assignment only after known non-execution", async () => {
  const start = vi
    .fn<(turn: AgentTurn) => Promise<AgentResult>>()
    .mockResolvedValueOnce({ outcome: "not_started", reason: "No executable." })
    .mockResolvedValueOnce({ outcome: "failed", reason: "Provider rejected the turn." });
  const execute = createAgentController(store.agentExecutions(), () => ({
    start,
    resume: vi.fn(),
  })).execute;
  expect((await execute(assignment)).execution.status).toBe("not_started");
  expect((await execute(assignment)).execution.status).toBe("not_started");
  expect((await execute({ ...assignment, id: "retry" })).execution.status).toBe("failed");
  await expect(execute({ ...assignment, id: "third" })).rejects.toThrow("already has");
  expect(start).toHaveBeenCalledTimes(2);
});

it("recovers a dead owner once and holds its assignment and native session without replay", async () => {
  const worker = crashAfterSession(path);
  expect(worker.signal, worker.stderr).toBe("SIGKILL");
  expect(store.agentExecutions().get("interrupted")?.status).toBe("running");
  store.close();
  store = new WorkflowStore(path);
  expect(store.recover()).toEqual({ deliveries: 0, unknownExecutions: 1 });
  expect(store.recover()).toEqual({ deliveries: 0, unknownExecutions: 0 });
  const adapter = vi.fn();
  const execute = createAgentController(store.agentExecutions(), adapter).execute;
  const run = await execute({ ...assignment, id: "interrupted", assignmentId: "interrupted" });
  expect(run).toMatchObject({
    execution: { status: "unknown", reason: expect.stringContaining("owner exited") },
    session: { nativeId: "crashed-native-id" },
  });
  expect(run).not.toHaveProperty("result");
  await expect(
    execute({ ...assignment, id: "retry", assignmentId: "interrupted" }),
  ).rejects.toThrow("already has");
  await expect(
    execute({
      id: "new",
      assignmentId: "new",
      sessionId: run.session.id,
      prompt: "continue",
    }),
  ).rejects.toThrow("unresolved execution");
  expect(adapter).not.toHaveBeenCalled();
});

it("holds unconfirmed completion and sanitizes adapter exceptions after the claim", async () => {
  const adapter = {
    start: vi
      .fn<(turn: AgentTurn) => Promise<AgentResult>>()
      .mockRejectedValueOnce(new Error("private diagnostics"))
      .mockResolvedValueOnce(success),
    resume: vi.fn(),
  };
  const execute = createAgentController(store.agentExecutions(), () => adapter).execute;
  expect((await execute(assignment)).execution).toMatchObject({
    status: "unknown",
    reason: "Native execution ended without a confirmed outcome.",
  });
  expect(
    (await execute({ ...assignment, id: "new", assignmentId: "new" })).execution,
  ).toMatchObject({
    status: "unknown",
    reason: "Could not confirm and record the native session.",
  });
});

it("retries transient session and outcome writes after one native invocation", async () => {
  const executions = store.agentExecutions();
  const recordSession = vi.spyOn(executions, "recordSession").mockImplementationOnce(() => {
    throw sqliteError(5);
  });
  const finish = vi.spyOn(executions, "finish").mockImplementationOnce(() => {
    throw sqliteError(261); // SQLITE_BUSY_RECOVERY
  });
  const start = vi.fn(async (turn: AgentTurn) => {
    turn.onSession("native-id");
    return success;
  });
  const { execute } = createAgentController(executions, () => ({ start, resume: vi.fn() }));
  const recorded = await execute(assignment);
  expect(recorded).toMatchObject({
    execution: { status: "completed" },
    session: { nativeId: "native-id" },
    result: success,
  });
  expect(executions.get(assignment.id)).toEqual(recorded.execution);
  expect(executions.session(recorded.session.id)).toEqual(recorded.session);
  expect(recordSession).toHaveBeenCalledTimes(1);
  expect(finish).toHaveBeenCalledTimes(2);
  expect(start).toHaveBeenCalledTimes(1);
});

it.each(["matching", "conflicting"])(
  "reads back a %s terminal record after an ambiguous commit",
  async (evidence) => {
    const executions = store.agentExecutions();
    const commit = executions.finish;
    const finish = vi
      .spyOn(executions, "finish")
      .mockImplementationOnce((id, outcome, nativeId) => {
        commit(
          id,
          evidence === "matching" ? outcome : { outcome: "unknown", reason: "Other evidence." },
          nativeId,
        );
        throw sqliteError(10); // SQLITE_IOERR
      });
    const start = vi.fn(async (turn: AgentTurn) => {
      turn.onSession("native-id");
      return success;
    });
    const { execute } = createAgentController(executions, () => ({ start, resume: vi.fn() }));
    const run = execute(assignment);
    if (evidence === "matching") {
      const recorded = await run;
      expect(recorded).toMatchObject({ execution: { status: "completed" }, result: success });
      expect(recorded.execution).toEqual(executions.get(assignment.id));
    } else {
      await expect(run).rejects.toThrow("fixture SQLite failure");
      expect(executions.get(assignment.id)?.status).toBe("unknown");
    }
    expect(finish).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
  },
);

it.each(["session", "outcome"])(
  "retains the dispatch claim after persistent %s write failure",
  async (write) => {
    const executions = store.agentExecutions();
    using db = new DatabaseSync(path);
    const finish = vi.spyOn(executions, "finish");
    if (write === "session") {
      db.exec(`
      CREATE TRIGGER fail_session BEFORE UPDATE OF native_id ON agent_sessions
      BEGIN SELECT RAISE(ABORT, 'fixture SQLite failure'); END;
    `);
    } else {
      finish.mockImplementation(() => {
        throw sqliteError(6);
      });
    }
    const start = vi.fn(async (turn: AgentTurn) => {
      turn.onSession("native-id");
      return success;
    });
    const execute = createAgentController(executions, () => ({
      start,
      resume: vi.fn(),
    })).execute;
    await expect(execute(assignment)).rejects.toThrow("fixture SQLite failure");
    const recorded = await execute(assignment);
    expect(recorded).toMatchObject({
      execution: { status: "running", finishedAt: null },
      session: { nativeId: write === "session" ? null : "native-id" },
    });
    expect(recorded).not.toHaveProperty("result");
    await expect(execute({ ...assignment, id: "replay" })).rejects.toThrow("already has");
    expect(finish).toHaveBeenCalledTimes(write === "session" ? 1 : 3);
    expect(start).toHaveBeenCalledTimes(1);
  },
);
