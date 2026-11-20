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
  onEvent?: (event: AgentEvent) => void;
};

export type AgentTurnResult =
  | { outcome: "completed"; response: string; structuredOutput?: unknown }
  | { outcome: "failed" | "interrupted" | "unknown"; reason: string };

export interface AgentSession {
  readonly reference: AgentSessionReference | null;
  runTurn(turn: AgentTurn): Promise<AgentTurnResult>;
}

export interface AgentAdapter {
  startSession(workspace: AgentWorkspace): AgentSession;
  resumeSession(workspace: AgentWorkspace, reference: AgentSessionReference): AgentSession;
}
