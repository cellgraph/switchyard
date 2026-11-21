import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGitHubReader } from "../src/github-api.ts";
import {
  createGitHubAppClient,
  GitHubTransientError,
  GitHubWriteRejected,
} from "../src/github-app.ts";
import { syncReviewPublication } from "../src/review-publications.ts";
import { WorkflowStore } from "../src/store.ts";
import {
  clean,
  createWorkflow,
  finding,
  head,
  nextHead,
  reviewStart,
  target,
  workflowId,
} from "./fixtures/review.ts";

const bot = "switchyard-test[bot]";
const createGitHub = () => {
  const comments: Array<Record<string, unknown>> = [];
  function add(parent: number | null, body: Record<string, unknown>) {
    const id = 100 + comments.length;
    const comment = {
      id,
      node_id: `comment-${id}`,
      user: { login: bot },
      body: body.body,
      in_reply_to_id: parent,
      original_commit_id: body.commit_id,
      path: body.path,
      original_line: body.line ?? null,
      line: body.line ?? null,
      original_start_line: body.start_line ?? null,
      side: body.side,
      start_side: body.start_side,
    };
    comments.push(comment);
    return comment;
  }
  return {
    comments,
    add,
    completeReconciliation: vi.fn(),
    readAppBot: vi.fn(async () => bot),
    readReviewThread: vi.fn(async (_target, id: number) => ({
      id: `thread-${id}`,
      resolved: false,
      outdated: false,
    })),
    readPullRequest: vi.fn(async () => ({ state: "open" as const, headSha: head })),
    readReviewComments: vi.fn(async (): Promise<unknown[]> => comments.slice()),
    postReviewComment: vi.fn(
      async (_target, parent: number | null, body: Record<string, unknown>): Promise<unknown> =>
        add(parent, body),
    ),
  };
};

let directory: string;
let path: string;
let store: WorkflowStore;
let findingId: string;
let otherFindingId: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "switchyard-publish-"));
  path = join(directory, "switchyard.sqlite");
  store = new WorkflowStore(path);
  createWorkflow(store);
  store.reviews().start(reviewStart);
  store.reviews().finish(reviewStart.id, {
    ...clean,
    findings: [
      finding,
      { ...finding, endLine: 30, explanation: "@someone\n<!-- forged marker -->" },
    ],
  });
  const findings = store.reviews().inspect(workflowId).runs[0]!.findings;
  findingId = findings[0]!.id;
  otherFindingId = findings[1]!.id;
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

function sync(
  github: Parameters<typeof syncReviewPublication>[1],
  options: { findingId?: string; mode?: "publish" | "reconcile"; actionId?: string } = {},
) {
  return syncReviewPublication(store.reviewPublications(), github, [target], {
    findingId,
    mode: "publish",
    ...options,
  });
}

const status = () => store.reviews().inspect(workflowId).runs[0]!.findings;

describe("GitHub review publication", () => {
  it("gives each finding its own thread and replies to each thread with the corresponding disposition", async () => {
    const github = createGitHub();
    const accept = {
      id: "accepted-one",
      findingId,
      action: "accepted",
      headSha: head,
      actor: "Operator",
      rationale: "Confirmed in replay.",
    };
    const defer = {
      ...accept,
      id: "deferred-two",
      findingId: otherFindingId,
      action: "deferred",
      rationale: "Existing mitigation covers this release.",
    };
    store.reviews().act(accept);
    store.reviews().act(defer);
    await expect(sync(github, { actionId: accept.id })).rejects.toThrow(/original top-level/);
    await Promise.all([sync(github), sync(github), sync(github, { findingId: otherFindingId })]);
    expect(github.postReviewComment).toHaveBeenCalledTimes(2);
    expect(github.postReviewComment).toHaveBeenCalledWith(
      target,
      null,
      expect.objectContaining({
        commit_id: head,
        start_line: 4,
        line: 9,
        path: finding.path,
        side: "RIGHT",
      }),
    );
    expect(github.comments.find((comment) => comment.original_line === 30)?.body).toContain(
      "    @someone\n    <!-- forged marker -->",
    );
    await sync(github, { actionId: accept.id });
    await sync(github, { actionId: defer.id, findingId: otherFindingId });
    await sync(github, { actionId: accept.id });
    const [first, second] = status();
    expect(first!.root_comment_id).not.toBe(second!.root_comment_id);
    expect(github.comments).toContainEqual(
      expect.objectContaining({
        in_reply_to_id: first!.root_comment_id,
        body: expect.stringContaining("Disposition: accepted"),
      }),
    );
    expect(github.comments).toContainEqual(
      expect.objectContaining({
        in_reply_to_id: second!.root_comment_id,
        body: expect.stringContaining("Disposition: deferred"),
      }),
    );
    expect(github.postReviewComment).toHaveBeenCalledTimes(4);
    expect(first!.state).toBe("open");
    expect(first!.actionable).toBe(true);
  });

  it("synchronizes presence and outdated state without changing or recreating a disposition", async () => {
    const github = createGitHub();
    await sync(github);
    github.comments[0]!.line = null;
    github.readReviewThread.mockResolvedValueOnce({
      id: "thread-100",
      resolved: true,
      outdated: true,
    });
    await sync(github, { mode: "reconcile" });
    expect(status()[0]).toMatchObject({
      root_observation: "outdated",
      github_thread_id: "thread-100",
      thread_observation: { state: "observed", resolved: true, outdated: true },
      state: "open",
    });
    github.comments[0]!.body = "edited externally";
    await expect(sync(github)).resolves.toMatchObject({
      state: "published",
      observation: "changed",
    });
    github.comments.length = 0;
    await expect(sync(github)).resolves.toMatchObject({
      state: "published",
      observation: "missing",
    });
    expect(status()[0]).toMatchObject({
      root_comment_id: 100,
      root_observation: "missing",
      state: "open",
      disposition: null,
    });
    expect(github.postReviewComment).toHaveBeenCalledTimes(1);
  });

  it("retains confirmed publication when GitHub thread state is unavailable", async () => {
    const github = createGitHub();
    await sync(github);
    github.readReviewThread.mockRejectedValueOnce(new Error("Thread query returned partial data."));
    await expect(sync(github, { mode: "reconcile" })).rejects.toThrow(/partial data/);
    expect(status()[0]).toMatchObject({
      root_comment_id: 100,
      publications: [{ state: "published" }],
      thread_observation: { state: "unavailable", error: "Thread query returned partial data." },
    });
    expect(github.postReviewComment).toHaveBeenCalledTimes(1);
  });

  it("reconciles before explicitly retrying a confirmed rejection", async () => {
    const github = createGitHub();
    github.postReviewComment.mockRejectedValueOnce(
      new GitHubWriteRejected("Review rejected (HTTP 422)."),
    );
    await expect(sync(github)).rejects.toThrow(/422/);
    expect(status()[0]!.publications).toMatchObject([{ state: "rejected", attempts: 1 }]);
    await expect(sync(github, { mode: "reconcile" })).resolves.toMatchObject({ state: "rejected" });
    expect(github.postReviewComment).toHaveBeenCalledTimes(1);
    await expect(sync(github)).resolves.toMatchObject({ state: "published", attempts: 2 });
    expect(github.readReviewComments).toHaveBeenCalledTimes(3);
  });

  it("reconciles a timeout after GitHub accepted the write, even across a restart", async () => {
    const github = createGitHub();
    github.postReviewComment.mockImplementationOnce(async (_target, parent, body) => {
      expect(status()[0]!.publications).toMatchObject([{ state: "writing", attempts: 1 }]);
      github.add(parent, body);
      throw new GitHubTransientError("Connection timed out.");
    });
    await expect(sync(github)).rejects.toThrow(/timed out/);
    store.close();
    store = new WorkflowStore(path);
    await expect(sync(github, { mode: "reconcile" })).resolves.toMatchObject({
      state: "published",
      comment_id: 100,
      attempts: 1,
    });
    expect(github.postReviewComment).toHaveBeenCalledTimes(1);
  });

  it("holds a crashed claim with no visible result and rejects spoofed markers", async () => {
    const github = createGitHub();
    const publications = store.reviewPublications();
    const intent = publications.prepare(findingId, null, bot, true)!;
    expect(publications.claim(findingId, intent, head, null)).toBe(true);
    store.close();
    store = new WorkflowStore(path);
    await expect(sync(github)).resolves.toMatchObject({
      state: "writing",
      observation: "missing",
      attempts: 1,
    });
    const spoof = github.add(null, {
      body: intent.body,
      commit_id: head,
      path: finding.path,
      line: 9,
      side: "RIGHT",
      start_line: 4,
      start_side: "RIGHT",
    });
    spoof.user = { login: "human" };
    await expect(sync(github)).resolves.toMatchObject({
      state: "writing",
      observation: "missing",
      attempts: 1,
    });
    expect(github.postReviewComment).not.toHaveBeenCalled();
  });

  it("can dispatch after restarting with persisted intent before the claim", async () => {
    const github = createGitHub();
    const prepared = store.reviewPublications().prepare(findingId, null, bot, true);
    expect(prepared).toMatchObject({ state: "pending", attempts: 0 });
    store.close();
    store = new WorkflowStore(path);
    await expect(sync(github)).resolves.toMatchObject({
      id: prepared!.id,
      state: "published",
      attempts: 1,
    });
    expect(github.postReviewComment).toHaveBeenCalledTimes(1);
  });

  it("holds an unverified response even if it looks successful", async () => {
    const github = createGitHub();
    github.postReviewComment.mockResolvedValueOnce({ id: 100 });
    await expect(sync(github)).rejects.toThrow(/publication identity/);
    await expect(sync(github)).resolves.toMatchObject({
      state: "writing",
      observation: "missing",
      attempts: 1,
    });
    expect(github.postReviewComment).toHaveBeenCalledTimes(1);
  });

  it("blocks new root publication for a stale PR head and an unanchored finding", async () => {
    const github = createGitHub();
    github.readPullRequest.mockResolvedValueOnce({ state: "open", headSha: nextHead });
    await expect(sync(github)).rejects.toThrow(/current reviewed PR head/);
    expect(status()[0]!.publications).toMatchObject([{ state: "pending", attempts: 0 }]);
    store.reviews().start({ ...reviewStart, id: "review-2" });
    store.reviews().finish("review-2", {
      ...clean,
      findings: [{ ...finding, path: null, startLine: null, endLine: null }],
    });
    const id = store.reviews().inspect(workflowId).runs[1]!.findings[0]!.id;
    await expect(sync(github, { findingId: id })).resolves.toMatchObject({
      state: "blocked",
      error: expect.stringContaining("anchor"),
    });
    expect(github.postReviewComment).not.toHaveBeenCalled();
  });
});

describe("GitHub App review transport", () => {
  it.each(["publish", "reconcile"] as const)(
    "clears a throttled publication’s retry streak after restart and successful %s",
    async (mode) => {
      const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const key = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
      const { comments, add } = createGitHub();
      const calls: string[] = [];
      let now = Date.now();
      let firstWrite = true;
      function clientForStore() {
        const client = createGitHubAppClient({
          clientId: "client",
          privateKey: key,
          reviewWrites: true,
          now: () => now,
          rateLimits: store.githubRateLimits(),
          retryDeadlines: store.reconciliationRetries(),
          fetcher: async (input, init) => {
            const request = new Request(input, init);
            const path = new URL(request.url).pathname;
            if (path === "/app") return Response.json({ slug: "switchyard-test" });
            if (path === "/app/installations/5/access_tokens")
              return Response.json({
                token: "fixture-token",
                expires_at: new Date(now + 120_000).toISOString(),
              });
            calls.push(`${request.method} ${path}`);
            if (path === "/repos/owner/repo/pulls/1")
              return Response.json({ number: 1, head: { sha: head }, state: "open" });
            expect(path).toBe("/repos/owner/repo/pulls/1/comments");
            if (request.method === "GET") return Response.json(comments);
            expect(request.method).toBe("POST");
            if (firstWrite) {
              firstWrite = false;
              return new Response(null, { status: 429, headers: { "retry-after": "60" } });
            }
            const body = (await request.json()) as Record<string, unknown>;
            return Response.json(add(null, body), { status: 201 });
          },
        });
        return {
          ...createGitHubReader(client),
          readAppBot: client.readAppBot,
          readReviewThread: client.readReviewThread,
          postReviewComment: client.postReviewComment,
        };
      }

      await expect(sync(clientForStore())).rejects.toThrow(/HTTP 429/);
      expect(status()[0]!.publications).toMatchObject([{ state: "rejected", attempts: 1 }]);
      expect(comments).toHaveLength(0);
      expect(store.githubRateLimits().get("secondary")?.throttledAttempts).toBe(1);

      store.close();
      store = new WorkflowStore(path);
      const github = clientForStore();
      calls.length = 0;
      await expect(sync(github)).rejects.toThrow(/rate limit/);
      expect(calls).toEqual([]);
      expect(status()[0]!.publications).toMatchObject([{ state: "rejected", attempts: 1 }]);

      now += 60_001;
      if (mode === "reconcile") {
        await expect(sync(github, { mode })).resolves.toMatchObject({
          state: "rejected",
          attempts: 1,
        });
        expect(calls.splice(0)).toEqual(["GET /repos/owner/repo/pulls/1/comments"]);
        expect(store.githubRateLimits().get("secondary")?.throttledAttempts).toBe(0);
      }
      await expect(sync(github)).resolves.toMatchObject({
        state: "published",
        attempts: 2,
        comment_id: 100,
      });
      expect(store.githubRateLimits().get("secondary")?.throttledAttempts).toBe(0);
      await expect(sync(github)).resolves.toMatchObject({ state: "published", attempts: 2 });
      expect(calls).toEqual([
        "GET /repos/owner/repo/pulls/1/comments",
        "GET /repos/owner/repo/pulls/1",
        "POST /repos/owner/repo/pulls/1/comments",
        "GET /repos/owner/repo/pulls/1/comments",
      ]);
      expect(comments).toHaveLength(1);
    },
  );

  it("reads the matching review thread through paginated GraphQL with a read token", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const cursors: unknown[] = [];
    const client = createGitHubAppClient({
      clientId: "client",
      privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      fetcher: async (input, init) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        if (path.startsWith("/app/installations")) {
          expect(await request.json()).toMatchObject({ permissions: { pull_requests: "read" } });
          return Response.json({
            token: "fixture-token",
            expires_at: new Date(Date.now() + 120_000).toISOString(),
          });
        }
        expect(path).toBe("/graphql");
        const { query, variables } = (await request.json()) as {
          query: string;
          variables: { after: string | null };
        };
        expect(query.trimStart()).toMatch(/^query SwitchyardReviewThread/);
        expect(variables).toMatchObject({ owner: "owner", repo: "repo", pr: 1 });
        cursors.push(variables.after);
        const reviewThreads =
          variables.after === null
            ? { nodes: [], pageInfo: { hasNextPage: true, endCursor: "second" } }
            : {
                nodes: [
                  {
                    id: "thread-id",
                    isResolved: true,
                    isOutdated: false,
                    comments: { nodes: [{ fullDatabaseId: "100" }] },
                  },
                ],
                pageInfo: { hasNextPage: false },
              };
        return Response.json({ data: { repository: { pullRequest: { reviewThreads } } } });
      },
    });
    await expect(client.readReviewThread(target, 100)).resolves.toEqual({
      id: "thread-id",
      resolved: true,
      outdated: false,
    });
    expect(cursors).toEqual([null, "second"]);
  });

  it.each([401, 403, 429])(
    "scopes the write token and classifies a single HTTP %i POST as rejected",
    async (code) => {
      const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const posts: unknown[] = [];
      const client = createGitHubAppClient({
        clientId: "client",
        privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        reviewWrites: true,
        fetcher: async (input, init) => {
          const request = new Request(input, init);
          const path = new URL(request.url).pathname;
          if (path === "/app") return Response.json({ slug: "switchyard-test" });
          const body: unknown = await request.json();
          expect(request.method).toBe("POST");
          if (path === "/app/installations/5/access_tokens") {
            expect(body).toEqual({
              repositories: ["repo"],
              permissions: { pull_requests: "write", checks: "read", statuses: "read" },
            });
            return Response.json({
              token: "fixture-token",
              expires_at: new Date(Date.now() + 120_000).toISOString(),
            });
          }
          expect(path).toBe("/repos/owner/repo/pulls/1/comments/123/replies");
          posts.push(body);
          return new Response(null, {
            status: code,
            ...(code === 401 ? {} : { headers: { "retry-after": "60" } }),
          });
        },
      });
      expect(await client.readAppBot(target)).toBe(bot);
      await expect(client.postReviewComment(target, 123, { body: "reply" })).rejects.toBeInstanceOf(
        GitHubWriteRejected,
      );
      expect(posts).toEqual([{ body: "reply" }]);
    },
  );
});
