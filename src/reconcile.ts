import type { GitHubReader, PullRequestState, PullRequestTarget } from "./github-api.ts";
import type { WorkflowStore } from "./store.ts";
import type { CheckEvidence } from "./workflow.ts";

export function createReconciler(store: WorkflowStore, github: GitHubReader) {
  return async (target: PullRequestTarget): Promise<void> => {
    const existing = store.findWorkflow(target.repository, target.pullRequest);
    if (
      existing?.state === "escalated" ||
      (existing?.state === "stopped" && !existing.closedByGitHub)
    )
      return;

    let id = existing?.id;
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
        // Required check discovery and review interpretation are later phases.
        store.transition(current.id, { type: "checks_received", evidence, configuredNames: null });
      }
    }

    try {
      const start = await github.readPullRequest(target);
      if (!observe(start)) {
        github.completeReconciliation(target);
        return;
      }

      const [checks, reviewInputs] = await Promise.allSettled([
        github.readChecks(target, start.headSha),
        github.readReviewInputs(target),
      ]);

      const latest = await github.readPullRequest(target);
      if (!observe(latest)) return;
      if (latest.headSha !== start.headSha)
        throw new Error("Pull request head changed during reconciliation.");

      if (reviewInputs.status === "rejected") throw reviewInputs.reason;
      if (checks.status === "rejected") throw checks.reason;
      recordChecks(checks.value);
      github.completeReconciliation(target);
    } catch (error) {
      recordChecks([]);
      throw error;
    }
  };
}
