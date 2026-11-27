import { setTimeout as delay } from "node:timers/promises";
import { workflowKey, type loadConfig } from "./config.ts";
import { createController } from "./controller.ts";
import type { GitHubReader, PullRequestTarget } from "./github-api.ts";
import {
  GitHubAuthenticationError,
  GitHubDrainError,
  GitHubRateLimitError,
  GitHubTransientError,
} from "./github-app.ts";
import { createReconciler, PullRequestHeadChangedError } from "./reconcile.ts";
import { localProcessAlive, type WorkflowStore } from "./store.ts";

function prStatus(store: WorkflowStore, target: PullRequestTarget) {
  const workflow = store.findWorkflow(target.repository, target.pullRequest);
  if (!workflow) return { state: "unobserved" as const };
  const attention =
    workflow.state === "escalated" || (workflow.state === "stopped" && !workflow.closedByGitHub)
      ? workflow.state
      : null;
  return {
    workflowId: workflow.id,
    state: workflow.state,
    headSha: workflow.headSha,
    attention,
    reason: workflow.escalationReason,
  };
}

export function workerStatus(store: WorkflowStore) {
  const record = store.workerRecord();
  if (!record) return { state: "never_started", pullRequests: [] };
  const { targets, ...worker } = record;
  return {
    ...worker,
    state: worker.stoppedAt ? "stopped" : localProcessAlive(worker.pid) ? "running" : "interrupted",
    pullRequests: targets.map((target) => ({
      repository: target.repository,
      pullRequest: target.pullRequest,
      ...prStatus(store, target),
    })),
  };
}

function failureKind(error: unknown) {
  if (error instanceof GitHubAuthenticationError) return "github_authentication";
  if (error instanceof GitHubDrainError) return "interrupted";
  if (error instanceof PullRequestHeadChangedError) return "observation_changed";
  if (error instanceof GitHubRateLimitError) return "github_rate_limited";
  if (error instanceof GitHubTransientError) return "github_transient";
  return "error";
}

export async function runUnattended({
  store,
  config,
  reader,
  signal,
  log,
  now = Date.now,
  wait = async (ms, signal) => {
    await delay(ms, undefined, { signal });
  },
}: {
  store: WorkflowStore;
  config: ReturnType<typeof loadConfig>;
  reader: GitHubReader;
  signal: AbortSignal;
  log: (entry: Record<string, unknown>) => void;
  now?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}) {
  const at = () => new Date(now()).toISOString();
  const { targets, requiredChecks, reconcileIntervalMs } = config;
  if (reconcileIntervalMs <= 0)
    throw new Error("The unattended worker requires a positive polling interval.");
  const claim = store.claimWorker(targets, reconcileIntervalMs, at());
  if (!claim) throw new Error("An unattended worker already owns this SQLite database.");
  const workerId = claim.record.id;
  function report(event: string, fields: Record<string, unknown> = {}) {
    log({ timestamp: at(), workerId, event, ...fields });
  }
  try {
    report("worker_started", {
      pid: process.pid,
      targets,
      pollIntervalMs: reconcileIntervalMs,
      interruptedRun: claim.interruptedRun,
    });
    const reconcile = createReconciler(
      store,
      reader,
      (target) => requiredChecks.get(workflowKey(target)) ?? null,
    );
    const controller = createController({
      store,
      targets,
      reconcileIntervalMs,
      now,
      signal,
      pollOnly: true,
      reportError: () => report("controller_attention"),
      async reconcile(target) {
        const context = { repository: target.repository, pullRequest: target.pullRequest };
        try {
          await reconcile(target, signal);
          report("reconciliation", { ...context, outcome: "completed" });
        } catch (error) {
          report("reconciliation", { ...context, outcome: failureKind(error) });
          if (error instanceof GitHubDrainError && signal.aborted) throw error;
          report("target_failed", {
            ...context,
            ...prStatus(store, target),
            installationId: target.installationId,
            ...(error instanceof GitHubAuthenticationError
              ? { httpStatus: error.status, retryAt: error.retryAt }
              : {}),
            stage: "reconciliation",
            outcome: failureKind(error),
          });
          throw error;
        }
      },
    });
    while (!signal.aborted) {
      store.updateWorker(workerId, { lastPollStartedAt: at() });
      report("poll_started");
      const before = targets.map((target) => prStatus(store, target));
      const succeeded = await controller.runPass();
      targets.forEach((target, index) => {
        const previous = before[index];
        const after = prStatus(store, target);
        if (JSON.stringify(previous) === JSON.stringify(after)) return;
        const context = { repository: target.repository, pullRequest: target.pullRequest };
        report("pr_changed", { ...context, from: previous, ...after });
        if ("attention" in after && after.attention)
          report("operator_attention", { ...context, ...after });
      });
      if (signal.aborted) {
        report("poll_interrupted");
        break;
      }
      store.updateWorker(workerId, { lastPollFinishedAt: at(), lastPollSucceeded: succeeded });
      report("poll_finished", { succeeded });
      try {
        await wait(reconcileIntervalMs, signal);
      } catch (error) {
        if (!signal.aborted || !(error instanceof Error) || error.name !== "AbortError")
          throw error;
      }
    }
  } finally {
    store.updateWorker(workerId, { stoppedAt: at() });
    report("worker_stopped", { outcome: signal.aborted ? "signal" : "error" });
  }
}
