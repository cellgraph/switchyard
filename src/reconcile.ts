import type { GitHubReader, PullRequestState, PullRequestTarget } from "./github-api.ts";
import { checkGitHubDrain, githubRetryError } from "./github-app.ts";
import type { GitHubObservationWriter, WorkflowStore } from "./store.ts";
import {
  isActive,
  isOperatorHeld,
  type CheckEvidence,
  type GitHubPullRequestStatus,
  type Workflow,
} from "./workflow.ts";

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

export function canReadPullRequestChecks(
  store: WorkflowStore,
  repository: string,
  pullRequest: number,
): boolean {
  return !isOperatorHeld(store.findWorkflow(repository, pullRequest));
}

export function statusOf(snapshot: PullRequestState, repository: string): GitHubPullRequestStatus {
  if (snapshot.merged) return "merged";
  if (snapshot.state === "closed") return "closed";
  if (snapshot.headRepository !== repository) return "fork";
  return snapshot.draft ? "draft" : "eligible";
}

export function createReconciler(
  store: WorkflowStore,
  github: Pick<GitHubReader, "readPullRequest" | "readChecks" | "completeReconciliation">,
  requiredChecks: (target: PullRequestTarget) => string[] | null = () => null,
) {
  return async (target: PullRequestTarget, signal?: AbortSignal): Promise<void> => {
    checkGitHubDrain(signal);
    const { repository, pullRequest } = target;
    const findWorkflow = () => store.findWorkflow(repository, pullRequest);
    const generation = store.beginGitHubObservation(repository, pullRequest);
    function apply(run: (observation: GitHubObservationWriter) => void): void {
      if (!generation.apply(run)) throw new SupersededObservationError();
    }

    function observe(
      snapshot: PullRequestState,
      status: GitHubPullRequestStatus,
      observation: GitHubObservationWriter,
    ): Workflow | null {
      const current = findWorkflow();
      if (!current && status !== "eligible") return null;
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
        status,
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

    function clearCurrentChecks() {
      apply((observation) => {
        const current = findWorkflow();
        if (isActive(current)) recordChecks(observation, current, []);
      });
    }

    try {
      const start = await github.readPullRequest(target, signal);
      const status = statusOf(start, repository);
      const current = findWorkflow();
      // An observed closure, eligibility loss or head change invalidates current evidence
      // even if shutdown or a failed GitHub request prevents a second read.
      const invalidatesCurrent =
        current && (status !== "eligible" || start.headSha !== current.headSha);
      if (!invalidatesCurrent) checkGitHubDrain(signal);
      let active = status === "eligible";
      apply((observation) => {
        const tracked = findWorkflow();
        if (status !== "eligible" || isOperatorHeld(tracked)) {
          observe(start, status, observation);
          active = false;
        } else if (isActive(tracked)) {
          observe(start, status, observation);
        }
      });
      checkGitHubDrain(signal);
      if (!active) {
        github.completeReconciliation(target, pullRequest);
        return;
      }

      let checks: CheckEvidence[] | undefined;
      let checkError: unknown;
      try {
        checks = await github.readChecks(target, start.headSha, signal);
      } catch (error) {
        checkError = error;
      }

      checkGitHubDrain(signal);
      if (isOperatorHeld(findWorkflow())) {
        const retry = githubRetryError([checkError]);
        if (retry) throw retry;
        return;
      }
      let latest: PullRequestState;
      try {
        latest = await github.readPullRequest(target, signal);
      } catch (error) {
        throw githubRetryError([checkError, error]) ?? error;
      }

      checkGitHubDrain(signal);
      const latestStatus = statusOf(latest, repository);
      const headChanged = latest.headSha !== start.headSha;
      let activeAtEnd = false;
      apply((observation) => {
        const tracked = findWorkflow();
        activeAtEnd = latestStatus === "eligible" && !isOperatorHeld(tracked);
        // Require a stable, eligible observation before enrolling or reactivating.
        if (activeAtEnd && headChanged && !isActive(tracked)) return;
        const updated = observe(latest, latestStatus, observation);
        if (activeAtEnd && updated && !headChanged)
          recordChecks(observation, updated, checks ?? []);
      });

      const retry = githubRetryError([checkError]);
      if (retry) throw retry;
      if (activeAtEnd && headChanged) throw new PullRequestHeadChangedError();
      if (activeAtEnd && !checks) throw checkError;
      github.completeReconciliation(target, pullRequest);
    } catch (error) {
      if (error instanceof SupersededObservationError) throw error;
      checkGitHubDrain(signal);
      clearCurrentChecks();
      throw error;
    }
  };
}
