import { isAbsolute } from "node:path";
import { object } from "./github-data.ts";

export type ClaudeSettings = {
  executable: string;
  home: string;
  timeoutMs: number;
  maxBudgetUsd?: number;
};

export type AgentConfig =
  | { provider?: "codex"; model: string; codexHome: string }
  | { provider: "claude-code"; model: string; claude: ClaudeSettings };

export function parseAgentConfig(input: Record<string, unknown>): AgentConfig {
  const { provider, model, codexHome } = input;
  if (typeof model !== "string" || !model.trim() || model.includes("\0"))
    throw new Error("An agent model must be configured.");
  if (provider === undefined || provider === "codex") {
    if (input.claude !== undefined || typeof codexHome !== "string" || !isAbsolute(codexHome))
      throw new Error("Codex requires an absolute codexHome and accepts only Codex settings.");
    // Keep existing persisted fix configuration and request digests compatible.
    return { codexHome, model };
  }
  if (provider !== "claude-code") throw new Error("Unsupported agent provider.");
  if (codexHome !== undefined || !/^[a-zA-Z0-9][a-zA-Z0-9._:[\]-]{0,127}$/.test(model))
    throw new Error("Invalid Claude Code model or mixed provider settings.");
  const claude = object(input.claude);
  if (
    !claude ||
    Object.keys(claude).some(
      (key) => !["executable", "home", "timeoutMs", "maxBudgetUsd"].includes(key),
    )
  )
    throw new Error("Claude Code requires executable and home settings.");
  const { executable, home, maxBudgetUsd } = claude;
  const timeoutMs = claude.timeoutMs === undefined ? 900_000 : claude.timeoutMs;
  if (
    typeof executable !== "string" ||
    !isAbsolute(executable) ||
    executable.includes("\0") ||
    typeof home !== "string" ||
    !isAbsolute(home) ||
    home.includes("\0")
  )
    throw new Error("Claude Code requires an absolute executable and home.");
  if (
    typeof timeoutMs !== "number" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 3_600_000
  )
    throw new Error("Claude Code timeoutMs must be between 1 and 3600000.");
  if (
    maxBudgetUsd !== undefined &&
    (typeof maxBudgetUsd !== "number" || !Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0)
  )
    throw new Error("Claude Code maxBudgetUsd must be a positive finite amount.");
  return {
    provider,
    model,
    claude: {
      executable,
      home,
      timeoutMs,
      ...(maxBudgetUsd === undefined ? {} : { maxBudgetUsd }),
    },
  };
}
