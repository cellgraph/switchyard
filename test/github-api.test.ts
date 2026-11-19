import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createGitHubReader } from "../src/github-api.ts";
import { createGitHubAppClient } from "../src/github-app.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const target = { repository: "owner/repo", installationId: 42, pullRequest: 7 };
const sha = "a".repeat(40);
const otherSha = "b".repeat(40);

function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  return new URL(input instanceof Request ? input.url : input);
}

describe("GitHub App and REST adapter", () => {
  it("signs RS256 JWTs, scopes tokens and coalesces refreshes", async () => {
    let now = Date.UTC(2026, 0, 1);
    let exchanges = 0;
    const fetcher = vi.fn<typeof fetch>(async (input, options) => {
      const url = requestUrl(input);
      expect(url.origin).toBe("https://api.github.com");
      const headers = new Headers(options?.headers);
      expect(headers.get("x-github-api-version")).toBe("2026-03-10");
      expect(options?.redirect).toBe("error");
      if (options?.method === "POST") {
        exchanges++;
        expect(url.pathname).toBe("/app/installations/42/access_tokens");
        const [header, claims, signature] = headers.get("authorization")!.slice(7).split(".");
        expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({
          alg: "RS256",
          typ: "JWT",
        });
        expect(JSON.parse(Buffer.from(claims!, "base64url").toString())).toEqual({
          iat: now / 1000 - 60,
          exp: now / 1000 + 540,
          iss: "fixture-client-id",
        });
        expect(
          verify(
            "RSA-SHA256",
            Buffer.from(`${header}.${claims}`),
            publicKey,
            Buffer.from(signature!, "base64url"),
          ),
        ).toBe(true);
        expect(JSON.parse(String(options.body))).toEqual({
          repositories: [exchanges === 3 ? "another" : "repo"],
          permissions: { pull_requests: "read", checks: "read", statuses: "read" },
        });
        return Response.json({
          token: `installation-token-${exchanges}`,
          expires_at: new Date(now + 3_600_000).toISOString(),
        });
      }
      return Response.json({ auth: headers.get("authorization") });
    });
    const client = createGitHubAppClient({
      clientId: "fixture-client-id",
      privateKey,
      fetcher,
      now: () => now,
    });
    const first = await Promise.all([
      client.get(target, "/pulls/7"),
      client.get(target, "/pulls/8"),
    ]);
    expect(first.map(({ data }) => data)).toEqual([
      { auth: "Bearer installation-token-1" },
      { auth: "Bearer installation-token-1" },
    ]);
    now += 3_541_000;
    expect((await client.get(target, "/pulls/7")).data).toEqual({
      auth: "Bearer installation-token-2",
    });
    expect((await client.get({ ...target, repository: "owner/another" }, "/pulls/7")).data).toEqual(
      {
        auth: "Bearer installation-token-3",
      },
    );
    expect(exchanges).toBe(3);
  });

  it("replaces rejected tokens once and omits error response bodies", async () => {
    let exchanges = 0;
    const seen = new Set<string>();
    const fetcher = vi.fn<typeof fetch>(async (_input, options) => {
      if (options?.method === "POST")
        return Response.json({
          token: `token-${++exchanges}`,
          expires_at: new Date(Date.now() + 3_600_000),
        });
      const auth = new Headers(options?.headers).get("authorization")!;
      if (auth === "Bearer token-2" && !seen.has(auth)) {
        seen.add(auth);
        return Response.json([]);
      }
      return Response.json({ body: "sensitive GitHub response" }, { status: 401 });
    });
    const client = createGitHubAppClient({ clientId: "fixture-client-id", privateKey, fetcher });
    await expect(client.get(target, "/pulls/7")).resolves.toMatchObject({ data: [] });
    await expect(client.get(target, "/pulls/7")).rejects.toThrow(
      /^GitHub API GET \/repos\/owner\/repo\/pulls\/7 failed \(HTTP 401\)\.$/,
    );
    expect(exchanges).toBe(3);
  });

  it("recovers from a failed token exchange and honors an API retry window", async () => {
    let now = Date.UTC(2026, 0, 1);
    let exchanges = 0;
    let gets = 0;
    const fetcher = vi.fn<typeof fetch>(async (_input, options) => {
      if (options?.method === "POST") {
        if (++exchanges === 1) return Response.json({ error: "private" }, { status: 503 });
        return Response.json({ token: "fixture-token", expires_at: new Date(now + 3_600_000) });
      }
      if (++gets === 1)
        return new Response(null, { status: 429, headers: { "retry-after": "60" } });
      return Response.json(null);
    });
    const client = createGitHubAppClient({
      clientId: "fixture-client-id",
      privateKey,
      fetcher,
      now: () => now,
    });
    await expect(client.get(target, "/pulls/7")).rejects.toThrow(
      "installation token request failed (HTTP 503)",
    );
    await expect(client.get(target, "/pulls/7")).rejects.toThrow("HTTP 429");
    now += 59_999;
    await expect(client.get(target, "/pulls/7")).rejects.toThrow("rate limit is active");
    expect(gets).toBe(1);
    now++;
    await expect(client.get(target, "/pulls/7")).resolves.toMatchObject({ data: null });
    expect(exchanges).toBe(2);
  });

  it("scopes a primary rate-limit reset to the affected installation", async () => {
    let now = Date.UTC(2026, 0, 1);
    const reset = now + 120_000;
    const fetcher = vi.fn<typeof fetch>(async (input, options) => {
      if (options?.method === "POST")
        return Response.json({ token: "fixture-token", expires_at: new Date(now + 3_600_000) });
      if (requestUrl(input).pathname.startsWith("/repos/owner/") && now < reset)
        return Response.json(
          { message: "API rate limit exceeded" },
          {
            status: 403,
            headers: {
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": String(reset / 1000),
              "retry-after": "10",
            },
          },
        );
      return Response.json([]);
    });
    const client = createGitHubAppClient({
      clientId: "fixture-client-id",
      privateKey,
      fetcher,
      now: () => now,
    });
    await expect(client.get(target, "/pulls/7")).rejects.toMatchObject({ retryAt: reset });
    expect(fetcher).toHaveBeenCalledTimes(2);

    await expect(
      client.get({ ...target, repository: "owner/another" }, "/pulls/7"),
    ).rejects.toMatchObject({ retryAt: reset });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(
      client.get({ ...target, repository: "other/repo", installationId: 84 }, "/pulls/7"),
    ).resolves.toMatchObject({ data: [] });
    expect(fetcher).toHaveBeenCalledTimes(4);

    now = reset;
    await expect(client.get(target, "/pulls/7")).resolves.toMatchObject({ data: [] });
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it("backs off a secondary 403 for one minute while ordinary permission errors stay local", async () => {
    let now = Date.UTC(2026, 0, 1);
    const fetcher = vi.fn<typeof fetch>(async (input, options) => {
      if (options?.method === "POST")
        return Response.json({ token: "fixture-token", expires_at: new Date(now + 3_600_000) });
      const path = requestUrl(input).pathname;
      if (path.endsWith("/pulls/8"))
        return Response.json(
          { message: "Resource not accessible by integration" },
          { status: 403 },
        );
      if (path.endsWith("/pulls/9"))
        return Response.json(
          { message: "You have exceeded a secondary rate limit. Sensitive detail." },
          {
            status: 403,
            headers: { "x-ratelimit-remaining": "100" },
          },
        );
      return Response.json([]);
    });
    const client = createGitHubAppClient({
      clientId: "fixture-client-id",
      privateKey,
      fetcher,
      now: () => now,
    });
    const other = { ...target, repository: "other/repo", installationId: 84 };
    await expect(client.get(target, "/pulls/8")).rejects.toThrow(
      /^GitHub API GET .* failed \(HTTP 403\)\.$/,
    );
    await expect(client.get(target, "/pulls/9")).rejects.toMatchObject({
      message: "GitHub API rate limit reached (HTTP 403).",
      retryAt: now + 60_000,
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    now += 59_999;
    await expect(client.get(other, "/pulls/7")).rejects.toThrow("rate limit is active");
    expect(fetcher).toHaveBeenCalledTimes(3);
    now++;
    await expect(client.get(other, "/pulls/7")).resolves.toMatchObject({ data: [] });
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it("paginates GitHub resources and normalizes conservative exact-head check evidence", async () => {
    const pagesSeen: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input, options) => {
      if (options?.method === "POST")
        return Response.json({
          token: "fixture-token",
          expires_at: new Date(Date.now() + 3_600_000),
        });
      const url = requestUrl(input);
      expect(url.origin).toBe("https://api.github.com");
      const path = url.pathname.replace("/repos/owner/repo", "");
      if (path === "/pulls/7") return Response.json({ number: 7, state: "open", head: { sha } });
      const page = url.searchParams.get("page");
      expect(url.searchParams.get("per_page")).toBe("100");
      pagesSeen.push(`${path}:${page}`);
      const next = { headers: { link: '<https://invalid.example/ignore>; rel="next"' } };
      if (path === "/pulls/7/reviews")
        return page === "1" ? Response.json([{ id: 1 }], next) : Response.json([{ id: 2 }]);
      if (path === "/pulls/7/comments") return Response.json([{ id: 3 }]);
      if (path === "/issues/7/comments") return Response.json([{ id: 4, body: "edited" }]);
      if (path === `/commits/${sha}/check-runs`) {
        expect(url.searchParams.get("filter")).toBe("latest");
        return Response.json(
          {
            check_runs:
              page === "1"
                ? [
                    {
                      name: "Stale",
                      head_sha: otherSha,
                      status: "completed",
                      conclusion: "success",
                    },
                    { name: "Lint", head_sha: sha, status: "completed", conclusion: "success" },
                    { name: "Build", head_sha: sha, status: "in_progress", conclusion: null },
                  ]
                : [
                    { name: "Neutral", head_sha: sha, status: "completed", conclusion: "neutral" },
                    { name: "Shared", head_sha: sha, status: "completed", conclusion: "success" },
                  ],
          },
          page === "1" ? next : undefined,
        );
      }
      if (path === `/commits/${sha}/status`)
        return Response.json({
          sha,
          statuses: [
            { context: "Shared", state: "success" },
            { context: "Legacy", state: "failure" },
          ],
        });
      throw new Error(`Unexpected fixture endpoint ${path}`);
    });
    const client = createGitHubAppClient({ clientId: "fixture-client-id", privateKey, fetcher });
    const api = createGitHubReader(client);
    expect(await api.readPullRequest(target)).toEqual({ headSha: sha, state: "open" });
    expect(await api.readReviewInputs(target)).toEqual({
      reviews: [{ id: 1 }, { id: 2 }],
      reviewComments: [{ id: 3 }],
      issueComments: [{ id: 4, body: "edited" }],
    });
    expect(await api.readChecks(target, sha)).toEqual([
      { name: "Build", sha, outcome: "pending" },
      { name: "Legacy", sha, outcome: "failed" },
      { name: "Lint", sha, outcome: "passed" },
      { name: "Neutral", sha, outcome: "unknown" },
      { name: "Shared", sha, outcome: "unknown" },
    ]);
    expect(pagesSeen).toContain("/pulls/7/reviews:2");
    expect(pagesSeen).toContain(`/commits/${sha}/check-runs:2`);
  });

  it("rejects legacy statuses resolved to a different SHA", async () => {
    const api = createGitHubReader({
      async get(_target, suffix) {
        return {
          data: suffix.includes("check-runs")
            ? { check_runs: [] }
            : { sha: otherSha, statuses: [{ context: "Legacy", state: "success" }] },
          hasNext: false,
        };
      },
    });
    await expect(api.readChecks(target, sha)).rejects.toThrow("different SHA");
  });
});
