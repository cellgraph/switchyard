import type { ModelReasoningEffort } from "@openai/codex-sdk";

export type AgentProvider = "codex" | "claude-code";

export type AgentContext = {
  provider: AgentProvider;
  workingDirectory: string;
  model?: string;
  reasoningEffort?: ModelReasoningEffort;
  configDirectory?: string;
};

export type AgentTurn = {
  prompt: string;
  outputSchema?: Record<string, unknown>;
  signal?: AbortSignal;
  onSession: (nativeId: string) => void;
};

export type AgentFailure = {
  outcome: "not_started" | "failed" | "unknown";
  reason: string;
};

export type AgentResult =
  { outcome: "completed"; response: string; structuredOutput?: unknown } | AgentFailure;

export interface AgentAdapter {
  start(turn: AgentTurn): Promise<AgentResult>;
  resume(nativeId: string, turn: AgentTurn): Promise<AgentResult>;
}

export function validNativeId(id: unknown): id is string {
  return typeof id === "string" && /^[a-z0-9][a-z0-9._:-]{0,199}$/i.test(id);
}

// Return fixed diagnostics. Native errors may include prompts, output or credentials.
export function authenticationFailure(message: unknown): boolean {
  return (
    typeof message === "string" &&
    /authentication_error|failed to authenticate|unauthorized|not logged in|please (?:log|sign) in|invalid (?:api key|x-api-key|access token)|\b(?:401 Unauthorized|status(?: code)?:? 401)\b/i.test(
      message,
    )
  );
}
