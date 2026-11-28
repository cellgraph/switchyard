import type { ThreadEvent } from "@openai/codex-sdk";
import { beforeEach, expect, it, vi } from "vitest";
import { createAgentController } from "../src/agent-controller.ts";
import { createCodexAgent } from "../src/codex-agent.ts";
import { WorkflowStore } from "../src/store.ts";

const sdk = vi.hoisted(() => ({
  create: vi.fn(),
  startThread: vi.fn(),
  resumeThread: vi.fn(),
  runStreamed: vi.fn(),
}));

vi.mock("@openai/codex-sdk", () => ({
  Codex: class {
    constructor(options: unknown) {
      sdk.create(options);
    }
    startThread = sdk.startThread;
    resumeThread = sdk.resumeThread;
  },
}));

const context = { provider: "codex", workingDirectory: "/repo" } as const;
const thread = { type: "thread.started", thread_id: "native-id" } as const;
const completed = {
  type: "turn.completed",
  usage: {
    input_tokens: 1,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 0,
  },
} satisfies ThreadEvent;

function message(text: string): ThreadEvent {
  return { type: "item.completed", item: { id: "1", type: "agent_message", text } };
}

function stream(events: ThreadEvent[], error?: Error) {
  sdk.runStreamed.mockImplementationOnce(async () => ({
    events: (async function* () {
      yield* events;
      if (error) throw error;
    })(),
  }));
}

beforeEach(() => {
  vi.resetAllMocks();
  for (const open of [sdk.startThread, sdk.resumeThread])
    open.mockReturnValue({ runStreamed: sdk.runStreamed });
});

it("starts a native thread and passes through the prompt and schema using native defaults", async () => {
  const adapter = createCodexAgent(context);
  const outputSchema = { type: "object", properties: { ok: { const: true } } };
  const onSession = vi.fn();
  stream([thread, message('{"ok":true}'), completed]);
  expect(await adapter.start({ prompt: "test", outputSchema, onSession })).toEqual({
    outcome: "completed",
    response: '{"ok":true}',
    structuredOutput: { ok: true },
  });
  expect(sdk.create).toHaveBeenCalledWith(undefined);
  expect(sdk.startThread).toHaveBeenCalledWith({ workingDirectory: "/repo" });
  expect(sdk.runStreamed).toHaveBeenCalledWith("test", { outputSchema });
  expect(onSession).toHaveBeenCalledExactlyOnceWith(thread.thread_id);
});

it("passes explicit model and effort to new and resumed threads", async () => {
  const adapter = createCodexAgent({
    ...context,
    model: "configured",
    reasoningEffort: "xhigh",
    configDirectory: "/codex",
  });
  const onSession = vi.fn();
  stream([thread, message("continued"), completed]);
  expect(await adapter.resume(thread.thread_id, { prompt: "continue", onSession })).toEqual({
    outcome: "completed",
    response: "continued",
  });
  const { env } = sdk.create.mock.calls[0]![0];
  expect(Object.keys(env).sort()).toEqual(
    Object.keys({ ...process.env, CODEX_HOME: "/codex" }).sort(),
  );
  expect(env.CODEX_HOME).toBe("/codex");
  expect(sdk.resumeThread).toHaveBeenCalledWith(thread.thread_id, {
    workingDirectory: "/repo",
    model: "configured",
    modelReasoningEffort: "xhigh",
  });
  expect(onSession).toHaveBeenCalledExactlyOnceWith(thread.thread_id);

  stream([thread, message("started"), completed]);
  expect((await adapter.start({ prompt: "start", onSession })).outcome).toBe("completed");
  expect(sdk.startThread).toHaveBeenCalledWith({
    workingDirectory: "/repo",
    model: "configured",
    modelReasoningEffort: "xhigh",
  });
  onSession.mockClear();
  stream([{ ...thread, thread_id: "different-id" }, message("unexpected"), completed]);
  expect((await adapter.resume(thread.thread_id, { prompt: "continue", onSession })).outcome).toBe(
    "unknown",
  );
  expect(onSession).not.toHaveBeenCalled();
});

it("distinguishes launch failure, native failure and authentication with fixed reasons", async () => {
  const adapter = createCodexAgent(context);
  const turn = { prompt: "test", onSession: vi.fn() };
  stream(
    [],
    Object.assign(new Error("sensitive path"), { code: "ENOENT", syscall: "spawn codex" }),
  );
  expect(await adapter.start(turn)).toEqual({
    outcome: "not_started",
    reason: "Could not launch the Codex CLI.",
  });
  stream(
    [{ type: "turn.failed", error: { message: "private details" } }],
    new Error("private stderr"),
  );
  expect(await adapter.start(turn)).toEqual({
    outcome: "failed",
    reason: "Codex reported a turn failure.",
  });
  stream([{ type: "turn.failed", error: { message: "401 Unauthorized: private details" } }]);
  expect(await adapter.start(turn)).toEqual({
    outcome: "failed",
    reason: "Codex could not authenticate.",
  });
  stream([], new Error("401 Unauthorized: private details"));
  expect(await adapter.start(turn)).toEqual({
    outcome: "unknown",
    reason: "Codex reported an authentication error without a confirmed terminal result.",
  });
});

it("holds missing or conflicting terminal evidence and reports invalid structured JSON", async () => {
  const adapter = createCodexAgent(context);
  const turn = { prompt: "test", onSession: vi.fn() };
  for (const events of [
    [thread, message("partial")],
    [message("response"), completed],
    [thread, message("response"), completed, completed],
  ]) {
    stream(events);
    expect((await adapter.start(turn)).outcome).toBe("unknown");
  }
  stream([thread], new Error("lost stream after tool stderr mentioned Unauthorized"));
  expect((await adapter.start(turn)).outcome).toBe("unknown");
  stream([], Object.assign(new Error("stream I/O"), { code: "EACCES", syscall: "read" }));
  expect((await adapter.start(turn)).outcome).toBe("unknown");
  stream([thread, message("not JSON"), completed]);
  expect(await adapter.start({ ...turn, outputSchema: {} })).toEqual({
    outcome: "failed",
    reason: "Codex returned invalid structured JSON.",
  });

  stream([thread, message("confirmed"), completed], new Error("stream disconnected after result"));
  expect(await adapter.start(turn)).toEqual({ outcome: "completed", response: "confirmed" });
});

it("holds continuation when an auth diagnostic is followed by a disconnected stream", async () => {
  const store = new WorkflowStore();
  try {
    const executions = store.agentExecutions();
    const { execute } = createAgentController(executions);
    stream(
      [
        thread,
        { type: "turn.started" },
        { type: "error", message: "401 Unauthorized: private details" },
      ],
      new Error("disconnected"),
    );
    const run = await execute({ id: "first", assignmentId: "first", context, prompt: "test" });
    expect(executions.get("first")).toMatchObject({
      status: "unknown",
      reason: "Codex reported an authentication error without a confirmed terminal result.",
    });
    expect(run.session.nativeId).toBe(thread.thread_id);
    await expect(
      execute({
        id: "later",
        assignmentId: "later",
        sessionId: run.session.id,
        prompt: "continue",
      }),
    ).rejects.toThrow("unresolved execution");
    expect(sdk.runStreamed).toHaveBeenCalledTimes(1);
  } finally {
    store.close();
  }
});

it("fails a confirmed turn without a response, blocks replay and allows a new assignment to resume", async () => {
  const store = new WorkflowStore();
  try {
    const executions = store.agentExecutions();
    const { execute } = createAgentController(executions);
    const request = { id: "first", assignmentId: "first", context, prompt: "test" };
    stream([thread, completed]);
    const run = await execute(request);
    expect(executions.get("first")).toMatchObject({
      status: "failed",
      reason: "Codex omitted the required response.",
    });
    expect(run).not.toHaveProperty("result");
    await expect(execute({ ...request, id: "retry" })).rejects.toThrow("already has");
    stream([thread, message("confirmed"), completed]);
    const next = await execute({
      id: "later",
      assignmentId: "later",
      sessionId: run.session.id,
      prompt: "continue",
    });
    expect(next.execution.status).toBe("completed");
    expect(next.session).toEqual(run.session);
    expect(sdk.runStreamed).toHaveBeenCalledTimes(2);
  } finally {
    store.close();
  }
});

it("forwards cancellation and holds a dispatched turn without a terminal result", async () => {
  const adapter = createCodexAgent(context);
  const abort = new AbortController();
  stream([thread], new Error("aborted"));
  const turn = { prompt: "test", signal: abort.signal, onSession: () => abort.abort() };
  expect(await adapter.start(turn)).toEqual({
    outcome: "unknown",
    reason: "Cancellation was requested without a complete Codex result.",
  });
  expect(sdk.runStreamed).toHaveBeenCalledWith(
    "test",
    expect.objectContaining({ signal: abort.signal }),
  );
  expect((await adapter.start(turn)).outcome).toBe("not_started");
  expect(sdk.runStreamed).toHaveBeenCalledTimes(1);
});
