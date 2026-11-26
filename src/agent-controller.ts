import { isAbsolute } from "node:path";
import {
  validNativeId,
  type AgentAdapter,
  type AgentContext,
  type AgentResult,
  type AgentTurn,
} from "./agent.ts";
import { type createAgentStore, type ExecutionIntent } from "./agent-store.ts";
import { createClaudeAgent } from "./claude-agent.ts";
import { createCodexAgent } from "./codex-agent.ts";

type Assignment = ExecutionIntent & Pick<AgentTurn, "prompt" | "outputSchema" | "signal">;

export function createAgentController(
  executions: ReturnType<typeof createAgentStore>,
  adapterFor: (context: AgentContext) => AgentAdapter = (context) =>
    context.provider === "codex" ? createCodexAgent(context) : createClaudeAgent(context),
) {
  return {
    async execute(assignment: Assignment) {
      const { id, assignmentId, context, prompt, outputSchema, signal } = assignment;
      if (![id, assignmentId].every((value) => /^[a-z0-9][a-z0-9._:-]{0,199}$/i.test(value)))
        throw new Error("Execution and assignment IDs must be short identifiers.");
      if (!prompt.trim()) throw new Error("An assignment prompt is required.");
      if (
        context &&
        (!isAbsolute(context.workingDirectory) ||
          (context.configDirectory !== undefined && !isAbsolute(context.configDirectory)))
      )
        throw new Error(
          "The working directory and any native config directory must be absolute paths.",
        );

      const claim = executions.claim(assignment);
      if (!claim.claimed) return { execution: claim.execution, session: claim.session };

      let sessionWriteFailed = false;
      const turn: AgentTurn = {
        prompt,
        ...(outputSchema === undefined ? {} : { outputSchema }),
        ...(signal === undefined ? {} : { signal }),
        onSession(nativeId) {
          try {
            if (!validNativeId(nativeId)) throw new Error("Invalid native session ID.");
            executions.recordSession(id, nativeId);
          } catch {
            sessionWriteFailed = true;
          }
        },
      };
      let result: AgentResult;
      try {
        const adapter = adapterFor(claim.session.context);
        result = claim.session.nativeId
          ? await adapter.resume(claim.session.nativeId, turn)
          : await adapter.start(turn);
      } catch {
        result = {
          outcome: "unknown",
          reason: "Native execution ended without a confirmed outcome.",
        };
      }
      const session = executions.session(claim.session.id)!;
      if (sessionWriteFailed || (result.outcome === "completed" && !session.nativeId))
        result = { outcome: "unknown", reason: "Could not confirm and record the native session." };

      // Only coordination metadata crosses the SQLite boundary.
      const execution = executions.finish(
        id,
        result.outcome === "completed" ? { outcome: result.outcome } : result,
      );
      return {
        execution,
        session,
        ...(result.outcome === "completed" ? { result } : {}),
      };
    },
  };
}
