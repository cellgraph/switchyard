import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { agentTokenCount } from "./agent.ts";
import type {
  AgentAdapter,
  AgentSession,
  AgentTurn,
  AgentTurnResult,
  AgentTurnTelemetry,
} from "./agent.ts";
import {
  assertClaudePolicy,
  assertClaudeWorkspace,
  claudeEnvironment,
  claudeExecutableIdentity,
  claudeProvider,
  claudeSessionId,
  claudeVersion,
  claudeTranscript,
} from "./claude-runtime.ts";
import { object } from "./github-data.ts";

const fileTools = ["Read", "Glob", "Grep", "Edit", "Write"];
const internalTools = new Set(["StructuredOutput"]);
const maxOutputBytes = 16 * 1024 * 1024;
type Options = {
  executable: string;
  executableIdentity: string;
  home: string;
  model: string;
  timeoutMs: number;
  maxBudgetUsd?: number;
  allowedPaths?: string[];
};

export function claudeEditRules(paths: string[] | undefined): string[] {
  if (!paths) return ["Edit(./**)"];
  return paths.map((path) => {
    // Only accept literal path segments representable without gitignore metacharacters.
    if (
      !/^[a-zA-Z0-9_@.+-]+(?:\/[a-zA-Z0-9_@.+-]+)*\/?$/.test(path) ||
      path.split("/").some((part) => [".", "..", ".git"].includes(part.toLowerCase()))
    )
      throw new Error(
        "Claude Code edit scopes require literal path segments without pattern characters.",
      );
    return `Edit(/${path.endsWith("/") ? `${path}**` : path})`;
  });
}

function command(options: Options, turn: AgentTurn, session: string[], rules: string[]) {
  const deny = ["Edit(.git)", "Read(.git)", "Edit(.claude)"];
  for (const path of options.allowedPaths ?? [])
    if (!path.endsWith("/")) deny.push(`Edit(/${path}/**)`);
  return [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--bare",
    "--restricted",
    "--safe-mode",
    "--setting-sources",
    "",
    "--disable-slash-commands",
    "--no-chrome",
    "--strict-mcp-config",
    "--tools",
    fileTools.join(","),
    "--allowedTools",
    rules.join(","),
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "none",
    "--settings",
    JSON.stringify({
      apiKeyHelper: "/usr/bin/printenv SWITCHYARD_CLAUDE_API_KEY",
      disableAllHooks: true,
      disableClaudeAiConnectors: true,
      permissions: { deny, disableBypassPermissionsMode: "disable", disableAutoMode: "disable" },
    }),
    "--model",
    options.model,
    ...(options.maxBudgetUsd === undefined
      ? []
      : ["--max-budget-usd", String(options.maxBudgetUsd)]),
    ...(turn.outputSchema === undefined
      ? []
      : ["--json-schema", JSON.stringify(turn.outputSchema)]),
    ...session,
  ];
}

function diagnostic(text: string): string | undefined {
  if (/authentication_error|invalid api key|not logged in|\b401\b|invalid x-api-key/i.test(text))
    return "Claude Code could not authenticate. Check ANTHROPIC_API_KEY.";
  if (/model.*(?:not found|not available|does not exist)|not_found_error/i.test(text))
    return "The configured Claude Code model is unavailable.";
  if (/permission_error|permission denied|forbidden|\b403\b/i.test(text))
    return "Claude Code denied permission to run the request.";
}

function usageEvidence(result: Record<string, unknown>): AgentTurnTelemetry {
  const evidence: AgentTurnTelemetry = {};
  const usage = object(result.usage);
  const input = usage?.input_tokens;
  const output = usage?.output_tokens;
  const read = usage?.cache_read_input_tokens ?? 0;
  const create = usage?.cache_creation_input_tokens ?? 0;
  if (
    agentTokenCount(input) &&
    agentTokenCount(output) &&
    agentTokenCount(read) &&
    agentTokenCount(create) &&
    agentTokenCount(input + output + read + create)
  ) {
    evidence.usage = {
      inputTokens: input + read + create,
      outputTokens: output,
      ...(read ? { cacheReadInputTokens: read } : {}),
      ...(create ? { cacheCreationInputTokens: create } : {}),
    };
  }
  const cost = result.total_cost_usd;
  // Claude includes spend restored from earlier turns in total_cost_usd.
  if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0)
    evidence.sessionCostUsd = cost;
  return evidence;
}

function checkWorkspace(directory: string) {
  // The CLI checks symlink resolution. Reject aliases and special files as well,
  // since a hard link or file on another mount can alias content outside this checkout.
  const device = lstatSync(directory).dev;
  let remaining = 10_000;
  const pending = [directory];
  while (pending.length) {
    for (const name of readdirSync(pending.pop()!, { withFileTypes: true })) {
      if (--remaining < 0)
        throw new Error("Claude Code worktree exceeds the checkout entry limit.");
      const path = join(name.parentPath, name.name);
      const stat = lstatSync(path);
      if (stat.dev !== device || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)))
        throw new Error(
          "Claude Code requires a worktree without links, other filesystems, or special files.",
        );
      if (stat.isDirectory()) pending.push(path);
    }
  }
}

export function createClaudeAgent(options: Options, apiKey: string): AgentAdapter {
  const rules = claudeEditRules(options.allowedPaths);
  // Using the supported key helper keeps provider policy delivery off for this profile
  // and requires the CLI to load the same settings document as the permission rules.
  const env = { ...claudeEnvironment(options.home), SWITCHYARD_CLAUDE_API_KEY: apiKey };
  function open(directory: string, savedId?: string): AgentSession {
    if (!isAbsolute(directory)) throw new Error("Agent workspace must be an absolute path.");
    assertClaudeWorkspace(options.home, directory);
    let confirmedId = savedId;
    return {
      get reference() {
        return confirmedId ? { provider: claudeProvider, id: confirmedId } : null;
      },
      async runTurn(turn) {
        if (turn.signal?.aborted)
          return { outcome: "interrupted", reason: "Canceled before launch." };
        assertClaudePolicy(options.home);
        if (claudeExecutableIdentity(options.executable) !== options.executableIdentity)
          throw new Error("Claude Code executable changed during preflight.");
        checkWorkspace(directory);
        const id = confirmedId ?? randomUUID();
        const transcript = claudeTranscript(options.home, id, directory);
        const session = confirmedId ? ["--resume", transcript] : ["--session-id", id];
        return new Promise<AgentTurnResult>((resolve) => {
          const child = spawn(options.executable, command(options, turn, session, rules), {
            cwd: directory,
            env,
            detached: true,
            stdio: ["pipe", "pipe", "pipe"],
          });
          let buffer = "";
          let stderr = "";
          let bytes = 0;
          let initialized = false;
          let terminal: Record<string, unknown> | undefined;
          let model: string | undefined;
          let stopReason: AgentTurnResult | undefined;
          let spawnFailed = false;
          let force: NodeJS.Timeout | undefined;
          function kill(signal: NodeJS.Signals) {
            if (!child.pid) return;
            try {
              process.kill(-child.pid, signal);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal);
            }
          }
          function stop(outcome: "interrupted" | "unknown", reason: string) {
            if (stopReason) return;
            stopReason = { outcome, reason };
            kill("SIGTERM");
            force = setTimeout(() => kill("SIGKILL"), 1_000);
          }
          const abort = () => stop("interrupted", "Claude Code execution was canceled.");
          const timeout = setTimeout(
            () => stop("interrupted", "Claude Code execution timed out."),
            options.timeoutMs,
          );
          turn.signal?.addEventListener("abort", abort, { once: true });
          if (turn.signal?.aborted) abort();

          function frame(line: string) {
            const event = object(JSON.parse(line));
            if (
              !event ||
              typeof event.type !== "string" ||
              terminal ||
              (event.session_id !== undefined && event.session_id !== id)
            )
              throw new Error("Unexpected Claude Code event.");
            if (event.type === "system" && event.subtype === "init") {
              if (
                initialized ||
                event.session_id !== id ||
                event.permissionMode !== "dontAsk" ||
                event.cwd !== directory ||
                event.apiKeySource !== "apiKeyHelper" ||
                event.claude_code_version !== claudeVersion ||
                !Array.isArray(event.additional_directories) ||
                event.additional_directories.length !== 0 ||
                !Array.isArray(event.tools) ||
                !event.tools.every(
                  (tool) =>
                    typeof tool === "string" &&
                    (fileTools.includes(tool) ||
                      (turn.outputSchema !== undefined && internalTools.has(tool))),
                ) ||
                !Array.isArray(event.mcp_servers) ||
                event.mcp_servers.length !== 0
              )
                throw new Error("Claude Code did not confirm the required execution policy.");
              initialized = true;
              confirmedId = id;
              if (
                typeof event.model === "string" &&
                /^claude-[a-z0-9.-]{1,100}$/i.test(event.model) &&
                !event.model.includes(apiKey)
              )
                model = event.model;
              turn.onEvent?.({ provider: claudeProvider, kind: "session_started", data: null });
            }
            if (event.type === "result") {
              if (event.session_id !== id) throw new Error("Terminal session ID differs.");
              terminal = event;
            }
          }

          function consume(data: string) {
            if (stopReason) return;
            bytes += Buffer.byteLength(data);
            if (bytes > maxOutputBytes) {
              stop("unknown", "Claude Code exceeded the structured output limit.");
              return;
            }
            buffer += data;
            const lines = buffer.split("\n");
            buffer = lines.pop()!;
            try {
              for (const line of lines) if (line.trim()) frame(line);
            } catch {
              stop("unknown", "Claude Code returned invalid session, policy, or stream evidence.");
            }
          }

          child.stdout.setEncoding("utf8").on("data", consume);
          child.stderr.setEncoding("utf8").on("data", (data: string) => {
            stderr = (stderr + data).slice(-4096);
          });
          child.stdin.on("error", () => {
            // A provider can reject startup before reading stdin. Its terminal evidence
            // or exit status still determines the outcome.
          });
          child.once("error", () => {
            spawnFailed = !child.pid;
          });
          child.once("close", (code, signal) => {
            clearTimeout(timeout);
            clearTimeout(force);
            turn.signal?.removeEventListener("abort", abort);
            if (!stopReason && buffer.trim()) {
              try {
                frame(buffer);
              } catch {
                stopReason = {
                  outcome: "unknown",
                  reason: "Claude Code returned invalid session, policy, or stream evidence.",
                };
              }
            }
            const telemetry = {
              ...(model ? { model } : {}),
              ...(terminal ? usageEvidence(terminal) : {}),
            };
            const finish = (result: AgentTurnResult) => resolve({ ...result, ...telemetry });
            if (stopReason) return finish(stopReason);
            if (spawnFailed)
              return finish({ outcome: "failed", reason: "Could not launch the Claude Code CLI." });
            if (signal)
              return finish({
                outcome: "interrupted",
                reason: "The Claude Code process was terminated.",
              });
            const details = diagnostic(
              [stderr, terminal?.result, terminal?.errors]
                .flat()
                .filter((value) => typeof value === "string")
                .join("\n"),
            );
            if (terminal?.is_error === true && typeof terminal.subtype === "string")
              return finish({
                outcome: "failed",
                reason: details ?? "Claude Code reported a turn error.",
              });
            if (
              !initialized ||
              code !== 0 ||
              terminal?.subtype !== "success" ||
              terminal.is_error !== false
            )
              return finish({
                outcome: "unknown",
                reason: details ?? "Claude Code exited without verified completion.",
              });
            if (Array.isArray(terminal.permission_denials) && terminal.permission_denials.length)
              return finish({
                outcome: "failed",
                reason: "Claude Code reported denied tool calls.",
              });
            if (turn.outputSchema !== undefined && !Object.hasOwn(terminal, "structured_output"))
              return finish({
                outcome: "failed",
                reason: "Claude Code omitted the requested structured output.",
              });
            const redact = (text: string) => text.replaceAll(apiKey, "[redacted]");
            const response = typeof terminal.result === "string" ? redact(terminal.result) : "";
            const structured =
              turn.outputSchema === undefined
                ? {}
                : {
                    structuredOutput: JSON.parse(
                      JSON.stringify(terminal.structured_output),
                      (_key, value: unknown) => (typeof value === "string" ? redact(value) : value),
                    ),
                  };
            return finish({ outcome: "completed", response, ...structured });
          });
          child.stdin.end(turn.prompt);
        });
      },
    };
  }
  return {
    startSession: ({ workingDirectory }) => open(workingDirectory),
    resumeSession({ workingDirectory }, reference) {
      if (reference.provider !== claudeProvider || !claudeSessionId.test(reference.id))
        throw new Error("A Claude Code session reference is required.");
      return open(workingDirectory, reference.id);
    },
  };
}
