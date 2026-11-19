import type { PullRequestTarget } from "./github-api.ts";
import {
  belongsToReconciliation,
  GitHubRateLimitError,
  isSecondaryLimitPaused,
  retireInactiveGitHubRetry,
} from "./github-app.ts";
import { canReconcilePullRequest } from "./reconcile.ts";
import type { WorkflowStore } from "./store.ts";
import { readReconcileHint } from "./webhook.ts";

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown controller error.";
}

export function createGitHubRetryOwnerCheck(
  store: WorkflowStore,
  targets: readonly PullRequestTarget[],
) {
  return (key: string): boolean =>
    targets.some(
      (target) =>
        belongsToReconciliation(key, target, target.pullRequest) &&
        canReconcilePullRequest(store, target.repository, target.pullRequest),
    );
}

export function createController({
  store,
  targets,
  reconcile,
  reportError,
  reconcileIntervalMs,
  reportDeferred = false,
  now = Date.now,
  isRetryOwnerActive = createGitHubRetryOwnerCheck(store, targets),
}: {
  store: WorkflowStore;
  targets: PullRequestTarget[];
  reconcile: (target: PullRequestTarget) => Promise<void>;
  reportError: (message: string) => void;
  reconcileIntervalMs: number;
  reportDeferred?: boolean;
  now?: () => number;
  isRetryOwnerActive?: (key: string) => boolean;
}) {
  const rateLimits = store.githubRateLimits();
  const startupDueAt = new Map(targets.map((target) => [target, 0]));
  let nextSweep = 0;
  let running: Promise<boolean> | undefined;

  function needsGitHub(selected: readonly PullRequestTarget[]): boolean {
    return selected.some((target) =>
      canReconcilePullRequest(store, target.repository, target.pullRequest),
    );
  }

  function secondaryDeferral() {
    const secondary = rateLimits.get("secondary");
    if (secondary && (isSecondaryLimitPaused(secondary) || secondary.retryAt > now()))
      return secondary;
    return undefined;
  }

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
    retireInactiveGitHubRetry(rateLimits, isRetryOwnerActive);
    const observations = new Map<PullRequestTarget, Promise<void>>();
    async function reconcileTargets(selected: PullRequestTarget[]) {
      const failures: string[] = [];
      const throttledTargets = new Map<PullRequestTarget, number>();
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
          if (error instanceof GitHubRateLimitError) {
            throttledTargets.set(target, error.retryAt);
            retryAt = Math.max(retryAt, error.retryAt);
          }
        }
      }
      return { failures, retryAt, throttledTargets };
    }

    let success = true;
    const deliveries = store.dueDeliveries(
      now(),
      25,
      secondaryDeferral()
        ? ({ payload, workflowId }) => !needsGitHub(deliveryTargets(payload, workflowId))
        : undefined,
    );
    for (const { deliveryId, payload, workflowId } of deliveries) {
      const selected = deliveryTargets(payload, workflowId);
      if (secondaryDeferral() && needsGitHub(selected)) continue;
      try {
        let retryAt = 0;
        await store.processDelivery(
          deliveryId,
          async () => {
            const result = await reconcileTargets(selected);
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
    const deferred = secondaryDeferral();
    if (deferred && needsGitHub(targets)) {
      if (reportDeferred && success) {
        const message = isSecondaryLimitPaused(deferred)
          ? new GitHubRateLimitError(deferred.retryAt, undefined, true).message
          : `GitHub reconciliation is deferred until ${new Date(deferred.retryAt).toISOString()}.`;
        reportError(message);
      }
      return false;
    }

    const sweepAt = now();
    const periodic = sweepAt >= nextSweep;
    if (periodic || startupDueAt.size > 0) {
      // Throttled startup targets have their own deadlines, independent of periodic polling.
      const due = targets.filter((target) => {
        const startupDeadline = startupDueAt.get(target);
        return startupDeadline === undefined ? periodic : startupDeadline <= sweepAt;
      });
      const { failures, throttledTargets } = await reconcileTargets(due);
      for (const target of due) {
        if (!startupDueAt.has(target)) continue;
        const retryAt = throttledTargets.get(target);
        if (retryAt === undefined) startupDueAt.delete(target);
        else startupDueAt.set(target, retryAt);
      }
      if (periodic) nextSweep = reconcileIntervalMs > 0 ? now() + reconcileIntervalMs : Infinity;
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
