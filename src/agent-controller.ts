import { setTimeout as delay } from "node:timers/promises";
import { parseAgentContext, parseRexPlacement, validIdentifier } from "./agent-config.ts";
import {
  validNativeId,
  type AgentAdapter,
  type AgentContext,
  type AgentResult,
  type AgentTurn,
} from "./agent.ts";
import { type createAgentStore, type ExecutionIntent } from "./agent-store.ts";
import { createNativeAgent } from "./native-agent.ts";
import { createRexExecution } from "./rex-execution.ts";

type Assignment = ExecutionIntent & Pick<AgentTurn, "prompt" | "outputSchema" | "signal">;

const persistenceRetryDelays = [25, 75];

function sqliteContention(error: unknown): boolean {
  const { code, errcode } = (error as { code?: string; errcode?: number } | null) ?? {};
  if (code !== "ERR_SQLITE_ERROR" || typeof errcode !== "number") return false;
  // Extended result codes keep SQLITE_BUSY and SQLITE_LOCKED in the low byte.
  return [5, 6].includes(errcode & 0xff);
}

export function createAgentController(
  executions: ReturnType<typeof createAgentStore>,
  adapterFor: (context: AgentContext) => AgentAdapter = createNativeAgent,
  remote = createRexExecution(executions),
) {
  return {
    async execute(assignment: Assignment) {
      const { id, assignmentId, context, prompt, outputSchema, signal } = assignment;
      if (![id, assignmentId].every(validIdentifier))
        throw new Error("Execution and assignment IDs must be short identifiers.");
      if (!prompt.trim()) throw new Error("An assignment prompt is required.");
      if (assignment.agentName !== undefined && !validIdentifier(assignment.agentName))
        throw new Error("An agent name must be a short identifier.");

      const rex = assignment.rex && parseRexPlacement(assignment.rex);
      const claim = executions.claim(
        context
          ? {
              id,
              assignmentId,
              context: parseAgentContext(context, Boolean(rex)),
              ...(assignment.agentName === undefined ? {} : { agentName: assignment.agentName }),
              ...(rex ? { rex } : {}),
            }
          : assignment,
      );
      if (!claim.claimed) return { execution: claim.execution, session: claim.session };
      if (claim.session.rex) return remote.dispatch(claim.execution, claim.session, assignment);

      let nativeId = claim.session.nativeId;
      let conflictingSession = false;
      const turn: AgentTurn = {
        prompt,
        ...(outputSchema === undefined ? {} : { outputSchema }),
        ...(signal === undefined ? {} : { signal }),
        onSession(reportedId) {
          if (!validNativeId(reportedId) || (nativeId !== null && nativeId !== reportedId)) {
            conflictingSession = true;
            return;
          }
          if (nativeId === reportedId) return;
          nativeId = reportedId;
          try {
            executions.recordSession(id, nativeId);
          } catch {
            // Keep the observed ID for finalization if the early write could not be confirmed.
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
      if (conflictingSession || (result.outcome === "completed" && nativeId === null))
        result = { outcome: "unknown", reason: "Could not confirm and record the native session." };

      // Only coordination metadata crosses the SQLite boundary.
      const outcome = result.outcome === "completed" ? { outcome: result.outcome } : result;
      for (let attempt = 0; ; attempt++) {
        let saved;
        try {
          saved = executions.finish(id, outcome, nativeId);
        } catch (error) {
          try {
            saved = executions.confirmFinish(claim.execution, outcome, nativeId);
          } catch (readError) {
            if (!sqliteContention(readError)) throw readError;
          }
          if (!saved) {
            const retryDelay = persistenceRetryDelays[attempt];
            if (retryDelay === undefined || !sqliteContention(error)) throw error;
            await delay(retryDelay);
            continue;
          }
        }
        return { ...saved, ...(result.outcome === "completed" ? { result } : {}) };
      }
    },
  };
}
