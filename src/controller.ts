import type { PullRequestTarget } from "./github-api.ts";
import {
  belongsToReconciliation,
  GitHubRateLimitError,
  GitHubTransientError,
  isSecondaryLimitPaused,
  retireInactiveGitHubRetry,
} from "./github-app.ts";
import { canReconcilePullRequest, PullRequestHeadChangedError } from "./reconcile.ts";
import type { WorkflowStore } from "./store.ts";
import { readReconcileHint } from "./webhook.ts";

const retryDelayMs = 30_000;

function retryKey(target: PullRequestTarget): string {
  return `${target.installationId}:${target.repository}:${target.pullRequest}`;
}

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
  const retryStore = store.reconciliationRetries();
  const retryDueAt = new Map<PullRequestTarget, number>();
  for (const target of targets) {
    const deadline = retryStore.get(retryKey(target));
    if (deadline !== undefined) retryDueAt.set(target, deadline);
  }
  const pendingSweep = new Set<PullRequestTarget>();
  let nextSweep = 0;
  let running: Promise<boolean> | undefined;

  function isActive(target: PullRequestTarget): boolean {
    return canReconcilePullRequest(store, target.repository, target.pullRequest);
  }

  function needsGitHub(selected: readonly PullRequestTarget[]): boolean {
    return selected.some(isActive);
  }

  function updateRetryDeadline(target: PullRequestTarget, deadline?: number): void {
    const previous = retryDueAt.get(target);
    if (deadline === undefined) {
      if (previous === undefined) return;
      retryStore.delete(retryKey(target));
      retryDueAt.delete(target);
    } else if (previous === undefined || deadline > previous) {
      retryStore.set(retryKey(target), deadline);
      retryDueAt.set(target, deadline);
    }
  }

  function deliveryDeferred(selected: PullRequestTarget[]): boolean {
    const at = now();
    const secondary = secondaryDeferral();
    return selected.some(
      (target) => (secondary || (retryDueAt.get(target) ?? 0) > at) && isActive(target),
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
      let retryAt = 0;
      for (const target of selected) {
        if (!isActive(target)) {
          updateRetryDeadline(target);
          continue;
        }
        let deadline: number | undefined;
        try {
          let observation = observations.get(target);
          if (!observation) {
            observation = reconcile(target);
            observations.set(target, observation);
          }
          await observation;
        } catch (error) {
          failures.push(`${target.repository}#${target.pullRequest}: ${describeError(error)}`);
          if (error instanceof GitHubRateLimitError) deadline = error.retryAt;
          else if (error instanceof GitHubTransientError)
            deadline = Math.max(now() + retryDelayMs, error.retryAt ?? 0);
          else if (error instanceof PullRequestHeadChangedError) deadline = now() + retryDelayMs;
        }
        updateRetryDeadline(target, deadline);
        if (deadline !== undefined) retryAt = Math.max(retryAt, deadline);
      }
      return { failures, retryAt };
    }

    let success = true;
    const deliveries = store.dueDeliveries(
      now(),
      25,
      deliveryDeferred(targets)
        ? ({ payload, workflowId }) => !deliveryDeferred(deliveryTargets(payload, workflowId))
        : undefined,
    );
    for (const { deliveryId, payload, workflowId } of deliveries) {
      const selected = deliveryTargets(payload, workflowId);
      if (deliveryDeferred(selected)) continue;
      try {
        let retryAt = 0;
        await store.processDelivery(
          deliveryId,
          async () => {
            const result = await reconcileTargets(selected);
            retryAt = result.retryAt;
            if (result.failures.length) throw new Error(result.failures.join(", "));
          },
          () => Math.max(now() + retryDelayMs, retryAt),
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
    if (periodic) for (const target of targets) pendingSweep.add(target);
    if (pendingSweep.size > 0) {
      const due = targets.filter(
        (target) =>
          pendingSweep.has(target) &&
          ((retryDueAt.get(target) ?? 0) <= sweepAt || !isActive(target)),
      );
      const { failures } = await reconcileTargets(due);
      for (const target of due) {
        if (!retryDueAt.has(target)) pendingSweep.delete(target);
      }
      for (const failure of failures) reportError(`Periodic reconciliation failed for ${failure}`);
      if (failures.length) success = false;
    }
    if (periodic) nextSweep = reconcileIntervalMs > 0 ? now() + reconcileIntervalMs : Infinity;
    if (reportDeferred && success && pendingSweep.size > 0) {
      const deadline = Math.max(...[...pendingSweep].map((target) => retryDueAt.get(target) ?? 0));
      reportError(`GitHub reconciliation is deferred until ${new Date(deadline).toISOString()}.`);
    }
    return success && pendingSweep.size === 0;
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
