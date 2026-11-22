import type { PullRequestTarget } from "./github-api.ts";
import {
  belongsToReconciliation,
  GitHubRateLimitError,
  GitHubTransientError,
  isSecondaryLimitPaused,
  pullRequestRetryKey,
  retireInactiveGitHubRetry,
  tokenRetryKey,
} from "./github-app.ts";
import { canReconcilePullRequest, PullRequestHeadChangedError } from "./reconcile.ts";
import type { WorkflowStore } from "./store.ts";
import { readReconcileHint } from "./webhook.ts";

const retryDelayMs = 30_000;

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
  pollOnly = false,
  signal,
  now = Date.now,
  isRetryOwnerActive = createGitHubRetryOwnerCheck(store, targets),
}: {
  store: WorkflowStore;
  targets: PullRequestTarget[];
  reconcile: (target: PullRequestTarget) => Promise<void>;
  reportError: (message: string) => void;
  reconcileIntervalMs: number;
  reportDeferred?: boolean;
  pollOnly?: boolean;
  signal?: AbortSignal;
  now?: () => number;
  isRetryOwnerActive?: (key: string) => boolean;
}) {
  const rateLimits = store.githubRateLimits();
  const retryStore = store.reconciliationRetries();
  const pendingSweep = new Set<PullRequestTarget>();
  let nextSweep = 0;
  let running: Promise<boolean> | undefined;

  function isActive(target: PullRequestTarget): boolean {
    return canReconcilePullRequest(store, target.repository, target.pullRequest);
  }

  function needsGitHub(selected: readonly PullRequestTarget[]): boolean {
    return selected.some(isActive);
  }

  function retryDeadline(target: PullRequestTarget): number {
    return Math.max(
      retryStore.get(pullRequestRetryKey(target, target.pullRequest)) ?? 0,
      retryStore.get(tokenRetryKey(target)) ?? 0,
    );
  }

  function deliveryDeferred(selected: PullRequestTarget[]): boolean {
    const at = now();
    const secondary = secondaryDeferral();
    return selected.some((target) => isActive(target) && (secondary || retryDeadline(target) > at));
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
    const abandoned = store.recoverAgentClaims();
    if (abandoned) reportError(`Recovered ${abandoned} agent operation(s) with unknown outcomes.`);
    retireInactiveGitHubRetry(rateLimits, isRetryOwnerActive);
    const observations = new Map<PullRequestTarget, Promise<void>>();
    async function reconcileTargets(selected: PullRequestTarget[]) {
      const failures: string[] = [];
      const completed: PullRequestTarget[] = [];
      let deferred = false;
      let retryAt = 0;
      for (const target of selected) {
        if (signal?.aborted) break;
        const key = pullRequestRetryKey(target, target.pullRequest);
        if (!isActive(target)) {
          retryStore.delete(key);
          completed.push(target);
          continue;
        }
        const scheduled = retryDeadline(target);
        if (scheduled > now()) {
          deferred = true;
          retryAt = Math.max(retryAt, scheduled);
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
        const recorded = retryStore.get(key) ?? 0;
        if (deadline !== undefined) {
          if (deadline > recorded) retryStore.extend([key], deadline);
        } else if (recorded <= now()) {
          if (recorded > 0) retryStore.delete(key);
          completed.push(target);
        }
        retryAt = Math.max(retryAt, retryDeadline(target));
      }
      return { completed, deferred, failures, retryAt };
    }

    let success = true;
    const deliveries = pollOnly
      ? []
      : store.dueDeliveries(
          now(),
          25,
          deliveryDeferred(targets)
            ? ({ payload, workflowId }) => !deliveryDeferred(deliveryTargets(payload, workflowId))
            : undefined,
        );
    for (const { deliveryId, payload, workflowId } of deliveries) {
      if (signal?.aborted) return false;
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
            if (result.deferred) throw new Error("GitHub reconciliation was deferred.");
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
      const { completed, failures } = await reconcileTargets([...pendingSweep]);
      for (const target of completed) pendingSweep.delete(target);
      for (const failure of failures) reportError(`Periodic reconciliation failed for ${failure}`);
      if (failures.length) success = false;
    }
    if (periodic) nextSweep = reconcileIntervalMs > 0 ? now() + reconcileIntervalMs : Infinity;
    if (reportDeferred && success && pendingSweep.size > 0) {
      const deadline = Math.max(...[...pendingSweep].map(retryDeadline));
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
