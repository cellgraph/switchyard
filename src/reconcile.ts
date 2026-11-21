import { observeCodexReview } from "./codex-review.ts";
import type { GitHubReader, PullRequestState, PullRequestTarget } from "./github-api.ts";
import { GitHubRateLimitError, githubRetryError } from "./github-app.ts";
import type { WorkflowStore } from "./store.ts";
import type { CheckEvidence, Workflow } from "./workflow.ts";

export class PullRequestHeadChangedError extends Error {
  constructor() {
    super("Pull request head changed during reconciliation.");
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

export function createReconciler(store: WorkflowStore, github: GitHubReader) {
  return async (target: PullRequestTarget): Promise<void> => {
    const existing = store.findWorkflow(target.repository, target.pullRequest);
    if (isReconciliationTerminal(existing)) return;

    let id = existing?.id;
    const terminal = () => !canReconcilePullRequest(store, target.repository, target.pullRequest);
    function observe(snapshot: PullRequestState): boolean {
      if (id === undefined) {
        id = `${target.repository}#${target.pullRequest}`;
        store.createWorkflow({
          id,
          identity: { repository: target.repository, pullRequest: target.pullRequest },
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
      const workflow = store.transition(id, {
        type: "github_pull_request",
        state: snapshot.state,
        sha: snapshot.headSha,
      });
      return workflow.state !== "stopped" && workflow.state !== "escalated";
    }

    function recordChecks(evidence: CheckEvidence[]): void {
      const current = id === undefined ? null : store.getWorkflow(id);
      if (current && current.state !== "stopped" && current.state !== "escalated") {
        // Required check discovery remains in Phase 5.
        store.transition(current.id, { type: "checks_received", evidence, configuredNames: null });
      }
    }

    try {
      const start = await github.readPullRequest(target);
      if (terminal()) return;
      if (!observe(start)) {
        github.completeReconciliation(target);
        return;
      }

      const [checks, reviewInputs] = await Promise.allSettled([
        github.readChecks(target, start.headSha),
        github.readReviewInputs(target),
      ]);

      if (terminal()) return;
      const readErrors = [checks, reviewInputs].flatMap((read) =>
        read.status === "rejected" ? [read.reason as unknown] : [],
      );
      const review =
        reviewInputs.status === "fulfilled"
          ? observeCodexReview(start.headSha, reviewInputs.value)
          : undefined;
      let latest: PullRequestState;
      try {
        latest = await github.readPullRequest(target);
      } catch (error) {
        // Contradicting evidence can revoke local authorization even when the final
        // head is unconfirmed. A completed verdict still needs head confirmation.
        if (
          id !== undefined &&
          review !== undefined &&
          (review === null || "error" in review || review.status === "running")
        ) {
          store.reviews().observeCodex(id, start.headSha, review);
        }
        throw githubRetryError([...readErrors, error]) ?? error;
      }
      if (terminal()) return;
      if (!observe(latest)) {
        const throttled = readErrors.some((error) => error instanceof GitHubRateLimitError);
        if (!throttled) github.completeReconciliation(target);
        return;
      }
      const retry = githubRetryError(readErrors);
      if (latest.headSha !== start.headSha) throw retry ?? new PullRequestHeadChangedError();

      recordChecks(checks.status === "fulfilled" ? checks.value : []);
      if (id !== undefined && review !== undefined)
        store.reviews().observeCodex(id, latest.headSha, review);

      if (retry) throw retry;
      if (reviewInputs.status === "rejected") throw reviewInputs.reason;
      if (checks.status === "rejected") throw checks.reason;
      github.completeReconciliation(target);
    } catch (error) {
      if (terminal()) return;
      recordChecks([]);
      throw error;
    }
  };
}
