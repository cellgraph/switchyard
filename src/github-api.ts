import {
  checkGitHubDrain,
  githubRetryError,
  type GitHubAppClient,
  type GitHubRepository,
} from "./github-app.ts";
import { commitSha, object, repositoryName } from "./github-data.ts";
import type { CheckEvidence, CheckOutcome } from "./workflow.ts";

export type PullRequestTarget = GitHubRepository & { pullRequest: number };
export type PullRequestState = {
  headSha: string;
  state: "open" | "closed";
  headRef?: string;
  headRepository?: string;
  headDefaultBranch?: string;
};

export interface GitHubReader {
  completeReconciliation(target: PullRequestTarget): void;
  readPullRequest(target: PullRequestTarget, signal?: AbortSignal): Promise<PullRequestState>;
  readChecks(
    target: PullRequestTarget,
    headSha: string,
    signal?: AbortSignal,
  ): Promise<CheckEvidence[]>;
}

export function createGitHubReader(
  client: Pick<GitHubAppClient, "get" | "completeReconciliation">,
) {
  async function list(
    target: PullRequestTarget,
    path: string,
    signal?: AbortSignal,
    select: (data: unknown) => unknown = (data) => data,
  ): Promise<unknown[]> {
    const results: unknown[] = [];
    const separator = path.includes("?") ? "&" : "?";
    for (let page = 1; page <= 100; page += 1) {
      checkGitHubDrain(signal);
      const { data, hasNext } = await client.get(
        target,
        `${path}${separator}per_page=100&page=${page}`,
        target.pullRequest,
        signal,
      );
      const items = select(data);
      if (!Array.isArray(items)) throw new Error(`Invalid GitHub response for ${path}.`);
      results.push(...items);
      if (!hasNext) return results;
    }
    throw new Error(`GitHub pagination limit exceeded for ${path}.`);
  }

  return {
    readReviews: (target: PullRequestTarget, signal?: AbortSignal) =>
      list(target, `/pulls/${target.pullRequest}/reviews`, signal),
    readReviewComments: (target: PullRequestTarget, signal?: AbortSignal) =>
      list(target, `/pulls/${target.pullRequest}/comments`, signal),
    readIssueComments: (target: PullRequestTarget, signal?: AbortSignal) =>
      list(target, `/issues/${target.pullRequest}/comments`, signal),
    completeReconciliation(target: PullRequestTarget) {
      client.completeReconciliation(target, target.pullRequest);
    },

    async readPullRequest(
      target: PullRequestTarget,
      signal?: AbortSignal,
    ): Promise<PullRequestState> {
      const { data } = await client.get(
        target,
        `/pulls/${target.pullRequest}`,
        target.pullRequest,
        signal,
      );
      const pullRequest = object(data);
      const head = object(pullRequest?.head);
      const headSha = commitSha(head?.sha);
      const state = pullRequest?.state;
      if (
        pullRequest?.number !== target.pullRequest ||
        !headSha ||
        (state !== "open" && state !== "closed")
      )
        throw new Error("GitHub returned an invalid pull request response.");
      const repository = object(head?.repo);
      const headRepository = repositoryName(repository?.full_name);
      return {
        headSha,
        state,
        ...(typeof head?.ref === "string" ? { headRef: head.ref } : {}),
        ...(headRepository ? { headRepository } : {}),
        ...(typeof repository?.default_branch === "string"
          ? { headDefaultBranch: repository.default_branch }
          : {}),
      };
    },

    async readChecks(target: PullRequestTarget, headSha: string, signal?: AbortSignal) {
      const [runs, statuses] = await readAll(
        list(
          target,
          `/commits/${headSha}/check-runs?filter=latest`,
          signal,
          (data) => object(data)?.check_runs,
        ),
        list(target, `/commits/${headSha}/status`, signal, (data) => {
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
  } satisfies GitHubReader & Record<string, unknown>;
}

async function readAll<T extends unknown[]>(
  ...reads: { [K in keyof T]: Promise<T[K]> }
): Promise<T> {
  // Sibling reads can still record a GitHub backoff after another read has failed.
  const results = await Promise.allSettled(reads);
  const retry = githubRetryError(
    results.flatMap((result) => (result.status === "rejected" ? [result.reason as unknown] : [])),
  );
  if (retry) throw retry;
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
