import { createPrivateKey, sign } from "node:crypto";
import { object } from "./github-data.ts";

const permissions = {
  pull_requests: "read",
  checks: "read",
  statuses: "read",
} as const;

export type GitHubRepository = { repository: string; installationId: number };

type Token = { value: string; expiresAt: number };
type ApiRequest = {
  path: string;
  method?: "POST";
  body?: string;
};

export function createGitHubAppClient({
  clientId,
  privateKey,
  fetcher = fetch,
  now = Date.now,
}: {
  clientId: string;
  privateKey: string;
  fetcher?: typeof fetch;
  now?: () => number;
}) {
  const key = createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== "rsa") throw new Error("GitHub App requires an RSA private key.");
  const tokens = new Map<string, Token>();
  const refreshes = new Map<string, Promise<Token>>();
  let rateLimitedUntil = 0;

  function appJwt(): string {
    const seconds = Math.floor(now() / 1000);
    const encode = (data: object) => Buffer.from(JSON.stringify(data)).toString("base64url");
    const claims = encode({ iat: seconds - 60, exp: seconds + 540, iss: clientId });
    const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${claims}`;
    return `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), key).toString("base64url")}`;
  }

  async function request(
    { path, method, body }: ApiRequest,
    credential: string,
  ): Promise<Response> {
    if (now() < rateLimitedUntil) throw new Error("GitHub API rate limit is active.");
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
      const retryAfter = response.headers.get("retry-after");
      const reset = response.headers.get("x-ratelimit-reset");
      if (retryAfter && /^\d+$/.test(retryAfter)) {
        rateLimitedUntil = now() + Number(retryAfter) * 1000;
      } else if (
        response.headers.get("x-ratelimit-remaining") === "0" &&
        reset &&
        /^\d+$/.test(reset)
      ) {
        rateLimitedUntil = Number(reset) * 1000;
      } else if (response.status === 429) {
        rateLimitedUntil = now() + 60_000;
      }
    }
    return response;
  }

  async function tokenFor(target: GitHubRepository, cacheKey: string): Promise<Token> {
    const cached = tokens.get(cacheKey);
    if (cached && cached.expiresAt - now() > 60_000) return cached;
    const inFlight = refreshes.get(cacheKey);
    if (inFlight) return inFlight;

    const refresh = (async () => {
      const response = await request(
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
    async get(
      target: GitHubRepository,
      suffix: string,
    ): Promise<{ data: unknown; hasNext: boolean }> {
      const cacheKey = `${target.installationId}:${target.repository}`;
      const path = `/repos/${target.repository}${suffix}`;
      let token = await tokenFor(target, cacheKey);
      let response = await request({ path }, token.value);
      if (response.status === 401) {
        if (tokens.get(cacheKey) === token) tokens.delete(cacheKey);
        token = await tokenFor(target, cacheKey);
        response = await request({ path }, token.value);
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

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error("GitHub API response could not be read as JSON.");
  }
}

export type GitHubAppClient = ReturnType<typeof createGitHubAppClient>;
