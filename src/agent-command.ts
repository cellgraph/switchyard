import { randomUUID } from "node:crypto";
import { readFileSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createAgentController } from "./agent-controller.ts";
import type { ExecutionIntent } from "./agent-store.ts";
import { WorkflowStore } from "./store.ts";

const usage = [
  "agent run --provider codex|claude-code [--cwd DIR] [--model MODEL] [--config-dir DIR] --prompt FILE [--schema FILE]",
  "agent run --session SESSION_ID --prompt FILE [--schema FILE]",
  "agent status EXECUTION_ID",
  "agent recover",
].join("\n");

export async function runAgentCommand(args: string[], dbPath: string): Promise<boolean> {
  if (args[0] !== "agent") return false;

  const [, command, ...rest] = args;
  if (command === "run") {
    const { values } = parseArgs({
      args: rest,
      options: {
        provider: { type: "string" },
        cwd: { type: "string" },
        model: { type: "string" },
        "config-dir": { type: "string" },
        session: { type: "string" },
        prompt: { type: "string" },
        schema: { type: "string" },
        assignment: { type: "string" },
        execution: { type: "string" },
      },
    });
    const { provider, cwd, model, session, prompt, schema } = values;
    const configDirectory = values["config-dir"];
    if (
      !prompt ||
      (session !== undefined &&
        (!session ||
          provider !== undefined ||
          cwd !== undefined ||
          model !== undefined ||
          configDirectory !== undefined))
    )
      throw new Error(usage);
    const id = values.execution ?? randomUUID();
    const assignmentId = values.assignment ?? id;
    let intent: ExecutionIntent;
    if (session) {
      intent = { id, assignmentId, sessionId: session };
    } else {
      if (provider !== "codex" && provider !== "claude-code") throw new Error(usage);
      intent = {
        id,
        assignmentId,
        context: {
          provider,
          workingDirectory: resolve(cwd ?? "."),
          ...(model === undefined ? {} : { model }),
          ...(configDirectory === undefined ? {} : { configDirectory: resolve(configDirectory) }),
        },
      };
    }
    const promptText = readFileSync(prompt, "utf8");
    let outputSchema: Record<string, unknown> | undefined;
    if (schema !== undefined) {
      const raw = readFileSync(schema, "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error("The response schema must be a JSON object.");
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("The response schema must be a JSON object.");
      outputSchema = parsed as Record<string, unknown>;
    }

    const store = new WorkflowStore(dbPath);
    const abort = new AbortController();
    const stop = () => abort.abort();
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    try {
      writeSync(process.stderr.fd, `Execution ID: ${JSON.stringify(id)}\n`);
      const execution = await createAgentController(store.agentExecutions()).execute({
        ...intent,
        prompt: promptText,
        signal: abort.signal,
        ...(outputSchema === undefined ? {} : { outputSchema }),
      });
      console.info(JSON.stringify(execution));
      if (execution.execution.status !== "completed") process.exitCode = 1;
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      store.close();
    }
    return true;
  }

  if ((command !== "status" || rest.length !== 1) && (command !== "recover" || rest.length !== 0))
    throw new Error(usage);
  const store = new WorkflowStore(dbPath);
  try {
    const executions = store.agentExecutions();
    if (command === "recover") {
      console.info(JSON.stringify({ unknownExecutions: executions.recover() }));
    } else {
      const execution = executions.get(rest[0]!);
      if (!execution) throw new Error("Execution record not found.");
      console.info(JSON.stringify({ execution, session: executions.session(execution.sessionId) }));
    }
  } finally {
    store.close();
  }
  return true;
}
