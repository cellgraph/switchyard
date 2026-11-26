import { Codex, type ThreadOptions } from "@openai/codex-sdk";
import {
  authenticationFailure,
  validNativeId,
  type AgentAdapter,
  type AgentContext,
  type AgentResult,
  type AgentTurn,
} from "./agent.ts";

export function createCodexAgent({
  workingDirectory,
  model,
  configDirectory,
}: AgentContext): AgentAdapter {
  async function run(turn: AgentTurn, nativeId?: string): Promise<AgentResult> {
    if (turn.signal?.aborted)
      return { outcome: "not_started", reason: "Canceled before Codex launch." };

    const options: ThreadOptions = {
      workingDirectory,
      ...(model === undefined ? {} : { model }),
    };
    let thread;
    try {
      const codex = new Codex(
        configDirectory ? { env: { ...process.env, CODEX_HOME: configDirectory } } : undefined,
      );
      thread = nativeId ? codex.resumeThread(nativeId, options) : codex.startThread(options);
    } catch {
      return { outcome: "not_started", reason: "Could not initialize the Codex SDK." };
    }
    let sessionConfirmed = false;
    let invalidEvidence = false;
    let receivedEvent = false;
    let terminal: "completed" | "failed" | undefined;
    let authDiagnostic = false;
    let response: string | undefined;
    let streamIssue: string | undefined;
    try {
      const { events } = await thread.runStreamed(turn.prompt, {
        outputSchema: turn.outputSchema,
        ...(turn.signal === undefined ? {} : { signal: turn.signal }),
      });
      for await (const event of events) {
        receivedEvent = true;
        switch (event.type) {
          case "thread.started":
            if (!validNativeId(event.thread_id) || (nativeId && event.thread_id !== nativeId)) {
              invalidEvidence = true;
              break;
            }
            if (!sessionConfirmed) turn.onSession(event.thread_id);
            nativeId = event.thread_id;
            sessionConfirmed = true;
            break;
          case "item.completed":
            if (!terminal && event.item.type === "agent_message") response = event.item.text;
            break;
          case "turn.completed":
          case "turn.failed":
            if (terminal) invalidEvidence = true;
            terminal = event.type === "turn.completed" ? "completed" : "failed";
            if (event.type === "turn.failed")
              authDiagnostic ||= authenticationFailure(event.error?.message);
            break;
          case "error":
            authDiagnostic ||= authenticationFailure(event.message);
            break;
        }
      }
    } catch (error) {
      const { code, syscall } = (error as NodeJS.ErrnoException | null) ?? {};
      if (
        !receivedEvent &&
        syscall?.startsWith("spawn ") &&
        (code === "ENOENT" || code === "EACCES" || code === "EPERM")
      )
        return { outcome: "not_started", reason: "Could not launch the Codex CLI." };
      authDiagnostic ||=
        !receivedEvent && error instanceof Error && authenticationFailure(error.message);
      streamIssue = "The Codex event stream ended with an error.";
    }

    if (invalidEvidence)
      return { outcome: "unknown", reason: "Codex reported conflicting execution evidence." };
    if (terminal === "failed")
      return {
        outcome: "failed",
        reason: authDiagnostic ? "Codex could not authenticate." : "Codex reported a turn failure.",
      };
    if (terminal !== "completed" || !sessionConfirmed)
      return {
        outcome: "unknown",
        reason: turn.signal?.aborted
          ? "Cancellation was requested without a complete Codex result."
          : authDiagnostic
            ? "Codex reported an authentication error without a confirmed terminal result."
            : (streamIssue ?? "Codex did not report a complete terminal result."),
      };
    if (typeof response !== "string")
      return { outcome: "failed", reason: "Codex omitted the required response." };
    if (turn.outputSchema === undefined) return { outcome: "completed", response };
    try {
      return { outcome: "completed", response, structuredOutput: JSON.parse(response) };
    } catch {
      return { outcome: "failed", reason: "Codex returned invalid structured JSON." };
    }
  }

  return { start: (turn) => run(turn), resume: (id, turn) => run(turn, id) };
}
