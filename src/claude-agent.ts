import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  authenticationFailure,
  validNativeId,
  type AgentAdapter,
  type AgentContext,
  type AgentResult,
  type AgentTurn,
} from "./agent.ts";

export function createClaudeAgent({
  workingDirectory,
  model,
  reasoningEffort,
  configDirectory,
}: AgentContext): AgentAdapter {
  async function run(turn: AgentTurn, nativeId?: string): Promise<AgentResult> {
    if (turn.signal?.aborted)
      return { outcome: "not_started", reason: "Canceled before Claude Code launch." };

    const args = ["--print", "--output-format", "stream-json", "--verbose"];
    if (model !== undefined) args.push("--model", model);
    if (reasoningEffort !== undefined) args.push("--effort", reasoningEffort);
    if (nativeId) args.push("--resume", nativeId);
    if (turn.outputSchema !== undefined)
      args.push("--json-schema", JSON.stringify(turn.outputSchema));

    let child;
    try {
      child = spawn("claude", args, {
        cwd: workingDirectory,
        env: configDirectory ? { ...process.env, CLAUDE_CONFIG_DIR: configDirectory } : process.env,
        signal: turn.signal,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      return { outcome: "not_started", reason: "Could not launch the Claude Code CLI." };
    }
    const exit = new Promise<void>((resolve) => child.once("close", () => resolve()));
    let launched = false;
    let processError = false;
    let stderr = "";
    child.once("spawn", () => {
      launched = true;
    });
    child.once("error", () => {
      processError = true;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4096);
    });
    // Startup rejection can close stdin while the prompt is being sent.
    child.stdin.on("error", () => {});
    child.stdin.end(turn.prompt);

    let invalidEvidence = false;
    let sessionConfirmed = false;
    let terminal: Record<string, unknown> | undefined;
    try {
      for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
        if (!line.trim()) continue;
        const event = JSON.parse(line) as Record<string, unknown> | null;
        if (!event || typeof event.type !== "string") {
          invalidEvidence = true;
          continue;
        }
        if (event.type === "result" || (event.type === "system" && event.subtype === "init")) {
          if (!validNativeId(event.session_id) || (nativeId && event.session_id !== nativeId)) {
            invalidEvidence = true;
            continue;
          }
          if (!sessionConfirmed) turn.onSession(event.session_id);
          nativeId = event.session_id;
          sessionConfirmed = true;
        }
        if (event.type === "result") {
          if (terminal) invalidEvidence = true;
          terminal = event;
        }
      }
    } catch {
      invalidEvidence = true;
      // Keep draining stdout while waiting for the process to close.
      child.stdout.resume();
    }
    await exit;
    if (processError && !launched)
      return { outcome: "not_started", reason: "Could not launch the Claude Code CLI." };
    const authFailed =
      authenticationFailure(stderr) ||
      authenticationFailure(terminal?.result) ||
      (Array.isArray(terminal?.errors) && terminal.errors.some(authenticationFailure));

    if (invalidEvidence)
      return { outcome: "unknown", reason: "Claude Code reported invalid execution evidence." };
    if (terminal?.is_error === true)
      return {
        outcome: "failed",
        reason: authFailed
          ? "Claude Code could not authenticate."
          : "Claude Code reported a turn failure.",
      };
    if (!sessionConfirmed || terminal?.subtype !== "success" || terminal.is_error !== false)
      return {
        outcome: "unknown",
        reason: turn.signal?.aborted
          ? "Cancellation was requested without a complete Claude Code result."
          : authFailed
            ? "Claude Code reported an authentication error without a confirmed terminal result."
            : "Claude Code did not report a complete terminal result.",
      };
    if (typeof terminal.result !== "string")
      return { outcome: "failed", reason: "Claude Code omitted the required response." };
    if (turn.outputSchema !== undefined && !Object.hasOwn(terminal, "structured_output"))
      return { outcome: "failed", reason: "Claude Code omitted the required structured output." };
    return {
      outcome: "completed",
      response: terminal.result,
      ...(turn.outputSchema === undefined ? {} : { structuredOutput: terminal.structured_output }),
    };
  }

  return { start: (turn) => run(turn), resume: (id, turn) => run(turn, id) };
}
