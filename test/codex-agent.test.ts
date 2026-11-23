import type { ThreadEvent } from "@openai/codex-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCodexAgent } from "../src/codex-agent.ts";

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

const workspace = { workingDirectory: "/tmp/worktree" };
const settings = { model: "configured-model", codexHome: "/tmp/codex-home" };
const options = {
  workingDirectory: workspace.workingDirectory,
  model: settings.model,
  sandboxMode: "workspace-write",
  approvalPolicy: "never",
  networkAccessEnabled: false,
  webSearchMode: "disabled",
};
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

function stream(events: ThreadEvent[], error?: Error) {
  sdk.runStreamed.mockImplementationOnce(async () => ({
    events: (async function* () {
      yield* events;
      if (error) throw error;
    })(),
  }));
}

describe("Codex SDK adapter", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    for (const open of [sdk.startThread, sdk.resumeThread])
      open.mockReturnValue({ runStreamed: sdk.runStreamed });
  });

  it("scopes SDK execution and streams native events while exposing structured output", async () => {
    const adapter = createCodexAgent(settings);
    const session = adapter.startSession(workspace);
    expect(sdk.startThread).toHaveBeenCalledWith(options);
    const { env, config } = sdk.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(env).toEqual(expect.objectContaining({ CODEX_HOME: settings.codexHome }));
    expect(
      Object.keys(env as object).every((key) =>
        ["HOME", "CODEX_HOME", "PATH", "TMPDIR", "LANG", "LC_ALL"].includes(key),
      ),
    ).toBe(true);
    expect(config).toMatchObject({
      sandbox_workspace_write: {
        writable_roots: [],
        exclude_slash_tmp: true,
        exclude_tmpdir_env_var: true,
      },
    });
    expect(session.reference).toBeNull();
    const outputSchema = { type: "object" };
    const response = '{"summary":"done"}';
    const message = {
      type: "item.completed",
      item: { id: "1", type: "agent_message", text: response },
    } as const;
    const onEvent = vi.fn();
    stream([
      { type: "thread.started", thread_id: "opaque" },
      { type: "turn.started" },
      message,
      completed,
    ]);
    expect(await session.runTurn({ prompt: "test", outputSchema, onEvent })).toEqual({
      outcome: "completed",
      response,
      structuredOutput: { summary: "done" },
      usage: { inputTokens: 1, outputTokens: 2 },
    });
    expect(sdk.runStreamed).toHaveBeenCalledWith("test", { outputSchema });
    expect(onEvent.mock.calls.map(([event]) => event.kind)).toEqual([
      "session_started",
      "turn_started",
      "progress",
      "turn_completed",
    ]);
    expect(onEvent).toHaveBeenCalledWith({ provider: "codex", kind: "progress", data: message });
    expect(session.reference).toEqual({ provider: "codex", id: "opaque" });
  });

  it("resumes the opaque provider reference and rejects a replacement thread", async () => {
    const adapter = createCodexAgent(settings);
    expect(() => adapter.resumeSession(workspace, { provider: "other", id: "opaque" })).toThrow(
      "Codex session",
    );
    const reference = { provider: "codex", id: "opaque" };
    const session = adapter.resumeSession(workspace, reference);
    expect(sdk.resumeThread).toHaveBeenCalledWith(reference.id, options);
    stream([{ type: "thread.started", thread_id: "different" }, completed]);
    expect((await session.runTurn({ prompt: "test" })).outcome).toBe("unknown");
    expect(session.reference).toEqual(reference);
  });

  it("distinguishes explicit failure, cancellation, and lost completion", async () => {
    const session = createCodexAgent(settings).startSession(workspace);
    const failure = { type: "turn.failed", error: { message: "provider denied request" } } as const;
    const onEvent = vi.fn();
    stream([failure], new Error("stderr with sensitive details"));
    const result = await session.runTurn({ prompt: "test", onEvent });
    expect(result).toEqual({ outcome: "failed", reason: "Codex reported a turn error." });
    expect(onEvent).toHaveBeenCalledWith({ provider: "codex", kind: "turn_failed", data: failure });

    stream([{ type: "turn.started" }]);
    expect((await session.runTurn({ prompt: "test" })).outcome).toBe("unknown");

    stream([completed], new Error("transport lost after terminal event"));
    expect((await session.runTurn({ prompt: "test" })).outcome).toBe("unknown");

    const controller = new AbortController();
    const signal = controller.signal;
    stream([{ type: "turn.started" }], new Error("aborted"));
    const interrupted = await session.runTurn({
      prompt: "test",
      signal,
      onEvent: () => controller.abort(),
    });
    expect(interrupted.outcome).toBe("interrupted");
    expect(sdk.runStreamed).toHaveBeenLastCalledWith("test", { signal });
    expect((await session.runTurn({ prompt: "skip", signal })).outcome).toBe("interrupted");
    expect(sdk.runStreamed).not.toHaveBeenCalledWith("skip", expect.anything());
  });

  it.each([false, true])(
    "keeps a diagnostic followed by stream loss uncertain (cancelled: %s)",
    async (cancelled) => {
      const session = createCodexAgent(settings).startSession(workspace);
      const controller = new AbortController();
      const diagnostic = {
        type: "error",
        message: "permission denied: sensitive provider details",
      } as const;
      stream([{ type: "turn.started" }, diagnostic], new Error("lost stream"));
      const onEvent = vi.fn((event) => {
        if (cancelled && event.data === diagnostic) controller.abort();
      });
      const result = await session.runTurn({ prompt: "test", signal: controller.signal, onEvent });
      expect(result).toEqual({
        outcome: cancelled ? "interrupted" : "unknown",
        reason: cancelled
          ? "Codex execution was canceled. Codex denied permission to run the request."
          : "The Codex event stream ended with an error. Codex denied permission to run the request.",
      });
      expect(onEvent).toHaveBeenCalledWith({
        kind: "progress",
        provider: "codex",
        data: diagnostic,
      });
    },
  );

  it("reports invalid structured output and startup errors", async () => {
    const session = createCodexAgent(settings).startSession(workspace);
    stream([{ type: "thread.started", thread_id: "opaque" }, completed]);
    expect(await session.runTurn({ prompt: "test", outputSchema: {} })).toEqual({
      outcome: "failed",
      reason: "Codex returned invalid structured JSON.",
      usage: { inputTokens: 1, outputTokens: 2 },
    });
    stream([], Object.assign(new Error("missing executable"), { code: "ENOENT" }));
    expect(
      await createCodexAgent(settings).startSession(workspace).runTurn({ prompt: "test" }),
    ).toEqual({
      outcome: "failed",
      reason: "Could not launch Codex (ENOENT).",
    });
  });
});
