import { loadConfig, workflowKey } from "./config.ts";
import { localAgentWorker } from "./agent-command.ts";
import { authorizeFix, createFixController, fixStatus } from "./fix-controller.ts";
import { createFixGit, runValidation } from "./fix-git.ts";
import { canConfirmLatePush, requiredChecksForCycle, type FixConfig } from "./fix-store.ts";
import type { GitHubReader, PullRequestTarget } from "./github-api.ts";
import { createReconciler } from "./reconcile.ts";
import { WorkflowStore } from "./store.ts";
import { createWorktreeManager } from "./worktree.ts";

export function advanceReconciledFix(
  store: WorkflowStore,
  workflowId: string,
  target: PullRequestTarget,
  configured: FixConfig,
  reader: GitHubReader,
  refresh: () => Promise<void>,
  options: Pick<
    Parameters<typeof createFixController>[0],
    "signal" | "drainSignal" | "report" | "now"
  >,
) {
  const latest = store.fixes(workflowId).read().at(-1);
  const config =
    latest && !["finished", "proposed"].includes(latest.phase) ? latest.config : configured;
  const worktrees = createWorktreeManager(config);
  return createFixController({
    store,
    workflowId,
    config,
    configuredRequiredChecks: configured.requiredChecks,
    worker: localAgentWorker(config),
    git: createFixGit(worktrees, `git@github.com:${target.repository}.git`),
    validate: runValidation,
    readPullRequest: () => reader.readPullRequest(target, options.drainSignal),
    refresh,
    ...options,
  }).advanceReconciled();
}

export async function runFixCommand(
  args: string[],
  dbPath: string,
  makeReader: (store: WorkflowStore, targets: PullRequestTarget[]) => GitHubReader,
): Promise<boolean> {
  const [command, workflowId, input] = args;
  if (
    !command ||
    !["--fix-status", "--fix-advance", "--fix-authorize", "--fix-publish"].includes(command)
  )
    return false;
  if (!workflowId || args.length !== (command === "--fix-status" ? 2 : 3))
    throw new Error(
      "Usage: --fix-status WORKFLOW_ID, --fix-advance WORKFLOW_ID CONFIG.json, --fix-authorize WORKFLOW_ID CYCLE_ID, or --fix-publish WORKFLOW_ID CYCLE_ID.",
    );
  const store = new WorkflowStore(dbPath);
  try {
    if (command === "--fix-authorize" || command === "--fix-publish") {
      authorizeFix(store, workflowId, input!, command === "--fix-publish");
    } else if (command === "--fix-advance") {
      const { targets, fixes } = loadConfig(input!);
      const target = targets.find((target) => workflowKey(target) === workflowId);
      if (!target) throw new Error("The workflow is missing from the configured GitHub PRs.");
      const configured = fixes.get(workflowId);
      if (!configured) throw new Error("The workflow is missing its fix configuration.");
      const reader = makeReader(store, targets);
      const abort = new AbortController();
      const stop = () => abort.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      try {
        const reconcile = createReconciler(store, reader, () =>
          requiredChecksForCycle(store.fixes(workflowId).read().at(-1), configured.requiredChecks),
        );
        store.recoverAgentClaims();
        const refresh = () => reconcile(target);
        await refresh();
        if (
          store.getWorkflow(workflowId)?.state !== "escalated" ||
          canConfirmLatePush(store.fixes(workflowId).read().at(-1))
        )
          await advanceReconciledFix(store, workflowId, target, configured, reader, refresh, {
            signal: abort.signal,
          });
      } finally {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
      }
    }
    console.info(JSON.stringify(fixStatus(store, workflowId)));
    return true;
  } finally {
    store.close();
  }
}
