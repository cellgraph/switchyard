import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { createAgentController } from "../src/agent-controller.ts";
import type { AgentResult } from "../src/agent.ts";
import type { PrWorkflowConfig } from "../src/config.ts";
import { createController } from "../src/controller.ts";
import { GitHubRateLimitError } from "../src/github-app.ts";
import type { PullRequestState } from "../src/github-api.ts";
import { findingUrl, prRoles, type Disposition, type PrRole } from "../src/pr-assignments.ts";
import { runPrCommand } from "../src/pr-command.ts";
import { createPrCoordinator } from "../src/pr-workflow.ts";
import { createReconciler } from "../src/reconcile.ts";
import { WorkflowStore } from "../src/store.ts";
import type { CheckOutcome } from "../src/workflow.ts";

const target = { repository: "cellgraph/fixture", installationId: 42, pullRequest: 5 };
const id = "cellgraph/fixture#5";
const blockId = "block:22222222-2222-2222-2222-222222222222";
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
  const configured = structuredClone(config);
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
  let dependentCheck: CheckOutcome | null = null;
  let nextId = 1;
  let retainedCommit = true;
  let throttlePublications = false;
  let unavailablePullRequest = false;
  let unavailableIssues = false;
  let conflictingRex = false;
  let rexProcess: "unavailable" | "exited" | "running" = "unavailable";
  let clock = Date.now() + 180_000;
  const calls: Array<Parameters<Execute>[0]> = [];
  const recoveries: string[] = [];
  const completions: number[] = [];
  const reviews: Record<string, unknown>[] = [];
  const comments: Record<string, unknown>[] = [];
  const issues = new Map<number, unknown>();
  const commits = new Map<string, unknown>();
  const outputs = new Map<string, Extract<AgentResult, { outcome: "completed" }>>();
  const reviewer = { id: config.reviewer.producerId };
  const adjudicator = { id: config.adjudicator.producerId };
  let finding = false;
  let findingCount = 1;
  let resolvePrevious = true;
  let decision: Disposition["decision"] = "accept";
  let unavailable: "not_started" | "unknown" | "failed" | null = null;
  let interrupt = false;
  let unsigned = false;
  let beforeDispatch: (() => void) | undefined;
  let beforeInspect: ((id: string) => void) | undefined;
  let beforeReadComments: (() => void | Promise<void>) | undefined;
  let editEvidence: ((role: PrRole) => void) | undefined;
  let loseResult: PrRole | null = null;
  let lostPublication: unknown;
  const published = () => new Date(clock).toISOString();
  let latestFinding = 0;

  const github = {
    completeReconciliation(_: unknown, pullRequest?: number) {
      if (pullRequest !== undefined) completions.push(pullRequest);
    },
    async listOpenPullRequests() {
      return discovery;
    },
    async readPullRequest() {
      if (unavailablePullRequest) throw new Error("GitHub no longer exposes this pull request.");
      return { ...snapshot };
    },
    async readChecks(_: unknown, sha: string) {
      return [
        { name: "quality", sha, outcome: check },
        ...(dependentCheck === null ? [] : [{ name: "dependent", sha, outcome: dependentCheck }]),
      ];
    },
    async readReviews() {
      if (throttlePublications) throw new GitHubRateLimitError(clock + 60000);
      return reviews;
    },
    async readReviewComments() {
      await beforeReadComments?.();
      return comments;
    },
    async readIssue(_: unknown, number: number) {
      if (unavailableIssues) throw new Error("GitHub issue endpoint unavailable.");
      return issues.get(number);
    },
    async readCommit(_: unknown, sha: string) {
      return commits.get(sha);
    },
    async readComparison(_: unknown, base: string) {
      return {
        status: retainedCommit ? "ahead" : "diverged",
        base_commit: { sha: base },
        merge_base_commit: { sha: retainedCommit ? base : heads[0] },
      };
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
    let launchAllowed;
    try {
      launchAllowed = await request.confirmLaunch?.();
    } catch (error) {
      agent.recordRemote(request.id, {
        outcome: { outcome: "not_started", reason: "Fixture launch fence." },
      });
      throw error;
    }
    const authorized =
      launchAllowed && agent.authorizeRemoteDispatch(request.id, request.mayLaunch);
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
      const findingIds = finding ? Array.from({ length: findingCount }, () => nextId++) : [];
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
    if (loseResult === role) {
      lostPublication = structuredOutput;
      agent.recordRemote(request.id, {
        outcome: { outcome: "unknown", reason: "The fixture lost its native result." },
        blockId,
        nativeId: `native-${claim.session.id}`,
      });
      return { execution: agent.get(request.id)!, session: agent.session(claim.session.id)! };
    }
    const result = {
      outcome: "completed",
      response: "Native transcript stays in Rex",
      structuredOutput,
    } as const;
    outputs.set(request.id, result);
    agent.recordRemote(request.id, {
      outcome: result,
      digest: "final-fixture",
      blockId,
      nativeId: `native-${claim.session.id}`,
    });
    if (interrupt) throw new Error("Controller exited after native completion.");
    return { execution: agent.get(request.id)!, session: agent.session(claim.session.id)!, result };
  };

  function build() {
    const reconcile = createReconciler(store, github, () =>
      dependentCheck === null ? ["quality"] : ["quality", "dependent"],
    );
    const coordinator = createPrCoordinator({
      store,
      github,
      reconcile,
      execute,
      now: () => clock,
      async inspect(id) {
        recoveries.push(id);
        beforeInspect?.(id);
        const agent = store.agentExecutions();
        const execution = agent.get(id)!;
        const result = outputs.get(id);
        return {
          execution,
          session: agent.session(execution.sessionId)!,
          observation: {
            process: conflictingRex
              ? { state: "running" }
              : rexProcess === "exited"
                ? { state: "exited", exitCode: 1 }
                : { state: rexProcess },
            evidence: conflictingRex ? "conflicting" : result ? "valid" : "unavailable",
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
      coordinate: (target) => coordinator(target, configured),
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
    completions,
    set unavailableIssues(value: boolean) {
      unavailableIssues = value;
    },
    set unavailablePullRequest(value: boolean) {
      unavailablePullRequest = value;
    },
    set conflictingRex(value: boolean) {
      conflictingRex = value;
    },
    set rexProcess(value: typeof rexProcess) {
      rexProcess = value;
    },
    set loseResult(value: typeof loseResult) {
      loseResult = value;
    },
    get lostPublication() {
      return lostPublication;
    },
    set retainedCommit(value: boolean) {
      retainedCommit = value;
    },
    set throttlePublications(value: boolean) {
      throttlePublications = value;
    },
    observeOnly() {
      return flows.coordinator(target);
    },
    target,
    set discovery(value: number[]) {
      discovery = value;
    },
    set findingCount(value: number) {
      findingCount = value;
    },
    set hasFinding(value: boolean) {
      finding = value;
    },
    set check(value: CheckOutcome) {
      check = value;
    },
    set dependentCheck(value: CheckOutcome) {
      dependentCheck = value;
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
    set beforeInspect(value: typeof beforeInspect) {
      beforeInspect = value;
    },
    set beforeReadComments(value: typeof beforeReadComments) {
      beforeReadComments = value;
    },
    configured,
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
      return flows.coordinator(target, configured);
    },
    coordinate() {
      return flows.coordinator(target, configured);
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
    const initial = f.calls[0]?.prompt;
    const adjudication = f.calls[1]?.prompt;
    const followUp = f.calls[3]?.prompt;
    const reviewReference = `#pullrequestreview-${String(f.reviews[0]?.id)}`;
    expect(initial).toContain(
      "Conduct a comprehensive independent review of the PR against its base",
    );
    expect(initial).not.toContain("Prior verified review at");
    expect(followUp).toContain(`Prior verified review at ${heads[0]}`);
    expect(followUp).toContain(reviewReference);
    expect(followUp).toContain(findingUrl(target, f.findingId));
    expect(followUp).toContain(
      "verifying corrections, checking affected invariants and looking for regressions",
    );
    expect(followUp).toContain(
      "Broaden the review when substantial changes or material architectural changes warrant it",
    );
    expect(followUp).toContain("comparison or prior review is insufficient");
    for (const prompt of [initial, followUp]) {
      expect(prompt).toContain(
        "In every round, report newly discovered consequential defects, including those outside the revision diff",
      );
      expect(prompt).toContain(
        "the plausible trigger, the consequence and the behavior that needs correction",
      );
    }
    expect(adjudication).toContain("likelihood, impact, recoverability and correction cost");
    expect(adjudication).toContain("A technically valid finding may be nonblocking");
    expect(adjudication).toContain("Accept findings that warrant correction before acceptance");
    expect(adjudication).toContain("Reject unsupported or immaterial findings");
    expect(adjudication).toContain("Defer worthwhile nonblocking work with a linked issue");
    expect(adjudication).toContain(
      "Escalate consequential decisions that require operator judgment",
    );
    expect(adjudication).toContain(
      "create a same-repository GitHub issue whose body contains the full finding URL",
    );
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

  it("requires the Reviewer to publish its own findings when an earlier review raised the issue", async () => {
    const f = fixture();
    f.hasFinding = true;
    f.editEvidence = () => {
      f.comments[0]!.pull_request_review_id = 12345;
    };

    await f.tick();
    expect(f.calls[0]?.prompt).toContain("Prior Switchyard findings for this assignment: []");
    expect(f.calls[0]?.prompt).toContain("publish your own root inline finding in this review");
    expect(f.calls[0]?.prompt).toContain(
      "Outcome findings requires at least one root inline finding ID from this review.",
    );
    await f.tick();

    expect(f.workflow?.state).toBe("escalated");
    expect(f.roles).toEqual(["reviewer"]);
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
      expect(f.calls.at(-1)?.prompt).toContain(`Prior verified review at ${heads[0]}`);
      if (!hasFinding)
        expect(f.calls.at(-1)?.prompt).toContain(
          "Prior Switchyard findings for this assignment: []",
        );
    },
  );

  it("fixes a known failure when a dependent check was skipped", async () => {
    const f = fixture();
    f.check = "failed";
    f.dependentCheck = "unknown";
    await f.tick();
    await f.tick();
    expect(f.assignments.at(-1)?.input).toMatchObject({
      role: "implementer",
      failedChecks: ["quality"],
    });
    await f.tick();
    await f.tick();
    expect(f.workflow?.state).toBe("awaiting_review");
    f.dependentCheck = "passed";
    await f.tick();
    expect(f.workflow?.state).toBe("ready");
  });

  it("can review a new head after an old clean review disappears", async () => {
    const f = fixture();
    await f.tick();
    await f.tick();
    f.reviews.length = 0;
    f.move(1);
    await f.tick();
    expect(f.workflow?.state).toBe("awaiting_review");
    expect(f.calls.at(-1)?.prompt).toContain("Conduct a comprehensive independent review");
    expect(f.calls.at(-1)?.prompt).not.toContain("Prior verified review at");
    await f.tick();
    expect(f.roles).toEqual(["reviewer", "reviewer"]);
    expect(f.workflow).toMatchObject({ state: "ready", headSha: heads[1] });
  });

  it("can continue after the operator accounts for an uncorroborated terminal assignment", async () => {
    const f = fixture();
    f.editEvidence = () => {
      f.reviews[0]!.user = { id: 666 };
    };
    await f.tick();
    await f.tick();
    expect(f.workflow?.state).toBe("escalated");
    f.store.prWorkflows().operate(id, {
      kind: "abandon",
      executionId: f.calls[0]!.id,
      reason: "Inspected the incorrect publication.",
    });
    f.store
      .prWorkflows()
      .operate(id, { kind: "resume", reason: "Run a fresh review within the allowance." });
    f.editEvidence = undefined;
    await f.tick();
    await f.tick();
    expect(f.roles).toEqual(["reviewer", "reviewer"]);
    expect(f.allowance.reviews.reservedOrUsed).toBe(2);
    expect(f.workflow?.state).toBe("ready");
  });

  it.each(["reviewer", "adjudicator"] as const)(
    "discards stale %s evidence when another connection stops, abandons and resumes",
    async (role) => {
      const f = fixture();
      f.hasFinding = true;
      f.decision = "reject";
      await f.tick();
      if (role === "adjudicator") await f.tick();
      const executionId = f.calls.at(-1)!.id;
      const reading = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      f.beforeReadComments = () => {
        reading.resolve();
        return release.promise;
      };
      const stalePass = f.tick();
      await reading.promise;
      const operator = new WorkflowStore(f.path);
      try {
        const pr = operator.prWorkflows();
        pr.operate(id, { kind: "stop", reason: "Discard the terminal assignment." });
        pr.operate(id, { kind: "abandon", executionId, reason: "Discard the unverified claim." });
        pr.operate(id, { kind: "resume", reason: "Reconcile without the abandoned publication." });
      } finally {
        operator.close();
        f.beforeReadComments = undefined;
        release.resolve();
        await stalePass;
      }
      expect(f.assignments.at(-1)).toMatchObject({ executionId, superseded: true, proof: null });
      if (role === "reviewer") {
        expect(f.store.reviews().list(id)).toEqual([]);
        f.hasFinding = false;
      } else {
        expect(f.store.reviews().list(id)[0]?.findings[0]?.disposition).toBeNull();
      }
      await f.tick();
      expect(f.roles).toEqual(
        role === "reviewer" ? ["reviewer", "reviewer"] : ["reviewer", "adjudicator", "adjudicator"],
      );
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

  it("revokes an existing handoff when the repository switches to observation-only", async () => {
    const f = fixture();
    await f.tick();
    await f.tick();
    expect(f.workflow?.state).toBe("ready");
    await f.observeOnly();
    expect(f.workflow?.state).toBe("awaiting_review");
  });

  it("keeps the PR's GitHub throttle streak until publication reads succeed", async () => {
    const f = fixture();
    f.controller.scheduleSweep();
    expect(await f.controller.runPass()).toBe(true);
    expect(f.completions).toHaveLength(1);
    f.throttlePublications = true;
    expect(await f.controller.runPass()).toBe(false);
    expect(f.completions).toHaveLength(1);
  });

  it.each([true, false])(
    "verifies a signed revision covered by an external push when retained=%s",
    async (retained) => {
      const f = fixture();
      f.check = "failed";
      f.unsigned = true;
      f.retainedCommit = retained;
      await f.tick();
      await f.tick();
      f.move(2);
      await f.tick();
      if (retained) {
        expect(f.workflow?.state).toBe("escalated");
        expect(f.roles).toEqual(["reviewer", "implementer"]);
      } else {
        await f.tick();
        expect(f.workflow?.state).toBe("ready");
        expect(f.roles).toEqual(["reviewer", "implementer", "reviewer"]);
      }
    },
  );

  it("surfaces conflicting Rex evidence even if the block is still running", async () => {
    const f = fixture();
    f.unavailable = "unknown";
    await f.tick();
    f.conflictingRex = true;
    await f.tick();
    expect(f.attention?.reason).toMatch(/Rex evidence conflicts/);
    expect(f.calls).toHaveLength(1);
  });

  it("can replace a deleted rejected finding without claiming a code fix", async () => {
    const f = fixture();
    f.hasFinding = true;
    f.decision = "reject";
    for (let i = 0; i < 3; i += 1) await f.tick();
    expect(f.workflow?.state).toBe("ready");
    f.comments.length = 0;
    await f.tick();
    f.store.prWorkflows().operate(id, {
      kind: "replace_evidence",
      executionId: f.calls[0]!.id,
      reason: "The original review was removed.",
    });
    f.store.prWorkflows().operate(id, { kind: "resume", reason: "Review the unchanged head." });
    f.hasFinding = false;
    await f.tick();
    expect(f.assignments.at(-1)?.input).toEqual({ role: "reviewer", previousFindingIds: [] });
    await f.tick();
    expect(f.workflow?.state).toBe("ready");
  });

  it.each(["reject", "defer"] as const)(
    "requires replacement review to account for a present edited finding previously marked %s",
    async (decision) => {
      const f = fixture();
      f.hasFinding = true;
      f.decision = decision;
      for (let i = 0; i < 3; i += 1) await f.tick();
      expect(f.workflow?.state).toBe("ready");
      f.comments[0]!.body = "A different actionable finding introduced by an edit.";
      await f.tick();
      expect(f.workflow?.state).toBe("escalated");
      const pr = f.store.prWorkflows();
      pr.operate(id, {
        kind: "replace_evidence",
        executionId: f.calls[0]!.id,
        reason: "The existing finding now describes a different blocker.",
      });
      pr.operate(id, { kind: "resume", reason: "Review the edited finding." });
      f.hasFinding = false;
      f.resolvePrevious = false;
      await f.tick();
      expect(f.assignments.at(-1)?.input).toEqual({
        role: "reviewer",
        previousFindingIds: [f.findingId],
      });
      expect(f.calls.at(-1)?.prompt).toContain(findingUrl(target, f.findingId));
      await f.tick();
      expect(f.workflow?.state).toBe("escalated");
      expect(f.attention?.references).toContain(findingUrl(target, f.findingId));

      pr.operate(id, {
        kind: "replace_evidence",
        executionId: f.calls.at(-1)!.id,
        reason: "The replacement review did not account for the edited finding.",
      });
      pr.operate(id, { kind: "resume", reason: "Verify that the edited finding is resolved." });
      f.resolvePrevious = true;
      await f.tick();
      await f.tick();
      expect(f.workflow?.state).toBe("ready");
    },
  );

  it.each(["contrary outcome", "omitted root"] as const)(
    "holds a trusted review with a competing %s until the publication is reconciled",
    async (kind) => {
      const f = fixture();
      await f.tick();
      const original = f.reviews[0]!;
      const competing = {
        ...original,
        id: 900,
        body: kind === "contrary outcome" ? "Review outcome: findings" : "Validation summary.",
      };
      f.reviews.push(
        competing,
        { ...competing, id: 901, user: { id: 555 }, body: "Review outcome: findings" },
        { ...competing, id: 902, submitted_at: "2000-01-01Z", body: "Review outcome: findings" },
      );
      if (kind === "omitted root")
        f.comments.push({
          id: 903,
          user: original.user,
          original_commit_id: original.commit_id,
          pull_request_review_id: competing.id,
          path: "fixture.txt",
          body: "An actionable root missing from the claimed clean review.",
        });
      await f.tick();
      expect(f.workflow?.state).toBe("escalated");
      expect(f.attention?.reason).toMatch(/contradictory reviews/);
      expect(
        f.attention?.references.filter((item) => item.includes("#pullrequestreview-")),
      ).toEqual([
        expect.stringContaining(`#pullrequestreview-${String(original.id)}`),
        expect.stringContaining("#pullrequestreview-900"),
      ]);
      expect(f.assignments[0]?.proof).toBeNull();
      expect(f.calls).toHaveLength(1);

      Object.assign(competing, { state: "DISMISSED" });
      f.store.prWorkflows().operate(id, { kind: "resume", reason: "The conflict was reconciled." });
      await f.tick();
      expect(f.workflow?.state).toBe("ready");
      expect(f.calls).toHaveLength(1);
    },
  );

  it("accepts canonical repository casing in deferred issue and finding links", async () => {
    const f = fixture();
    f.hasFinding = true;
    f.decision = "defer";
    await f.tick();
    await f.tick();
    const reply = f.comments.at(-1)!;
    reply.body = String(reply.body).replace("cellgraph/fixture", "CellGraph/Fixture");
    const issue = f.issues.values().next().value as { body: string };
    issue.body = issue.body.replace("cellgraph/fixture", "CellGraph/Fixture");
    await f.tick();
    expect(f.workflow?.state).toBe("ready");
  });

  it("renews a lost deferral when the original finding can still be adjudicated", async () => {
    const f = fixture();
    f.hasFinding = true;
    f.decision = "defer";
    for (let i = 0; i < 3; i += 1) await f.tick();
    expect(f.workflow?.state).toBe("ready");
    const finding = f.findingId;
    f.issues.clear();
    await f.tick();
    f.store.prWorkflows().operate(id, {
      kind: "replace_evidence",
      executionId: f.calls[0]!.id,
      reason: "The deferred issue disappeared.",
    });
    f.store.prWorkflows().operate(id, { kind: "resume", reason: "Publish a new deferral." });
    f.hasFinding = false;
    await f.tick();
    expect(f.assignments.at(-1)?.input).toMatchObject({
      role: "adjudicator",
      findingIds: [finding],
    });
    await f.tick();
    await f.tick();
    expect(f.roles).toEqual(["reviewer", "adjudicator", "adjudicator", "reviewer"]);
    expect(f.workflow?.state).toBe("ready");
    const renewedReply = f.comments.at(-1)!;
    f.comments.splice(f.comments.indexOf(renewedReply), 1);
    await f.tick();
    expect(f.workflow?.state).toBe("awaiting_review");
    expect(f.roles.at(-1)).toBe("adjudicator");
  });

  it("skips obsolete deferral evidence after a replacement review verifies the finding is fixed", async () => {
    const f = fixture();
    f.hasFinding = true;
    f.decision = "defer";
    for (let i = 0; i < 3; i += 1) await f.tick();
    const finding = f.findingId;
    f.issues.clear();
    f.comments.length = 0;
    await f.tick();
    f.store.prWorkflows().operate(id, {
      kind: "replace_evidence",
      executionId: f.calls[0]!.id,
      reason: "The original comment and issue were removed.",
    });
    f.store
      .prWorkflows()
      .operate(id, { kind: "resume", reason: "Review the correction independently." });
    f.move(1);
    f.hasFinding = false;
    await f.tick();
    expect(f.assignments.at(-1)?.input).toEqual({
      role: "reviewer",
      previousFindingIds: [finding],
    });
    f.unavailableIssues = true;
    await f.tick();
    expect(f.workflow?.state).toBe("ready");
  });

  it("renews only the surviving original finding after replacing both publications", async () => {
    const f = fixture();
    f.hasFinding = true;
    f.findingCount = 2;
    f.decision = "defer";
    for (let i = 0; i < 3; i += 1) await f.tick();
    expect(f.workflow?.state).toBe("ready");
    const [removed, remaining] = f.comments.slice(0, 2).map((item) => Number(item.id));
    f.comments.splice(0, 1);
    f.issues.clear();
    await f.tick();
    for (const { id: executionId } of f.calls) {
      f.store.prWorkflows().operate(id, {
        kind: "replace_evidence",
        executionId,
        reason: "One root comment and the issues disappeared.",
      });
    }
    f.store
      .prWorkflows()
      .operate(id, { kind: "resume", reason: "Renew evidence for the available finding." });
    f.hasFinding = false;
    await f.tick();
    expect(f.assignments.at(-1)?.input).toMatchObject({
      role: "adjudicator",
      findingIds: [remaining],
    });
    await f.tick();
    expect(f.assignments.at(-1)?.input).toEqual({
      role: "reviewer",
      previousFindingIds: [removed],
    });
  });

  it("does not revive an older deferral after replacing the latest disposition", async () => {
    const f = fixture();
    f.hasFinding = true;
    f.decision = "defer";
    for (let i = 0; i < 3; i += 1) await f.tick();
    const finding = f.findingId;
    const originalIssues = [...f.issues];
    f.issues.clear();
    await f.tick();
    f.store.prWorkflows().operate(id, {
      kind: "replace_evidence",
      executionId: f.calls[0]!.id,
      reason: "Renew the original review evidence.",
    });
    f.store.prWorkflows().operate(id, { kind: "resume", reason: "Renew the disposition." });
    f.decision = "accept";
    f.check = "pending";
    f.resolvePrevious = false;
    f.hasFinding = false;
    await f.tick();
    const renewed = f.calls.at(-1)!.id;
    await f.tick();
    await f.tick();
    f.store
      .prWorkflows()
      .operate(id, { kind: "stop", reason: "Replace the most recent reasoning." });
    f.store.prWorkflows().operate(id, {
      kind: "replace_evidence",
      executionId: renewed,
      reason: "Require a fresh disposition.",
    });
    for (const [number, issue] of originalIssues) f.issues.set(number, issue);
    f.store
      .prWorkflows()
      .operate(id, { kind: "resume", reason: "Adjudicate without reusing the historical result." });
    f.decision = "reject";
    await f.tick();
    expect(f.assignments.at(-1)?.input).toMatchObject({
      role: "adjudicator",
      findingIds: [finding],
    });
    f.check = "passed";
    await f.tick();
    expect(f.workflow?.state).toBe("ready");
  });

  it("pauses on a conflicting reply to a renewed disposition before dispatching a revision", async () => {
    const f = fixture();
    f.hasFinding = true;
    f.decision = "defer";
    for (let i = 0; i < 3; i += 1) await f.tick();
    const finding = f.findingId;
    f.issues.clear();
    await f.tick();
    f.store.prWorkflows().operate(id, {
      kind: "replace_evidence",
      executionId: f.calls[0]!.id,
      reason: "The original deferral was lost.",
    });
    f.store.prWorkflows().operate(id, { kind: "resume", reason: "Renew the disposition." });
    f.decision = "accept";
    f.check = "pending";
    f.resolvePrevious = false;
    f.hasFinding = false;
    await f.tick();
    await f.tick();
    f.comments.push({
      id: 1000,
      user: { id: config.adjudicator.producerId },
      in_reply_to_id: finding,
      body: "Decision: reject\nContradicts the accepted disposition.",
    });
    f.check = "passed";
    await f.tick();
    expect(f.attention?.reason).toMatch(/conflicting dispositions/);
    expect(f.roles).not.toContain("implementer");
  });

  it("requires reasoning alongside a mixed-case issue link", async () => {
    const f = fixture();
    f.hasFinding = true;
    f.decision = "defer";
    await f.tick();
    await f.tick();
    const reply = f.comments.at(-1)!;
    reply.body = String(reply.body)
      .replace("This is the disposition reasoning.\n", "")
      .replace("https://", "HTTPS://");
    await f.tick();
    expect(f.workflow?.state).toBe("escalated");
  });

  it("recovers an outstanding turn on a merged PR in later sweeps without dispatch", async () => {
    const f = fixture();
    f.unavailable = "unknown";
    await f.tick();
    const executionId = f.calls[0]!.id;
    f.snapshot.state = "closed";
    f.snapshot.merged = true;
    await f.tick();
    expect(f.workflow?.githubStatus).toBe("merged");
    f.discovery = [];
    f.unavailablePullRequest = true;
    f.beforeInspect = () => {
      f.store.agentExecutions().recordRemote(executionId, {
        nativeId: "merged-native",
        digest: "merged-result",
        blockId: "block:22222222-2222-2222-2222-222222222222",
        outcome: { outcome: "completed" },
      });
    };
    f.controller.scheduleSweep();
    expect(await f.controller.runPass()).toBe(true);
    expect(f.store.agentExecutions().get(executionId)?.status).toBe("completed");
    expect(f.calls).toHaveLength(1);
  });

  it("requires a new review to account for deleted verified findings after operator replacement", async () => {
    const f = fixture();
    f.hasFinding = true;
    f.decision = "accept";
    await f.tick();
    await f.tick();
    f.check = "pending";
    await f.tick();
    const finding = f.findingId;
    f.comments.length = 0;
    await f.tick();
    expect(f.workflow?.state).toBe("escalated");
    f.store.prWorkflows().operate(id, {
      kind: "replace_evidence",
      executionId: f.calls[0]!.id,
      reason: "The removed finding concerned the validation contract.",
    });
    f.store
      .prWorkflows()
      .operate(id, { kind: "resume", reason: "Independent verification of the removed finding." });
    f.check = "passed";
    f.hasFinding = false;
    await f.tick();
    expect(f.assignments.at(-1)?.input).toEqual({
      role: "reviewer",
      previousFindingIds: [finding],
    });
    await f.tick();
    expect(f.workflow?.state).toBe("ready");
    expect(f.assignments[0]).toMatchObject({ proof: expect.any(String), superseded: true });
  });

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

  it("refreshes passing CI after review reads before recording readiness", async () => {
    const f = fixture();
    await f.tick();
    f.beforeReadComments = () => {
      f.check = "failed";
    };
    expect(await f.tick()).toBe(true);
    expect(f.workflow).toMatchObject({
      state: "awaiting_review",
      checks: [{ name: "quality", sha: heads[0], outcome: "failed" }],
    });
    expect(f.store.transitions(id).some(({ to }) => to === "ready")).toBe(false);
    expect(f.calls).toHaveLength(1);
  });

  it.each(["cleared", "changed"] as const)(
    "does not authorize a staged CI-driven revision after failures have %s",
    async (failures) => {
      const f = fixture();
      f.check = "failed";
      f.dependentCheck = "passed";
      await f.tick();
      f.beforeDispatch = () => {
        f.check = "passed";
        f.dependentCheck = failures === "cleared" ? "passed" : "failed";
      };
      expect(await f.tick()).toBe(true);
      expect(f.store.agentExecutions().get(f.calls[1]!.id)).toMatchObject({
        status: "not_started",
        remote: { launchAuthorized: false },
      });
      expect(f.allowance.revisions.reservedOrUsed).toBe(0);
      f.beforeDispatch = undefined;
      await f.tick();
      expect(f.assignments[1]?.superseded).toBe(true);
      if (failures === "cleared") {
        expect(f.workflow?.state).toBe("ready");
        expect(f.calls).toHaveLength(2);
      } else {
        expect(f.assignments.at(-1)?.input).toMatchObject({
          role: "implementer",
          failedChecks: ["dependent"],
        });
        expect(f.allowance.revisions.reservedOrUsed).toBe(1);
      }
    },
  );

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
    await expect(f.tick()).rejects.toThrow("did not start");
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

  it.each(prRoles)(
    "recovers a published %s objective after losing the native result",
    async (role) => {
      const f = fixture();
      f.loseResult = role;
      f.hasFinding = role === "adjudicator";
      f.decision = "defer";
      f.check = role === "implementer" ? "failed" : "passed";
      await f.tick();
      if (role !== "reviewer") await f.tick();
      const executionId = f.calls.at(-1)!.id;
      f.rexProcess = "exited";
      await f.tick();
      expect(f.attention?.reason).toMatch(/unknown/);

      const cli = (publication: unknown) =>
        runPrCommand(
          [
            "workflow",
            "direction",
            id,
            "--recover-outcome",
            executionId,
            JSON.stringify(publication),
            "Inspected the correlated Rex process and GitHub publication.",
          ],
          f.path,
        );
      const output = vi.spyOn(console, "info").mockImplementation(() => {});
      try {
        if (role === "reviewer") {
          expect(() => cli({ headSha: heads[1] })).toThrow("original assignment");
          cli({ ...(f.lostPublication as object), reviewId: 9999 });
          f.store
            .prWorkflows()
            .operate(id, { kind: "resume", reason: "Check the supplied review." });
          await f.tick();
          expect(f.attention?.reason).toMatch(/publication.*missing/);
          expect(f.assignments[0]).toMatchObject({ claim: null, proof: null });
          expect(f.store.reviews().list(id)).toEqual([]);
          expect(f.calls).toHaveLength(1);
        }
        expect(cli(f.lostPublication)).toBe(true);
      } finally {
        output.mockRestore();
      }
      f.restart();
      f.store
        .prWorkflows()
        .operate(id, { kind: "resume", reason: "Verify the recovered objective." });
      await f.tick();
      if (role === "implementer") await f.tick();
      expect(f.workflow?.state).toBe("ready");
      expect(f.calls.map((call) => call.id).filter((call) => call === executionId)).toHaveLength(1);
      expect(f.calls).toHaveLength(role === "reviewer" ? 1 : role === "adjudicator" ? 2 : 3);
      expect(
        f.assignments.find((assignment) => assignment.executionId === executionId),
      ).toMatchObject({
        claim: f.lostPublication,
        proof: expect.any(String),
      });
      expect(f.store.agentExecutions().get(executionId)).toMatchObject({
        status: "unknown",
        remote: { resultDigest: null },
      });
      expect(f.store.prWorkflows().events(id)).toContainEqual(
        expect.objectContaining({
          kind: "recover_outcome",
          recovery: expect.objectContaining({ executionId, confirmedBy: { blockId } }),
        }),
      );
      expect(f.allowance.reviews.reservedOrUsed).toBe(role === "implementer" ? 2 : 1);
      expect(f.allowance.revisions.reservedOrUsed).toBe(role === "implementer" ? 1 : 0);
      if (role === "implementer") {
        f.loseResult = null;
        f.check = "failed";
        await f.tick();
        expect(f.calls).toHaveLength(4);
        expect(f.calls.at(-1)?.sessionId).toBeUndefined();
      }
    },
  );

  it("holds outcome recovery without quiescence and rejects attestation against a running process", async () => {
    const f = fixture();
    f.loseResult = "reviewer";
    await f.tick();
    await f.tick();
    const executionId = f.calls[0]!.id;
    const pr = f.store.prWorkflows();
    const recovery = {
      kind: "recover_outcome" as const,
      executionId,
      publication: f.lostPublication,
      reason: "Inspected the native turn through its supported interface.",
    };
    pr.operate(id, { ...recovery, attestQuiescent: false });
    pr.operate(id, { kind: "resume", reason: "Test quiescence without Rex process evidence." });
    await f.tick();
    expect(f.attention?.reason).toMatch(/quiescence/);
    pr.operate(id, { ...recovery, attestQuiescent: true });
    pr.operate(id, { kind: "resume", reason: "Check the operator attestation." });
    f.rexProcess = "running";
    await f.tick();
    expect(f.attention?.reason).toMatch(/quiescence/);
    expect(f.calls).toHaveLength(1);
    expect(f.assignments[0]).toMatchObject({ claim: null, proof: null });

    f.rexProcess = "unavailable";
    pr.operate(id, { kind: "resume", reason: "Recheck after the running observation." });
    await f.tick();
    expect(f.workflow?.state).toBe("escalated");
    expect(f.assignments[0]?.proof).toBeNull();
    pr.operate(id, { ...recovery, attestQuiescent: true });
    pr.operate(id, {
      kind: "resume",
      reason: "Confirmed the turn has stopped by native inspection.",
    });
    await f.tick();
    expect(f.workflow?.state).toBe("ready");
    expect(f.calls).toHaveLength(1);
    expect(
      pr.events(id).findLast((event) => event.kind === "recover_outcome")?.recovery,
    ).toMatchObject({ confirmedBy: { operatorAttested: true } });
  });

  it("commits a recovered outcome once when another pass corroborates the same publication", async () => {
    const f = fixture();
    f.loseResult = "reviewer";
    f.rexProcess = "exited";
    await f.tick();
    await f.tick();
    const executionId = f.calls[0]!.id;
    const pr = f.store.prWorkflows();
    pr.operate(id, {
      kind: "recover_outcome",
      executionId,
      publication: f.lostPublication,
      attestQuiescent: false,
      reason: "The correlated Rex block exited.",
    });
    pr.operate(id, { kind: "resume", reason: "Corroborate the review." });
    const reading = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.beforeReadComments = () => {
      f.beforeReadComments = undefined;
      reading.resolve();
      return release.promise;
    };
    const first = f.tick();
    await reading.promise;
    try {
      await f.coordinate();
      expect(f.workflow?.state).toBe("ready");
    } finally {
      release.resolve();
      await first;
    }
    await f.tick();
    expect(f.store.reviews().list(id)).toHaveLength(1);
    expect(f.calls).toHaveLength(1);
    expect(f.allowance.reviews.reservedOrUsed).toBe(1);
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

  it("rechecks GitHub eligibility after staging and does not authorize a stale launch", async () => {
    const f = fixture();
    f.beforeDispatch = () => {
      f.snapshot.state = "closed";
      f.move(1);
    };
    await expect(f.tick()).rejects.toThrow("head changed");
    expect(f.store.agentExecutions().get(f.calls[0]!.id)).toMatchObject({
      status: "not_started",
      remote: { launchAuthorized: false },
    });
    expect(f.workflow).toMatchObject({
      state: "stopped",
      githubStatus: "closed",
      headSha: heads[1],
    });
  });

  it("reconciles an outstanding Rex attempt on a closed PR before authorizing another PR", async () => {
    const f = fixture();
    const otherId = "cellgraph/fixture#6";
    const closed = {
      id: otherId,
      identity: { repository: target.repository, pullRequest: 6 },
      headSha: heads[0]!,
      state: "awaiting_review",
      githubStatus: "eligible",
      requiredChecks: ["quality"],
      checks: [],
      escalationReason: null,
    } as const;
    f.store.createWorkflow({ ...closed, checks: [], requiredChecks: ["quality"] });
    const other = f.store
      .prWorkflows()
      .reserve(
        { workflow: f.store.getWorkflow(otherId)!, version: 0 },
        { role: "reviewer", previousFindingIds: [] },
        "reviewer",
        config.reviewer.producerId,
      )!;
    const agent = f.store.agentExecutions();
    agent.claim({ id: other.executionId, assignmentId: other.id, ...config.reviewer.agent });
    expect(agent.authorizeRemoteDispatch(other.executionId)).toBe(true);
    f.store.transition(otherId, { type: "github_pull_request", status: "closed", sha: heads[0]! });
    f.restart();
    f.beforeInspect = (executionId) => {
      if (executionId !== other.executionId) return;
      f.store.agentExecutions().recordRemote(executionId, {
        blockId: "block:22222222-2222-2222-2222-222222222222",
        nativeId: "previous-native",
        digest: "fixture-result",
        outcome: { outcome: "completed" },
      });
    };
    await f.tick();
    expect(f.recoveries).toContain(other.executionId);
    expect(f.roles).toEqual(["reviewer"]);
    expect(f.store.getWorkflow(otherId)?.githubStatus).toBe("closed");
  });

  it.each(["abandoned continuation", "changed Rex executable"])(
    "starts a fresh Implementer session after %s",
    async (cause) => {
      const f = fixture();
      f.check = "failed";
      await f.tick();
      await f.tick();
      f.check = "failed";
      await f.tick();
      if (cause === "abandoned continuation") {
        f.unavailable = "failed";
        await f.tick();
        const failed = f.calls.at(-1)!;
        expect(failed.sessionId).toBeDefined();
        await f.tick();
        f.store.prWorkflows().operate(id, {
          kind: "abandon",
          executionId: failed.id,
          reason: "The previous native session was removed.",
        });
        f.store
          .prWorkflows()
          .operate(id, { kind: "resume", reason: "Start a fresh native session." });
        f.unavailable = null;
      } else {
        f.configured.implementer.agent.rex!.executable = "/opt/new-rex";
      }
      await f.tick();
      const next = f.calls.at(-1)!;
      expect(next.sessionId).toBeUndefined();
      expect(next.rex?.executable).toBe(f.configured.implementer.agent.rex!.executable);
    },
  );

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
