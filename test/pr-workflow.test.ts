import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { createAgentController } from "../src/agent-controller.ts";
import type { AgentResult } from "../src/agent.ts";
import type { PrWorkflowConfig } from "../src/config.ts";
import { createController } from "../src/controller.ts";
import type { PullRequestState } from "../src/github-api.ts";
import { findingUrl, prRoles, type Disposition, type PrRole } from "../src/pr-assignments.ts";
import { runPrCommand } from "../src/pr-command.ts";
import { createPrCoordinator } from "../src/pr-workflow.ts";
import { createReconciler } from "../src/reconcile.ts";
import { WorkflowStore } from "../src/store.ts";
import type { CheckOutcome } from "../src/workflow.ts";

const target = { repository: "cellgraph/fixture", installationId: 42, pullRequest: 5 };
const id = "cellgraph/fixture#5";
const heads = ["a", "b", "c", "d", "e", "f"].map((letter) => letter.repeat(40));
const config = Object.fromEntries(
  prRoles.map((role, index) => [
    role,
    {
      producerId: index + 100,
      agent: {
        agentName: role,
        context: { provider: "codex", workingDirectory: "/fixture" },
        rex: {
          endpoint: "ssh://test@agent.test/run/rex.sock",
          executable: "/opt/rex",
          executor: "/fixture/src/remote-executor.ts",
          node: "/opt/node",
          stateDirectory: "/tmp/agent",
          session: "session:11111111-1111-1111-1111-111111111111",
        },
      },
    },
  ]),
) as PrWorkflowConfig;

type Execute = ReturnType<typeof createAgentController>["execute"];
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "switchyard-pr-test-"));
  const path = join(directory, "workflow.sqlite");
  let store = new WorkflowStore(path);
  cleanups.push(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const snapshot: PullRequestState = {
    headSha: heads[0]!,
    state: "open",
    draft: false,
    merged: false,
    headRepository: target.repository,
  };
  let discovery = [target.pullRequest];
  let check: CheckOutcome = "passed";
  let nextId = 1;
  let clock = Date.now() + 180_000;
  const calls: Array<Parameters<Execute>[0]> = [];
  const recoveries: string[] = [];
  const reviews: Record<string, unknown>[] = [];
  const comments: Record<string, unknown>[] = [];
  const issues = new Map<number, unknown>();
  const commits = new Map<string, unknown>();
  const outputs = new Map<string, Extract<AgentResult, { outcome: "completed" }>>();
  const reviewer = { id: config.reviewer.producerId };
  const adjudicator = { id: config.adjudicator.producerId };
  let finding = false;
  let resolvePrevious = true;
  let decision: Disposition["decision"] = "accept";
  let unavailable: "not_started" | "unknown" | null = null;
  let interrupt = false;
  let unsigned = false;
  let beforeDispatch: (() => void) | undefined;
  let editEvidence: ((role: PrRole) => void) | undefined;
  const published = () => new Date(clock).toISOString();
  let latestFinding = 0;

  const github = {
    completeReconciliation() {},
    async listOpenPullRequests() {
      return discovery;
    },
    async readPullRequest() {
      return { ...snapshot };
    },
    async readChecks(_: unknown, sha: string) {
      return [{ name: "quality", sha, outcome: check }];
    },
    async readReviews() {
      return reviews;
    },
    async readReviewComments() {
      return comments;
    },
    async readIssue(_: unknown, number: number) {
      return issues.get(number);
    },
    async readCommit(_: unknown, sha: string) {
      return commits.get(sha);
    },
  };

  const execute: Execute = async (request) => {
    calls.push(request);
    const agent = store.agentExecutions();
    const claim = agent.claim(request);
    expect(claim.claimed).toBe(true);
    const assignment = store
      .prWorkflows()
      .list(id)
      .find((item) => item.id === request.assignmentId)!;
    const role = assignment.input.role;
    beforeDispatch?.();
    const authorized = agent.authorizeRemoteDispatch(request.id, request.mayLaunch);
    const outcome = unavailable ?? (authorized ? null : "not_started");
    if (outcome) {
      agent.recordRemote(request.id, { outcome: { outcome, reason: "Fixture interruption." } });
      return { execution: agent.get(request.id)!, session: claim.session };
    }
    const input = assignment.input;
    const headSha = snapshot.headSha;
    let structuredOutput: unknown;
    if (input.role === "reviewer") {
      const reviewId = nextId++;
      const findingIds = finding ? [nextId++] : [];
      if (findingIds.length) latestFinding = findingIds[0]!;
      const resolvedFindingIds = resolvePrevious ? input.previousFindingIds : [];
      const outcome = finding ? "findings" : "clean";
      reviews.push({
        id: reviewId,
        state: "COMMENTED",
        user: reviewer,
        commit_id: headSha,
        body: [
          `Review outcome: ${outcome}`,
          "Ran the fixture validation.",
          ...resolvedFindingIds.map((item) => `Resolved finding: ${findingUrl(target, item)}`),
        ].join("\n"),
        submitted_at: published(),
      });
      for (const findingId of findingIds)
        comments.push({
          id: findingId,
          user: reviewer,
          original_commit_id: headSha,
          pull_request_review_id: reviewId,
          path: "example.txt",
          body: "An actionable fixture finding.",
        });
      structuredOutput = { headSha, reviewId, findingIds, resolvedFindingIds, outcome };
    } else if (input.role === "adjudicator") {
      structuredOutput = {
        headSha: assignment.headSha,
        dispositions: input.findingIds.map((findingId) => {
          const replyId = nextId++;
          const issueNumber = decision === "defer" ? nextId++ : null;
          const issueUrl =
            issueNumber === null
              ? ""
              : `https://github.com/${target.repository}/issues/${issueNumber}`;
          if (issueNumber !== null)
            issues.set(issueNumber, {
              number: issueNumber,
              user: adjudicator,
              body: findingUrl(target, findingId),
              created_at: published(),
            });
          comments.push({
            id: replyId,
            user: adjudicator,
            in_reply_to_id: findingId,
            created_at: published(),
            body: `Decision: ${decision}\nThis is the disposition reasoning.\n${issueUrl}`,
          });
          return { replyId, decision, issueNumber, findingId };
        }),
      };
    } else {
      const nextHead = heads[heads.indexOf(headSha) + 1]!;
      commits.set(nextHead, {
        sha: nextHead,
        parents: [{ sha: headSha }],
        committer: { id: config.implementer.producerId },
        commit: { verification: { verified: !unsigned } },
      });
      snapshot.headSha = nextHead;
      check = "passed";
      finding = false;
      structuredOutput = { headSha, publishedHeadSha: nextHead };
    }
    editEvidence?.(role);
    const result = {
      outcome: "completed",
      response: "Native transcript stays in Rex",
      structuredOutput,
    } as const;
    outputs.set(request.id, result);
    agent.recordRemote(request.id, {
      outcome: result,
      digest: "final-fixture",
      blockId: "block:22222222-2222-2222-2222-222222222222",
      nativeId: `native-${claim.session.id}`,
    });
    if (interrupt) throw new Error("Controller exited after native completion.");
    return { execution: agent.get(request.id)!, session: agent.session(claim.session.id)!, result };
  };

  function build() {
    const reconcile = createReconciler(store, github, () => ["quality"]);
    const coordinator = createPrCoordinator({
      store,
      github,
      execute,
      now: () => clock,
      async inspect(id) {
        recoveries.push(id);
        const agent = store.agentExecutions();
        const execution = agent.get(id)!;
        const result = outputs.get(id);
        return {
          execution,
          session: agent.session(execution.sessionId)!,
          observation: {
            process: { state: "unavailable" },
            evidence: result ? "valid" : "unavailable",
          },
          ...(result ? { result } : {}),
        };
      },
    });
    const controller = createController({
      store,
      github,
      repositories: [target],
      reconcile,
      reportError: () => {},
      coordinate: (target) => coordinator(target, config),
    });
    return { reconcile, coordinator, controller };
  }

  let flows = build();
  return {
    get store() {
      return store;
    },
    get controller() {
      return flows.controller;
    },
    get workflow() {
      return store.getWorkflow(id);
    },
    get assignments() {
      return store.prWorkflows().list(id);
    },
    get roles() {
      return store
        .prWorkflows()
        .list(id)
        .map(({ input }) => input.role);
    },
    get allowance() {
      return store.prWorkflows().allowances(id);
    },
    get attention() {
      return store.prWorkflows().attention(id);
    },
    get findingId() {
      return latestFinding;
    },
    path,
    snapshot,
    reviews,
    comments,
    issues,
    commits,
    calls,
    recoveries,
    target,
    set discovery(value: number[]) {
      discovery = value;
    },
    set hasFinding(value: boolean) {
      finding = value;
    },
    set check(value: CheckOutcome) {
      check = value;
    },
    set decision(value: Disposition["decision"]) {
      decision = value;
    },
    set unavailable(value: typeof unavailable) {
      unavailable = value;
    },
    set interrupt(value: boolean) {
      interrupt = value;
    },
    set unsigned(value: boolean) {
      unsigned = value;
    },
    set resolvePrevious(value: boolean) {
      resolvePrevious = value;
    },
    set beforeDispatch(value: typeof beforeDispatch) {
      beforeDispatch = value;
    },
    set editEvidence(value: typeof editEvidence) {
      editEvidence = value;
    },
    move(index: number) {
      snapshot.headSha = heads[index]!;
    },
    advance() {
      clock += 600_000;
    },
    useRealTime() {
      clock = Date.now();
    },
    async tick() {
      await flows.reconcile(target);
      return flows.coordinator(target, config);
    },
    restart() {
      store.close();
      store = new WorkflowStore(path);
      flows = build();
    },
  };
}

describe("autonomous PR coordination", () => {
  it("automatically enrolls, reviews, adjudicates, revises and hands off passing exact-head evidence", async () => {
    const f = fixture();
    f.hasFinding = true;
    f.controller.scheduleSweep();
    for (let step = 0; step < 5; step += 1) expect(await f.controller.runPass()).toBe(true);
    expect(f.roles).toEqual(["reviewer", "adjudicator", "implementer", "reviewer"]);
    expect(f.workflow).toMatchObject({
      state: "ready",
      headSha: heads[1],
      githubStatus: "eligible",
    });
    expect(f.allowance).toEqual({
      reviews: { reservedOrUsed: 2, authorized: 3 },
      revisions: { reservedOrUsed: 1, authorized: 3 },
    });
    expect(
      new Set(f.calls.map(({ id }) => f.store.agentExecutions().get(id)?.sessionId)).size,
    ).toBe(4);
    expect(JSON.stringify(f.assignments)).not.toContain("Native transcript");
    await f.tick();
    expect(f.calls).toHaveLength(4);
  });

  it("observes a durable explicit initiation absent from discovery and keeps draft and fork requests ineligible", async () => {
    const f = fixture();
    f.discovery = [];
    f.store.prWorkflows().request(target.repository, target.pullRequest);
    f.restart();
    f.controller.scheduleSweep();
    expect(await f.controller.runPass()).toBe(true);
    expect(f.roles).toEqual(["reviewer"]);
    expect(f.store.prWorkflows().requests()).toEqual([]);
    await f.tick();
    expect(f.workflow?.state).toBe("ready");

    const excluded = fixture();
    excluded.snapshot.draft = true;
    await excluded.tick();
    expect(excluded.workflow).toBeNull();
    excluded.snapshot.draft = false;
    excluded.snapshot.headRepository = "fork/fixture";
    await excluded.tick();
    expect(excluded.workflow).toBeNull();
    expect(excluded.calls).toHaveLength(0);
  });

  it.each(["reject", "defer"] as const)(
    "hands off a %s-only review without another round",
    async (decision) => {
      const f = fixture();
      f.hasFinding = true;
      f.decision = decision;
      await f.tick();
      await f.tick();
      await f.tick();
      expect(f.roles).toEqual(["reviewer", "adjudicator"]);
      expect(f.workflow?.state).toBe("ready");
      if (decision === "defer") {
        f.issues.clear();
        await f.tick();
        expect(f.workflow?.state).toBe("escalated");
      }
    },
  );

  it("holds escalated findings across a changed head, then adjudicates again after operator direction", async () => {
    const f = fixture();
    f.hasFinding = true;
    f.decision = "escalate";
    await f.tick();
    await f.tick();
    await f.tick();
    expect(f.attention).toMatchObject({
      references: expect.arrayContaining([findingUrl(target, f.findingId)]),
    });
    f.move(1);
    f.hasFinding = false;
    f.restart();
    await f.tick();
    expect(f.workflow).toMatchObject({ state: "escalated", headSha: heads[1] });
    expect(f.calls).toHaveLength(2);
    f.store.prWorkflows().operate(id, {
      kind: "direction",
      reason: "Recheck the finding against the repository contract.",
    });
    f.store.prWorkflows().operate(id, { kind: "resume", reason: "Direction recorded." });
    f.decision = "reject";
    await f.tick();
    await f.tick();
    await f.tick();
    expect(f.roles).toEqual(["reviewer", "adjudicator", "adjudicator", "reviewer"]);
    expect(f.workflow?.state).toBe("ready");
  });

  it.each([false, true])(
    "uses one revision for failed checks with findings=%s",
    async (hasFinding) => {
      const f = fixture();
      f.hasFinding = hasFinding;
      f.check = "failed";
      await f.tick();
      if (hasFinding) await f.tick();
      await f.tick();
      expect(f.assignments.at(-1)?.input).toEqual({
        role: "implementer",
        failedChecks: ["quality"],
        findingIds: hasFinding ? [f.findingId] : [],
      });
      await f.tick();
      await f.tick();
      expect(f.workflow?.state).toBe("ready");
      expect(f.allowance.revisions.reservedOrUsed).toBe(1);
    },
  );

  it("retains accepted findings across an external head change until the new review explicitly resolves them", async () => {
    const f = fixture();
    f.hasFinding = true;
    await f.tick();
    await f.tick();
    f.move(1);
    f.hasFinding = false;
    f.resolvePrevious = false;
    await f.tick();
    expect(f.assignments.at(-1)?.input).toEqual({
      role: "reviewer",
      previousFindingIds: [f.findingId],
    });
    await f.tick();
    expect(f.assignments.at(-1)?.input).toEqual({
      role: "implementer",
      findingIds: [f.findingId],
      failedChecks: [],
    });
    expect(f.workflow?.state).toBe("awaiting_review");
  });

  it.each(["missing", "wrong author", "stale", "conflicting"] as const)(
    "holds %s review publication",
    async (problem) => {
      const f = fixture();
      f.editEvidence = () => {
        const review = f.reviews[0]!;
        switch (problem) {
          case "missing":
            f.reviews.length = 0;
            break;
          case "wrong author":
            review.user = { id: 666 };
            break;
          case "stale":
            review.commit_id = heads[3];
            break;
          case "conflicting":
            review.state = "CHANGES_REQUESTED";
            break;
        }
      };
      await f.tick();
      await f.tick();
      expect(f.workflow?.state).toBe("escalated");
      expect(f.calls).toHaveLength(1);
    },
  );

  it("blocks an unsigned revision even after the GitHub head advanced", async () => {
    const f = fixture();
    f.check = "failed";
    f.unsigned = true;
    await f.tick();
    await f.tick();
    await f.tick();
    expect(f.workflow?.state).toBe("escalated");
    expect(f.roles).toEqual(["reviewer", "implementer"]);
  });

  it("revokes readiness on edited evidence and on missing CI", async () => {
    const f = fixture();
    await f.tick();
    await f.tick();
    expect(f.workflow?.state).toBe("ready");
    f.check = "unknown";
    await f.tick();
    expect(f.workflow?.state).toBe("awaiting_review");
    f.check = "passed";
    f.reviews[0]!.body = "Review outcome: clean\nReplaced validation.";
    await f.tick();
    expect(f.workflow?.state).toBe("escalated");
    expect(f.calls).toHaveLength(1);
  });

  it("preserves review slots across heads and refuses a revision that cannot be re-reviewed", async () => {
    const f = fixture();
    for (let count = 0; count < 3; count += 1) {
      f.move(count);
      await f.tick();
      await f.tick();
    }
    f.check = "failed";
    await f.tick();
    expect(f.roles).toEqual(["reviewer", "reviewer", "reviewer"]);
    expect(f.attention?.reason).toMatch(/No Reviewer round/);
    f.store
      .prWorkflows()
      .operate(id, { kind: "grant", reviews: 1, revisions: 0, reason: "One more review." });
    f.store.prWorkflows().operate(id, { kind: "resume", reason: "Additional review authorized." });
    await f.tick();
    await f.tick();
    await f.tick();
    expect(f.workflow?.state).toBe("ready");
    expect(f.allowance.reviews).toEqual({ reservedOrUsed: 4, authorized: 4 });
  });

  it("can use a final revision and later pauses on the shared revision allowance", async () => {
    const f = fixture();
    f.check = "failed";
    for (let i = 0; i < 3; i += 1) {
      if (i === 2)
        f.store.prWorkflows().operate(id, {
          kind: "grant",
          reviews: 1,
          revisions: 0,
          reason: "Review a third revision.",
        });
      await f.tick();
      await f.tick();
      // Keep a failing check on the changed head, so every revision addresses required CI.
      f.check = "failed";
    }
    await f.tick();
    await f.tick();
    expect(f.allowance.revisions).toEqual({ reservedOrUsed: 3, authorized: 3 });
    f.store.prWorkflows().operate(id, {
      kind: "grant",
      reviews: 1,
      revisions: 0,
      reason: "Evaluate revision limit separately.",
    });
    f.store.prWorkflows().operate(id, { kind: "resume", reason: "Additional review authorized." });
    await f.tick();
    expect(f.attention?.reason).toMatch(/No Implementer revision/);
  });

  it("reuses a reservation on confirmed non-execution and recovers a completed result after restart", async () => {
    const f = fixture();
    f.unavailable = "not_started";
    f.useRealTime();
    await f.tick();
    expect(f.allowance.reviews.reservedOrUsed).toBe(0);
    await f.tick();
    const assignment = f.assignments[0]!;
    expect(f.calls).toHaveLength(1);
    f.advance();
    f.unavailable = null;
    f.interrupt = true;
    await expect(f.tick()).rejects.toThrow("Controller exited");
    f.restart();
    await f.tick();
    expect(f.calls.map((call) => call.assignmentId)).toEqual([assignment.id, assignment.id]);
    expect(f.recoveries).toEqual([f.calls[1]!.id]);
    expect(f.workflow?.state).toBe("ready");
    expect(f.allowance.reviews.reservedOrUsed).toBe(1);
  });

  it("holds uncertain execution without replay after reconciliation, restart and resume", async () => {
    const f = fixture();
    f.unavailable = "unknown";
    await f.tick();
    f.restart();
    await f.tick();
    expect(f.attention?.reason).toMatch(/unknown/);
    f.move(1);
    f.store
      .prWorkflows()
      .operate(id, { kind: "resume", reason: "Inspect existing native execution." });
    await f.tick();
    expect(f.workflow?.state).toBe("escalated");
    expect(f.allowance.reviews.reservedOrUsed).toBe(1);
    expect(f.calls).toHaveLength(1);
  });

  it("exposes durable attention, direction and capacity in the operator CLI", async () => {
    const f = fixture();
    f.unavailable = "unknown";
    await f.tick();
    await f.tick();
    f.restart();
    const output = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      expect(runPrCommand(["workflow", "attention"], f.path)).toBe(true);
      expect(JSON.parse(String(output.mock.lastCall?.[0]))).toMatchObject([
        {
          id,
          state: "escalated",
          attention: { references: expect.arrayContaining([`execution:${f.calls[0]!.id}`]) },
        },
      ]);
      expect(
        runPrCommand(["workflow", "direction", id, "Inspect the uncertain execution."], f.path),
      ).toBe(true);
      expect(
        runPrCommand(["workflow", "grant", id, "2", "1", "Additional capacity."], f.path),
      ).toBe(true);
      expect(runPrCommand(["workflow", "inspect", id], f.path)).toBe(true);
      expect(JSON.parse(String(output.mock.lastCall?.[0]))).toMatchObject({
        allowances: { reviews: { authorized: 5 }, revisions: { authorized: 4 } },
        assignments: [{ executions: [{ id: f.calls[0]!.id, status: "unknown" }] }],
        operatorEvents: [{ kind: "direction" }, { kind: "grant", reviews: 2, revisions: 1 }],
      });
      expect(() =>
        runPrCommand(
          [
            "workflow",
            "direction",
            id,
            "--abandon",
            f.calls[0]!.id,
            "Abandon uncertain execution.",
          ],
          f.path,
        ),
      ).toThrow("terminal execution");
    } finally {
      output.mockRestore();
    }
  });

  it("fences a staged launch after operator stop and observes closure, reopen and merge", async () => {
    const f = fixture();
    f.beforeDispatch = () =>
      f.store.prWorkflows().operate(id, { kind: "stop", reason: "Operator hold." });
    await f.tick();
    expect(f.store.agentExecutions().get(f.calls[0]!.id)).toMatchObject({
      status: "not_started",
      remote: { launchAuthorized: false },
    });
    f.snapshot.state = "closed";
    f.move(1);
    f.restart();
    await f.tick();
    expect(f.workflow).toMatchObject({
      state: "stopped",
      githubStatus: "closed",
      headSha: heads[1],
    });
    f.snapshot.state = "open";
    await f.tick();
    expect(f.workflow).toMatchObject({ state: "stopped", githubStatus: "eligible" });
    expect(f.calls).toHaveLength(1);
    f.store.prWorkflows().operate(id, { kind: "resume", reason: "Continue review." });
    f.beforeDispatch = undefined;
    await f.tick();
    await f.tick();
    expect(f.workflow?.state).toBe("ready");
    f.snapshot.state = "closed";
    f.snapshot.merged = true;
    await f.tick();
    expect(f.workflow).toMatchObject({ state: "stopped", githubStatus: "merged" });
    expect(f.calls).toHaveLength(2);
  });
});
