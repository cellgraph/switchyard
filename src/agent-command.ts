import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createAgentController } from "./agent-controller.ts";
import type { AgentOperationWorker, AgentRuntime, AgentTurnRequest } from "./agent-operation.ts";
import { createCodexAgent } from "./codex-agent.ts";
import { codexRuntime, codexSessionCheckpoint } from "./codex-runtime.ts";
import { object } from "./github-data.ts";
import { createLocalAgentExecution } from "./local-agent-execution.ts";
import { WorkflowStore } from "./store.ts";
import { createWorktreeManager } from "./worktree.ts";

export async function runAgentCommand(args: string[], dbPath: string): Promise<boolean> {
  const [command, argument] = args;
  if (command !== "--agent-turn" && command !== "--agent-status" && command !== "--recover")
    return false;
  if (args.length !== (command === "--recover" ? 1 : 2))
    throw new Error("Usage: --agent-turn INPUT.json, --agent-status OPERATION_ID, or --recover");
  const store = new WorkflowStore(dbPath);
  try {
    if (command === "--recover") {
      console.info(JSON.stringify(store.recover()));
      return true;
    }
    if (command === "--agent-status") {
      const operations = store.agentOperations();
      const operation = operations.get(argument!);
      if (!operation) throw new Error("Agent operation does not exist.");
      console.info(
        JSON.stringify({ operation, session: operations.session(operation.intent.workflowId) }),
      );
      return true;
    }

    let config;
    try {
      config = object(JSON.parse(readFileSync(argument!, "utf8")));
    } catch {
      throw new Error("Agent request must be a readable JSON file.");
    }
    if (!config) throw new Error("Agent request must be a JSON object.");
    const fields = [
      "repositoryDirectory",
      "worktreeRoot",
      "codexHome",
      "model",
      "operationId",
      "workflowId",
      "branch",
      "expectedPullRequestHead",
      "expectedHead",
      "prompt",
    ] as const;
    for (const field of fields) {
      if (typeof config[field] !== "string" || !config[field].trim())
        throw new Error(`Agent request requires ${field}.`);
    }
    const { repositoryDirectory, worktreeRoot, codexHome, model, ...request } = config as Record<
      (typeof fields)[number],
      string
    >;
    const controller = createAgentController(
      store,
      localCodexWorker({ repositoryDirectory, worktreeRoot, codexHome, model }),
    );
    const abort = new AbortController();
    const stop = () => abort.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      const operation = await controller.runTurn(request satisfies AgentTurnRequest, abort.signal);
      console.info(JSON.stringify(operation));
      if (operation.status !== "completed" || operation.error) process.exitCode = 1;
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
    return true;
  } finally {
    store.close();
  }
}

export function localCodexWorker({
  repositoryDirectory,
  worktreeRoot,
  codexHome,
  model,
}: {
  repositoryDirectory: string;
  worktreeRoot: string;
  codexHome: string;
  model: string;
}): AgentOperationWorker {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  let identity: AgentRuntime;
  const configurationId = createHash("sha256")
    .update(JSON.stringify([repositoryDirectory, worktreeRoot, codexHome, model]))
    .digest("hex");
  return {
    configurationId,
    runtime: () => (identity = codexRuntime(model, codexHome, apiKey)),
    execute: (input) => {
      const worktrees = createWorktreeManager({ repositoryDirectory, worktreeRoot });
      const agent = createCodexAgent({
        model,
        codexHome: identity.home,
        ...(apiKey ? { apiKey } : {}),
      });
      return createLocalAgentExecution(worktrees, agent, (id, path) =>
        codexSessionCheckpoint(identity.home, id, path),
      ).execute(input);
    },
  };
}
