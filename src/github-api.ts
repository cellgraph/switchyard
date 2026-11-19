import { GitHubRateLimitError, type GitHubAppClient, type GitHubRepository } from "./github-app.ts";
import { commitSha, object } from "./github-data.ts";
import type { CheckEvidence, CheckOutcome } from "./workflow.ts";

export type PullRequestTarget = GitHubRepository & { pullRequest: number };
export type PullRequestState = { headSha: string; state: "open" | "closed" };

export interface GitHubReader {
  completeReconciliation(target: PullRequestTarget): void;
  readPullRequest(target: PullRequestTarget): Promise<PullRequestState>;
  readReviewInputs(target: PullRequestTarget): Promise<{
    reviews: unknown[];
    reviewComments: unknown[];
    issueComments: unknown[];
  }>;
  readChecks(target: PullRequestTarget, headSha: string): Promise<CheckEvidence[]>;
}

export function createGitHubReader(client: GitHubAppClient): GitHubReader {
  async function list(
    target: PullRequestTarget,
    path: string,
    select: (data: unknown) => unknown = (data) => data,
  ): Promise<unknown[]> {
    const results: unknown[] = [];
    const separator = path.includes("?") ? "&" : "?";
    for (let page = 1; page <= 100; page += 1) {
      const { data, hasNext } = await client.get(
        target,
        `${path}${separator}per_page=100&page=${page}`,
        target.pullRequest,
      );
      const items = select(data);
      if (!Array.isArray(items)) throw new Error(`Invalid GitHub response for ${path}.`);
      results.push(...items);
      if (!hasNext) return results;
    }
    throw new Error(`GitHub pagination limit exceeded for ${path}.`);
  }

  return {
    completeReconciliation(target) {
      client.completeReconciliation(target, target.pullRequest);
    },

    async readPullRequest(target) {
      const { data } = await client.get(target, `/pulls/${target.pullRequest}`, target.pullRequest);
      const pullRequest = object(data);
      const headSha = commitSha(object(pullRequest?.head)?.sha);
      const state = pullRequest?.state;
      if (
        pullRequest?.number !== target.pullRequest ||
        !headSha ||
        (state !== "open" && state !== "closed")
      )
        throw new Error("GitHub returned an invalid pull request response.");
      return { headSha, state };
    },

    async readReviewInputs(target) {
      const [reviews, reviewComments, issueComments] = await readAll(
        list(target, `/pulls/${target.pullRequest}/reviews`),
        list(target, `/pulls/${target.pullRequest}/comments`),
        list(target, `/issues/${target.pullRequest}/comments`),
      );
      return { reviews, reviewComments, issueComments };
    },

    async readChecks(target, headSha) {
      const [runs, statuses] = await readAll(
        list(
          target,
          `/commits/${headSha}/check-runs?filter=latest`,
          (data) => object(data)?.check_runs,
        ),
        list(target, `/commits/${headSha}/status`, (data) => {
          const combined = object(data);
          if (commitSha(combined?.sha) !== headSha)
            throw new Error("GitHub returned commit statuses for a different SHA.");
          return combined?.statuses;
        }),
      );

      const checks = new Map<string, CheckEvidence>();
      function add(name: unknown, outcome: CheckOutcome): void {
        if (typeof name !== "string" || !name.trim())
          throw new Error("GitHub returned check evidence without a name.");
        // A name alone cannot disambiguate checks from multiple producers.
        checks.set(name, { name, sha: headSha, outcome: checks.has(name) ? "unknown" : outcome });
      }
      for (const item of runs) {
        const run = object(item);
        const sha = commitSha(run?.head_sha);
        if (!run || !sha || typeof run.status !== "string")
          throw new Error("GitHub returned an invalid check run.");
        if (sha === headSha) add(run.name, checkRunOutcome(run.status, run.conclusion));
      }
      for (const item of statuses) {
        const status = object(item);
        if (!status) throw new Error("GitHub returned an invalid commit status.");
        add(status.context, statusOutcome(status.state));
      }
      return [...checks.values()].sort((left, right) => left.name.localeCompare(right.name, "en"));
    },
  };
}

async function readAll<T extends unknown[]>(
  ...reads: { [K in keyof T]: Promise<T[K]> }
): Promise<T> {
  // Sibling reads can still record a GitHub backoff after another read has failed.
  const results = await Promise.allSettled(reads);
  let longestBackoff: GitHubRateLimitError | undefined;
  for (const result of results) {
    if (
      result.status === "rejected" &&
      result.reason instanceof GitHubRateLimitError &&
      (!longestBackoff || result.reason.retryAt > longestBackoff.retryAt)
    )
      longestBackoff = result.reason;
  }
  if (longestBackoff) throw longestBackoff;
  return results.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  }) as T;
}

function checkRunOutcome(status: string, conclusion: unknown): CheckOutcome {
  if (status !== "completed") return "pending";
  if (conclusion === "success") return "passed";
  if (
    conclusion === "failure" ||
    conclusion === "timed_out" ||
    conclusion === "cancelled" ||
    conclusion === "action_required" ||
    conclusion === "startup_failure" ||
    conclusion === "stale"
  )
    return "failed";
  // Phase 5 will decide how a repository treats skipped and neutral checks.
  return "unknown";
}

function statusOutcome(state: unknown): CheckOutcome {
  if (state === "success") return "passed";
  if (state === "error" || state === "failure") return "failed";
  if (state === "pending") return "pending";
  return "unknown";
}
