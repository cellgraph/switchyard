import { observeCodexReview } from "./codex-review.ts";
import type { GitHubReader, PullRequestState, PullRequestTarget } from "./github-api.ts";
import { checkGitHubDrain, GitHubRateLimitError, githubRetryError } from "./github-app.ts";
import { canConfirmLatePush } from "./fix-store.ts";
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
  includeLatePush = false,
): boolean {
  const workflow = store.findWorkflow(repository, pullRequest);
  return (
    !isReconciliationTerminal(workflow) ||
    Boolean(
      includeLatePush &&
      workflow?.state === "escalated" &&
      canConfirmLatePush(store.fixes(workflow.id).read().at(-1)),
    )
  );
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
          review: null,
          checks: [],
          fixCycles: 0,
          cycleAwaitingReview: false,
          validationHeadSha: null,
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
      // A changed head or closure is complete evidence that can revoke authorization on its own.
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

      const [checks, reviewInputs] = await Promise.allSettled([
        github.readChecks(target, start.headSha, signal),
        github.readReviewInputs(target, signal),
      ]);

      checkGitHubDrain(signal);
      if (isReconciliationTerminal(findWorkflow())) return;
      const readErrors = [checks, reviewInputs].flatMap((read) =>
        read.status === "rejected" ? [read.reason as unknown] : [],
      );
      const review =
        reviewInputs.status === "fulfilled"
          ? observeCodexReview(start.headSha, reviewInputs.value)
          : undefined;
      let latest: PullRequestState;
      try {
        latest = await github.readPullRequest(target, signal);
      } catch (error) {
        checkGitHubDrain(signal);
        // A contradictory review can revoke authorization before head confirmation.
        if (
          review !== undefined &&
          (review === null || "error" in review || review.status === "running")
        ) {
          apply((observation) => {
            const current = findWorkflow();
            if (current?.headSha === start.headSha && !isReconciliationTerminal(current))
              observation.observeCodex(current.id, start.headSha, review);
          });
        }
        throw githubRetryError([...readErrors, error]) ?? error;
      }

      checkGitHubDrain(signal);
      const retry = githubRetryError(readErrors);
      let unfinished = false;
      apply((observation) => {
        if (isReconciliationTerminal(findWorkflow())) return;
        const current = observe(latest, observation);
        if (current.state === "stopped" || current.state === "escalated") {
          if (!readErrors.some((error) => error instanceof GitHubRateLimitError))
            github.completeReconciliation(target);
          return;
        }
        unfinished = true;
        if (latest.headSha !== start.headSha) return;

        recordChecks(
          observation,
          current,
          readErrors.length || checks.status !== "fulfilled" ? [] : checks.value,
        );
        if (review !== undefined) observation.observeCodex(current.id, latest.headSha, review);
        if (!readErrors.length) github.completeReconciliation(target);
      });
      if (!unfinished) return;
      if (latest.headSha !== start.headSha) throw retry ?? new PullRequestHeadChangedError();
      if (retry) throw retry;
      if (reviewInputs.status === "rejected") throw reviewInputs.reason;
      if (checks.status === "rejected") throw checks.reason;
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
