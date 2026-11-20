import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { Codex, type ThreadEvent, type ThreadOptions } from "@openai/codex-sdk";
import type {
  AgentAdapter,
  AgentEvent,
  AgentSession,
  AgentTurnResult,
  AgentWorkspace,
} from "./agent.ts";

const provider = "codex";
const eventKinds: Partial<Record<ThreadEvent["type"], AgentEvent["kind"]>> = {
  "thread.started": "session_started",
  "turn.started": "turn_started",
  "turn.completed": "turn_completed",
  "turn.failed": "turn_failed",
};

export const codexTurnPolicy = {
  sandboxMode: "workspace-write",
  approvalPolicy: "never",
  networkAccessEnabled: false,
  webSearchMode: "disabled",
} satisfies ThreadOptions;

export const codexConfig = {
  sandbox_workspace_write: {
    writable_roots: [],
    exclude_slash_tmp: true,
    exclude_tmpdir_env_var: true,
  },
  shell_environment_policy: { inherit: "core", exclude: ["*API_KEY*", "*TOKEN*", "*SECRET*"] },
};

function codexDiagnostic(message: string): string | undefined {
  if (/model.*not supported|model.*does not exist/i.test(message))
    return "The configured Codex model is unavailable for this account.";
  if (/unauthorized|authentication|not logged in|invalid api key|\b401\b/i.test(message))
    return "Codex could not authenticate the request.";
  if (/permission denied|access denied|forbidden|\b403\b/i.test(message))
    return "Codex denied permission to run the request.";
}

export function codexEnvironment(codexHome: string): Record<string, string> {
  const env: Record<string, string> = { HOME: homedir(), CODEX_HOME: codexHome };
  for (const key of ["PATH", "TMPDIR", "LANG", "LC_ALL"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export function createCodexAgent({
  model,
  codexHome,
  apiKey,
}: {
  model: string;
  codexHome: string;
  apiKey?: string;
}): AgentAdapter {
  if (!model.trim()) throw new Error("A Codex model must be configured.");
  if (!isAbsolute(codexHome)) throw new Error("Codex home must be an absolute path.");
  const env = codexEnvironment(codexHome);
  const codex = new Codex({
    env,
    ...(apiKey === undefined ? {} : { apiKey }),
    config: { ...codexConfig, sqlite_home: codexHome },
  });

  function open({ workingDirectory }: AgentWorkspace, id?: string): AgentSession {
    if (!isAbsolute(workingDirectory)) throw new Error("Agent workspace must be an absolute path.");
    const options: ThreadOptions = {
      workingDirectory,
      model,
      ...codexTurnPolicy,
    };
    const thread = id ? codex.resumeThread(id, options) : codex.startThread(options);
    let reference = id ?? null;

    return {
      get reference() {
        return reference ? { provider, id: reference } : null;
      },
      async runTurn({ prompt, outputSchema, signal, onEvent }) {
        if (signal?.aborted) return { outcome: "interrupted", reason: "Canceled before launch." };
        let completed = false;
        let failure: string | undefined;
        let diagnostic: string | undefined;
        let sessionConfirmed = false;
        let receivedEvent = false;
        let response = "";
        function uncertain(reason: string): AgentTurnResult {
          const interrupted = signal?.aborted;
          if (interrupted) reason = "Codex execution was canceled.";
          return {
            outcome: interrupted ? "interrupted" : "unknown",
            reason: diagnostic ? `${reason} ${diagnostic}` : reason,
          };
        }
        try {
          const { events } = await thread.runStreamed(prompt, {
            ...(signal === undefined ? {} : { signal }),
            ...(outputSchema === undefined ? {} : { outputSchema }),
          });
          for await (const event of events) {
            receivedEvent = true;
            if (event.type === "thread.started") {
              if (reference !== null && event.thread_id !== reference)
                return { outcome: "unknown", reason: "Codex reported a different session." };
              reference = event.thread_id;
              sessionConfirmed = true;
            }
            if (event.type === "item.completed" && event.item.type === "agent_message")
              response = event.item.text;
            if (event.type === "turn.completed") completed = true;
            if (event.type === "error") diagnostic = codexDiagnostic(event.message) ?? diagnostic;
            if (event.type === "turn.failed")
              failure = codexDiagnostic(event.error.message) ?? "Codex reported a turn error.";
            onEvent?.({ provider, kind: eventKinds[event.type] ?? "progress", data: event });
          }
        } catch (error) {
          if (failure) return { outcome: "failed", reason: failure };
          // The SDK can include stderr and raw model output in exceptions.
          const code = (error as NodeJS.ErrnoException | null)?.code;
          if (
            !signal?.aborted &&
            !receivedEvent &&
            (code === "ENOENT" || code === "EACCES" || code === "EPERM")
          )
            return { outcome: "failed", reason: `Could not launch Codex (${code}).` };
          return uncertain("The Codex event stream ended with an error.");
        }
        if (failure) return { outcome: "failed", reason: failure };
        if (!completed) return uncertain("Codex exited without a terminal turn event.");
        if (!sessionConfirmed)
          return { outcome: "unknown", reason: "Codex did not confirm the session for this turn." };
        if (outputSchema === undefined) return { outcome: "completed", response };
        try {
          return { outcome: "completed", response, structuredOutput: JSON.parse(response) };
        } catch {
          return { outcome: "failed", reason: "Codex returned invalid structured JSON." };
        }
      },
    };
  }

  return {
    startSession: (workspace) => open(workspace),
    resumeSession(workspace, reference) {
      if (reference.provider !== provider || !reference.id.trim())
        throw new Error("A Codex session reference is required.");
      return open(workspace, reference.id);
    },
  };
}
