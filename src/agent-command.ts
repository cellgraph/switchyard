import { randomUUID } from "node:crypto";
import { readFileSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadNamedAgent } from "./agent-config.ts";
import { createAgentController } from "./agent-controller.ts";
import type { ExecutionIntent } from "./agent-store.ts";
import { createRexExecution } from "./rex-execution.ts";
import { WorkflowStore } from "./store.ts";

const usage = [
  "agent run --provider codex|claude-code [--cwd DIR] [--model MODEL] [--config-dir DIR] --prompt FILE [--schema FILE]",
  "agent run --agent NAME --agents FILE --prompt FILE [--schema FILE]",
  "agent run --session SESSION_ID --prompt FILE [--schema FILE]",
  "agent status EXECUTION_ID",
  "agent inspect EXECUTION_ID",
  "agent cancel EXECUTION_ID",
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
        agent: { type: "string" },
        agents: { type: "string" },
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
    const { provider, agent, agents, cwd, model, session, prompt, schema } = values;
    const configDirectory = values["config-dir"];
    const inline = [provider, cwd, model, configDirectory].some((value) => value !== undefined);
    if (
      !prompt ||
      (session !== undefined && (!session || inline || agent !== undefined)) ||
      (agent !== undefined && (!agent || !agents || inline)) ||
      (agent === undefined && agents !== undefined)
    )
      throw new Error(usage);
    const id = values.execution ?? randomUUID();
    const assignmentId = values.assignment ?? id;
    let intent: ExecutionIntent;
    if (session) {
      intent = { id, assignmentId, sessionId: session };
    } else if (agent) {
      intent = { id, assignmentId, ...loadNamedAgent(agents!, agent) };
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

  if (
    (!(command === "status" || command === "inspect" || command === "cancel") ||
      rest.length !== 1) &&
    (command !== "recover" || rest.length !== 0)
  )
    throw new Error(usage);
  const store = new WorkflowStore(dbPath);
  try {
    const executions = store.agentExecutions();
    const remote = createRexExecution(executions);
    if (command === "recover") {
      const unknownExecutions = executions.recover();
      const remoteExecutions = await remote.recover();
      console.info(
        JSON.stringify({
          unknownExecutions,
          ...(remoteExecutions.length ? { remoteExecutions } : {}),
        }),
      );
    } else if (command === "inspect") {
      console.info(JSON.stringify(await remote.inspect(rest[0]!)));
    } else if (command === "cancel") {
      const result = await remote.cancel(rest[0]!);
      console.info(JSON.stringify(result));
      if (result.interruption !== "requested") process.exitCode = 1;
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
