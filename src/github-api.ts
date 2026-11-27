import {
  checkGitHubDrain,
  githubRetryError,
  type GitHubAppClient,
  type GitHubRepository,
} from "./github-app.ts";
import { commitSha, object, positiveInteger, repositoryName } from "./github-data.ts";
import type { CheckEvidence, CheckOutcome } from "./workflow.ts";

export type PullRequestTarget = GitHubRepository & { pullRequest: number };
export type PullRequestState = {
  headSha: string;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  headRepository: string | null;
};

export interface GitHubReader {
  completeReconciliation(target: GitHubRepository, pullRequest?: number): void;
  listOpenPullRequests(target: GitHubRepository, signal?: AbortSignal): Promise<number[]>;
  readPullRequest(target: PullRequestTarget, signal?: AbortSignal): Promise<PullRequestState>;
  readChecks(
    target: PullRequestTarget,
    headSha: string,
    signal?: AbortSignal,
  ): Promise<CheckEvidence[]>;
}

export function createGitHubReader(
  client: Pick<GitHubAppClient, "get" | "completeReconciliation">,
  checkApps: ReadonlyMap<string, ReadonlyMap<string, number>> = new Map(),
) {
  async function list(
    target: GitHubRepository,
    path: string,
    signal?: AbortSignal,
    select: (data: unknown) => unknown = (data) => data,
    pullRequest?: number,
  ): Promise<unknown[]> {
    const results: unknown[] = [];
    const separator = path.includes("?") ? "&" : "?";
    for (let page = 1; page <= 100; page += 1) {
      checkGitHubDrain(signal);
      const { data, hasNext } = await client.get(
        target,
        `${path}${separator}per_page=100&page=${page}`,
        pullRequest,
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
    async listOpenPullRequests(target: GitHubRepository, signal?: AbortSignal) {
      const items = await list(target, "/pulls?state=open&sort=created&direction=asc", signal);
      const numbers = items.map((item) => {
        const number = object(item)?.number;
        if (!positiveInteger(number))
          throw new Error("GitHub returned an invalid open pull request number.");
        return number;
      });
      return [...new Set(numbers)];
    },
    readReviews: (target: PullRequestTarget, signal?: AbortSignal) =>
      list(target, `/pulls/${target.pullRequest}/reviews`, signal, undefined, target.pullRequest),
    readReviewComments: (target: PullRequestTarget, signal?: AbortSignal) =>
      list(target, `/pulls/${target.pullRequest}/comments`, signal, undefined, target.pullRequest),
    readIssueComments: (target: PullRequestTarget, signal?: AbortSignal) =>
      list(target, `/issues/${target.pullRequest}/comments`, signal, undefined, target.pullRequest),
    async readIssue(target: PullRequestTarget, number: number, signal?: AbortSignal) {
      return (await client.get(target, `/issues/${number}`, target.pullRequest, signal)).data;
    },
    async readCommit(target: PullRequestTarget, sha: string, signal?: AbortSignal) {
      return (await client.get(target, `/commits/${sha}`, target.pullRequest, signal)).data;
    },
    completeReconciliation(target: GitHubRepository, pullRequest?: number) {
      client.completeReconciliation(target, pullRequest);
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
      const headRepository = repositoryName(object(head?.repo)?.full_name);
      const baseRepository = repositoryName(object(object(pullRequest?.base)?.repo)?.full_name);
      if (
        pullRequest?.number !== target.pullRequest ||
        !headSha ||
        (state !== "open" && state !== "closed") ||
        typeof pullRequest.draft !== "boolean" ||
        typeof pullRequest.merged !== "boolean" ||
        (state === "open" && pullRequest.merged) ||
        (!headRepository && head?.repo !== null) ||
        baseRepository !== target.repository
      )
        throw new Error("GitHub returned an invalid pull request response.");
      return {
        headSha,
        state,
        draft: pullRequest.draft,
        merged: pullRequest.merged,
        headRepository: headRepository ?? null,
      };
    },

    async readChecks(target: PullRequestTarget, headSha: string, signal?: AbortSignal) {
      const [runs, statuses] = await readAll(
        list(
          target,
          `/commits/${headSha}/check-runs?filter=latest`,
          signal,
          (data) => object(data)?.check_runs,
          target.pullRequest,
        ),
        list(
          target,
          `/commits/${headSha}/status`,
          signal,
          (data) => {
            const combined = object(data);
            if (commitSha(combined?.sha) !== headSha)
              throw new Error("GitHub returned commit statuses for a different SHA.");
            return combined?.statuses;
          },
          target.pullRequest,
        ),
      );

      const checks = new Map<string, CheckEvidence>();
      const expectedApps = checkApps.get(target.repository);
      function add(name: unknown, outcome: CheckOutcome, app?: unknown): void {
        if (typeof name !== "string" || !name.trim())
          throw new Error("GitHub returned check evidence without a name.");
        const expectedApp = expectedApps?.get(name);
        if (expectedApp !== undefined && app !== expectedApp) return;
        // A name alone cannot disambiguate checks from multiple producers.
        checks.set(name, { name, sha: headSha, outcome: checks.has(name) ? "unknown" : outcome });
      }
      for (const item of runs) {
        const run = object(item);
        const sha = commitSha(run?.head_sha);
        if (!run || !sha || typeof run.status !== "string")
          throw new Error("GitHub returned an invalid check run.");
        if (sha === headSha)
          add(run.name, checkRunOutcome(run.status, run.conclusion), object(run.app)?.id);
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
