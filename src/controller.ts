import type { PullRequestTarget } from "./github-api.ts";
import {
  GitHubRateLimitError,
  retireInactiveGitHubRetry,
  type GitHubRateLimits,
} from "./github-app.ts";
import { isReconciliationTerminal } from "./reconcile.ts";
import type { WorkflowStore } from "./store.ts";
import { readReconcileHint } from "./webhook.ts";

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown controller error.";
}

export function createGitHubRetryRetirement(
  store: WorkflowStore,
  targets: readonly PullRequestTarget[],
  rateLimits: GitHubRateLimits = store.githubRateLimits(),
): () => void {
  return () =>
    retireInactiveGitHubRetry(
      rateLimits,
      targets,
      (target) =>
        !isReconciliationTerminal(store.findWorkflow(target.repository, target.pullRequest)),
    );
}

export function createController({
  store,
  targets,
  reconcile,
  reportError,
  reconcileIntervalMs,
  now = Date.now,
  retireInactiveRetry = createGitHubRetryRetirement(store, targets),
}: {
  store: WorkflowStore;
  targets: PullRequestTarget[];
  reconcile: (target: PullRequestTarget) => Promise<void>;
  reportError: (message: string) => void;
  reconcileIntervalMs: number;
  now?: () => number;
  retireInactiveRetry?: () => void;
}) {
  let nextSweep = 0;
  let running: Promise<boolean> | undefined;

  function deliveryTargets(payload: unknown, workflowId: string | null): PullRequestTarget[] {
    if (workflowId !== null) {
      const identity = store.getWorkflow(workflowId)?.identity;
      if (!identity) return [];
      return targets.filter(
        (target) =>
          target.repository === identity.repository.toLowerCase() &&
          target.pullRequest === identity.pullRequest,
      );
    }
    const hint = readReconcileHint(payload);
    if (hint === undefined) return targets;
    if (hint === null) return [];
    return targets.filter(
      (target) =>
        target.repository === hint.repository &&
        target.installationId === hint.installationId &&
        (hint.pullRequest === null || hint.pullRequest === target.pullRequest),
    );
  }

  async function pass(): Promise<boolean> {
    retireInactiveRetry();
    const observations = new Map<PullRequestTarget, Promise<void>>();
    async function reconcileTargets(
      selected: PullRequestTarget[],
    ): Promise<{ failures: string[]; retryAt: number }> {
      const failures: string[] = [];
      let retryAt = 0;
      for (const target of selected) {
        try {
          let observation = observations.get(target);
          if (!observation) {
            observation = reconcile(target);
            observations.set(target, observation);
          }
          await observation;
        } catch (error) {
          failures.push(`${target.repository}#${target.pullRequest}: ${describeError(error)}`);
          if (error instanceof GitHubRateLimitError) retryAt = Math.max(retryAt, error.retryAt);
        }
      }
      return { failures, retryAt };
    }

    let success = true;
    for (const deliveryId of store.dueDeliveryIds(now(), 25)) {
      try {
        let retryAt = 0;
        await store.processDelivery(
          deliveryId,
          async (payload, workflowId) => {
            const result = await reconcileTargets(deliveryTargets(payload, workflowId));
            retryAt = result.retryAt;
            if (result.failures.length) throw new Error(result.failures.join(", "));
          },
          () => Math.max(now() + 30_000, retryAt),
        );
      } catch (error) {
        success = false;
        reportError(`Delivery ${deliveryId} failed: ${describeError(error)}`);
      }
    }
    if (now() >= nextSweep) {
      const { failures } = await reconcileTargets(targets);
      nextSweep = reconcileIntervalMs > 0 ? now() + reconcileIntervalMs : Infinity;
      for (const failure of failures) reportError(`Periodic reconciliation failed for ${failure}`);
      if (failures.length) success = false;
    }
    return success;
  }

  return {
    runPass(): Promise<boolean> {
      running ??= pass().finally(() => {
        running = undefined;
      });
      return running;
    },
  };
}
