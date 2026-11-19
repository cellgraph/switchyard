import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createController } from "../src/controller.ts";
import { createGitHubReader } from "../src/github-api.ts";
import { createGitHubAppClient, resumeGitHubAfterSecondaryLimit } from "../src/github-app.ts";
import { createReconciler } from "../src/reconcile.ts";
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

  it.each(["primary", "secondary"] as const)(
    "restores %s backoff before the startup sweep after restart",
    async (kind) => {
      const dir = mkdtempSync(join(tmpdir(), "switchyard-backoff-"));
      const path = join(dir, "state.sqlite");
      let store = new WorkflowStore(path);
      let now = Date.UTC(2026, 0, 1);
      const retryAt = now + 120_000;
      const fetcher = vi.fn<typeof fetch>(async (_input, options) => {
        if (options?.method === "POST")
          return Response.json({ token: "fixture-token", expires_at: new Date(now + 3_600_000) });
        if (now >= retryAt) return Response.json({ number: 7, state: "open", head: { sha } });
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
        return createController({
          store,
          targets: [target],
          reconcile: async (target) => {
            await reader.readPullRequest(target);
          },
          reportError: vi.fn(),
          reconcileIntervalMs: 0,
          now: () => now,
        });
      }

      try {
        store.receiveDelivery("fixture-delivery", target);
        expect(await controller().runPass()).toBe(false);
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(store.deliveryStatus("fixture-delivery")).toMatchObject({
          status: "failed",
          attempts: 1,
          retryAt,
        });

        store.close();
        store = new WorkflowStore(path);
        store.recover();
        now += 10_000;
        const restarted = controller();
        expect(await restarted.runPass()).toBe(false);
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(store.deliveryStatus("fixture-delivery")?.attempts).toBe(1);

        now = retryAt;
        expect(await restarted.runPass()).toBe(true);
        expect(fetcher).toHaveBeenCalledTimes(4);
        expect(store.deliveryStatus("fixture-delivery")).toMatchObject({
          status: "processed",
          attempts: 2,
        });
      } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

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

  it("counts in-flight secondary throttles once and clears the sequence after a successful read", async () => {
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
      completeCheckRead: vi.fn(),
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

  it.each(["checks", "reviews"] as const)(
    "waits for a late %s backoff before a run-once pass can close the store",
    async (group) => {
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
          return Response.json({ number: 7, state: "open", head: { sha } });
        const failsEarly =
          group === "checks" ? path.endsWith("/check-runs") : path.endsWith("/reviews");
        const failsLate =
          group === "checks" ? path.endsWith("/status") : path.endsWith("/issues/7/comments");
        if (failsEarly) return new Response(null, { status: 500 });
        if (failsLate) {
          started.resolve();
          return delayed.promise;
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
        const controller = createController({
          store,
          targets: [target],
          reconcile: createReconciler(store, createGitHubReader(client)),
          reportError: vi.fn(),
          reconcileIntervalMs: 0,
          now: () => now,
        });
        store.receiveDelivery("fixture-delivery", target);
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
        expect(store.deliveryStatus("fixture-delivery")).toMatchObject({
          status: "failed",
          retryAt,
        });
      } finally {
        store.close();
      }
    },
  );

  it("clears obsolete check throttles when checks succeed for the same PR's new head", async () => {
    const store = new WorkflowStore();
    let now = Date.UTC(2026, 0, 1);
    let throttledHead = sha;
    const fetcher = vi.fn<typeof fetch>(async (input, options) => {
      if (options?.method === "POST")
        return Response.json({ token: "fixture-token", expires_at: new Date(now + 3_600_000) });
      const [, head, resource] = /\/commits\/([a-f0-9]+)\/(check-runs|status)$/.exec(
        requestUrl(input).pathname,
      )!;
      if (resource === "status") return Response.json({ sha: head, statuses: [] });
      if (head === throttledHead) return new Response(null, { status: 429 });
      return Response.json({ check_runs: [] });
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
      const api = createGitHubReader(client);
      for (const digit of ["b", "c", "d", "e", "f"]) {
        const newHead = digit.repeat(40);
        const retryAt = now + 60_000;
        await expect(api.readChecks(target, throttledHead)).rejects.toMatchObject({ retryAt });
        now = retryAt;
        await expect(api.readChecks({ ...target, pullRequest: 8 }, newHead)).resolves.toEqual([]);
        expect(rateLimits.get("secondary")?.throttledAttempts).toBe(1);
        await expect(api.readChecks(target, newHead)).resolves.toEqual([]);
        expect(rateLimits.get("secondary")?.throttledAttempts).toBe(0);
        throttledHead = newHead;
      }
    } finally {
      store.close();
    }
  });

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
