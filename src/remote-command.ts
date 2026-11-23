import { once } from "node:events";
import { readFileSync } from "node:fs";
import { localAgentWorker } from "./agent-command.ts";
import { parseAgentConfig } from "./agent-config.ts";
import { createRemoteServer, remoteClient, remoteControllerUrl } from "./remote-http.ts";
import {
  capabilities,
  path,
  placement,
  providerName,
  record,
  sha,
  string,
  workerId,
} from "./remote-protocol.ts";
import { runRemoteWorker, type RemoteProfile } from "./remote-worker.ts";
import { WorkflowStore } from "./store.ts";
import { createWorktreeManager } from "./worktree.ts";

function integer(value: unknown, min: number, max: number) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`Expected an integer from ${min} to ${max}.`);
  return value;
}

async function withSignals(run: (signal: AbortSignal) => Promise<void>) {
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    await run(abort.signal);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

async function serve(config: Record<string, unknown>, dbPath: string, signal: AbortSignal) {
  const principals = new Map<string, Buffer>();
  const digests = new Set<string>();
  for (const [name, value] of Object.entries(record(config.workers))) {
    const hash = string(value, 64);
    if (!/^[0-9a-f]{64}$/.test(hash) || digests.has(hash))
      throw new Error("Use a distinct SHA-256 token digest for each worker.");
    principals.set(workerId(name), Buffer.from(hash, "hex"));
    digests.add(hash);
  }
  if (!principals.size) throw new Error("Configure at least one worker principal.");
  const port = integer(config.port ?? 8788, 1, 65535);
  const store = new WorkflowStore(dbPath);
  const remote = store.remoteWorkers();
  const report = (error: unknown) =>
    console.error(
      JSON.stringify({
        event: "remote_controller_error",
        kind: error instanceof Error ? error.name : "Error",
      }),
    );
  const server = createRemoteServer(remote, principals, report);
  let sweep: NodeJS.Timeout | undefined;
  try {
    remote.expire();
    server.listen(port, "127.0.0.1");
    await once(server, "listening");
    console.info(JSON.stringify({ event: "remote_controller_listening", port }));
    sweep = setInterval(() => {
      try {
        remote.expire();
      } catch (error) {
        report(error);
      }
    }, 1000);
    if (!signal.aborted)
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
  } finally {
    clearInterval(sweep);
    if (server.listening)
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    store.close();
  }
}

async function work(config: Record<string, unknown>, signal: AbortSignal) {
  const token = process.env.SWITCHYARD_WORKER_TOKEN ?? "";
  delete process.env.SWITCHYARD_WORKER_TOKEN;
  const id = workerId(config.id);
  const request = remoteClient(remoteControllerUrl(config.controller), id, token);
  if (!Array.isArray(config.profiles) || !config.profiles.length || config.profiles.length > 64)
    throw new Error("Configure one to 64 worker profiles.");
  const profiles = config.profiles.map((value): RemoteProfile => {
    const input = record(value);
    const profile = placement(input);
    const location = {
      repositoryDirectory: path(input.repositoryDirectory),
      worktreeRoot: path(input.worktreeRoot),
    };
    const worker = localAgentWorker({ ...location, ...parseAgentConfig(input), readOnly: true });
    return {
      ...profile,
      worker,
      locate: (target) => createWorktreeManager(location).locate(target),
    };
  });
  const advertised = capabilities({
    platform: process.platform,
    architecture: process.arch,
    isolation: "linked-worktree",
    sandbox: "read-only",
    concurrency: 1,
    profiles: profiles.map(({ repository, provider, model }) => ({ repository, provider, model })),
  });
  await runRemoteWorker({
    capabilities: advertised,
    profiles,
    request,
    signal,
    log: (event) => console.info(JSON.stringify({ workerId: id, ...event })),
  });
}

export async function runRemoteCommand(args: string[], dbPath: string): Promise<boolean> {
  const [command, filename] = args;
  if (command === "--remote-status") {
    if (args.length !== 1) throw new Error("Usage: --remote-status");
    const store = new WorkflowStore(dbPath);
    try {
      console.info(JSON.stringify(store.remoteWorkers().status()));
    } finally {
      store.close();
    }
    return true;
  }
  if (
    command !== "--remote-controller" &&
    command !== "--remote-worker" &&
    command !== "--remote-turn"
  )
    return false;
  if (args.length !== 2 || !filename) throw new Error(`Usage: ${command} CONFIG.json`);
  let config: Record<string, unknown>;
  try {
    config = record(JSON.parse(readFileSync(filename, "utf8")));
  } catch {
    throw new Error("Expected a readable JSON configuration object.");
  }
  if (command === "--remote-controller")
    await withSignals((signal) => serve(config, dbPath, signal));
  else if (command === "--remote-worker") await withSignals((signal) => work(config, signal));
  else {
    const {
      operationId,
      workflowId,
      branch,
      expectedPullRequestHead,
      expectedHead,
      prompt,
      provider,
      model,
    } = config;
    const parsedBranch = string(branch);
    if (!/^(feat|fix|docs|refactor|test|chore)\//.test(parsedBranch))
      throw new Error("Expected a semantic workflow branch.");
    const store = new WorkflowStore(dbPath);
    try {
      const operation = store.remoteWorkers().enqueue(
        {
          operationId: string(operationId),
          workflowId: string(workflowId),
          branch: parsedBranch,
          expectedPullRequestHead: sha(expectedPullRequestHead),
          expectedHead: sha(expectedHead),
          prompt: string(prompt, 32_000),
        },
        { provider: providerName(provider), model: string(model, 128) },
        integer(config.timeoutMs ?? 900_000, 1000, 3_600_000),
      );
      console.info(
        JSON.stringify({
          operationId: operation.intent.operationId,
          status: operation.status,
          error: operation.error,
        }),
      );
      if (operation.error) process.exitCode = 1;
    } finally {
      store.close();
    }
  }
  return true;
}
