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
type RateLimitScope = "secondary" | `installation:${number}`;
export type GitHubRateLimits = {
  get(scope: RateLimitScope): GitHubRateLimitState | undefined;
  set(scope: RateLimitScope, state: GitHubRateLimitState): void;
};

const maxSecondaryAttempts = 5;
const fallbackRetryDelay = 60_000;

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

export function resumeGitHubAfterSecondaryLimit(rateLimits: GitHubRateLimits): boolean {
  const state = rateLimits.get("secondary");
  if (!state || state.throttledAttempts < maxSecondaryAttempts) return false;
  rateLimits.set("secondary", { ...state, throttledAttempts: 0, retryRequest: null });
  return true;
}

type Token = { value: string; expiresAt: number };
type ApiRequest = {
  path: string;
  method?: "POST";
  body?: string;
  checkPullRequest?: number;
};

function checkRetryKey(target: GitHubRepository, pullRequest: number): string {
  return `checks:${target.installationId}:${target.repository}:${pullRequest}`;
}

export function createGitHubAppClient({
  clientId,
  privateKey,
  fetcher = fetch,
  now = Date.now,
  rateLimits = new Map<RateLimitScope, GitHubRateLimitState>(),
}: {
  clientId: string;
  privateKey: string;
  fetcher?: typeof fetch;
  now?: () => number;
  rateLimits?: GitHubRateLimits;
}) {
  const key = createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== "rsa") throw new Error("GitHub App requires an RSA private key.");
  const tokens = new Map<string, Token>();
  const refreshes = new Map<string, Promise<Token>>();

  function limitsFor(scope: RateLimitScope) {
    const secondary = rateLimits.get("secondary");
    return {
      retryAt: Math.max(rateLimits.get(scope)?.retryAt ?? 0, secondary?.retryAt ?? 0),
      throttledAttempts: secondary?.throttledAttempts ?? 0,
    };
  }

  function clearSecondaryAttempts(requestKey: string, startedAt: number): void {
    const latest = rateLimits.get("secondary");
    if (latest?.retryRequest === requestKey && latest.retryAt <= startedAt)
      rateLimits.set("secondary", { retryAt: 0, throttledAttempts: 0, retryRequest: null });
  }

  function appJwt(): string {
    const seconds = Math.floor(now() / 1000);
    const encode = (data: object) => Buffer.from(JSON.stringify(data)).toString("base64url");
    const claims = encode({ iat: seconds - 60, exp: seconds + 540, iss: clientId });
    const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${claims}`;
    return `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), key).toString("base64url")}`;
  }

  async function request(
    target: GitHubRepository,
    { path, method, body, checkPullRequest }: ApiRequest,
    credential: string,
  ): Promise<Response> {
    const scope = `installation:${target.installationId}` as const;
    const requestKey =
      checkPullRequest !== undefined
        ? checkRetryKey(target, checkPullRequest)
        : method === "POST"
          ? `token:${target.installationId}:${target.repository}`
          : `${target.installationId}:GET:${path}`;
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
    } catch {
      throw new Error("GitHub API request failed or timed out.");
    }
    if (response.status === 403 || response.status === 429) {
      const retryDelay = headerMilliseconds(response.headers.get("retry-after"));
      const primaryLimited = response.headers.get("x-ratelimit-remaining") === "0";
      const secondaryLimited =
        (!primaryLimited && (response.status === 429 || retryDelay !== undefined)) ||
        (await reportsSecondaryLimit(response));
      const observedAt = now();
      if (secondaryLimited) {
        const previous = rateLimits.get("secondary");
        // Concurrent responses from before the current cooldown describe the same attempt.
        const alreadyCounted = previous && previous.retryAt > startedAt;
        const throttledAttempts = alreadyCounted
          ? previous.throttledAttempts
          : Math.min((previous?.throttledAttempts ?? 0) + 1, maxSecondaryAttempts);
        const delay = Math.max(retryDelay ?? 0, fallbackRetryDelay * 2 ** (throttledAttempts - 1));
        rateLimits.set("secondary", {
          retryAt: Math.max(previous?.retryAt ?? 0, observedAt + delay),
          throttledAttempts,
          retryRequest: alreadyCounted ? previous.retryRequest : requestKey,
        });
      }
      if (primaryLimited) {
        const reset = headerMilliseconds(response.headers.get("x-ratelimit-reset"));
        rateLimits.set(scope, {
          retryAt: Math.max(
            rateLimits.get(scope)?.retryAt ?? 0,
            reset !== undefined && reset > observedAt ? reset : observedAt + fallbackRetryDelay,
            observedAt + (retryDelay ?? 0),
          ),
          throttledAttempts: 0,
          retryRequest: null,
        });
      }
      if (primaryLimited || secondaryLimited) {
        const latest = limitsFor(scope);
        throw new GitHubRateLimitError(
          latest.retryAt,
          response.status,
          latest.throttledAttempts >= maxSecondaryAttempts,
        );
      }
    }
    // A successful check page cannot clear the count while another page may still be throttled.
    if (response.ok && limit.throttledAttempts > 0 && checkPullRequest === undefined)
      clearSecondaryAttempts(requestKey, startedAt);
    return response;
  }

  async function tokenFor(target: GitHubRepository, cacheKey: string): Promise<Token> {
    const cached = tokens.get(cacheKey);
    if (cached && cached.expiresAt - now() > 60_000) return cached;
    const inFlight = refreshes.get(cacheKey);
    if (inFlight) return inFlight;

    const refresh = (async () => {
      const response = await request(
        target,
        {
          path: `/app/installations/${target.installationId}/access_tokens`,
          method: "POST",
          body: JSON.stringify({
            repositories: [target.repository.split("/")[1]],
            permissions,
          }),
        },
        appJwt(),
      );
      if (!response.ok)
        throw new Error(`GitHub installation token request failed (HTTP ${response.status}).`);
      const data = object(await readJson(response));
      const expiresAt = typeof data?.expires_at === "string" ? Date.parse(data.expires_at) : NaN;
      if (!data || typeof data.token !== "string" || !data.token || !(expiresAt > now()))
        throw new Error("GitHub returned an invalid installation token response.");
      const token = { value: data.token, expiresAt };
      tokens.set(cacheKey, token);
      return token;
    })();
    refreshes.set(cacheKey, refresh);
    try {
      return await refresh;
    } finally {
      refreshes.delete(cacheKey);
    }
  }

  return {
    completeCheckRead(target: GitHubRepository, pullRequest: number): void {
      clearSecondaryAttempts(checkRetryKey(target, pullRequest), now());
    },

    async get(
      target: GitHubRepository,
      suffix: string,
      checkPullRequest?: number,
    ): Promise<{ data: unknown; hasNext: boolean }> {
      const cacheKey = `${target.installationId}:${target.repository}`;
      const path = `/repos/${target.repository}${suffix}`;
      const read = { path, ...(checkPullRequest === undefined ? {} : { checkPullRequest }) };
      let token = await tokenFor(target, cacheKey);
      let response = await request(target, read, token.value);
      if (response.status === 401) {
        if (tokens.get(cacheKey) === token) tokens.delete(cacheKey);
        token = await tokenFor(target, cacheKey);
        response = await request(target, read, token.value);
        if (response.status === 401 && tokens.get(cacheKey) === token) tokens.delete(cacheKey);
      }
      if (!response.ok) throw new Error(`GitHub API GET ${path} failed (HTTP ${response.status}).`);
      return {
        data: await readJson(response),
        hasNext: /;\s*rel="next"/.test(response.headers.get("link") ?? ""),
      };
    },
  };
}

function headerMilliseconds(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const milliseconds = Number(value) * 1000;
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
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
  } catch {
    throw new Error("GitHub API response could not be read as JSON.");
  }
}

export type GitHubAppClient = ReturnType<typeof createGitHubAppClient>;
