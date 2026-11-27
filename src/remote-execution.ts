import {
  parseAgentContext,
  record,
  validIdentifier,
  validRemoteKey,
  validRexId,
} from "./agent-config.ts";
import { validNativeId, type AgentContext, type AgentResult } from "./agent.ts";

export type ExecutionCorrelation = {
  version: 1;
  key: string;
  executionId: string;
  assignmentId: string;
  sessionId: string;
  expectedNativeId: string | null;
};

export type RemoteRequest = ExecutionCorrelation & {
  context: AgentContext;
  prompt: string;
  outputSchema?: Record<string, unknown>;
};

export type RemoteEvidence = ExecutionCorrelation & {
  blockId: string;
  nativeId: string | null;
  result?: AgentResult;
};

export function readCorrelation(value: Record<string, unknown>): ExecutionCorrelation {
  const { version, key, executionId, assignmentId, sessionId, expectedNativeId } = value;
  if (
    version !== 1 ||
    !validRemoteKey(key) ||
    !validIdentifier(executionId) ||
    !validIdentifier(assignmentId) ||
    !validRemoteKey(sessionId) ||
    (expectedNativeId !== null && !validNativeId(expectedNativeId))
  )
    throw new Error("Invalid remote execution correlation.");
  return { version, key, executionId, assignmentId, sessionId, expectedNativeId };
}

export function readRequest(value: unknown): RemoteRequest {
  const entry = record(value);
  if (!entry) throw new Error("Invalid remote execution request.");
  const { prompt, outputSchema } = entry;
  const schema = record(outputSchema);
  if (typeof prompt !== "string" || !prompt.trim() || (outputSchema !== undefined && !schema))
    throw new Error("Invalid remote assignment inputs.");
  return {
    ...readCorrelation(entry),
    context: parseAgentContext(entry.context, true),
    prompt,
    ...(schema ? { outputSchema: schema } : {}),
  };
}

export function readEvidence(value: unknown, expected: ExecutionCorrelation): RemoteEvidence {
  const entry = record(value);
  if (!entry) throw new Error("Invalid remote execution evidence.");
  const correlation = readCorrelation(entry);
  for (const field of Object.keys(correlation) as (keyof ExecutionCorrelation)[]) {
    if (expected[field] !== correlation[field])
      throw new Error("Remote evidence does not match the execution claim.");
  }
  const { blockId, nativeId } = entry;
  if (
    !validRexId(blockId, "block") ||
    (nativeId !== null && !validNativeId(nativeId)) ||
    (expected.expectedNativeId !== null && expected.expectedNativeId !== nativeId)
  )
    throw new Error("Invalid remote block or native session reference.");

  const evidence = { ...correlation, blockId, nativeId };
  if (entry.result === undefined) return evidence;
  const result = record(entry.result);
  if (result?.outcome === "completed" && nativeId !== null && typeof result.response === "string") {
    return {
      ...evidence,
      result: {
        outcome: result.outcome,
        response: result.response,
        ...(Object.hasOwn(result, "structuredOutput")
          ? { structuredOutput: result.structuredOutput }
          : {}),
      },
    };
  }
  if (
    (result?.outcome === "not_started" ||
      result?.outcome === "failed" ||
      result?.outcome === "unknown") &&
    typeof result.reason === "string" &&
    result.reason.length > 0 &&
    result.reason.length <= 300 &&
    (result.outcome !== "not_started" || nativeId === expected.expectedNativeId)
  )
    return { ...evidence, result: { outcome: result.outcome, reason: result.reason } };
  throw new Error("Invalid remote execution result.");
}
