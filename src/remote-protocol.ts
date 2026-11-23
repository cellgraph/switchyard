import type { WorkerSessionReference } from "./local-worker.ts";
import { isAbsolute } from "node:path";
import { agentTokenCount } from "./agent.ts";
import type {
  AgentRuntime,
  AgentSessionBinding,
  AgentTurnEvidence,
  AgentTurnIntent,
} from "./agent-operation.ts";
import type { Worktree, WorktreeLocation } from "./worktree.ts";

export const remoteLeaseMs = 30_000;
export const remotePollMs = 2_000;

export type Placement = {
  repository: string;
  provider: "codex" | "claude-code";
  model: string;
};
export type Capabilities = {
  platform: "darwin" | "linux";
  architecture: "x64" | "arm64";
  isolation: "linked-worktree";
  sandbox: "read-only";
  concurrency: 1;
  profiles: Placement[];
};
export type RemoteTask = {
  intent: AgentTurnIntent & { remote: NonNullable<AgentTurnIntent["remote"]> };
  repository: string;
  prompt: string;
  previous: AgentSessionBinding | null;
  fence: string;
};
export type LeaseKey = { operationId: string; instance: string; fence: string };

export class RemoteProtocolError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RemoteProtocolError("Expected a JSON object.");
  return value as Record<string, unknown>;
}

export function string(value: unknown, max = 256): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0"))
    throw new RemoteProtocolError("Invalid string field.");
  return value;
}

export function workerId(value: unknown): string {
  const id = string(value, 64);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw new RemoteProtocolError("Invalid worker ID.");
  return id;
}

export function instanceId(value: unknown): string {
  const id = string(value, 36);
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(id))
    throw new RemoteProtocolError("Invalid execution identifier.");
  return id;
}

export function sha(value: unknown): string {
  const result = string(value, 64);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(result))
    throw new RemoteProtocolError("Expected a full Git SHA.");
  return result;
}

export function path(value: unknown): string {
  const result = string(value, 4096);
  if (!isAbsolute(result)) throw new RemoteProtocolError("Expected an absolute local path.");
  return result;
}

export function repositoryName(value: unknown): string {
  const name = string(value);
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(name))
    throw new RemoteProtocolError("Expected a GitHub owner and repository.");
  return name.toLowerCase();
}

export function providerName(value: unknown): Placement["provider"] {
  if (value !== "codex" && value !== "claude-code")
    throw new RemoteProtocolError("Unknown execution provider.");
  return value;
}

export function placement(value: unknown): Placement {
  const input = record(value);
  return {
    repository: repositoryName(input.repository),
    provider: providerName(input.provider),
    model: string(input.model, 128),
  };
}

export function capabilities(value: unknown): Capabilities {
  const { platform, architecture, isolation, sandbox, concurrency, profiles } = record(value);
  if (
    (platform !== "darwin" && platform !== "linux") ||
    (architecture !== "arm64" && architecture !== "x64") ||
    isolation !== "linked-worktree" ||
    sandbox !== "read-only" ||
    concurrency !== 1 ||
    !Array.isArray(profiles) ||
    !profiles.length ||
    profiles.length > 64
  )
    throw new RemoteProtocolError("Unsupported worker capabilities.");
  const parsed = profiles.map(placement);
  if (new Set(parsed.map((profile) => JSON.stringify(profile))).size !== parsed.length)
    throw new RemoteProtocolError("Duplicate worker profile.");
  return { platform, architecture, isolation, sandbox, concurrency, profiles: parsed };
}

export function runtimeEvidence(value: unknown): AgentRuntime {
  const input = record(value);
  return {
    provider: providerName(input.provider),
    model: string(input.model, 128),
    home: path(input.home),
    cliVersion: string(input.cliVersion),
    sdkVersion: string(input.sdkVersion),
    configuration: string(input.configuration, 1024),
  };
}

export function worktreeLocation(value: unknown): WorktreeLocation {
  const input = record(value);
  return {
    path: path(input.path),
    repository: path(input.repository),
    workflowId: string(input.workflowId),
    branch: string(input.branch),
  };
}

export function worktreeEvidence(value: unknown): Worktree {
  const input = record(value);
  return { ...worktreeLocation(input), checkoutIdentity: string(input.checkoutIdentity, 1024) };
}

export function sessionEvidence(value: unknown): WorkerSessionReference {
  const { agent, worktree } = record(value);
  const identity = record(agent);
  return {
    agent: { id: string(identity.id), provider: providerName(identity.provider) },
    worktree: worktreeEvidence(worktree),
  };
}

export function turnEvidence(value: unknown): AgentTurnEvidence {
  const input = record(value);
  const evidence: AgentTurnEvidence = {};
  if (input.agent !== undefined) {
    const { outcome, reason } = record(input.agent);
    if (
      outcome !== "completed" &&
      outcome !== "failed" &&
      outcome !== "unknown" &&
      outcome !== "interrupted"
    )
      throw new RemoteProtocolError("Invalid agent outcome.");
    evidence.agent = { outcome, ...(reason === undefined ? {} : { reason: string(reason, 1024) }) };
  }
  if (input.error !== undefined) evidence.error = string(input.error, 1024);
  if (!evidence.agent && !evidence.error)
    throw new RemoteProtocolError("Expected terminal agent evidence.");
  if (input.reference !== undefined) evidence.reference = sessionEvidence(input.reference);
  if (input.workspace !== undefined) {
    const { head, changedPaths, error } = record(input.workspace);
    if (error !== undefined) evidence.workspace = { error: string(error, 1024) };
    else {
      if (!Array.isArray(changedPaths) || changedPaths.length > 1024)
        throw new RemoteProtocolError("Invalid changed path list.");
      evidence.workspace = {
        head: sha(head),
        changedPaths: changedPaths.map((entry) => string(entry, 4096)),
      };
    }
  }
  if (input.checkpoint !== undefined) {
    const { workspace, session } = record(input.checkpoint);
    const checkpoint = record(session);
    evidence.checkpoint = {
      workspace: sha(workspace),
      session: { identity: string(checkpoint.identity, 4096), digest: sha(checkpoint.digest) },
    };
  }
  if (input.usage !== undefined) {
    const { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens } = record(
      input.usage,
    );
    if (
      !agentTokenCount(inputTokens) ||
      !agentTokenCount(outputTokens) ||
      !agentTokenCount(inputTokens + outputTokens) ||
      (cacheReadInputTokens !== undefined && !agentTokenCount(cacheReadInputTokens)) ||
      (cacheCreationInputTokens !== undefined && !agentTokenCount(cacheCreationInputTokens))
    )
      throw new RemoteProtocolError("Invalid usage counts.");
    evidence.usage = {
      inputTokens,
      outputTokens,
      ...(cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens }),
      ...(cacheCreationInputTokens === undefined ? {} : { cacheCreationInputTokens }),
    };
  }
  if (input.sessionCostUsd !== undefined) {
    if (
      typeof input.sessionCostUsd !== "number" ||
      !Number.isFinite(input.sessionCostUsd) ||
      input.sessionCostUsd < 0
    )
      throw new RemoteProtocolError("Invalid session cost.");
    evidence.sessionCostUsd = input.sessionCostUsd;
  }
  if (input.model !== undefined) evidence.model = string(input.model, 128);
  return evidence;
}
