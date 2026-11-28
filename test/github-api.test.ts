import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createController, createGitHubRetryOwnerCheck } from "../src/controller.ts";
import { createGitHubReader, type GitHubReader } from "../src/github-api.ts";
import {
  createGitHubAppClient,
  GitHubTransientError,
  GitHubAuthenticationError,
  repositoryRetryKey,
  resumeGitHubAfterSecondaryLimit,
  tokenRetryKey,
} from "../src/github-app.ts";
import { canReadPullRequestChecks, createReconciler } from "../src/reconcile.ts";
import { WorkflowStore } from "../src/store.ts";

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

function targetedController({
  targets,
  ...options
}: Omit<Parameters<typeof createController>[0], "repositories" | "github"> & {
  targets: (typeof target)[];
}) {
  const repositories = [
    ...new Map(
      targets.map(({ repository, installationId }) => [repository, { repository, installationId }]),
    ).values(),
  ];
  const controller = createController({
    ...options,
    repositories,
    github: {
      listOpenPullRequests: async () => {
        throw new Error("Expected a PR-specific reconciliation.");
      },
      completeReconciliation: () => undefined,
    },
  });
  return {
    runPass() {
      for (const target of targets) controller.notify(target);
      return controller.runPass();
    },
  };
}

function prFixture(
  input: Parameters<typeof fetch>[0],
  fields: { number: number; state: string; head: { sha: string } },
  init?: ResponseInit,
) {
  const [, , owner, repo] = requestUrl(input).pathname.split("/");
  const repository = { full_name: `${owner}/${repo}` };
  return Response.json(
    {
      ...fields,
      draft: false,
      merged: false,
      base: { repo: repository },
      head: { ...fields.head, repo: repository },
    },
    init,
  );
}

function seedWorkflow(store: WorkflowStore, target: { repository: string; pullRequest: number }) {
  store.createWorkflow({
    id: `${target.repository}#${target.pullRequest}`,
    identity: { repository: target.repository, pullRequest: target.pullRequest },
    state: "awaiting_review",
    headSha: sha,
    requiredChecks: null,
    checks: [],
    escalationReason: null,
  });
}

describe("GitHub App and REST adapter", () => {
  it("uses every discovery page and enrolls human and bot PRs from authoritative detail reads", async () => {
    const sources = ["alice", "dependabot[bot]", "independent-agent[bot]"];
    const next = {
      headers: {
        link: '<https://api.github.com/repos/owner/repo/pulls?state=open&page=2>; rel="next"',
      },
    };
    const fetcher = vi.fn<typeof fetch>(async (input, options) => {
      if (options?.method === "POST")
        return Response.json({ token: "fixture", expires_at: "2099-01-01T00:00:00Z" });
      const { pathname, searchParams } = requestUrl(input);
      if (pathname.endsWith("/pulls")) {
        expect(searchParams.get("state")).toBe("open");
        expect(searchParams.get("per_page")).toBe("100");
        const candidate = (number: number) => ({
          number,
          user: { login: sources[number - 7] },
          draft: true,
          head: { repo: { full_name: "stale/fork" } },
        });
        return searchParams.get("page") === "1"
          ? Response.json([candidate(7), candidate(8)], next)
          : Response.json([candidate(8), candidate(9)]);
      }
      const match = pathname.match(/\/pulls\/(\d+)$/);
      if (match) {
        const number = Number(match[1]);
        const repo = { full_name: "OWNER/REPO" };
        return Response.json({
          number,
          state: "open",
          draft: false,
          merged: false,
          user: { login: sources[number - 7] },
          base: { repo },
          head: { sha, repo },
        });
      }
      if (pathname.endsWith("/check-runs")) return Response.json({ check_runs: [] });
      if (pathname.endsWith("/status")) return Response.json({ sha, statuses: [] });
      throw new Error(`Unexpected fixture endpoint ${pathname}`);
    });
    const store = new WorkflowStore();
    try {
      const github = createGitHubReader(
        createGitHubAppClient({ clientId: "fixture", privateKey, fetcher }),
      );
      const controller = createController({
        store,
        repositories: [target],
        github,
        reconcile: createReconciler(store, github),
        reportError: vi.fn(),
      });
      controller.scheduleSweep();
      expect(await controller.runPass()).toBe(true);
      expect(store.listWorkflows(target.repository).map(({ id }) => id)).toEqual([
        "owner/repo#7",
        "owner/repo#8",
        "owner/repo#9",
      ]);
      expect(
        fetcher.mock.calls.filter(([input]) => requestUrl(input).pathname.endsWith("/pulls/8")),
      ).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  it.each(["invalid page", "repository Retry-After", "installation quota"] as const)(
    "isolates incomplete discovery caused by %s and recovers on a later sweep",
    async (failure) => {
      const store = new WorkflowStore();
      const other = { repository: "owner/other", installationId: 84, pullRequest: 10 };
      let now = Date.UTC(2026, 0, 1);
      const retryAt = now + 120_000;
      const fetcher = vi.fn<typeof fetch>(async (input, options) => {
        if (options?.method === "POST")
          return Response.json({ token: "fixture", expires_at: "2099-01-01T00:00:00Z" });
        const { pathname, searchParams } = requestUrl(input);
        if (pathname.endsWith("/other/pulls")) return Response.json([{ number: 10 }]);
        if (pathname.endsWith("/repo/pulls")) {
          if (now >= retryAt) return Response.json([{ number: 8 }]);
          if (searchParams.get("page") === "1") {
            const headers = new Headers({
              link: '<https://api.github.com/repos/owner/repo/pulls?page=2>; rel="next"',
            });
            if (failure === "installation quota") {
              headers.set("x-ratelimit-remaining", "0");
              headers.set("x-ratelimit-reset", String(retryAt / 1000));
            }
            return Response.json([{ number: 8 }], { headers });
          }
          if (failure === "repository Retry-After")
            return new Response(null, { status: 503, headers: { "retry-after": "120" } });
          return Response.json({ error: "missing page items" });
        }
        const number = Number(pathname.match(/\/pulls\/(\d+)$/)?.[1]);
        if (number)
          return prFixture(input, {
            number,
            state: number === 7 ? "closed" : "open",
            head: { sha },
          });
        if (pathname.endsWith("/check-runs")) return Response.json({ check_runs: [] });
        if (pathname.endsWith("/status")) return Response.json({ sha, statuses: [] });
        throw new Error(`Unexpected fixture endpoint ${pathname}`);
      });
      try {
        seedWorkflow(store, target);
        const rateLimits = store.githubRateLimits();
        const retryDeadlines = store.reconciliationRetries();
        const github = createGitHubReader(
          createGitHubAppClient({
            clientId: "fixture",
            privateKey,
            fetcher,
            rateLimits,
            retryDeadlines,
            now: () => now,
          }),
        );
        const controller = createController({
          store,
          repositories: [target, other],
          github,
          reconcile: createReconciler(store, github),
          reportError: vi.fn(),
          now: () => now,
        });
        const sweep = () => {
          controller.scheduleSweep();
          return controller.runPass();
        };
        expect(await sweep()).toBe(false);
        expect(store.findWorkflow(target.repository, 8)).toBeNull();
        expect(store.findWorkflow(other.repository, 10)?.state).toBe("awaiting_review");
        expect(store.findWorkflow(target.repository, 7)?.state).toBe(
          failure === "installation quota" ? "awaiting_review" : "stopped",
        );
        if (failure !== "invalid page") {
          expect(
            retryDeadlines.get(repositoryRetryKey(target)) ??
              rateLimits.get("installation:42")?.retryAt,
          ).toBe(retryAt);
          const countDiscoveryRequests = () =>
            fetcher.mock.calls.filter(([input]) =>
              requestUrl(input).pathname.endsWith("/repo/pulls"),
            ).length;
          const before = countDiscoveryRequests();
          now = retryAt - 1;
          expect(await sweep()).toBe(false);
          expect(countDiscoveryRequests()).toBe(before);
        }
        now = retryAt;
        expect(await sweep()).toBe(true);
        expect(store.findWorkflow(target.repository, 7)).toMatchObject({ githubStatus: "closed" });
        expect(store.findWorkflow(target.repository, 8)).toMatchObject({
          githubStatus: "eligible",
        });
      } finally {
        store.close();
      }
    },
  );

  it("preserves discovery secondary backoff across restart and clears it after complete discovery", async () => {
    const dir = mkdtempSync(join(tmpdir(), "switchyard-discovery-limit-"));
    const path = join(dir, "state.sqlite");
    let store = new WorkflowStore(path);
    let now = Date.UTC(2026, 0, 1);
    const firstRetry = now + 120_000;
    const fetcher = vi.fn<typeof fetch>(async (_input, options) => {
      if (options?.method === "POST")
        return Response.json({ token: "fixture", expires_at: "2099-01-01T00:00:00Z" });
      if (now < firstRetry)
        return new Response(null, {
          status: 429,
          headers: { "retry-after": new Date(firstRetry).toUTCString() },
        });
      return Response.json([]);
    });
    function sweep() {
      const github = createGitHubReader(
        createGitHubAppClient({
          clientId: "fixture",
          privateKey,
          fetcher,
          rateLimits: store.githubRateLimits(),
          retryDeadlines: store.reconciliationRetries(),
          isRetryOwnerActive: createGitHubRetryOwnerCheck(store, [target]),
          now: () => now,
        }),
      );
      const controller = createController({
        store,
        repositories: [target],
        github,
        reconcile: createReconciler(store, github),
        reportError: vi.fn(),
        now: () => now,
      });
      controller.scheduleSweep();
      return controller.runPass();
    }
    try {
      expect(await sweep()).toBe(false);
      expect(store.githubRateLimits().get("secondary")).toEqual({
        retryAt: firstRetry,
        throttledAttempts: 1,
        retryRequest: repositoryRetryKey(target),
      });
      store.close();
      store = new WorkflowStore(path);
      expect(await sweep()).toBe(false);
      expect(fetcher).toHaveBeenCalledTimes(2);
      now = firstRetry;
      expect(await sweep()).toBe(true);
      expect(store.githubRateLimits().get("secondary")).toEqual({
        retryAt: 0,
        throttledAttempts: 0,
        retryRequest: null,
      });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("counts consecutive throttles when a tracked PR is becoming eligible again", async () => {
    const store = new WorkflowStore();
    let now = Date.UTC(2026, 0, 1);
    const start = now;
    const fetcher = vi.fn<typeof fetch>(async (input, options) => {
      if (options?.method === "POST")
        return Response.json({ token: "fixture", expires_at: "2099-01-01T00:00:00Z" });
      const { pathname } = requestUrl(input);
      if (pathname.endsWith("/pulls/7"))
        return prFixture(input, { number: 7, state: "open", head: { sha } });
      return new Response(null, { status: 429 });
    });
    try {
      seedWorkflow(store, target);
      store.transition("owner/repo#7", { type: "github_pull_request", sha, status: "draft" });
      const rateLimits = store.githubRateLimits();
      const github = createGitHubReader(
        createGitHubAppClient({
          clientId: "fixture",
          privateKey,
          fetcher,
          rateLimits,
          isRetryOwnerActive: createGitHubRetryOwnerCheck(store, [target]),
          now: () => now,
        }),
      );
      const { runPass } = targetedController({
        store,
        targets: [target],
        reconcile: createReconciler(store, github),
        reportError: vi.fn(),
        now: () => now,
      });
      expect(await runPass()).toBe(false);
      expect(rateLimits.get("secondary")?.retryAt).toBe(start + 60_000);
      now = start + 60_000;
      expect(await runPass()).toBe(false);
      expect(rateLimits.get("secondary")).toEqual({
        throttledAttempts: 2,
        retryAt: start + 180_000,
        retryRequest: "pr:42:owner/repo:7",
      });
      expect(store.getWorkflow("owner/repo#7")).toMatchObject({
        state: "stopped",
        githubStatus: "draft",
      });
    } finally {
      store.close();
    }
  });

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
      /^GitHub rejected credentials \(HTTP 401\)/,
    );
    expect(exchanges).toBe(3);
  });

  it("recognizes an auth cooldown recorded during token exchange before starting a repository read", async () => {
    const now = Date.UTC(2026, 0, 1);
    let retryAt: number | undefined;
    const fetcher = vi.fn<typeof fetch>(async () => {
      retryAt = now + 300_000;
      return Response.json({ token: "fixture", expires_at: new Date(now + 3_600_000) });
    });
    const client = createGitHubAppClient({
      clientId: "test",
      privateKey,
      fetcher,
      now: () => now,
      retryDeadlines: {
        get: (key) => (key.startsWith("auth:") ? retryAt : undefined),
        extend: vi.fn(),
      },
    });
    await expect(client.get(target, "/pulls/7")).rejects.toBeInstanceOf(GitHubAuthenticationError);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(requestUrl(fetcher.mock.calls[0]![0]).pathname).toContain("/access_tokens");
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

  it.each([403, 200] as const)(
    "scopes a primary rate-limit reset from HTTP %i to its installation",
    async (status) => {
      let now = Date.UTC(2026, 0, 1);
      const reset = now + 120_000;
      const fetcher = vi.fn<typeof fetch>(async (input, options) => {
        if (options?.method === "POST")
          return Response.json({ token: "fixture-token", expires_at: new Date(now + 3_600_000) });
        if (requestUrl(input).pathname.startsWith("/repos/owner/") && now < reset)
          return Response.json(
            status === 200 ? { number: 7 } : { message: "API rate limit exceeded" },
            {
              status,
              headers: {
                "x-ratelimit-remaining": "0",
                "x-ratelimit-reset": String(reset / 1000),
                ...(status === 403 ? { "retry-after": "10" } : {}),
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
      const response = client.get(target, "/pulls/7");
      if (status === 200) await expect(response).resolves.toMatchObject({ data: { number: 7 } });
      else await expect(response).rejects.toMatchObject({ retryAt: reset });
      expect(fetcher).toHaveBeenCalledTimes(2);

      await expect(client.get(target, "/pulls/7/reviews")).rejects.toMatchObject({
        retryAt: reset,
      });
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
    },
  );

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

  it.each(["primary", "secondary"] as const)(
    "restores %s backoff before the startup sweep after restart",
    async (kind) => {
      const dir = mkdtempSync(join(tmpdir(), "switchyard-backoff-"));
      const path = join(dir, "state.sqlite");
      let store = new WorkflowStore(path);
      let now = Date.UTC(2026, 0, 1);
      const retryAt = now + 120_000;
      const fetcher = vi.fn<typeof fetch>(async (input, options) => {
        if (options?.method === "POST")
          return Response.json({ token: "fixture-token", expires_at: new Date(now + 3_600_000) });
        if (now >= retryAt) return prFixture(input, { number: 7, state: "open", head: { sha } });
        return Response.json(
          {
            message:
              kind === "secondary"
                ? "You have exceeded a secondary rate limit"
                : "API rate limit exceeded",
          },
          {
            status: 403,
            headers:
              kind === "primary"
                ? { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(retryAt / 1000) }
                : { "retry-after": "120", "x-ratelimit-remaining": "100" },
          },
        );
      });
      function controller() {
        const client = createGitHubAppClient({
          clientId: "fixture-client-id",
          privateKey,
          fetcher,
          now: () => now,
          rateLimits: store.githubRateLimits(),
        });
        const reader = createGitHubReader(client);
        return targetedController({
          store,
          targets: [target],
          reconcile: async (target) => {
            await reader.readPullRequest(target);
          },
          reportError: vi.fn(),

          now: () => now,
        });
      }

      try {
        expect(await controller().runPass()).toBe(false);
        expect(fetcher).toHaveBeenCalledTimes(2);

        store.close();
        store = new WorkflowStore(path);

        now += 10_000;
        const restarted = controller();
        expect(await restarted.runPass()).toBe(false);
        expect(fetcher).toHaveBeenCalledTimes(2);

        now = retryAt;
        expect(await restarted.runPass()).toBe(true);
        expect(fetcher).toHaveBeenCalledTimes(4);
      } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.each(["primary", "secondary"] as const)(
    "resumes PR observations independently after %s throttling",
    async (kind) => {
      const store = new WorkflowStore();
      let now = Date.UTC(2026, 0, 1);
      const firstReset = now + 60_000;
      const lastReset = now + 120_000;
      const other = { repository: "other/repo", installationId: 84, pullRequest: 8 };
      const fetcher = vi.fn<typeof fetch>(async (input, options) => {
        if (options?.method === "POST")
          return Response.json({ token: "fixture-token", expires_at: new Date(now + 3_600_000) });
        const path = requestUrl(input).pathname;
        if (path.endsWith("/pulls/7") && kind === "secondary" && now < lastReset)
          return new Response(null, { status: 429, headers: { "retry-after": "120" } });
        if (path.endsWith("/pulls/7"))
          return prFixture(input, { number: 7, state: "open", head: { sha } });
        if (path.endsWith("/pulls/8"))
          return prFixture(input, { number: 8, state: "open", head: { sha } });
        if (path.endsWith("/check-runs")) return Response.json({ check_runs: [] });
        if (path.endsWith("/status")) return Response.json({ sha, statuses: [] });
        return Response.json([]);
      });
      try {
        const rateLimits = store.githubRateLimits();
        if (kind === "primary") {
          rateLimits.set("installation:42", {
            retryAt: firstReset,
            throttledAttempts: 0,
            retryRequest: null,
          });
          rateLimits.set("installation:84", {
            retryAt: lastReset,
            throttledAttempts: 0,
            retryRequest: null,
          });
        }
        const client = createGitHubAppClient({
          clientId: "fixture-client-id",
          privateKey,
          fetcher,
          rateLimits,
          now: () => now,
        });
        const { runPass } = targetedController({
          store,
          targets: [target, other],
          reconcile: createReconciler(store, createGitHubReader(client)),
          reportError: vi.fn(),

          now: () => now,
        });
        expect(await runPass()).toBe(false);
        expect(fetcher).toHaveBeenCalledTimes(kind === "primary" ? 0 : 2);

        now = firstReset;
        await runPass();
        expect(store.findWorkflow(other.repository, other.pullRequest)).toBeNull();
        expect(Boolean(store.findWorkflow(target.repository, target.pullRequest))).toBe(
          kind === "primary",
        );
        now = lastReset;
        expect(await runPass()).toBe(true);
        expect(store.findWorkflow(target.repository, target.pullRequest)?.headSha).toBe(sha);
        expect(store.findWorkflow(other.repository, other.pullRequest)?.headSha).toBe(sha);
        expect(
          fetcher.mock.calls.filter(([input]) => requestUrl(input).pathname.endsWith("/pulls/7")),
        ).toHaveLength(kind === "primary" ? 4 : 3);
      } finally {
        store.close();
      }
    },
  );

  it.each(["pause", "cooldown"] as const)(
    "explains a manual reconciliation deferred by a persisted secondary %s",
    async (state) => {
      const store = new WorkflowStore();
      const now = Date.UTC(2026, 0, 1);
      const retryAt = state === "pause" ? now - 1 : now + 120_000;
      const reportError = vi.fn();
      const reconcile = vi.fn();
      try {
        store.githubRateLimits().set("secondary", {
          retryAt,
          throttledAttempts: state === "pause" ? 5 : 1,
          retryRequest: "pr:42:owner/repo:7",
        });
        const { runPass } = targetedController({
          store,
          targets: [target],
          reconcile,
          reportError,

          now: () => now,
        });
        expect(await runPass()).toBe(false);
        expect(reconcile).not.toHaveBeenCalled();
        expect(reportError).toHaveBeenCalledExactlyOnceWith(
          expect.stringContaining(
            state === "pause" ? "--resume-github" : new Date(retryAt).toISOString(),
          ),
        );
      } finally {
        store.close();
      }
    },
  );

  it("observes a changed head on a later hint after the cooldown", async () => {
    const store = new WorkflowStore();
    let now = Date.UTC(2026, 0, 1);
    const resetAt = now + 120_000;
    let prReads = 0;
    const fetcher = vi.fn<typeof fetch>(async (input, options) => {
      if (options?.method === "POST")
        return Response.json({ token: "fixture-token", expires_at: new Date(now + 3_600_000) });
      const path = requestUrl(input).pathname;
      if (path.endsWith("/pulls/7"))
        return prFixture(input, {
          number: 7,
          state: "open",
          head: { sha: ++prReads === 1 ? sha : otherSha },
        });
      const commit = /\/commits\/([a-f0-9]+)\/(check-runs|status)$/.exec(path);
      if (commit?.[2] === "check-runs")
        return Response.json({
          check_runs: [
            {
              name: "build",
              head_sha: commit[1],
              status: "completed",
              conclusion: "success",
            },
          ],
        });
      if (commit?.[2] === "status") return Response.json({ sha: commit[1], statuses: [] });
      return Response.json([]);
    });
    try {
      const rateLimits = store.githubRateLimits();
      rateLimits.set("installation:42", {
        retryAt: resetAt,
        throttledAttempts: 0,
        retryRequest: null,
      });
      const client = createGitHubAppClient({
        clientId: "fixture-client-id",
        privateKey,
        fetcher,
        rateLimits,
        now: () => now,
      });
      const { runPass } = targetedController({
        store,
        targets: [target],
        reconcile: createReconciler(store, createGitHubReader(client)),
        reportError: vi.fn(),

        now: () => now,
      });
      expect(await runPass()).toBe(false);
      expect(fetcher).not.toHaveBeenCalled();
      now = resetAt;
      expect(await runPass()).toBe(false);
      expect(store.findWorkflow(target.repository, target.pullRequest)).toBeNull();
      expect(prReads).toBe(2);

      now += 29_999;
      await runPass();
      expect(prReads).toBe(2);
      now++;
      expect(await runPass()).toBe(true);
      expect(store.findWorkflow(target.repository, target.pullRequest)).toMatchObject({
        headSha: otherSha,
        checks: [{ name: "build", sha: otherSha, outcome: "passed" }],
      });
      expect(prReads).toBe(4);
    } finally {
      store.close();
    }
  });

  it("doubles consecutive secondary delays, persists the pause, and resumes after the final deadline", async () => {
    const dir = mkdtempSync(join(tmpdir(), "switchyard-pause-"));
    const path = join(dir, "state.sqlite");
    let store = new WorkflowStore(path);
    let now = Date.UTC(2026, 0, 1);
    let limited = true;
    const fetcher = vi.fn<typeof fetch>(async (_input, options) => {
      // Token refreshes can succeed even while every PR read is throttled.
      if (options?.method === "POST")
        return Response.json({ token: "fixture-token", expires_at: new Date(now + 65_000) });
      if (limited)
        return Response.json(
          { message: "You have exceeded a secondary rate limit" },
          { status: 403 },
        );
      return Response.json([]);
    });
    function client() {
      return createGitHubAppClient({
        clientId: "fixture-client-id",
        privateKey,
        fetcher,
        now: () => now,
        rateLimits: store.githubRateLimits(),
      });
    }
    try {
      const app = client();
      for (const minutes of [1, 2, 4, 8, 16]) {
        const retryAt = now + minutes * 60_000;
        const request = app.get(target, "/pulls/7");
        await expect(request).rejects.toMatchObject({ retryAt });
        if (minutes === 16)
          await expect(request).rejects.toThrow("paused after repeated secondary rate limits");
        now = retryAt;
      }
      expect(fetcher).toHaveBeenCalledTimes(10);
      const finalDeadline = now;

      store.close();
      store = new WorkflowStore(path);
      const restarted = client();
      await expect(restarted.get(target, "/pulls/7")).rejects.toThrow(
        "paused after repeated secondary rate limits",
      );
      expect(fetcher).toHaveBeenCalledTimes(10);
      expect(resumeGitHubAfterSecondaryLimit(store.githubRateLimits())).toBe(true);
      expect(store.githubRateLimits().get("secondary")).toEqual({
        retryAt: finalDeadline,
        throttledAttempts: 0,
        retryRequest: null,
      });
      limited = false;
      await expect(restarted.get(target, "/pulls/7")).resolves.toMatchObject({ data: [] });
      expect(fetcher).toHaveBeenCalledTimes(12);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(["503", "network failure", "body failure", "evidence retry deadline", "404"] as const)(
    "handles a %s after a persisted cooldown",
    async (failure) => {
      const store = new WorkflowStore();
      let now = Date.UTC(2026, 0, 1);
      const resetAt = now + 120_000;
      const retryAt = resetAt + (failure === "evidence retry deadline" ? 90_000 : 30_000);
      const fetcher = vi.fn<typeof fetch>(async (input, options) => {
        if (options?.method === "POST")
          return Response.json({ token: "fixture-token", expires_at: new Date(now + 3_600_000) });
        const path = requestUrl(input).pathname;
        if (path.endsWith("/pulls/7")) {
          if (now === resetAt) {
            if (failure === "503" || failure === "404")
              return new Response(null, { status: Number(failure) });
            if (failure === "network failure") throw new TypeError("Fixture connection failure");
            if (failure === "body failure")
              return new Response(
                new ReadableStream({
                  start(stream) {
                    stream.error(new Error("Fixture read failure"));
                  },
                }),
              );
          }
          return prFixture(input, { number: 7, state: "open", head: { sha } });
        }
        if (path.endsWith("/check-runs")) {
          if (failure === "evidence retry deadline" && now === resetAt)
            return new Response(null, {
              status: 503,
              headers: { "retry-after": new Date(retryAt).toUTCString() },
            });
          return Response.json({
            check_runs: [
              {
                name: "build",
                head_sha: sha,
                status: "completed",
                conclusion: "success",
              },
            ],
          });
        }
        if (path.endsWith("/status")) {
          if (failure === "evidence retry deadline" && now === resetAt)
            return Response.json(
              { message: "Resource not accessible by integration" },
              { status: 403 },
            );
          return Response.json({ sha, statuses: [] });
        }
        return Response.json([]);
      });
      try {
        const rateLimits = store.githubRateLimits();
        rateLimits.set("installation:42", {
          retryAt: resetAt,
          throttledAttempts: 0,
          retryRequest: null,
        });
        const client = createGitHubAppClient({
          clientId: "fixture-client-id",
          privateKey,
          fetcher,
          rateLimits,
          now: () => now,
        });
        const { runPass } = targetedController({
          store,
          targets: [target],
          reconcile: createReconciler(store, createGitHubReader(client)),
          reportError: vi.fn(),

          now: () => now,
        });
        expect(await runPass()).toBe(false);
        expect(fetcher).not.toHaveBeenCalled();
        now = resetAt;
        expect(await runPass()).toBe(false);
        const requests = fetcher.mock.calls.length;
        expect(requests).toBeGreaterThan(0);
        if (failure === "404")
          expect(store.findWorkflow(target.repository, target.pullRequest)).toBeNull();
        else {
          now = retryAt - 1;
          await runPass();
          expect(fetcher).toHaveBeenCalledTimes(requests);
        }
        now = retryAt;
        expect(await runPass()).toBe(true);
        expect(store.findWorkflow(target.repository, target.pullRequest)).toMatchObject({
          headSha: sha,
          checks: [{ name: "build", sha, outcome: "passed" }],
        });
      } finally {
        store.close();
      }
    },
  );

  it("blocks queued reads after a secondary throttle and clears the sequence after a successful read", async () => {
    let now = Date.UTC(2026, 0, 1);
    let limited = true;
    const fetcher = vi.fn<typeof fetch>(async (_input, options) => {
      if (options?.method === "POST")
        return Response.json({ token: "fixture-token", expires_at: new Date(now + 3_600_000) });
      if (limited) return new Response(null, { status: 429 });
      return Response.json([]);
    });
    const client = createGitHubAppClient({
      clientId: "fixture-client-id",
      privateKey,
      fetcher,
      now: () => now,
    });
    await Promise.all(
      ["/pulls/7", "/pulls/8"].map((path) =>
        expect(client.get(target, path)).rejects.toMatchObject({ retryAt: now + 60_000 }),
      ),
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    now += 60_000;
    limited = false;
    await client.get(target, "/pulls/9");
    limited = true;
    await expect(client.get(target, "/pulls/7")).rejects.toMatchObject({ retryAt: now + 120_000 });
    now += 120_000;
    limited = false;
    await client.get(target, "/pulls/7");
    limited = true;
    await expect(client.get(target, "/pulls/7")).rejects.toMatchObject({ retryAt: now + 60_000 });
  });

  it.each([
    [503, 0],
    [404, 0],
    [503, 180],
  ] as const)(
    "preserves the strongest startup retry deadline with a final HTTP %i and a %i-second retry hint",
    async (finalStatus, finalRetryAfter) => {
      const store = new WorkflowStore();
      let now = Date.UTC(2026, 0, 1);
      const startedAt = now;
      const retryAt = startedAt + Math.max(120, finalRetryAfter) * 1000;
      const finalError =
        finalStatus === 503
          ? new GitHubTransientError("HTTP 503", {
              retryAt: finalRetryAfter ? now + finalRetryAfter * 1000 : undefined,
            })
          : new Error("HTTP 404");
      const reader = {
        readPullRequest: vi
          .fn<GitHubReader["readPullRequest"]>()
          .mockResolvedValue({
            state: "open",
            headSha: sha,
            draft: false,
            merged: false,
            headRepository: target.repository,
          })
          .mockResolvedValueOnce({
            state: "open",
            headSha: sha,
            draft: false,
            merged: false,
            headRepository: target.repository,
          })
          .mockRejectedValueOnce(finalError),
        readChecks: vi
          .fn<GitHubReader["readChecks"]>()
          .mockRejectedValueOnce(new GitHubTransientError("HTTP 503", { retryAt: now + 120_000 }))
          .mockResolvedValue([{ name: "build", sha, outcome: "passed" }]),
        completeReconciliation: vi.fn(),
      };
      try {
        const { runPass } = targetedController({
          store,
          targets: [target],
          reconcile: createReconciler(store, reader),
          reportError: vi.fn(),

          now: () => now,
        });
        expect(await runPass()).toBe(false);
        expect(store.reconciliationRetries().get("42:owner/repo:7")).toBe(retryAt);
        now = startedAt + 30_000;
        expect(await runPass()).toBe(false);
        now = retryAt - 1;
        expect(await runPass()).toBe(false);
        expect(reader.readPullRequest).toHaveBeenCalledTimes(2);
        now++;
        expect(await runPass()).toBe(true);
        expect(store.findWorkflow(target.repository, target.pullRequest)?.checks).toEqual([
          { name: "build", sha, outcome: "passed" },
        ]);
        expect(reader.readPullRequest).toHaveBeenCalledTimes(4);
        expect(store.reconciliationRetries().get("42:owner/repo:7")).toBeUndefined();
      } finally {
        store.close();
      }
    },
  );

  it.each(["startup", "periodic"] as const)(
    "honors a deadline from a %s sweep across subsequent signals",
    async (trigger) => {
      const dir = mkdtempSync(join(tmpdir(), "switchyard-retry-trigger-"));
      const dbPath = join(dir, "state.sqlite");
      let store = new WorkflowStore(dbPath);
      let now = Date.UTC(2026, 0, 1);
      let unavailable = trigger === "startup";
      const other = { repository: "other/repo", installationId: 84, pullRequest: 8 };
      const fetcher = vi.fn<typeof fetch>(async (input, options) => {
        if (options?.method === "POST")
          return Response.json({ token: "fixture-token", expires_at: new Date(now + 3_600_000) });
        const path = requestUrl(input).pathname;
        if (path.endsWith("/pulls/7"))
          return prFixture(input, { number: 7, state: "open", head: { sha } });
        if (path.endsWith("/pulls/8"))
          return prFixture(input, { number: 8, state: "open", head: { sha } });
        if (path.endsWith("/check-runs")) {
          if (unavailable && path.startsWith("/repos/owner/repo/"))
            return new Response(null, { status: 503, headers: { "retry-after": "120" } });
          return Response.json({
            check_runs: [
              { name: "build", head_sha: sha, status: "completed", conclusion: "success" },
            ],
          });
        }
        if (path.endsWith("/status")) return Response.json({ sha, statuses: [] });
        return Response.json([]);
      });
      function controller() {
        const client = createGitHubAppClient({
          clientId: "fixture-client-id",
          privateKey,
          fetcher,
          now: () => now,
          rateLimits: store.githubRateLimits(),
          retryDeadlines: store.reconciliationRetries(),
        });
        return targetedController({
          store,
          targets: [target, other],
          reconcile: createReconciler(store, createGitHubReader(client)),
          reportError: vi.fn(),

          now: () => now,
        });
      }
      const readsForTarget = () =>
        fetcher.mock.calls.filter(([input]) =>
          requestUrl(input).pathname.startsWith("/repos/owner/repo/"),
        ).length;
      try {
        let { runPass } = controller();
        if (trigger === "periodic") {
          expect(await runPass()).toBe(true);
          now += 60_000;
          unavailable = true;
        }
        const readsBeforeFailure = readsForTarget();
        const retryAt = now + 120_000;
        expect(await runPass()).toBe(false);
        const reads = readsBeforeFailure + 2;
        expect(readsForTarget()).toBe(reads);
        expect(store.reconciliationRetries().get("42:owner/repo:7")).toBe(retryAt);
        unavailable = false;

        now += 1_000;
        expect(await runPass()).toBe(false);

        expect(readsForTarget()).toBe(reads);

        if (trigger === "startup") {
          store.close();
          store = new WorkflowStore(dbPath);
          ({ runPass } = controller());
        }
        now = retryAt - 60_000;
        expect(await runPass()).toBe(false);
        expect(readsForTarget()).toBe(reads);

        now = retryAt;
        expect(await runPass()).toBe(true);
        expect(readsForTarget()).toBe(reads + 4);

        expect(store.findWorkflow(target.repository, target.pullRequest)?.checks).toEqual([
          { name: "build", sha, outcome: "passed" },
        ]);
      } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("shares a durable token Retry-After across PRs in one repository", async () => {
    const dir = mkdtempSync(join(tmpdir(), "switchyard-token-retry-"));
    const dbPath = join(dir, "state.sqlite");
    let store = new WorkflowStore(dbPath);
    let now = Date.UTC(2026, 0, 1);
    const retryAt = now + 120_000;
    const sibling = { ...target, pullRequest: 8 };
    const other = { ...target, repository: "owner/another", pullRequest: 9 };
    const exchanges: string[] = [];
    const reads: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input, options) => {
      if (options?.method === "POST") {
        const repository = String(JSON.parse(String(options.body)).repositories[0]);
        exchanges.push(repository);
        if (repository === "repo" && now < retryAt)
          return new Response(null, { status: 503, headers: { "retry-after": "120" } });
        return Response.json({ token: "fixture-token", expires_at: new Date(now + 3_600_000) });
      }
      const path = requestUrl(input).pathname;
      reads.push(path);
      return prFixture(input, {
        number: Number(path.split("/").at(-1)),
        state: "closed",
        head: { sha },
      });
    });
    function client() {
      return createGitHubAppClient({
        clientId: "fixture-client-id",
        privateKey,
        fetcher,
        now: () => now,
        rateLimits: store.githubRateLimits(),
        retryDeadlines: store.reconciliationRetries(),
      });
    }
    function controller() {
      return targetedController({
        store,
        targets: [target, sibling, other],
        reconcile: createReconciler(store, createGitHubReader(client())),
        reportError: vi.fn(),

        now: () => now,
      });
    }
    try {
      expect(await controller().runPass()).toBe(false);
      expect(exchanges).toEqual(["repo", "another"]);
      expect(reads).toEqual(["/repos/owner/another/pulls/9"]);
      expect(store.reconciliationRetries().get(tokenRetryKey(target))).toBe(retryAt);

      store.close();
      store = new WorkflowStore(dbPath);

      now = retryAt - 1;
      await expect(createGitHubReader(client()).readPullRequest(sibling)).rejects.toMatchObject({
        retryAt,
      });
      expect(exchanges).toEqual(["repo", "another"]);
      const { runPass } = controller();
      expect(await runPass()).toBe(false);
      expect(exchanges).toEqual(["repo", "another", "another"]);

      now = retryAt;
      expect(await runPass()).toBe(true);
      expect(exchanges).toEqual(["repo", "another", "another", "repo"]);
      expect(reads.slice(-3)).toEqual([
        "/repos/owner/repo/pulls/7",
        "/repos/owner/repo/pulls/8",
        "/repos/owner/another/pulls/9",
      ]);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocks queued reads and close and reopen notifications during a PR Retry-After", async () => {
    const store = new WorkflowStore();
    let now = Date.UTC(2026, 0, 1);
    const retryAt = now + 120_000;
    let state = "open";
    let headSha = sha;
    const fetcher = vi.fn<typeof fetch>(async (input, options) => {
      if (options?.method === "POST")
        return Response.json({ token: "fixture-token", expires_at: new Date(now + 3_600_000) });
      const path = requestUrl(input).pathname;
      if (path.endsWith("/pulls/8"))
        return prFixture(input, { number: 8, state: "closed", head: { sha } });
      if (path.endsWith("/pulls/7"))
        return prFixture(input, { number: 7, state, head: { sha: headSha } });
      if (path.endsWith("/check-runs")) {
        if (now < retryAt) {
          state = "closed";
          return new Response(null, { status: 503, headers: { "retry-after": "120" } });
        }
        return Response.json({
          check_runs: [
            { name: "build", head_sha: headSha, status: "completed", conclusion: "success" },
          ],
        });
      }
      if (path.endsWith("/status")) return Response.json({ sha: headSha, statuses: [] });
      return Response.json([]);
    });
    try {
      const client = createGitHubAppClient({
        clientId: "fixture-client-id",
        privateKey,
        fetcher,
        now: () => now,
        retryDeadlines: store.reconciliationRetries(),
      });
      const reader = createGitHubReader(client);
      const { runPass } = targetedController({
        store,
        targets: [target],
        reconcile: createReconciler(store, reader),
        reportError: vi.fn(),

        now: () => now,
      });
      expect(await runPass()).toBe(false);
      expect(fetcher.mock.calls.map(([input]) => requestUrl(input).pathname)).toEqual([
        "/app/installations/42/access_tokens",
        "/repos/owner/repo/pulls/7",
        `/repos/owner/repo/commits/${sha}/check-runs`,
      ]);
      await expect(reader.readPullRequest({ ...target, pullRequest: 8 })).resolves.toMatchObject({
        state: "closed",
      });

      now += 1_000;

      expect(await runPass()).toBe(false);
      now += 1_000;
      state = "open";
      headSha = otherSha;

      expect(await runPass()).toBe(false);
      expect(fetcher).toHaveBeenCalledTimes(4);

      now = retryAt;
      expect(await runPass()).toBe(true);
      expect(store.findWorkflow(target.repository, target.pullRequest)).toMatchObject({
        state: "awaiting_review",
        headSha: otherSha,
        checks: [{ name: "build", sha: otherSha, outcome: "passed" }],
      });

      expect(fetcher).toHaveBeenCalledTimes(8);
    } finally {
      store.close();
    }
  });

  it.each(["check-runs", "status"] as const)(
    "honors a shared commit %s Retry-After across PRs and restarts",
    async (endpoint) => {
      const dir = mkdtempSync(join(tmpdir(), "switchyard-commit-retry-"));
      const dbPath = join(dir, "state.sqlite");
      let store = new WorkflowStore(dbPath);
      let now = Date.UTC(2026, 0, 1);
      const retryAt = now + 120_000;
      const sibling = { ...target, pullRequest: 8 };
      const differentHead = { ...target, pullRequest: 9 };
      const differentRepo = { ...target, repository: "owner/another", pullRequest: 10 };
      const sharedPath = `/repos/owner/repo/commits/${sha}/${endpoint}`;
      const sharedPages: string[] = [];
      const fetcher = vi.fn<typeof fetch>(async (input, options) => {
        if (options?.method === "POST")
          return Response.json({ token: "fixture-token", expires_at: new Date(now + 3_600_000) });
        const { pathname, searchParams } = requestUrl(input);
        const number = Number(pathname.match(/\/pulls\/(\d+)$/)?.[1]);
        if (number)
          return prFixture(input, {
            number,
            state: "open",
            head: { sha: number === 9 ? otherSha : sha },
          });
        const commit = pathname.split("/").at(-2);
        let headers: HeadersInit = {};
        if (pathname === sharedPath) {
          const page = searchParams.get("page")!;
          sharedPages.push(page);
          if (page === "1") headers = { link: '<https://unused.example/page=2>; rel="next"' };
          else if (now < retryAt)
            return new Response(null, { status: 503, headers: { "retry-after": "120" } });
        }
        if (pathname.endsWith("/check-runs"))
          return Response.json(
            {
              check_runs:
                pathname === sharedPath && searchParams.get("page") === "1"
                  ? []
                  : [
                      {
                        name: "build",
                        head_sha: commit,
                        status: "completed",
                        conclusion: "success",
                      },
                    ],
            },
            { headers },
          );
        if (pathname.endsWith("/status"))
          return Response.json({ sha: commit, statuses: [] }, { headers });
        return Response.json([]);
      });
      function controller(targets: (typeof target)[]) {
        const client = createGitHubAppClient({
          clientId: "fixture-client-id",
          privateKey,
          fetcher,
          now: () => now,
          retryDeadlines: store.reconciliationRetries(),
        });
        return targetedController({
          store,
          targets,
          reconcile: createReconciler(store, createGitHubReader(client)),
          reportError: vi.fn(),

          now: () => now,
        });
      }
      try {
        for (const tracked of [target, sibling]) seedWorkflow(store, tracked);
        expect(await controller([target, sibling, differentHead, differentRepo]).runPass()).toBe(
          false,
        );
        expect(sharedPages).toEqual(["1", "2"]);
        for (const affected of [target, sibling])
          expect(store.findWorkflow(affected.repository, affected.pullRequest)?.checks).toEqual([]);
        for (const unaffected of [differentHead, differentRepo])
          expect(store.findWorkflow(unaffected.repository, unaffected.pullRequest)?.checks).toEqual(
            [
              {
                name: "build",
                sha: unaffected === differentHead ? otherSha : sha,
                outcome: "passed",
              },
            ],
          );

        // A newly tracked PR has no existing per-PR deadline to carry over from the first sweep.
        store.close();
        store = new WorkflowStore(dbPath);
        const late = { ...target, pullRequest: 11 };
        const { runPass } = controller([late]);
        now = retryAt - 30_000;
        expect(await runPass()).toBe(false);
        now = retryAt - 1;
        expect(await runPass()).toBe(false);
        expect(sharedPages).toEqual(["1", "2"]);
        now = retryAt;
        expect(await runPass()).toBe(true);
        expect(sharedPages).toEqual(["1", "2", "1", "2"]);
        expect(store.findWorkflow(late.repository, late.pullRequest)?.checks).toEqual([
          { name: "build", sha, outcome: "passed" },
        ]);
      } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

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
      if (path === "/pulls/7") return prFixture(input, { number: 7, state: "open", head: { sha } });
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
    expect(await api.readPullRequest(target)).toEqual({
      headSha: sha,
      state: "open",
      headRepository: target.repository,
      draft: false,
      merged: false,
    });
    expect(await api.readReviews(target)).toEqual([{ id: 1 }, { id: 2 }]);
    expect(await api.readReviewComments(target)).toEqual([{ id: 3 }]);
    expect(await api.readIssueComments(target)).toEqual([{ id: 4, body: "edited" }]);
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

  it("uses scoped read-only permissions and requires the configured check App", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, options) => {
      const path = requestUrl(input).pathname;
      if (path === "/app/installations/42/access_tokens") {
        expect(JSON.parse(String(options?.body))).toEqual({
          repositories: ["repo"],
          permissions: {
            pull_requests: "read",
            checks: "read",
            statuses: "read",
            contents: "read",
            issues: "read",
          },
        });
        return Response.json({
          token: "fixture-token",
          expires_at: new Date(Date.now() + 3_600_000),
        });
      }
      expect(options?.method ?? "GET").toBe("GET");
      if (path.endsWith("/check-runs")) {
        const run = (name: string, id: number, conclusion: string) => ({
          name,
          head_sha: sha,
          status: "completed",
          conclusion,
          app: { id },
        });
        return Response.json({
          check_runs: [
            run("Verified", 30, "failure"),
            run("Verified", 31, "success"),
            run("Spoofed", 31, "success"),
            run("Ambiguous", 30, "success"),
            run("Ambiguous", 30, "failure"),
          ],
        });
      }
      if (path.endsWith("/status"))
        return Response.json({ sha, statuses: [{ context: "Spoofed", state: "success" }] });
      if (path.endsWith("/issues/19")) return Response.json({ number: 19 });
      if (path.endsWith(`/commits/${sha}`)) return Response.json({ sha });
      throw new Error(`Unexpected fixture endpoint ${path}`);
    });

    const client = createGitHubAppClient({
      clientId: "fixture-client-id",
      privateKey,
      fetcher,
      workflowEvidence: () => true,
    });
    const api = createGitHubReader(
      client,
      new Map([
        [
          target.repository,
          new Map([
            ["Verified", 30],
            ["Spoofed", 30],
            ["Ambiguous", 30],
          ]),
        ],
      ]),
    );
    expect(await api.readChecks(target, sha)).toEqual([
      { name: "Ambiguous", sha, outcome: "unknown" },
      { name: "Verified", sha, outcome: "failed" },
    ]);
    expect(await api.readIssue(target, 19)).toEqual({ number: 19 });
    expect(await api.readCommit(target, sha)).toEqual({ sha });
  });

  it("reads a referenced thread with a paginated GraphQL query and read-only credentials", async () => {
    const seenCursors: (string | null)[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input, options) => {
      const path = requestUrl(input).pathname;
      expect(options?.method).toBe("POST");
      const body = JSON.parse(String(options?.body));
      if (path === "/app/installations/42/access_tokens") {
        expect(body).toEqual({
          repositories: ["repo"],
          permissions: { pull_requests: "read", checks: "read", statuses: "read" },
        });
        return Response.json({
          token: "fixture-token",
          expires_at: new Date(Date.now() + 3_600_000),
        });
      }
      expect(path).toBe("/graphql");
      expect(new Headers(options?.headers).get("authorization")).toBe("Bearer fixture-token");
      expect(body.query).toMatch(/^query SwitchyardReviewThread\(/);
      const after = seenCursors.length === 0 ? null : "next-cursor";
      expect(body.variables).toEqual({ owner: "owner", repo: "repo", pr: 7, after });
      seenCursors.push(after);
      return Response.json({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: after
                  ? [
                      {
                        id: "thread-2",
                        isResolved: false,
                        isOutdated: true,
                        comments: { nodes: [{ fullDatabaseId: "202" }] },
                      },
                    ]
                  : [],
                pageInfo: { hasNextPage: after === null, endCursor: "next-cursor" },
              },
            },
          },
        },
      });
    });
    const client = createGitHubAppClient({ clientId: "fixture-client-id", privateKey, fetcher });
    expect(await client.readReviewThread(target, 202)).toEqual({
      id: "thread-2",
      resolved: false,
      outdated: true,
    });
    expect(seenCursors).toEqual([null, "next-cursor"]);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("rejects legacy statuses resolved to a different SHA", async () => {
    const api = createGitHubReader({
      completeReconciliation: vi.fn(),
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

  it("waits for a late CI backoff before a run-once pass can close the store", async () => {
    const now = Date.UTC(2026, 0, 1);
    const retryAt = now + 120_000;
    const store = new WorkflowStore();
    const delayed = Promise.withResolvers<Response>();
    const started = Promise.withResolvers<void>();
    const fetcher = vi.fn<typeof fetch>(async (input, options) => {
      if (options?.method === "POST")
        return Response.json({ token: "fixture-token", expires_at: new Date(now + 3_600_000) });
      const path = requestUrl(input).pathname;
      if (path.endsWith("/pulls/7"))
        return prFixture(input, { number: 7, state: "open", head: { sha } });
      if (path.endsWith("/check-runs")) return new Response(null, { status: 500 });
      if (path.endsWith("/status")) {
        started.resolve();
        return delayed.promise;
      }
      throw new Error(`Unexpected fixture endpoint ${path}`);
    });
    try {
      const rateLimits = store.githubRateLimits();
      const client = createGitHubAppClient({
        clientId: "fixture-client-id",
        privateKey,
        fetcher,
        rateLimits,
        now: () => now,
      });
      const controller = targetedController({
        store,
        targets: [target],
        reconcile: createReconciler(store, createGitHubReader(client)),
        reportError: vi.fn(),

        now: () => now,
      });

      let settled = false;
      const pass = controller.runPass().finally(() => {
        settled = true;
      });
      try {
        await started.promise;
        await setImmediate();
        expect(settled).toBe(false);
      } finally {
        delayed.resolve(new Response(null, { status: 429, headers: { "retry-after": "120" } }));
        expect(await pass).toBe(false);
      }
      expect(rateLimits.get("secondary")?.retryAt).toBe(retryAt);
    } finally {
      store.close();
    }
  });

  it("preserves the GitHub retry deadline when discarding a throttled response body fails", async () => {
    const store = new WorkflowStore();
    const now = Date.UTC(2026, 0, 1);
    const retryAt = now + 120_000;
    const body = new ReadableStream({
      start(stream) {
        stream.error(new Error("Fixture response stream failed"));
      },
    });
    const fetcher = vi.fn<typeof fetch>(async (_input, options) => {
      if (options?.method === "POST")
        return Response.json({ token: "fixture-token", expires_at: new Date(now + 3_600_000) });
      return new Response(body, { status: 429, headers: { "retry-after": "120" } });
    });
    try {
      const rateLimits = store.githubRateLimits();
      const client = createGitHubAppClient({
        clientId: "fixture-client-id",
        privateKey,
        fetcher,
        rateLimits,
        now: () => now,
      });
      const { runPass } = targetedController({
        store,
        targets: [target],
        reconcile: createReconciler(store, createGitHubReader(client)),
        reportError: vi.fn(),

        now: () => now,
      });

      expect(await runPass()).toBe(false);
      expect(rateLimits.get("secondary")?.retryAt).toBe(retryAt);

      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      store.close();
    }
  });

  it("clears a throttle for an obsolete check head after the same PR reconciles successfully", async () => {
    const store = new WorkflowStore();
    let now = Date.UTC(2026, 0, 1);
    let headSha = sha;
    let throttle = true;
    const fetcher = vi.fn<typeof fetch>(async (input, options) => {
      if (options?.method === "POST")
        return Response.json({ token: "fixture-token", expires_at: new Date(now + 3_600_000) });
      const url = requestUrl(input);
      const prNumber = /\/pulls\/(\d+)$/.exec(url.pathname)?.[1];
      if (prNumber)
        return prFixture(input, {
          number: Number(prNumber),
          state: "open",
          head: { sha: headSha },
        });
      if (url.pathname.endsWith("/status")) return Response.json({ sha: headSha, statuses: [] });
      if (url.pathname.endsWith("/check-runs"))
        return throttle ? new Response(null, { status: 429 }) : Response.json({ check_runs: [] });
      throw new Error(`Unexpected fixture endpoint ${url.pathname}`);
    });
    try {
      const rateLimits = store.githubRateLimits();
      const client = createGitHubAppClient({
        clientId: "fixture-client-id",
        privateKey,
        fetcher,
        rateLimits,
        now: () => now,
      });
      const reconcile = createReconciler(store, createGitHubReader(client));
      for (const digit of ["b", "c", "d", "e", "f"]) {
        const retryAt = now + 60_000;
        await expect(reconcile(target)).rejects.toMatchObject({ retryAt });
        now = retryAt;
        headSha = digit.repeat(40);
        throttle = false;
        await reconcile({ ...target, pullRequest: 8 });
        expect(rateLimits.get("secondary")?.throttledAttempts).toBe(1);
        await reconcile(target);
        expect(rateLimits.get("secondary")?.throttledAttempts).toBe(0);
        throttle = true;
      }
    } finally {
      store.close();
    }
  });

  it("doubles the retry delay when alternating reads still throttle the same reconciliation", async () => {
    const store = new WorkflowStore();
    let now = Date.UTC(2026, 0, 1);
    let resource = "status";
    const fetcher = vi.fn<typeof fetch>(async (input, options) => {
      if (options?.method === "POST")
        return Response.json({ token: "fixture-token", expires_at: new Date(now + 3_600_000) });
      const path = requestUrl(input).pathname;
      if (path.endsWith("/pulls/7"))
        return prFixture(input, { number: 7, state: "open", head: { sha } });
      if (path.endsWith("/" + resource)) {
        await setImmediate();
        return new Response(null, { status: 429 });
      }
      if (path.endsWith("/check-runs")) return Response.json({ check_runs: [] });
      if (path.endsWith("/status")) return Response.json({ sha, statuses: [] });
      return Response.json([]);
    });
    try {
      const rateLimits = store.githubRateLimits();
      const client = createGitHubAppClient({
        clientId: "fixture-client-id",
        privateKey,
        fetcher,
        rateLimits,
        now: () => now,
      });
      const reconcile = createReconciler(store, createGitHubReader(client));
      for (const minutes of [1, 2, 4, 8, 16]) {
        const retryAt = now + minutes * 60_000;
        await expect(reconcile(target)).rejects.toMatchObject({ retryAt });
        resource = resource === "status" ? "check-runs" : "status";
        now = retryAt;
      }
      const requests = fetcher.mock.calls.length;
      await expect(reconcile(target)).rejects.toThrow(
        "paused after repeated secondary rate limits",
      );
      expect(fetcher).toHaveBeenCalledTimes(requests);
    } finally {
      store.close();
    }
  });

  it.each(["branch discovery", "publication verification"])(
    "pauses after repeated %s throttling despite successful PR reconciliation",
    async (operation) => {
      const store = new WorkflowStore();
      let now = Date.UTC(2026, 0, 1);
      const fetcher = vi.fn<typeof fetch>(async (input, options) => {
        if (options?.method === "POST")
          return Response.json({ token: "fixture-token", expires_at: new Date(now + 3_600_000) });
        const url = requestUrl(input);
        if (url.pathname.endsWith("/pulls/7"))
          return prFixture(input, { number: 7, state: "open", head: { sha } });
        if (url.pathname.endsWith("/status")) return Response.json({ sha, statuses: [] });
        if (url.pathname.endsWith("/check-runs")) return Response.json({ check_runs: [] });
        if (url.pathname.endsWith(`/commits/${sha}`)) return new Response(null, { status: 429 });
        if (url.searchParams.has("head") && operation === "branch discovery")
          return new Response(null, { status: 429 });
        return Response.json([{ number: 7 }]);
      });
      try {
        const rateLimits = store.githubRateLimits();
        const github = createGitHubReader(
          createGitHubAppClient({
            clientId: "fixture-client-id",
            privateKey,
            fetcher,
            rateLimits,
            now: () => now,
          }),
        );
        const reportError = vi.fn();
        const controller = createController({
          store,
          repositories: [target],
          github,
          reconcile: createReconciler(store, github),
          coordinate: async () => false,
          coordinatePlans: async (repository, signal) => {
            await github.listBranchPullRequests(repository, "feat/reserved", signal);
            await github.readCommit({ ...repository, pullRequest: 7 }, sha, signal, "repository");
          },
          reportError,
          now: () => now,
        });
        for (const minutes of [1, 2, 4, 8, 16]) {
          controller.scheduleSweep();
          expect(await controller.runPass()).toBe(false);
          now += minutes * 60_000;
          expect(rateLimits.get("secondary")).toMatchObject({
            retryAt: now,
            retryRequest: repositoryRetryKey(target),
          });
        }
        const requests = fetcher.mock.calls.length;
        controller.scheduleSweep();
        expect(await controller.runPass()).toBe(false);
        expect(reportError).toHaveBeenLastCalledWith(
          expect.stringContaining("paused after repeated secondary rate limits"),
        );
        expect(fetcher).toHaveBeenCalledTimes(requests);
      } finally {
        store.close();
      }
    },
  );

  it("clears the retry count when a PR closes on the final read", async () => {
    const store = new WorkflowStore();
    const now = Date.UTC(2026, 0, 1);
    let prReads = 0;
    const fetcher = vi.fn<typeof fetch>(async (input, options) => {
      if (options?.method === "POST")
        return Response.json({ token: "fixture-token", expires_at: new Date(now + 3_600_000) });
      const path = requestUrl(input).pathname;
      if (path.endsWith("/pulls/7"))
        return prFixture(input, {
          number: 7,
          state: ++prReads === 1 ? "open" : "closed",
          head: { sha },
        });
      if (path.endsWith("/pulls/8")) return new Response(null, { status: 429 });
      if (path.endsWith("/check-runs")) return Response.json({ check_runs: [] });
      if (path.endsWith("/status")) return Response.json({ sha, statuses: [] });
      return Response.json([]);
    });
    try {
      const rateLimits = store.githubRateLimits();
      rateLimits.set("secondary", {
        retryAt: now,
        throttledAttempts: 4,
        retryRequest: "pr:42:owner/repo:7",
      });
      const client = createGitHubAppClient({
        clientId: "fixture-client-id",
        privateKey,
        fetcher,
        rateLimits,
        now: () => now,
      });
      const reconcile = createReconciler(store, createGitHubReader(client));
      seedWorkflow(store, target);
      await reconcile(target);
      expect(prReads).toBe(2);
      expect(store.findWorkflow(target.repository, target.pullRequest)).toMatchObject({
        state: "stopped",
        githubStatus: "closed",
      });
      expect(rateLimits.get("secondary")?.throttledAttempts).toBe(0);
      await expect(reconcile({ ...target, pullRequest: 8 })).rejects.toMatchObject({
        retryAt: now + 60_000,
      });
      expect(rateLimits.get("secondary")?.throttledAttempts).toBe(1);
    } finally {
      store.close();
    }
  });

  it("retires an inactive target's count at startup while honoring its cooldown", async () => {
    const store = new WorkflowStore();
    let now = Date.UTC(2026, 0, 1);
    const retryAt = now + 120_000;
    const remaining = { repository: "other/repo", installationId: 84, pullRequest: 8 };
    let throttle = false;
    const fetcher = vi.fn<typeof fetch>(async (input, options) => {
      if (options?.method === "POST")
        return Response.json({ token: "fixture-token", expires_at: new Date(now + 3_600_000) });
      const path = requestUrl(input).pathname;
      if (path.endsWith("/pulls/8"))
        return throttle
          ? new Response(null, { status: 429 })
          : prFixture(input, { number: 8, state: "open", head: { sha } });
      if (path.endsWith("/check-runs")) return Response.json({ check_runs: [] });
      if (path.endsWith("/status")) return Response.json({ sha, statuses: [] });
      return Response.json([]);
    });
    try {
      const rateLimits = store.githubRateLimits();
      rateLimits.set("secondary", {
        retryAt,
        throttledAttempts: 4,
        retryRequest: "pr:42:owner/repo:7",
      });
      const client = createGitHubAppClient({
        clientId: "fixture-client-id",
        privateKey,
        fetcher,
        rateLimits,
        now: () => now,
      });
      const { runPass } = targetedController({
        store,
        targets: [remaining],
        reconcile: createReconciler(store, createGitHubReader(client)),
        reportError: vi.fn(),

        now: () => now,
      });
      expect(await runPass()).toBe(false);
      expect(rateLimits.get("secondary")).toEqual({
        retryAt,
        throttledAttempts: 0,
        retryRequest: null,
      });
      expect(fetcher).not.toHaveBeenCalled();
      now = retryAt;
      expect(await runPass()).toBe(true);
      now += 60_000;
      throttle = true;
      expect(await runPass()).toBe(false);
      expect(rateLimits.get("secondary")).toMatchObject({
        retryAt: now + 60_000,
        throttledAttempts: 1,
        retryRequest: "pr:84:other/repo:8",
      });
    } finally {
      store.close();
    }
  });

  it.each(["existing", "incoming"] as const)(
    "accounts for a stopped %s retry owner when a PR is throttled mid-pass",
    async (stoppedOwner) => {
      const store = new WorkflowStore();
      let now = Date.UTC(2026, 0, 1);
      const other = { repository: "other/repo", installationId: 84, pullRequest: 8 };
      const targets = [other, target];
      const pending = Promise.withResolvers<Response>();
      const started = Promise.withResolvers<void>();
      let throttle = false;
      const fetcher = vi.fn<typeof fetch>(async (input, options) => {
        if (options?.method === "POST")
          return Response.json({ token: "fixture-token", expires_at: new Date(now + 3_600_000) });
        const path = requestUrl(input).pathname;
        if (path.endsWith("/pulls/8") && throttle) {
          started.resolve();
          return pending.promise;
        }
        if (path.endsWith("/pulls/7"))
          return prFixture(input, { number: 7, state: "open", head: { sha } });
        if (path.endsWith("/pulls/8"))
          return prFixture(input, { number: 8, state: "open", head: { sha } });
        if (path.endsWith("/check-runs")) return Response.json({ check_runs: [] });
        if (path.endsWith("/status")) return Response.json({ sha, statuses: [] });
        return Response.json([]);
      });
      try {
        const rateLimits = store.githubRateLimits();
        const isRetryOwnerActive = createGitHubRetryOwnerCheck(store, targets);
        const client = createGitHubAppClient({
          clientId: "fixture-client-id",
          privateKey,
          fetcher,
          rateLimits,
          isRetryOwnerActive,
          now: () => now,
        });
        const { runPass } = targetedController({
          store,
          targets,
          reconcile: createReconciler(store, createGitHubReader(client)),
          reportError: vi.fn(),

          now: () => now,
        });
        expect(await runPass()).toBe(true);
        now += 60_000;
        rateLimits.set("secondary", {
          retryAt: now,
          throttledAttempts: 4,
          retryRequest: "pr:42:owner/repo:7",
        });
        throttle = true;
        const stoppedTarget = stoppedOwner === "existing" ? target : other;
        const retryAt = now + 120_000;
        const pass = runPass();
        try {
          await started.promise;
          expect(rateLimits.get("secondary")?.throttledAttempts).toBe(4);
          store.transition(
            store.findWorkflow(stoppedTarget.repository, stoppedTarget.pullRequest)!.id,
            {
              type: "stop",
              reason: "Operator stop",
            },
          );
        } finally {
          pending.resolve(new Response(null, { status: 429, headers: { "retry-after": "120" } }));
          await pass;
        }
        expect(await pass).toBe(false);
        expect(rateLimits.get("secondary")).toEqual({
          retryAt,
          throttledAttempts: stoppedOwner === "existing" ? 1 : 4,
          retryRequest: stoppedOwner === "existing" ? "pr:84:other/repo:8" : "pr:42:owner/repo:7",
        });
        if (stoppedOwner === "incoming") {
          throttle = false;
          now = retryAt;
          expect(await runPass()).toBe(true);
          expect(rateLimits.get("secondary")?.throttledAttempts).toBe(0);
        }
      } finally {
        store.close();
      }
    },
  );

  it.each(["evidence read", "final PR read"] as const)(
    "avoids new evidence requests after an operator stop after an in-flight %s",
    async (stage) => {
      const store = new WorkflowStore();
      const now = Date.UTC(2026, 0, 1);
      const pending = Promise.withResolvers<Response>();
      const started = Promise.withResolvers<void>();
      let prReads = 0;
      const fetcher = vi.fn<typeof fetch>(async (input, options) => {
        if (options?.method === "POST")
          return Response.json({ token: "fixture-token", expires_at: new Date(now + 3_600_000) });
        const path = requestUrl(input).pathname;
        if (path.endsWith("/pulls/7")) {
          if (++prReads === 2 && stage === "final PR read") {
            started.resolve();
            return pending.promise;
          }
          return prFixture(input, { number: 7, state: "open", head: { sha } });
        }
        if (path.endsWith("/check-runs")) {
          if (stage === "evidence read") {
            started.resolve();
            return pending.promise;
          }
          return Response.json({ check_runs: [] });
        }
        if (path.endsWith("/status")) return Response.json({ sha, statuses: [] });
        return Response.json([]);
      });
      try {
        const reportError = vi.fn();
        const client = createGitHubAppClient({
          clientId: "fixture-client-id",
          privateKey,
          fetcher,
          now: () => now,
          canReadPullRequestChecks: (target, pullRequest) =>
            canReadPullRequestChecks(store, target.repository, pullRequest),
        });
        const { runPass } = targetedController({
          store,
          targets: [target],
          reconcile: createReconciler(store, createGitHubReader(client)),
          reportError,

          now: () => now,
        });

        seedWorkflow(store, target);
        const pass = runPass();
        let requestsWhenStopped = 0;
        try {
          await started.promise;
          requestsWhenStopped = fetcher.mock.calls.length;
          store.transition(store.findWorkflow(target.repository, target.pullRequest)!.id, {
            type: "stop",
            reason: "Operator stop",
          });
        } finally {
          pending.resolve(
            stage === "evidence read"
              ? Response.json(
                  { check_runs: [] },
                  {
                    headers: {
                      link: '<https://api.github.com/next>; rel="next"',
                    },
                  },
                )
              : prFixture("https://api.github.com/repos/owner/repo/pulls/7", {
                  number: 7,
                  state: "open",
                  head: { sha: otherSha },
                }),
          );
          await pass;
        }
        expect(await pass).toBe(true);
        expect(fetcher).toHaveBeenCalledTimes(requestsWhenStopped);

        expect(store.findWorkflow(target.repository, target.pullRequest)).toMatchObject({
          state: "stopped",
          escalationReason: "Operator stop",
          headSha: stage === "final PR read" ? otherSha : sha,
        });
        expect(reportError).not.toHaveBeenCalled();
      } finally {
        store.close();
      }
    },
  );

  it("sends no further evidence requests after the last successful GET exhausts the quota", async () => {
    const store = new WorkflowStore();
    const now = Date.UTC(2026, 0, 1);
    const retryAt = now + 120_000;
    const fetcher = vi.fn<typeof fetch>(async (input, options) => {
      if (options?.method === "POST")
        return Response.json({ token: "fixture-token", expires_at: new Date(now + 3_600_000) });
      const path = requestUrl(input).pathname;
      if (path.endsWith("/pulls/7"))
        return prFixture(
          input,
          { number: 7, state: "open", head: { sha } },
          {
            headers: { "x-ratelimit-remaining": "1", "x-ratelimit-reset": String(retryAt / 1000) },
          },
        );
      if (path.endsWith("/check-runs")) {
        await setImmediate();
        return Response.json(
          { check_runs: [] },
          {
            headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(retryAt / 1000) },
          },
        );
      }
      return new Response(null, { status: 403 });
    });
    try {
      const rateLimits = store.githubRateLimits();
      const client = createGitHubAppClient({
        clientId: "fixture-client-id",
        privateKey,
        fetcher,
        rateLimits,
        now: () => now,
      });
      const reconcile = createReconciler(store, createGitHubReader(client));
      await expect(reconcile(target)).rejects.toMatchObject({ retryAt });
      expect(fetcher.mock.calls.map(([input]) => requestUrl(input).pathname)).toEqual([
        "/app/installations/42/access_tokens",
        "/repos/owner/repo/pulls/7",
        `/repos/owner/repo/commits/${sha}/check-runs`,
      ]);
      expect(rateLimits.get("installation:42")?.retryAt).toBe(retryAt);
    } finally {
      store.close();
    }
  });

  it.each([
    ["pr:42:owner/repo:7", 4],
    ["token:42:owner/repo", 4],
    ["pr:84:other/repo:8", 5],
  ] as const)(
    "preserves tracked retries and operator pauses at startup (%s)",
    async (retryRequest, throttledAttempts) => {
      const store = new WorkflowStore();
      try {
        const rateLimits = store.githubRateLimits();
        const state = { retryAt: 100_000, throttledAttempts, retryRequest };
        rateLimits.set("secondary", state);
        const { runPass } = targetedController({
          store,
          targets: [target],
          reconcile: vi.fn(),
          reportError: vi.fn(),
        });
        await runPass();
        expect(rateLimits.get("secondary")).toEqual(state);
      } finally {
        store.close();
      }
    },
  );

  it("keeps token throttles across successful exchanges for another repository on the same installation", async () => {
    let now = Date.UTC(2026, 0, 1);
    const other = { ...target, repository: "owner/another" };
    const fetcher = vi.fn<typeof fetch>(async (_input, options) => {
      if (options?.method !== "POST") return Response.json([]);
      if (JSON.parse(String(options.body)).repositories[0] === "repo")
        return new Response(null, { status: 429 });
      return Response.json({ token: "fixture-token", expires_at: new Date(now + 65_000) });
    });
    const client = createGitHubAppClient({
      clientId: "fixture-client-id",
      privateKey,
      fetcher,
      now: () => now,
    });
    for (const minutes of [1, 2, 4, 8, 16]) {
      await expect(client.get(other, "/pulls/7")).resolves.toMatchObject({ data: [] });
      const retryAt = now + minutes * 60_000;
      await expect(client.get(target, "/pulls/7")).rejects.toMatchObject({ retryAt });
      now = retryAt;
    }
    expect(fetcher).toHaveBeenCalledTimes(15);
    await expect(client.get(target, "/pulls/7")).rejects.toThrow(
      "paused after repeated secondary rate limits",
    );
    expect(fetcher).toHaveBeenCalledTimes(15);
  });
});
