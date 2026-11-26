import type { GitHubReader, PullRequestState, PullRequestTarget } from "./github-api.ts";
import { checkGitHubDrain, GitHubRateLimitError, githubRetryError } from "./github-app.ts";
import type { GitHubObservationWriter, WorkflowStore } from "./store.ts";
import type { CheckEvidence, Workflow } from "./workflow.ts";

export class PullRequestHeadChangedError extends Error {
  constructor(message = "Pull request head changed during reconciliation.") {
    super(message);
  }
}

class SupersededObservationError extends PullRequestHeadChangedError {
  constructor() {
    super("A newer GitHub reconciliation superseded this observation.");
  }
}

function isReconciliationTerminal(workflow: Workflow | null): boolean {
  return (
    workflow?.state === "escalated" || (workflow?.state === "stopped" && !workflow.closedByGitHub)
  );
}

export function canReconcilePullRequest(
  store: WorkflowStore,
  repository: string,
  pullRequest: number,
): boolean {
  return !isReconciliationTerminal(store.findWorkflow(repository, pullRequest));
}

export function createReconciler(
  store: WorkflowStore,
  github: GitHubReader,
  requiredChecks: (target: PullRequestTarget) => string[] | null = () => null,
) {
  return async (target: PullRequestTarget, signal?: AbortSignal): Promise<void> => {
    checkGitHubDrain(signal);
    const { repository, pullRequest } = target;
    const findWorkflow = () => store.findWorkflow(repository, pullRequest);
    if (isReconciliationTerminal(findWorkflow())) return;
    const generation = store.beginGitHubObservation(repository, pullRequest);
    function apply(run: (observation: GitHubObservationWriter) => void): void {
      if (!generation.apply(run)) throw new SupersededObservationError();
    }

    function observe(snapshot: PullRequestState, observation: GitHubObservationWriter): Workflow {
      const current = findWorkflow();
      const id = current?.id ?? `${repository}#${pullRequest}`;
      if (!current) {
        store.createWorkflow({
          id,
          identity: { repository, pullRequest },
          state: "awaiting_review",
          headSha: snapshot.headSha,
          requiredChecks: null,
          checks: [],
          escalationReason: null,
        });
      }
      return observation.transition(id, {
        type: "github_pull_request",
        state: snapshot.state,
        sha: snapshot.headSha,
      });
    }

    function recordChecks(
      observation: GitHubObservationWriter,
      current: Workflow,
      evidence: CheckEvidence[],
    ) {
      observation.transition(current.id, {
        type: "checks_received",
        evidence,
        configuredNames: requiredChecks(target),
      });
    }

    try {
      const start = await github.readPullRequest(target, signal);
      const current = findWorkflow();
      // A confirmed head change or closure invalidates the current checks immediately.
      const invalidatesHead =
        current && (start.headSha !== current.headSha || start.state === "closed");
      if (!invalidatesHead) checkGitHubDrain(signal);
      let active = false;
      if (signal && !current && start.state === "open") active = true;
      else
        apply((observation) => {
          if (isReconciliationTerminal(findWorkflow())) return;
          const workflow = observe(start, observation);
          active = workflow.state !== "stopped" && workflow.state !== "escalated";
          if (!active) github.completeReconciliation(target);
        });
      checkGitHubDrain(signal);
      if (!active) return;

      let checks: CheckEvidence[] | undefined;
      let checkError: unknown;
      try {
        checks = await github.readChecks(target, start.headSha, signal);
      } catch (error) {
        checkError = error;
      }

      checkGitHubDrain(signal);
      if (isReconciliationTerminal(findWorkflow())) return;
      const retry = githubRetryError([checkError]);
      let latest: PullRequestState;
      try {
        latest = await github.readPullRequest(target, signal);
      } catch (error) {
        throw githubRetryError([checkError, error]) ?? error;
      }

      checkGitHubDrain(signal);
      let unfinished = false;
      apply((observation) => {
        if (isReconciliationTerminal(findWorkflow())) return;
        const current = observe(latest, observation);
        if (current.state === "stopped" || current.state === "escalated") {
          if (!(checkError instanceof GitHubRateLimitError)) github.completeReconciliation(target);
          return;
        }
        unfinished = true;
        if (latest.headSha !== start.headSha) return;

        recordChecks(observation, current, checks ?? []);
        if (checks) github.completeReconciliation(target);
      });
      if (!unfinished) return;
      if (latest.headSha !== start.headSha) throw retry ?? new PullRequestHeadChangedError();
      if (retry) throw retry;
      if (!checks) throw checkError;
    } catch (error) {
      if (error instanceof SupersededObservationError) throw error;
      checkGitHubDrain(signal);
      let active = false;
      apply((observation) => {
        const current = findWorkflow();
        if (isReconciliationTerminal(current)) return;
        active = true;
        if (current && current.state !== "stopped") recordChecks(observation, current, []);
      });
      if (active) throw error;
    }
  };
}
