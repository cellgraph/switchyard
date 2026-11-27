import type { AgentContext } from "./agent.ts";
import { createClaudeAgent } from "./claude-agent.ts";
import { createCodexAgent } from "./codex-agent.ts";

export function createNativeAgent(context: AgentContext) {
  return context.provider === "codex" ? createCodexAgent(context) : createClaudeAgent(context);
}
