import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseAgentConfig, type AgentConfig } from "./agent-config.ts";
import { createAgentController } from "./agent-controller.ts";
import type { AgentOperationWorker, AgentRuntime, AgentTurnRequest } from "./agent-operation.ts";
import { createClaudeAgent } from "./claude-agent.ts";
import { claudeRuntime, claudeSessionCheckpoint } from "./claude-runtime.ts";
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
    const agent = parseAgentConfig(config);
    const {
      repositoryDirectory,
      worktreeRoot,
      operationId,
      workflowId,
      branch,
      expectedPullRequestHead,
      expectedHead,
      prompt,
    } = config as Record<(typeof fields)[number], string>;
    const request: AgentTurnRequest = {
      operationId,
      workflowId,
      branch,
      expectedPullRequestHead,
      expectedHead,
      prompt,
    };
    const controller = createAgentController(
      store,
      localAgentWorker({ repositoryDirectory, worktreeRoot, ...agent }),
    );
    const abort = new AbortController();
    const stop = () => abort.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      const operation = await controller.runTurn(request, abort.signal);
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
  readOnly = false,
}: {
  repositoryDirectory: string;
  worktreeRoot: string;
  codexHome: string;
  model: string;
  readOnly?: boolean;
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
        readOnly,
        codexHome: identity.home,
        ...(apiKey ? { apiKey } : {}),
      });
      return createLocalAgentExecution(
        worktrees,
        agent,
        (id, path) => codexSessionCheckpoint(identity.home, id, path),
        readOnly,
      ).execute(input);
    },
  };
}

export function localAgentWorker(
  config: AgentConfig & {
    repositoryDirectory: string;
    worktreeRoot: string;
    allowedPaths?: string[];
    readOnly?: boolean;
  },
): AgentOperationWorker {
  if (config.provider !== "claude-code") return localCodexWorker(config);
  const { model, claude, repositoryDirectory, worktreeRoot, allowedPaths, readOnly } = config;
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  let identity: ReturnType<typeof claudeRuntime>;
  const configurationId = createHash("sha256")
    .update(
      JSON.stringify([
        repositoryDirectory,
        worktreeRoot,
        config.provider,
        model,
        claude,
        allowedPaths,
      ]),
    )
    .digest("hex");
  return {
    configurationId,
    runtime: () => (identity = claudeRuntime(model, claude, apiKey)).runtime,
    execute: (input) => {
      const worktrees = createWorktreeManager({ repositoryDirectory, worktreeRoot });
      const agent = createClaudeAgent(
        {
          ...claude,
          ...identity,
          home: identity.runtime.home,
          model,
          ...(readOnly ? { readOnly } : {}),
          ...(allowedPaths === undefined ? {} : { allowedPaths }),
        },
        apiKey!,
      );
      return createLocalAgentExecution(
        worktrees,
        agent,
        (id, path) => claudeSessionCheckpoint(identity.runtime.home, id, path),
        readOnly,
      ).execute(input);
    },
  };
}
