import { fork } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { runAgentCommand } from "./agent-command.ts";
import { createController, createGitHubRetryOwnerCheck, describeError } from "./controller.ts";
import { requiredChecksForCycle } from "./fix-store.ts";
import { runFixCommand } from "./fix-command.ts";
import { loadConfig, workflowKey } from "./config.ts";
import { createGitHubReader, type PullRequestTarget } from "./github-api.ts";
import { createGitHubAppClient, resumeGitHubAfterSecondaryLimit } from "./github-app.ts";
import { positiveInteger } from "./github-data.ts";
import { canReconcilePullRequest, createReconciler } from "./reconcile.ts";
import { runReviewCommand } from "./review-command.ts";
import { WorkflowStore } from "./store.ts";
import { runUnattended, workerStatus } from "./unattended.ts";
import { createWebhookServer } from "./webhook.ts";

function makeReader(store: WorkflowStore, targets: PullRequestTarget[]) {
  const clientId = process.env.GITHUB_APP_CLIENT_ID;
  const keyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
  if (!clientId || !keyPath)
    throw new Error("Set GITHUB_APP_CLIENT_ID and GITHUB_APP_PRIVATE_KEY_PATH.");
  return createGitHubReader(
    createGitHubAppClient({
      clientId,
      privateKey: readFileSync(keyPath, "utf8"),
      rateLimits: store.githubRateLimits(),
      retryDeadlines: store.reconciliationRetries(),
      isRetryOwnerActive: createGitHubRetryOwnerCheck(store, targets),
      canReadPullRequest: (target, pullRequest) =>
        canReconcilePullRequest(store, target.repository, pullRequest),
    }),
  );
}

async function superviseWorker(configPath: string): Promise<void> {
  // The SDK starts Codex in its caller's process group. Keep the worker and
  // its children out of the terminal group and translate Ctrl-C into a drain.
  const child = fork(fileURLToPath(import.meta.url), ["--worker-process", configPath], {
    detached: true,
    stdio: ["inherit", "inherit", "inherit", "ipc"],
  });
  const stop = () => {
    if (child.connected) child.disconnect();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    const [code] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
    if (code !== 0) process.exitCode = code ?? 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dbPath = process.env.SWITCHYARD_DB_PATH ?? "switchyard.sqlite";
  process.umask(0o077);
  if (await runReviewCommand(args, dbPath, (path) => loadConfig(path).targets)) return;
  if (await runAgentCommand(args, dbPath)) return;
  if (await runFixCommand(args, dbPath, makeReader)) return;
  if (args[0] === "--worker-status") {
    if (args.length !== 1) throw new Error("Usage: --worker-status");
    const store = new WorkflowStore(dbPath);
    try {
      console.info(JSON.stringify(workerStatus(store)));
    } finally {
      store.close();
    }
    return;
  }
  if (args.length === 1 && args[0] === "--resume-github") {
    const store = new WorkflowStore(dbPath);
    try {
      const resumed = resumeGitHubAfterSecondaryLimit(store.githubRateLimits());
      console.info(
        resumed
          ? "GitHub retry pause cleared. The last recorded retry deadline still applies."
          : "GitHub retries are already enabled.",
      );
    } finally {
      store.close();
    }
    return;
  }
  const onceOnly = args[0] === "--once";
  const supervised = args[0] === "--worker-process";
  const unattended = supervised || args[0] === "--worker";
  const configPath = args[onceOnly || unattended ? 1 : 0];
  if (!configPath || args.length !== (onceOnly || unattended ? 2 : 1))
    throw new Error(
      "Usage: npm start -- [--once | --worker] CONFIG.json or npm start -- --worker-status | --resume-github",
    );
  if (unattended && !supervised) return superviseWorker(configPath);
  if (supervised && !process.connected) return;

  const config = loadConfig(configPath);
  const store = new WorkflowStore(dbPath);
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  const reportError = (message: string) => console.error(message);
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  if (supervised) process.on("disconnect", stop);
  let server: ReturnType<typeof createWebhookServer> | undefined;

  try {
    const isRetryOwnerActive = createGitHubRetryOwnerCheck(store, config.targets);
    const reader = makeReader(store, config.targets);
    if (unattended) {
      await runUnattended({
        store,
        config,
        reader,
        signal: abort.signal,
        log: (entry) => console.info(JSON.stringify(entry)),
      });
      return;
    }
    const recovered = store.recover();
    if (
      recovered.deliveries ||
      recovered.ambiguousOperations ||
      recovered.unverifiedAgentOperations
    )
      console.info(`Recovered SQLite state ${JSON.stringify(recovered)}`);
    const controller = createController({
      ...config,
      store,
      reconcile: createReconciler(store, reader, (target) =>
        requiredChecksForCycle(
          store.fixes(`${target.repository}#${target.pullRequest}`).read().at(-1),
          config.fixes.get(workflowKey(target))?.requiredChecks ?? null,
        ),
      ),
      reportError,
      reportDeferred: onceOnly,
      isRetryOwnerActive,
    });

    if (!onceOnly && secret) {
      const port = Number(process.env.SWITCHYARD_WEBHOOK_PORT ?? "3000");
      if (!positiveInteger(port) || port > 65_535) throw new Error("Invalid webhook port.");
      server = createWebhookServer({ secret, store, reportError });
      server.listen(port, "127.0.0.1");
      await once(server, "listening");
      console.info(`GitHub webhook receiver listening on 127.0.0.1:${port}.`);
    }
    do {
      const succeeded = await controller.runPass();
      if (onceOnly) {
        if (!succeeded) process.exitCode = 1;
        return;
      }
      try {
        await delay(1000, undefined, { signal: abort.signal });
      } catch (error) {
        if (!abort.signal.aborted) throw error;
      }
    } while (!abort.signal.aborted);
  } finally {
    try {
      if (server?.listening) {
        server.close();
        await once(server, "close");
      }
    } finally {
      store.close();
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      if (supervised) process.removeListener("disconnect", stop);
    }
  }
}

await main().catch((error: unknown) => {
  console.error(describeError(error));
  process.exitCode = 1;
});
