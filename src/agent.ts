export type AgentWorkspace = { workingDirectory: string };

export type AgentSessionReference = { provider: string; id: string };

export type AgentEvent = {
  kind: "session_started" | "turn_started" | "progress" | "turn_completed" | "turn_failed";
  provider: string;
  data: unknown;
};

export type AgentTurn = {
  prompt: string;
  outputSchema?: Record<string, unknown>;
  signal?: AbortSignal;
  checkLaunch?: () => void;
  onEvent?: (event: AgentEvent) => void;
};

export type AgentUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
};

export type AgentTurnTelemetry = {
  usage?: AgentUsage;
  sessionCostUsd?: number;
  model?: string;
};

export type AgentTurnResult = AgentTurnTelemetry &
  (
    | { outcome: "completed"; response: string; structuredOutput?: unknown }
    | { outcome: "failed" | "interrupted" | "unknown"; reason: string }
  );

export interface AgentSession {
  readonly reference: AgentSessionReference | null;
  runTurn(turn: AgentTurn): Promise<AgentTurnResult>;
}

export interface AgentAdapter {
  startSession(workspace: AgentWorkspace): AgentSession;
  resumeSession(workspace: AgentWorkspace, reference: AgentSessionReference): AgentSession;
}

export function agentTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
