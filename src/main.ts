import { once } from "node:events";
import { readFileSync } from "node:fs";
import { runAgentCommand } from "./agent-command.ts";
import {
  createController,
  createGitHubRetryOwnerCheck,
  describeError,
  runController,
  workerStatus,
} from "./controller.ts";
import { loadConfig } from "./config.ts";
import { createGitHubReader } from "./github-api.ts";
import {
  createGitHubAppClient,
  resumeGitHubAfterSecondaryLimit,
  type GitHubRepository,
} from "./github-app.ts";
import { positiveInteger } from "./github-data.ts";
import { canReadPullRequestChecks, createReconciler } from "./reconcile.ts";
import { WorkflowStore } from "./store.ts";
import { createWebhookServer } from "./webhook.ts";

function makeReader(store: WorkflowStore, repositories: GitHubRepository[]) {
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
      isRetryOwnerActive: createGitHubRetryOwnerCheck(store, repositories),
      canReadPullRequestChecks: (target, pullRequest) =>
        canReadPullRequestChecks(store, target.repository, pullRequest),
    }),
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dbPath = process.env.SWITCHYARD_DB_PATH ?? "switchyard.sqlite";
  process.umask(0o077);
  if (await runAgentCommand(args, dbPath)) return;
  if (args[0] === "--review-status") {
    const workflowId = args[1];
    if (args.length !== 2 || !workflowId) throw new Error("Usage: --review-status WORKFLOW_ID");
    const store = new WorkflowStore(dbPath);
    try {
      const workflow = store.getWorkflow(workflowId);
      if (!workflow) throw new Error(`Workflow ${workflowId} does not exist.`);
      console.info(
        JSON.stringify({
          workflowId,
          headSha: workflow.headSha,
          reviews: store.reviews().list(workflowId),
        }),
      );
    } finally {
      store.close();
    }
    return;
  }
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
  const configPath = args[onceOnly ? 1 : 0];
  if (!configPath || configPath.startsWith("--") || args.length !== (onceOnly ? 2 : 1))
    throw new Error(
      "Usage: npm start -- [--once] CONFIG.json or npm start -- --worker-status | --resume-github | --review-status WORKFLOW_ID",
    );

  const config = loadConfig(configPath);
  const store = new WorkflowStore(dbPath);
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  const reportError = (message: string) => console.error(message);
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  let server: ReturnType<typeof createWebhookServer> | undefined;

  try {
    const github = makeReader(store, config.repositories);
    const controller = createController({
      store,
      repositories: config.repositories,
      github,
      reconcile: createReconciler(
        store,
        github,
        (target) => config.requiredChecks.get(target.repository) ?? null,
      ),
      reportError,
      signal: abort.signal,
    });

    if (!onceOnly && secret) {
      const port = Number(process.env.SWITCHYARD_WEBHOOK_PORT ?? "3000");
      if (!positiveInteger(port) || port > 65_535) throw new Error("Invalid webhook port.");
      server = createWebhookServer({ secret, notify: controller.notify, reportError });
      server.listen(port, "127.0.0.1");
      await once(server, "listening");
      console.info(`GitHub webhook receiver listening on 127.0.0.1:${port}.`);
    }
    const succeeded = await runController({
      controller,
      store,
      repositories: config.repositories,
      reconcileIntervalMs: config.reconcileIntervalMs,
      onceOnly,
      signal: abort.signal,
      log: (entry) => console.info(JSON.stringify(entry)),
    });
    if (onceOnly && !succeeded) process.exitCode = 1;
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
    }
  }
}

await main().catch((error: unknown) => {
  console.error(describeError(error));
  process.exitCode = 1;
});
