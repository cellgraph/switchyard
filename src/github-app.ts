import { createPrivateKey, sign } from "node:crypto";
import { object } from "./github-data.ts";

const permissions = {
  pull_requests: "read",
  checks: "read",
  statuses: "read",
} as const;

export type GitHubRepository = { repository: string; installationId: number };
export type GitHubRateLimitState = {
  retryAt: number;
  throttledAttempts: number;
  retryRequest: string | null;
};
type InstallationScope = `installation:${number}`;
type RateLimitScope = "secondary" | InstallationScope;
export type GitHubRateLimits = {
  get(scope: RateLimitScope): GitHubRateLimitState | undefined;
  set(scope: RateLimitScope, state: GitHubRateLimitState): void;
};
export type GitHubRetryDeadlines = {
  get(key: string): number | undefined;
  extend(keys: readonly string[], retryAt: number): void;
};

const maxSecondaryAttempts = 5;
const fallbackRetryDelay = 60_000;
const authenticationRetryDelay = 300_000;
const transientStatuses = new Set([408, 500, 502, 503, 504]);

export function isSecondaryLimitPaused(state: GitHubRateLimitState | undefined): boolean {
  return (state?.throttledAttempts ?? 0) >= maxSecondaryAttempts;
}

export class GitHubRateLimitError extends Error {
  readonly retryAt: number;

  constructor(retryAt: number, status?: number, paused = false) {
    super(
      paused
        ? "GitHub API requests paused after repeated secondary rate limits. Run npm start -- --resume-github to resume."
        : status === undefined
          ? "GitHub API rate limit is active."
          : `GitHub API rate limit reached (HTTP ${status}).`,
    );
    this.retryAt = retryAt;
  }
}

export class GitHubTransientError extends Error {
  readonly retryAt: number | undefined;

  constructor(message: string, options?: ErrorOptions & { retryAt?: number | undefined }) {
    super(message, options);
    this.retryAt = options?.retryAt;
  }
}

export class GitHubAuthenticationError extends GitHubTransientError {
  readonly status = 401;

  constructor(retryAt: number) {
    super("GitHub rejected credentials (HTTP 401). Check the App credentials and installation.", {
      retryAt,
    });
  }
}

export function installationAuthRetryKey(target: GitHubRepository): string {
  return `auth:${target.installationId}`;
}

export class GitHubDrainError extends Error {
  constructor() {
    super("GitHub reconciliation was interrupted by worker shutdown.");
  }
}

export function checkGitHubDrain(signal?: AbortSignal): void {
  if (signal?.aborted) throw new GitHubDrainError();
}

export function githubRetryError(
  errors: readonly unknown[],
): GitHubRateLimitError | GitHubTransientError | undefined {
  let selected: GitHubRateLimitError | GitHubTransientError | undefined;
  for (const error of errors) {
    if (
      (error instanceof GitHubRateLimitError || error instanceof GitHubTransientError) &&
      (!selected || (error.retryAt ?? 0) > (selected.retryAt ?? 0))
    )
      selected = error;
  }
  return selected;
}

export function resumeGitHubAfterSecondaryLimit(rateLimits: GitHubRateLimits): boolean {
  const state = rateLimits.get("secondary");
  if (!state || state.throttledAttempts < maxSecondaryAttempts) return false;
  rateLimits.set("secondary", { ...state, throttledAttempts: 0, retryRequest: null });
  return true;
}

type Token = { value: string; expiresAt: number };
type ApiRequest = {
  path: string;
  reconcilePullRequest?: number | undefined;
  commitRetryKey?: string | undefined;
  drainSignal?: AbortSignal | undefined;
} & (
  | { method?: undefined; body?: undefined }
  | {
      path: `/app/installations/${number}/access_tokens` | "/graphql";
      method: "POST";
      body: string;
    }
);

export function pullRequestRetryKey(target: GitHubRepository, pullRequest: number): string {
  return `${target.installationId}:${target.repository}:${pullRequest}`;
}

export function tokenRetryKey(target: GitHubRepository): string {
  return `token:${target.installationId}:${target.repository}`;
}

export function belongsToReconciliation(
  key: string,
  target: GitHubRepository,
  pullRequest: number,
): boolean {
  return key === `pr:${pullRequestRetryKey(target, pullRequest)}` || key === tokenRetryKey(target);
}

export function retireInactiveGitHubRetry(
  rateLimits: GitHubRateLimits,
  isRetryOwnerActive: (key: string) => boolean,
): void {
  const state = rateLimits.get("secondary");
  if (!state || state.throttledAttempts === 0 || state.throttledAttempts >= maxSecondaryAttempts)
    return;
  const key = state.retryRequest;
  if (key && isRetryOwnerActive(key)) return;
  rateLimits.set("secondary", { ...state, throttledAttempts: 0, retryRequest: null });
}

function memoryRetryDeadlines(): GitHubRetryDeadlines {
  const deadlines = new Map<string, number>();
  return {
    get: (key) => deadlines.get(key),
    extend(keys, retryAt) {
      for (const key of keys) deadlines.set(key, Math.max(deadlines.get(key) ?? 0, retryAt));
    },
  };
}

export function createGitHubAppClient({
  clientId,
  privateKey,
  fetcher = fetch,
  now = Date.now,
  rateLimits = new Map<RateLimitScope, GitHubRateLimitState>(),
  retryDeadlines = memoryRetryDeadlines(),
  isRetryOwnerActive = () => true,
  canReadPullRequest = () => true,
}: {
  clientId: string;
  privateKey: string;
  fetcher?: typeof fetch;
  now?: () => number;
  rateLimits?: GitHubRateLimits;
  retryDeadlines?: GitHubRetryDeadlines;
  isRetryOwnerActive?: (key: string) => boolean;
  canReadPullRequest?: (target: GitHubRepository, pullRequest: number) => boolean;
}) {
  const key = createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== "rsa") throw new Error("GitHub App requires an RSA private key.");
  const tokens = new Map<string, Token>();
  const installationReads = new Map<number, Promise<void>>();

  function queueRead<T>(installationId: number, read: () => Promise<T>): Promise<T> {
    const result = (installationReads.get(installationId) ?? Promise.resolve()).then(read);
    // A failed read still rejects for its caller and releases the next queued read.
    const completion = result.then(
      () => undefined,
      () => undefined,
    );
    installationReads.set(installationId, completion);
    void completion.then(() => {
      if (installationReads.get(installationId) === completion)
        installationReads.delete(installationId);
    });
    return result;
  }

  function limitsFor(scope: RateLimitScope) {
    const secondary = rateLimits.get("secondary");
    return {
      retryAt: Math.max(rateLimits.get(scope)?.retryAt ?? 0, secondary?.retryAt ?? 0),
      throttledAttempts: secondary?.throttledAttempts ?? 0,
    };
  }

  function rememberPrimaryReset(scope: InstallationScope, retryAt: number): void {
    if (retryAt > (rateLimits.get(scope)?.retryAt ?? 0))
      rateLimits.set(scope, { retryAt, throttledAttempts: 0, retryRequest: null });
  }

  function clearSecondaryAttempts(
    startedAt: number,
    belongsToRetry: (key: string) => boolean,
  ): void {
    const latest = rateLimits.get("secondary");
    if (latest?.retryRequest && latest.retryAt <= startedAt && belongsToRetry(latest.retryRequest))
      rateLimits.set("secondary", { retryAt: 0, throttledAttempts: 0, retryRequest: null });
  }

  function appJwt(): string {
    const seconds = Math.floor(now() / 1000);
    const encode = (data: object) => Buffer.from(JSON.stringify(data)).toString("base64url");
    const claims = encode({ iat: seconds - 60, exp: seconds + 540, iss: clientId });
    const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${claims}`;
    return `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), key).toString("base64url")}`;
  }

  function checkRetryDeadline(...keys: (string | undefined)[]): void {
    let retryAt = 0;
    for (const key of keys) {
      if (key !== undefined) retryAt = Math.max(retryAt, retryDeadlines.get(key) ?? 0);
    }
    if (retryAt > now())
      throw new GitHubTransientError("GitHub request is deferred by Retry-After.", { retryAt });
  }

  async function request(
    target: GitHubRepository,
    { path, method, body, reconcilePullRequest, commitRetryKey, drainSignal }: ApiRequest,
    credential: string,
  ): Promise<Response> {
    checkGitHubDrain(drainSignal);
    checkAuthentication(target);
    if (reconcilePullRequest !== undefined && !canReadPullRequest(target, reconcilePullRequest))
      throw new Error("Pull request reconciliation was stopped.");
    const scope = `installation:${target.installationId}` as const;
    const pullRequestKey =
      reconcilePullRequest === undefined
        ? undefined
        : pullRequestRetryKey(target, reconcilePullRequest);
    const tokenRequest = method === "POST" && path.startsWith("/app/installations/");
    const requestKey = tokenRequest
      ? tokenRetryKey(target)
      : pullRequestKey !== undefined
        ? `pr:${pullRequestKey}`
        : `${target.installationId}:GET:${path}`;
    const deadlineKey = tokenRequest ? requestKey : pullRequestKey;
    const startedAt = now();
    const limit = limitsFor(scope);
    const paused = limit.throttledAttempts >= maxSecondaryAttempts;
    if (paused || startedAt < limit.retryAt)
      throw new GitHubRateLimitError(limit.retryAt, undefined, paused);
    const headers = {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${credential}`,
      "content-type": "application/json",
      "user-agent": "switchyard",
      "x-github-api-version": "2026-03-10",
    };
    let response: Response;
    try {
      response = await fetcher(new URL(path, "https://api.github.com"), {
        headers,
        ...(method ? { method, body: body! } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
    } catch (cause) {
      throw new GitHubTransientError("GitHub API request failed or timed out.", { cause });
    }
    const primaryLimited = response.headers.get("x-ratelimit-remaining") === "0";
    const reset = primaryLimited
      ? headerMilliseconds(response.headers.get("x-ratelimit-reset"))
      : undefined;
    if (response.ok && !tokenRequest && reset !== undefined && reset > now())
      rememberPrimaryReset(scope, reset);

    let responseError: GitHubRateLimitError | GitHubTransientError | undefined;
    if (response.status === 403 || response.status === 429) {
      const retryDelay = headerMilliseconds(response.headers.get("retry-after"));
      const secondaryLimited =
        (!primaryLimited && (response.status === 429 || retryDelay !== undefined)) ||
        (await reportsSecondaryLimit(response));
      const observedAt = now();
      if (secondaryLimited) {
        retireInactiveGitHubRetry(rateLimits, isRetryOwnerActive);
        const previous = rateLimits.get("secondary");
        const previousAttempts = previous?.throttledAttempts ?? 0;
        const ownerActive = isRetryOwnerActive(requestKey);
        // Concurrent responses from before the current cooldown describe the same attempt.
        const alreadyCounted = previousAttempts > 0 && (previous?.retryAt ?? 0) > startedAt;
        const countAttempt =
          ownerActive && !alreadyCounted && previousAttempts < maxSecondaryAttempts;
        const throttledAttempts = previousAttempts + (countAttempt ? 1 : 0);
        // A late throttle from a stopped workflow still sets a cooldown without advancing the streak.
        const delay = Math.max(
          retryDelay ?? 0,
          fallbackRetryDelay * 2 ** (ownerActive ? Math.max(throttledAttempts - 1, 0) : 0),
        );
        rateLimits.set("secondary", {
          retryAt: Math.max(previous?.retryAt ?? 0, observedAt + delay),
          throttledAttempts,
          retryRequest: countAttempt ? requestKey : (previous?.retryRequest ?? null),
        });
      }
      if (primaryLimited) {
        rememberPrimaryReset(
          scope,
          Math.max(
            reset !== undefined && reset > observedAt ? reset : observedAt + fallbackRetryDelay,
            observedAt + (retryDelay ?? 0),
          ),
        );
      }
      if (primaryLimited || secondaryLimited) {
        const latest = limitsFor(scope);
        responseError = new GitHubRateLimitError(
          latest.retryAt,
          response.status,
          latest.throttledAttempts >= maxSecondaryAttempts,
        );
      }
    }
    if (transientStatuses.has(response.status)) {
      const retryAt = retryAfterDeadline(response.headers.get("retry-after"), now());
      if (retryAt !== undefined) {
        const keys = [deadlineKey, commitRetryKey].filter((key) => key !== undefined);
        if (keys.length > 0) retryDeadlines.extend(keys, retryAt);
      }
      const operation = tokenRequest
        ? "GitHub installation token request"
        : `GitHub API ${method ?? "GET"} ${path}`;
      responseError = new GitHubTransientError(`${operation} failed (HTTP ${response.status}).`, {
        retryAt,
      });
    }
    if (!response.ok && !response.bodyUsed) {
      try {
        await response.body?.cancel();
      } catch (cause) {
        const cleanupError = new Error("GitHub API response body could not be canceled.", {
          cause,
        });
        if (!responseError) throw cleanupError;
        responseError.cause = cleanupError;
      }
    }
    if (responseError) throw responseError;
    // Reads in a reconciliation only clear the count when the entire reconciliation succeeds.
    if (response.ok && limit.throttledAttempts > 0 && reconcilePullRequest === undefined)
      clearSecondaryAttempts(startedAt, (key) => key === requestKey);
    return response;
  }

  function checkAuthentication(target: GitHubRepository): void {
    const retryAt = retryDeadlines.get(installationAuthRetryKey(target));
    if (retryAt !== undefined && retryAt > now()) throw new GitHubAuthenticationError(retryAt);
  }

  function rejectAuthentication(target: GitHubRepository): never {
    const retryAt = now() + authenticationRetryDelay;
    retryDeadlines.extend([installationAuthRetryKey(target)], retryAt);
    throw new GitHubAuthenticationError(retryAt);
  }

  async function tokenFor(
    target: GitHubRepository,
    cacheKey: string,
    reconcilePullRequest: number | undefined,
    drainSignal?: AbortSignal,
  ): Promise<Token> {
    checkGitHubDrain(drainSignal);
    checkAuthentication(target);
    const cached = tokens.get(cacheKey);
    if (cached && cached.expiresAt - now() > 60_000) return cached;

    checkRetryDeadline(tokenRetryKey(target));
    const response = await request(
      target,
      {
        path: `/app/installations/${target.installationId}/access_tokens`,
        method: "POST",
        reconcilePullRequest,
        drainSignal,
        body: JSON.stringify({
          repositories: [target.repository.split("/")[1]],
          permissions,
        }),
      },
      appJwt(),
    );
    if (response.status === 401) rejectAuthentication(target);
    if (!response.ok)
      throw new Error(`GitHub installation token request failed (HTTP ${response.status}).`);
    const data = object(await readJson(response));
    const expiresAt = typeof data?.expires_at === "string" ? Date.parse(data.expires_at) : NaN;
    if (!data || typeof data.token !== "string" || !data.token || !(expiresAt > now()))
      throw new Error("GitHub returned an invalid installation token response.");
    const token = { value: data.token, expiresAt };
    tokens.set(cacheKey, token);
    return token;
  }

  return {
    completeReconciliation(target: GitHubRepository, pullRequest: number): void {
      clearSecondaryAttempts(now(), (key) => belongsToReconciliation(key, target, pullRequest));
    },

    readReviewThread(
      target: GitHubRepository & { pullRequest: number },
      rootCommentId: number,
    ): Promise<{ id: string; resolved: boolean; outdated: boolean } | null> {
      const query = `query SwitchyardReviewThread($owner: String!, $repo: String!, $pr: Int!, $after: String) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $pr) {
            reviewThreads(first: 100, after: $after) {
              nodes { id isResolved isOutdated comments(first: 1) { nodes { fullDatabaseId } } }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }`;
      const [owner, repo] = target.repository.split("/");
      return queueRead(target.installationId, async () => {
        let after: string | null = null;
        for (let page = 1; page <= 100; page += 1) {
          checkRetryDeadline(pullRequestRetryKey(target, target.pullRequest));
          const cacheKey = `${target.installationId}:${target.repository}`;
          const token = await tokenFor(target, cacheKey, target.pullRequest);
          const response = await request(
            target,
            {
              path: "/graphql",
              method: "POST",
              reconcilePullRequest: target.pullRequest,
              body: JSON.stringify({
                query,
                variables: { owner, repo, pr: target.pullRequest, after },
              }),
            },
            token.value,
          );
          if (!response.ok)
            throw new Error(`GitHub thread query failed (HTTP ${response.status}).`);
          const payload = object(await readJson(response));
          if (Array.isArray(payload?.errors) && payload.errors.length)
            throw new Error("GitHub returned errors for the review thread query.");
          const pullRequest = object(object(object(payload?.data)?.repository)?.pullRequest);
          const threads = object(pullRequest?.reviewThreads);
          const pageInfo = object(threads?.pageInfo);
          if (!Array.isArray(threads?.nodes) || typeof pageInfo?.hasNextPage !== "boolean")
            throw new Error("GitHub returned an incomplete review thread page.");
          for (const value of threads.nodes as unknown[]) {
            const thread = object(value);
            const roots = object(thread?.comments)?.nodes;
            const rootId = Array.isArray(roots) ? object(roots[0])?.fullDatabaseId : null;
            if (rootId !== rootCommentId && rootId !== String(rootCommentId)) continue;
            if (
              typeof thread?.id !== "string" ||
              !thread.id ||
              typeof thread.isResolved !== "boolean" ||
              typeof thread.isOutdated !== "boolean"
            )
              throw new Error("GitHub returned incomplete review thread state.");
            return { id: thread.id, resolved: thread.isResolved, outdated: thread.isOutdated };
          }
          if (!pageInfo.hasNextPage) return null;
          if (
            typeof pageInfo.endCursor !== "string" ||
            !pageInfo.endCursor ||
            after === pageInfo.endCursor
          )
            throw new Error("GitHub returned an invalid review thread cursor.");
          after = pageInfo.endCursor;
        }
        throw new Error("GitHub review thread pagination limit exceeded.");
      });
    },

    get(
      target: GitHubRepository,
      suffix: string,
      reconcilePullRequest?: number,
      drainSignal?: AbortSignal,
    ): Promise<{ data: unknown; hasNext: boolean }> {
      const cacheKey = `${target.installationId}:${target.repository}`;
      const path = `/repos/${target.repository}${suffix}`;
      const prRetryKey =
        reconcilePullRequest === undefined
          ? undefined
          : pullRequestRetryKey(target, reconcilePullRequest);
      // PRs at one commit share these endpoints, including all pages of an endpoint.
      const commitRetryKey = suffix.startsWith("/commits/")
        ? `commit:${target.installationId}:${path.split("?", 1)[0]}`
        : undefined;
      const read = { path, reconcilePullRequest, commitRetryKey, drainSignal };
      return queueRead(target.installationId, async () => {
        checkGitHubDrain(drainSignal);
        checkAuthentication(target);
        checkRetryDeadline(prRetryKey, commitRetryKey);
        let token = await tokenFor(target, cacheKey, reconcilePullRequest, drainSignal);
        let response = await request(target, read, token.value);
        if (response.status === 401) {
          tokens.delete(cacheKey);
          token = await tokenFor(target, cacheKey, reconcilePullRequest, drainSignal);
          response = await request(target, read, token.value);
          if (response.status === 401) {
            tokens.delete(cacheKey);
            rejectAuthentication(target);
          }
        }
        if (!response.ok)
          throw new Error(`GitHub API GET ${path} failed (HTTP ${response.status}).`);
        return {
          data: await readJson(response),
          hasNext: /;\s*rel="next"/.test(response.headers.get("link") ?? ""),
        };
      });
    },
  };
}

function headerMilliseconds(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const milliseconds = Number(value) * 1000;
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

function retryAfterDeadline(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const delay = headerMilliseconds(value);
  const deadline = delay === undefined ? Date.parse(value) : now + delay;
  return Number.isSafeInteger(deadline) && deadline > now ? deadline : undefined;
}

async function reportsSecondaryLimit(response: Response): Promise<boolean> {
  try {
    const message = object(await response.json())?.message;
    return typeof message === "string" && /\bsecondary rate limit\b/i.test(message);
  } catch {
    return false;
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
    if (cause instanceof SyntaxError)
      throw new Error("GitHub API response could not be read as JSON.", { cause });
    throw new GitHubTransientError("GitHub API response body could not be read.", { cause });
  }
}

export type GitHubAppClient = ReturnType<typeof createGitHubAppClient>;
