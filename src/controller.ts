import type { PullRequestTarget } from "./github-api.ts";
import type { WorkflowStore } from "./store.ts";
import { readReconcileHint } from "./webhook.ts";

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown controller error.";
}

export function createController({
  store,
  targets,
  reconcile,
  reportError,
  reconcileIntervalMs,
  now = Date.now,
}: {
  store: WorkflowStore;
  targets: PullRequestTarget[];
  reconcile: (target: PullRequestTarget) => Promise<void>;
  reportError: (message: string) => void;
  reconcileIntervalMs: number;
  now?: () => number;
}) {
  let nextSweep = 0;
  let running: Promise<boolean> | undefined;

  async function pass(): Promise<boolean> {
    const observations = new Map<PullRequestTarget, Promise<void>>();
    async function reconcileTargets(selected: PullRequestTarget[]): Promise<string[]> {
      const failures: string[] = [];
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
        }
      }
      return failures;
    }

    let success = true;
    for (const deliveryId of store.dueDeliveryIds(now(), 25)) {
      try {
        await store.processDelivery(
          deliveryId,
          async (payload) => {
            const hint = readReconcileHint(payload);
            if (!hint) return;
            const matches = targets.filter(
              (target) =>
                target.repository === hint.repository &&
                target.installationId === hint.installationId &&
                (hint.pullRequest === null || hint.pullRequest === target.pullRequest),
            );
            const failures = await reconcileTargets(matches);
            if (failures.length) throw new Error(failures.join(", "));
          },
          () => now() + 30_000,
        );
      } catch (error) {
        success = false;
        reportError(`Delivery ${deliveryId} failed: ${describeError(error)}`);
      }
    }
    if (now() >= nextSweep) {
      const failures = await reconcileTargets(targets);
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
