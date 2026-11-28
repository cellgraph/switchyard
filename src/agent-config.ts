import type { ModelReasoningEffort } from "@openai/codex-sdk";
import { readFileSync } from "node:fs";
import { isAbsolute, posix } from "node:path";
import type { AgentContext } from "./agent.ts";

export type RexPlacement = {
  endpoint: string;
  session: string;
  executable: string;
  node: string;
  executor: string;
  stateDirectory: string;
};

export type AgentSelection = { context: AgentContext; agentName?: string; rex?: RexPlacement };

export function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._:-]{0,199}$/i.test(value);
}

export function validRemoteKey(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
}

export function validRexId(value: unknown, kind: "session" | "block"): value is string {
  return (
    typeof value === "string" &&
    value.startsWith(kind + ":") &&
    validRemoteKey(value.slice(kind.length + 1))
  );
}

function absolute(value: unknown, remote: boolean): value is string {
  return (
    typeof value === "string" &&
    !value.includes("\0") &&
    (remote ? posix.isAbsolute(value) : isAbsolute(value))
  );
}

const supportedEfforts = {
  codex: ["minimal", "low", "medium", "high", "xhigh", "max", "ultra", "persistent"],
  "claude-code": ["low", "medium", "high", "xhigh", "max"],
} satisfies Record<AgentContext["provider"], ModelReasoningEffort[]>;

export function parseAgentContext(value: unknown, remote: boolean): AgentContext {
  const { provider, workingDirectory, model, reasoningEffort, configDirectory } =
    record(value) ?? {};
  if (
    (provider !== "codex" && provider !== "claude-code") ||
    !absolute(workingDirectory, remote) ||
    (model !== undefined && (typeof model !== "string" || !model.trim() || model.includes("\0"))) ||
    (configDirectory !== undefined && !absolute(configDirectory, remote))
  ) {
    throw new Error(
      "An agent requires a native provider, an absolute working directory, and valid model and config directory overrides.",
    );
  }
  const levels = supportedEfforts[provider];
  const effort = levels.find((level) => level === reasoningEffort);
  if (reasoningEffort !== undefined && effort === undefined)
    throw new Error(
      `Invalid reasoningEffort for ${provider}. Supported levels: ${levels.join(", ")}.`,
    );
  return {
    provider,
    workingDirectory,
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
    ...(configDirectory === undefined ? {} : { configDirectory }),
  };
}

export function parseRexPlacement(value: unknown): RexPlacement {
  const { endpoint, session, executable, node, executor, stateDirectory } = record(value) ?? {};
  if (
    typeof endpoint !== "string" ||
    !/^ssh:\/\/[a-z0-9_][a-z0-9_.-]*@[a-z0-9][a-z0-9.-]*(?::[0-9]{1,5})?\/[a-z0-9_./-]+$/i.test(
      endpoint,
    ) ||
    !validRexId(session, "session") ||
    !absolute(executable, false) ||
    !absolute(node, true) ||
    !absolute(executor, true) ||
    typeof stateDirectory !== "string" ||
    !/^\/[\w./-]+$/.test(stateDirectory) ||
    posix.normalize(stateDirectory) !== stateDirectory ||
    stateDirectory.endsWith("/")
  ) {
    throw new Error(
      "Rex placement requires an explicit SSH socket, a full Rex session ID, and absolute Rex, Node, executor and state paths.",
    );
  }
  return { endpoint, session, executable, node, executor, stateDirectory };
}

export function loadNamedAgent(path: string, name: string): AgentSelection {
  if (!validIdentifier(name)) throw new Error("An agent name must be a short identifier.");
  const agents = record(record(JSON.parse(readFileSync(path, "utf8")))?.agents);
  const agent = agents && Object.hasOwn(agents, name) ? record(agents[name]) : undefined;
  if (!agent || (agent.placement !== "local" && agent.placement !== "rex"))
    throw new Error("The named agent must configure local or Rex placement.");
  const rex = agent.placement === "rex" ? parseRexPlacement(agent.rex) : undefined;
  if (!rex && agent.rex !== undefined)
    throw new Error("A local agent cannot specify Rex placement.");
  return {
    agentName: name,
    context: parseAgentContext(agent, Boolean(rex)),
    ...(rex ? { rex } : {}),
  };
}
