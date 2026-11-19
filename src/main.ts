import { once } from "node:events";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { createController, createGitHubRetryRetirement, describeError } from "./controller.ts";
import { createGitHubReader, type PullRequestTarget } from "./github-api.ts";
import { createGitHubAppClient, resumeGitHubAfterSecondaryLimit } from "./github-app.ts";
import { object, positiveInteger, repositoryName } from "./github-data.ts";
import { createReconciler } from "./reconcile.ts";
import { WorkflowStore } from "./store.ts";
import { createWebhookServer } from "./webhook.ts";

function loadConfig(path: string): { targets: PullRequestTarget[]; reconcileIntervalMs: number } {
  const raw = readFileSync(path, "utf8");
  let config: Record<string, unknown> | undefined;
  try {
    config = object(JSON.parse(raw));
  } catch {
    throw new Error("Switchyard configuration is not valid JSON.");
  }
  if (!Array.isArray(config?.repositories) || !config.repositories.length)
    throw new Error("Configuration requires a non-empty repositories array.");
  const targets: PullRequestTarget[] = [];
  const seen = new Set<string>();
  for (const value of config.repositories as unknown[]) {
    const entry = object(value);
    const repository = repositoryName(entry?.repository);
    const installationId = entry?.installationId;
    const pullRequests = entry?.pullRequests;
    if (
      !repository ||
      !positiveInteger(installationId) ||
      !Array.isArray(pullRequests) ||
      !pullRequests.length ||
      !pullRequests.every(positiveInteger)
    )
      throw new Error(
        "Each repository needs an owner/name, installationId, and positive PR numbers.",
      );
    for (const pullRequest of pullRequests) {
      const id = `${repository}#${pullRequest}`;
      if (seen.has(id)) throw new Error(`Duplicate configured pull request ${id}.`);
      seen.add(id);
      targets.push({ repository, installationId, pullRequest });
    }
  }
  const interval = config.reconcileIntervalMs ?? 60_000;
  if (interval !== 0 && !positiveInteger(interval))
    throw new Error("reconcileIntervalMs must be a non-negative integer.");
  return { targets, reconcileIntervalMs: interval };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dbPath = process.env.SWITCHYARD_DB_PATH ?? "switchyard.sqlite";
  process.umask(0o077);
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
  if (!configPath || args.length !== (onceOnly ? 2 : 1))
    throw new Error(
      "Usage: npm start -- [--once] path/to/config.json or npm start -- --resume-github",
    );

  const config = loadConfig(configPath);
  const clientId = process.env.GITHUB_APP_CLIENT_ID;
  const keyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
  if (!clientId || !keyPath)
    throw new Error("Set GITHUB_APP_CLIENT_ID and GITHUB_APP_PRIVATE_KEY_PATH.");
  const privateKey = readFileSync(keyPath, "utf8");

  const store = new WorkflowStore(dbPath);
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  const reportError = (message: string) => console.error(message);
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let server: ReturnType<typeof createWebhookServer> | undefined;

  try {
    const rateLimits = store.githubRateLimits();
    const retireInactiveRetry = createGitHubRetryRetirement(store, config.targets, rateLimits);
    const reader = createGitHubReader(
      createGitHubAppClient({ clientId, privateKey, rateLimits, retireInactiveRetry }),
    );
    const recovered = store.recover();
    if (recovered.deliveries || recovered.ambiguousOperations)
      console.info(`Recovered SQLite state ${JSON.stringify(recovered)}`);
    const controller = createController({
      ...config,
      store,
      reconcile: createReconciler(store, reader),
      reportError,
      retireInactiveRetry,
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
    }
  }
}

await main().catch((error: unknown) => {
  console.error(describeError(error));
  process.exitCode = 1;
});
