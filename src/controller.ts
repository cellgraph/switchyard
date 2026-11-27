import type { GitHubReader, PullRequestTarget } from "./github-api.ts";
import {
  GitHubDrainError,
  GitHubRateLimitError,
  isSecondaryLimitPaused,
  GitHubTransientError,
  pullRequestRetryKey,
  repositoryRetryKey,
  retireInactiveGitHubRetry,
  tokenRetryKey,
  type GitHubRepository,
} from "./github-app.ts";
import { PullRequestHeadChangedError } from "./reconcile.ts";
import { createRexExecution } from "./rex-execution.ts";
import { localProcessAlive, type WorkflowStore } from "./store.ts";
import type { ReconcileHint } from "./webhook.ts";
import { isOperatorHeld } from "./workflow.ts";

const retryDelayMs = 30_000;

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown controller error.";
}

export function createGitHubRetryOwnerCheck(
  store: WorkflowStore,
  repositories: readonly GitHubRepository[],
) {
  return (key: string): boolean =>
    repositories.some((target) => {
      if (key === repositoryRetryKey(target) || key === tokenRetryKey(target)) return true;
      const prefix = `pr:${target.installationId}:${target.repository}:`;
      if (!key.startsWith(prefix)) return false;
      const workflow = store.findWorkflow(target.repository, Number(key.slice(prefix.length)));
      // A PR stopped by GitHub is still observed for reopen or renewed eligibility.
      return !isOperatorHeld(workflow) && workflow?.githubStatus !== "merged";
    });
}

export function workerStatus(store: WorkflowStore) {
  const worker = store.workerRecord();
  if (!worker) return { state: "never_started", pullRequests: [] };
  return {
    ...worker,
    state: worker.stoppedAt ? "stopped" : localProcessAlive(worker.pid) ? "running" : "interrupted",
    pullRequests: worker.repositories.flatMap(({ repository }) =>
      store.listWorkflows(repository).map((workflow) => ({
        ...workflow.identity,
        workflowId: workflow.id,
        state: workflow.state,
        githubStatus: workflow.githubStatus,
        headSha: workflow.headSha,
        attention: isOperatorHeld(workflow) ? workflow.state : null,
        reason: workflow.escalationReason,
      })),
    ),
  };
}

export function createController({
  store,
  repositories,
  github,
  reconcile,
  reportError,
  signal,
  now = Date.now,
}: {
  store: WorkflowStore;
  repositories: readonly GitHubRepository[];
  github: Pick<GitHubReader, "listOpenPullRequests" | "completeReconciliation">;
  reconcile: (target: PullRequestTarget, signal?: AbortSignal) => Promise<void>;
  reportError: (message: string) => void;
  signal?: AbortSignal;
  now?: () => number;
}) {
  const enabled = new Map(repositories.map((target) => [target.repository, target]));
  const isRetryOwnerActive = createGitHubRetryOwnerCheck(store, repositories);
  const rateLimits = store.githubRateLimits();
  const retries = store.reconciliationRetries();
  let pending = new Map<GitHubRepository, { discover: boolean; pullRequests: Set<number> }>();
  let wake = Promise.withResolvers<void>();
  let running: Promise<boolean> | undefined;

  async function attempt(
    target: GitHubRepository,
    pullRequest: number | undefined,
    observe: () => Promise<void>,
  ): Promise<boolean> {
    if (signal?.aborted) return false;
    const key =
      pullRequest === undefined
        ? repositoryRetryKey(target)
        : pullRequestRetryKey(target, pullRequest);
    const label =
      pullRequest === undefined ? target.repository : `${target.repository}#${pullRequest}`;
    const deadline = retries.get(key) ?? 0;
    if (deadline > now()) {
      reportError(
        `${label}: GitHub reconciliation deferred until ${new Date(deadline).toISOString()}.`,
      );
      return false;
    }
    try {
      await observe();
      retries.delete(key);
      return true;
    } catch (error) {
      if (error instanceof GitHubDrainError && signal?.aborted) return false;
      if (error instanceof GitHubTransientError || error instanceof PullRequestHeadChangedError)
        retries.extend(
          [key],
          (error instanceof GitHubTransientError ? error.retryAt : undefined) ??
            now() + retryDelayMs,
        );
      const retryAt =
        error instanceof GitHubRateLimitError || error instanceof GitHubTransientError
          ? error.retryAt
          : undefined;
      const deadline =
        retryAt !== undefined && retryAt > now()
          ? ` Retry deadline ${new Date(retryAt).toISOString()}.`
          : "";
      reportError(`${label}: ${describeError(error)}${deadline}`);
      return false;
    }
  }

  async function pass(selection: typeof pending): Promise<boolean> {
    const abandoned = store.agentExecutions().recover();
    if (abandoned) reportError(`Recovered ${abandoned} agent execution(s) with unknown outcomes.`);
    retries.prune(now());
    retireInactiveGitHubRetry(rateLimits, isRetryOwnerActive);
    const secondary = rateLimits.get("secondary");
    if (secondary && (isSecondaryLimitPaused(secondary) || secondary.retryAt > now())) {
      reportError(
        isSecondaryLimitPaused(secondary)
          ? new GitHubRateLimitError(secondary.retryAt, undefined, true).message
          : `GitHub reconciliation deferred until ${new Date(secondary.retryAt).toISOString()}.`,
      );
      return false;
    }
    let succeeded = true;
    for (const [target, { discover, pullRequests }] of selection) {
      if (signal?.aborted) return false;
      if (discover) {
        for (const workflow of store.listWorkflows(target.repository)) {
          if (workflow.githubStatus !== "merged") pullRequests.add(workflow.identity.pullRequest);
        }
        const discovered = await attempt(target, undefined, async () => {
          for (const number of await github.listOpenPullRequests(target, signal))
            pullRequests.add(number);
          github.completeReconciliation(target);
          // An untracked PR absent from a complete listing has no active retry owner.
          const prefix = `pr:${target.installationId}:${target.repository}:`;
          retireInactiveGitHubRetry(
            rateLimits,
            (key) =>
              isRetryOwnerActive(key) &&
              (!key.startsWith(prefix) || pullRequests.has(Number(key.slice(prefix.length)))),
          );
        });
        if (!discovered) succeeded = false;
      }
      for (const pullRequest of pullRequests) {
        if (signal?.aborted) return false;
        if (
          !(await attempt(target, pullRequest, () => reconcile({ ...target, pullRequest }, signal)))
        )
          succeeded = false;
      }
    }
    retireInactiveGitHubRetry(rateLimits, isRetryOwnerActive);
    return succeeded && !signal?.aborted;
  }

  function schedule(target: GitHubRepository, pullRequest: number | null) {
    let selection = pending.get(target);
    if (!selection) {
      selection = { discover: false, pullRequests: new Set() };
      pending.set(target, selection);
    }
    if (pullRequest === null) selection.discover = true;
    else selection.pullRequests.add(pullRequest);
    wake.resolve();
  }

  return {
    notify(hint: ReconcileHint) {
      const target = enabled.get(hint.repository);
      if (!target || hint.installationId !== target.installationId || signal?.aborted) return;
      schedule(target, hint.pullRequest);
    },

    scheduleSweep() {
      for (const target of enabled.values()) schedule(target, null);
    },

    async waitForWork() {
      const stop = () => wake.resolve();
      if (pending.size || signal?.aborted) return;
      signal?.addEventListener("abort", stop, { once: true });
      try {
        await wake.promise;
      } finally {
        signal?.removeEventListener("abort", stop);
      }
    },

    runPass() {
      if (running) return running;
      if (signal?.aborted || !pending.size) return Promise.resolve(!signal?.aborted);
      const selection = pending;
      pending = new Map();
      wake = Promise.withResolvers<void>();
      running = pass(selection).finally(() => {
        running = undefined;
      });
      return running;
    },
  };
}

export async function runController({
  controller,
  store,
  repositories,
  reconcileIntervalMs,
  onceOnly,
  signal,
  log,
  now = Date.now,
}: {
  controller: ReturnType<typeof createController>;
  store: WorkflowStore;
  repositories: GitHubRepository[];
  reconcileIntervalMs: number;
  onceOnly: boolean;
  signal: AbortSignal;
  log: (entry: Record<string, unknown>) => void;
  now?: () => number;
}): Promise<boolean> {
  const at = () => new Date(now()).toISOString();
  const claim = store.claimWorker(repositories, reconcileIntervalMs, at());
  if (!claim) throw new Error("A reconciliation worker already owns this SQLite database.");
  const workerId = claim.record.id;
  const report = (event: string, details = {}) =>
    log({ timestamp: at(), workerId, event, ...details });
  const periodic = onceOnly
    ? undefined
    : setInterval(controller.scheduleSweep, reconcileIntervalMs);
  try {
    report("worker_started", {
      pid: process.pid,
      repositories,
      interruptedRun: claim.interruptedRun,
    });
    for (const { execution, observation } of await createRexExecution(
      store.agentExecutions(),
    ).recover(signal))
      report("remote_execution_observed", {
        executionId: execution.id,
        status: execution.status,
        observation,
      });
    controller.scheduleSweep();
    while (!signal.aborted) {
      await controller.waitForWork();
      if (signal.aborted) break;
      store.updateWorker(workerId, { lastPassStartedAt: at() });
      const succeeded = await controller.runPass();
      store.updateWorker(workerId, { lastPassFinishedAt: at(), lastPassSucceeded: succeeded });
      report("reconciliation_finished", { succeeded });
      if (onceOnly) return succeeded;
    }
    return false;
  } finally {
    clearInterval(periodic);
    store.updateWorker(workerId, { stoppedAt: at() });
    report("worker_stopped", { interrupted: signal.aborted });
  }
}
