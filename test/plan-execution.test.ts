import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import type { createAgentController } from "../src/agent-controller.ts";
import type { AgentResult } from "../src/agent.ts";
import { loadApproval, parseIncrements } from "../src/approved-plan.ts";
import type { PrWorkflowConfig } from "../src/config.ts";
import { createController } from "../src/controller.ts";
import { createGitHubReader, type PlanPullRequest } from "../src/github-api.ts";
import { runPlanCommand } from "../src/plan-command.ts";
import { createPlanCoordinator, planBlockingExecutions } from "../src/plan-execution.ts";
import type { PlanAssignment } from "../src/plan-store.ts";
import { createPrCoordinator } from "../src/pr-workflow.ts";
import { createReconciler } from "../src/reconcile.ts";
import type { createRexExecution } from "../src/rex-execution.ts";
import { WorkflowStore } from "../src/store.ts";

const target = { repository: "cellgraph/fixture", installationId: 42 };
const path = "docs/plans/004-fixture.md";
const revision = "a".repeat(40);
const head = "b".repeat(40);
const mergeSha = "c".repeat(40);
const secondHead = "d".repeat(40);
const blockId = "block:22222222-2222-2222-2222-222222222222";
const markdown = [
  "# Approved fixture",
  "## Increments",
  "### 1. Add the fixture",
  "First scoped change.",
  "### 2. Validate the fixture",
  "Second scoped change.",
  "## Unapproved appendix",
  "Unscoped text.",
].join("\n");
const bytes = Buffer.from(markdown);
const blobSha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const config = {
  reviewer: configuredRole("reviewer", 11),
  adjudicator: configuredRole("adjudicator", 12),
  implementer: configuredRole("implementer", 13),
} satisfies PrWorkflowConfig;

function configuredRole(agentName: string, producerId: number) {
  return {
    producerId,
    agent: {
      agentName,
      context: { provider: "codex" as const, workingDirectory: "/fixture" },
      rex: {
        endpoint: "ssh://test@agent.test/run/rex.sock",
        executable: "/opt/rex",
        executor: "/fixture/src/remote-executor.ts",
        node: "/opt/node",
        stateDirectory: "/tmp/agent",
        session: "session:11111111-1111-1111-1111-111111111111",
      },
    },
  };
}

type Execute = ReturnType<typeof createAgentController>["execute"];
type Result = Extract<AgentResult, { outcome: "completed" }>;
const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  cleanups.splice(0).forEach((cleanup) => cleanup());
});

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "switchyard-plan-"));
  const dbPath = join(directory, "phase-e.sqlite");
  let store = new WorkflowStore(dbPath);
  cleanups.push(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const pulls = new Map<number, PlanPullRequest>();
  const mergeEvidence = new Map<number, Record<string, unknown>>();
  const planReader = createGitHubReader({
    completeReconciliation() {},
    async get({ repository }, _suffix, pullRequest) {
      const pull = pulls.get(pullRequest!)!;
      return {
        data: {
          number: pullRequest,
          state: pull.state,
          draft: pull.draft,
          merged: pull.merged,
          head: { sha: pull.headSha, ref: pull.headRef, repo: { full_name: pull.headRepository } },
          base: { ref: pull.baseRef, repo: { full_name: repository } },
          user: { id: pull.authorId },
          created_at: pull.createdAt,
          merged_at: pull.merge?.mergedAt,
          merged_by: { id: pull.merge?.mergedBy },
        },
        hasNext: false,
      };
    },
    async readPlanMerge({ repository, pullRequest }) {
      return {
        repository: { nameWithOwner: repository, pullRequest: mergeEvidence.get(pullRequest) },
      };
    },
  });
  const reviews = new Map<number, Record<string, unknown>[]>();
  const outputs = new Map<string, Result>();
  const calls: Array<Parameters<Execute>[0]> = [];
  const errors: string[] = [];
  const blockedSignatures = new Set<string>();
  const failedChecks = new Set<string>();
  const parents = new Map<string, string>();
  let processState: "running" | "exited" | "unavailable" = "running";
  let interruptBeforeClaim = false;
  let beforeLaunch: (() => void) | undefined;
  let clock = Date.now() + 1000;
  const timestamp = () => new Date(clock).toISOString();
  const github = {
    readPlanFile: vi.fn(async () => ({ bytes, blobSha })),
    readDefaultBranch: async () => "main",
    completeReconciliation() {},
    async listBranchPullRequests(_: unknown, branch: string) {
      return [...pulls].filter(([, pull]) => pull.headRef === branch).map(([number]) => number);
    },
    async listOpenPullRequests() {
      return [...pulls].filter(([, pull]) => pull.state === "open").map(([number]) => number);
    },
    readPlanPullRequest: planReader.readPlanPullRequest,
    async readPullRequest({ pullRequest }: { pullRequest: number }) {
      return structuredClone(pulls.get(pullRequest)!);
    },
    async readChecks(_: unknown, sha: string) {
      return [
        {
          name: "quality",
          sha,
          outcome: failedChecks.has(sha) ? ("failed" as const) : ("passed" as const),
        },
      ];
    },
    async readReviews({ pullRequest }: { pullRequest: number }) {
      return reviews.get(pullRequest) ?? [];
    },
    async readReviewComments() {
      return [];
    },
    async readIssue() {},
    async readComparison(_: unknown, base: string) {
      return { status: "ahead", base_commit: { sha: base }, merge_base_commit: { sha: base } };
    },
    async readCommit(_: unknown, sha: string) {
      return {
        sha,
        parents: parents.has(sha) ? [{ sha: parents.get(sha) }] : [],
        committer: { id: config.implementer.producerId },
        commit: { verification: { verified: !blockedSignatures.has(sha) } },
      };
    },
  };

  const approved = await loadApproval(github, target, path, revision);
  const { id } = store.plans().approve(approved);
  const read = () => store.plans().get(id)!;
  const assignment = (increment = 1) => read().increments[increment - 1]!.assignments.at(-1)!;
  const latestId = (selected: PlanAssignment) => selected.executionIds.at(-1)!;

  function finish(executionId: string, structuredOutput: unknown) {
    const agent = store.agentExecutions();
    const execution = agent.get(executionId)!;
    const result = {
      outcome: "completed",
      response: "Fixture transcript",
      structuredOutput,
    } as const;
    outputs.set(executionId, result);
    agent.recordRemote(executionId, {
      outcome: result,
      digest: "fixture-result",
      blockId,
      nativeId: `native-${execution.sessionId}`,
    });
    return result;
  }

  function openPull(selected: PlanAssignment, pullRequest: number, sha: string) {
    pulls.set(pullRequest, {
      headSha: sha,
      state: "open",
      draft: false,
      merged: false,
      headRepository: target.repository,
      headRef: selected.branch,
      baseRef: "main",
      authorId: config.implementer.producerId,
      createdAt: timestamp(),
      merge: null,
    });
  }

  function publish(increment: number, pullRequest: number, sha: string) {
    const selected = assignment(increment);
    openPull(selected, pullRequest, sha);
    finish(latestId(selected), {
      outcome: "published",
      planRevision: revision,
      increment,
      assignmentId: selected.id,
      pullRequest,
      headSha: sha,
      reason: null,
    });
  }

  function merge(pullRequest: number) {
    const pull = pulls.get(pullRequest)!;
    pull.state = "closed";
    pull.merged = true;
    pull.merge = { mergeSha, mergedBy: 71, mergedAt: timestamp() };
    mergeEvidence.set(pullRequest, {
      number: pullRequest,
      merged: true,
      headRefOid: pull.headSha,
      mergedAt: pull.merge.mergedAt,
      mergeCommit: { oid: mergeSha },
    });
  }

  const execute: Execute = async (request) => {
    calls.push(request);
    if (interruptBeforeClaim) throw new Error("Interrupted after reservation.");
    const agent = store.agentExecutions();
    const claim = agent.claim(request);
    if (!claim.claimed) return { execution: claim.execution, session: claim.session };
    const fence = beforeLaunch;
    beforeLaunch = undefined;
    fence?.();
    const launched =
      (await request.confirmLaunch?.()) &&
      agent.authorizeRemoteDispatch(request.id, request.mayLaunch);
    if (!launched) {
      agent.recordRemote(request.id, {
        outcome: { outcome: "not_started", reason: "Launch was fenced." },
      });
      return { execution: agent.get(request.id)!, session: claim.session };
    }
    for (const [pullRequest, pull] of pulls) {
      const workflowId = `${target.repository}#${pullRequest}`;
      const phaseD = store
        .prWorkflows()
        .list(workflowId)
        .find(({ id }) => id === request.assignmentId);
      if (!phaseD) continue;
      if (phaseD.input.role === "implementer") {
        parents.set(secondHead, pull.headSha);
        pull.headSha = secondHead;
        const result = finish(request.id, {
          headSha: phaseD.headSha,
          publishedHeadSha: secondHead,
        });
        return {
          execution: agent.get(request.id)!,
          session: agent.session(claim.session.id)!,
          result,
        };
      }
      expect(phaseD.input.role).toBe("reviewer");
      const previousReviews = reviews.get(pullRequest) ?? [];
      const reviewId = 100 + calls.length;
      reviews.set(pullRequest, [
        ...previousReviews,
        {
          id: reviewId,
          commit_id: pull.headSha,
          state: "COMMENTED",
          user: { id: config.reviewer.producerId },
          body: "Review outcome: clean\nValidated.",
          submitted_at: timestamp(),
        },
      ]);
      const result = finish(request.id, {
        headSha: pull.headSha,
        reviewId,
        outcome: "clean",
        findingIds: [],
        resolvedFindingIds: [],
      });
      return {
        execution: agent.get(request.id)!,
        session: agent.session(claim.session.id)!,
        result,
      };
    }
    return { execution: agent.get(request.id)!, session: claim.session };
  };

  const inspect: ReturnType<typeof createRexExecution>["inspect"] = async (id) => {
    const agent = store.agentExecutions();
    const execution = agent.get(id)!;
    const result = outputs.get(id);
    return {
      execution,
      session: agent.session(execution.sessionId)!,
      observation: {
        evidence: result ? "valid" : "unavailable",
        process:
          processState === "exited" ? { state: "exited", exitCode: 1 } : { state: processState },
      },
      ...(result ? { result } : {}),
    };
  };

  function build() {
    const reconcile = createReconciler(store, github, () => ["quality"]);
    const plans = createPlanCoordinator({ store, github, execute, inspect, now: () => clock });
    const pr = createPrCoordinator({
      store,
      github,
      reconcile,
      execute,
      inspect,
      now: () => clock,
      otherExecutions: () => planBlockingExecutions(store),
    });
    return createController({
      store,
      github,
      reconcile,
      repositories: [target],
      reportError: (message) => errors.push(message),
      coordinate: async (pull) => pr(pull, config, undefined, await plans.pullGate(pull)),
      coordinatePlans: () => plans.coordinate(target, config),
    });
  }

  let controller = build();
  const sweep = () => {
    controller.scheduleSweep();
    return controller.runPass();
  };
  const operate = (action: Parameters<ReturnType<WorkflowStore["plans"]>["operate"]>[1]) =>
    store.plans().operate(id, action);
  return {
    dbPath,
    read,
    assignment,
    latestId,
    openPull,
    publish,
    merge,
    mergeEvidence,
    pulls,
    calls,
    errors,
    sweep,
    reconcilePull(pullRequest: number) {
      controller.notify({ ...target, pullRequest });
      return controller.runPass();
    },
    approved,
    github,
    operate,
    finish,
    blockedSignatures,
    failedChecks,
    get store() {
      return store;
    },
    setProcess(state: typeof processState) {
      processState = state;
    },
    disconnect() {
      interruptBeforeClaim = true;
    },
    fence(run: () => void) {
      beforeLaunch = run;
    },
    advance(ms: number) {
      clock += ms;
    },
    restart() {
      store.close();
      store = new WorkflowStore(dbPath);
      interruptBeforeClaim = false;
      controller = build();
    },
  };
}

it("pins approval to the GitHub commit and blob and snapshots only ordered increment scope", async () => {
  const get = vi.fn(async (_: unknown, request: string) => {
    if (request === `/git/commits/${revision}`) return { data: { sha: revision }, hasNext: false };
    if (request === `/contents/${path}?ref=${revision}`)
      return {
        data: {
          type: "file",
          path,
          encoding: "base64",
          size: bytes.length,
          content: bytes.toString("base64"),
          sha: blobSha,
        },
        hasNext: false,
      };
    if (request.startsWith("/pulls?state=all&head=cellgraph%3Afeat%2Ffixture"))
      return {
        data: [{ number: request.endsWith("page=1") ? 8 : 9 }],
        hasNext: request.endsWith("page=1"),
      };
    return { data: { full_name: "cellgraph/fixture", default_branch: "main" }, hasNext: false };
  });
  const github = createGitHubReader({ get, readPlanMerge: vi.fn(), completeReconciliation() {} });
  await expect(loadApproval(github, target, path, "main")).rejects.toThrow("full 40-character");
  expect(get).not.toHaveBeenCalled();
  const approved = await loadApproval(github, target, path, revision);
  expect(get.mock.calls.map((call) => call[1])).toEqual([
    `/git/commits/${revision}`,
    `/contents/${path}?ref=${revision}`,
    "",
  ]);
  expect(approved).toMatchObject({ revision, blobSha, baseBranch: "main" });
  expect(approved.increments.map(({ scope }) => scope)).toEqual([
    "First scoped change.",
    "Second scoped change.",
  ]);
  await expect(github.listBranchPullRequests(target, "feat/fixture")).resolves.toEqual([8, 9]);
  await expect(
    loadApproval(
      { ...github, readPlanFile: async () => ({ bytes, blobSha: head }) },
      target,
      path,
      revision,
    ),
  ).rejects.toThrow("blob identity");
  expect(() => parseIncrements(markdown.replace("### 2.", "### 3."))).toThrow("consecutive");
  expect(parseIncrements("## Increments\n### 1. Fixture\n~~~md\n### 2. Example\n~~~")).toHaveLength(
    1,
  );
});

it("runs two increments in order through the real Phase D coordinator and waits for exact-head human merges", async () => {
  const f = await fixture();
  await f.sweep();
  const first = f.assignment();
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]!.prompt).toContain("First scoped change.");
  expect(f.calls[0]!.prompt).not.toContain("Second scoped change.");
  expect(f.calls[0]!.prompt).not.toContain("Unscoped text.");
  await f.sweep();
  expect(f.calls).toHaveLength(1);
  f.publish(1, 5, head);
  f.restart();
  await f.sweep();
  expect(f.calls).toHaveLength(1);
  expect(f.read().increments[0]!.publication).toEqual({
    pullRequest: 5,
    headSha: head,
    source: "native",
  });
  await f.sweep();
  await f.sweep();
  expect(f.store.findWorkflow(target.repository, 5)).toMatchObject({
    state: "ready",
    headSha: head,
  });
  expect(f.calls[1]!.prompt).toContain("First scoped change.");
  expect(f.store.prWorkflows().allowances(`${target.repository}#5`)).toEqual({
    reviews: { reservedOrUsed: 1, authorized: 3 },
    revisions: { reservedOrUsed: 0, authorized: 3 },
  });
  const out = vi.spyOn(console, "info").mockImplementation(() => {});
  const reader = () => {
    throw new Error("Inspection should use the local database.");
  };
  await runPlanCommand(["plan", "attention"], f.dbPath, reader);
  expect(JSON.parse(String(out.mock.lastCall![0]))).toEqual([
    expect.objectContaining({
      increment: 1,
      pullRequest: 5,
      attention: expect.objectContaining({ headSha: head }),
    }),
  ]);
  await f.sweep();
  expect(f.calls).toHaveLength(2);
  f.merge(5);
  const evidence = f.mergeEvidence.get(5)!;
  f.mergeEvidence.set(5, { ...evidence, headRefOid: secondHead });
  expect(await f.sweep()).toBe(false);
  expect(f.read().increments[0]!.merge).toBeNull();
  expect(f.read().increments[1]!.assignments).toEqual([]);
  expect(f.calls).toHaveLength(2);
  expect(f.errors.splice(0)).toEqual([
    `${target.repository}#5: GitHub did not identify the PR merge.`,
    `${target.repository}: GitHub did not identify the PR merge.`,
  ]);
  f.mergeEvidence.set(5, evidence);
  f.restart();
  await f.sweep();
  expect(f.read().increments[0]!.merge).toMatchObject({ headSha: head, mergeSha, mergedBy: 71 });
  expect(f.calls[2]!.prompt).toContain(mergeSha);
  expect(f.calls[2]!.prompt).toContain("Second scoped change.");
  expect(f.calls[2]!.prompt).not.toContain("First scoped change.");
  f.publish(2, 6, secondHead);
  await f.sweep();
  await f.sweep();
  await f.sweep();
  f.merge(6);
  await f.sweep();
  expect(f.read()).toMatchObject({ state: "completed", revision, blobSha });
  expect(f.read().history.map(({ kind }) => kind)).toEqual([
    "approved",
    "assigned",
    "associated",
    "merged",
    "assigned",
    "associated",
    "merged",
    "completed",
  ]);
  expect(f.read().increments[0]!.assignments[0]!.id).toBe(first.id);
  expect(f.store.agentExecutions().forAssignment(first.id)).toHaveLength(1);
  expect(f.calls).toHaveLength(4);
  expect(f.errors).toEqual([]);
});

it("recovers an unclaimed reservation on restart and fences a stop issued before launch", async () => {
  const f = await fixture();
  f.disconnect();
  expect(await f.sweep()).toBe(false);
  const reserved = f.assignment();
  expect(f.store.agentExecutions().forAssignment(reserved.id)).toHaveLength(0);
  f.restart();
  f.fence(() => f.operate({ kind: "stop", reason: "Pause before launch." }));
  await f.sweep();
  expect(f.read().state).toBe("stopped");
  expect(f.store.agentExecutions().get(f.latestId(reserved))).toMatchObject({
    status: "not_started",
  });
  f.restart();
  await f.sweep();
  expect(f.calls.map(({ id }) => id)).toEqual([f.latestId(reserved), f.latestId(reserved)]);
  f.operate({ kind: "resume", reason: "Proceed with the approved scope." });
  f.advance(180_000);
  await f.sweep();
  const current = f.assignment();
  expect(current.id).toBe(reserved.id);
  expect(current.executionIds).toHaveLength(2);
  expect(
    f.store
      .agentExecutions()
      .forAssignment(current.id)
      .map(({ status }) => status),
  ).toEqual(["not_started", "running"]);
  await f.sweep();
  expect(f.calls).toHaveLength(3);
});

it("stops associated PR dispatch and resumes into a Phase D revision using the original session", async () => {
  const f = await fixture();
  await f.sweep();
  f.failedChecks.add(head);
  f.publish(1, 5, head);
  await f.sweep();
  f.operate({ kind: "stop", reason: "Pause the associated PR." });
  await f.sweep();
  expect(f.calls).toHaveLength(1);
  f.operate({ kind: "resume", reason: "Start independent review." });
  await f.sweep();
  await f.sweep();
  expect(f.calls).toHaveLength(3);
  const original = f.store.agentExecutions().get(f.latestId(f.assignment()))!;
  expect(f.calls[2]).toMatchObject({ sessionId: original.sessionId });
  expect(f.calls[2]!.prompt).toContain("First scoped change.");
  await f.sweep();
  await f.sweep();
  await f.sweep();
  const workflow = f.store.findWorkflow(target.repository, 5)!;
  expect(workflow).toMatchObject({ state: "ready", headSha: secondHead });
  expect(f.store.prWorkflows().allowances(workflow.id).revisions.reservedOrUsed).toBe(1);
  expect(f.errors).toEqual([]);
});

it("holds unknown execution until an operator points to a verified PR and Rex confirms exit", async () => {
  const f = await fixture();
  await f.sweep();
  const selected = f.assignment();
  f.openPull(selected, 5, head);
  const id = f.latestId(selected);
  f.store.agentExecutions().recordRemote(id, {
    blockId,
    outcome: { outcome: "unknown", reason: "Missing native result." },
  });
  f.setProcess("unavailable");
  f.restart();
  await f.sweep();
  expect(f.read().attention?.reason).toContain("uncertain outcome");
  f.operate({ kind: "retry", assignmentId: selected.id, reason: "Try again." });
  f.operate({ kind: "resume", reason: "Reconcile before retrying." });
  await f.sweep();
  expect(f.calls).toHaveLength(1);
  f.operate({
    kind: "associate",
    assignmentId: selected.id,
    pullRequest: 5,
    headSha: head,
    reason: "Observed the signed publication.",
  });
  f.operate({ kind: "resume", reason: "Verify the association." });
  await f.sweep();
  expect(f.read().state).toBe("attention");
  f.setProcess("exited");
  f.operate({ kind: "resume", reason: "The correlated Rex block has exited." });
  await f.sweep();
  expect(f.read().increments[0]!.publication?.source).toBe("operator");
  expect(f.store.agentExecutions().get(id)?.status).toBe("unknown");
  expect(f.calls).toHaveLength(1);
});

it("holds multiple candidates and invalid evidence, then honors an explicit verified selection", async () => {
  const f = await fixture();
  await f.sweep();
  f.publish(1, 5, head);
  f.pulls.get(5)!.baseRef = "other";
  f.openPull(f.assignment(), 6, secondHead);
  await f.sweep();
  expect(f.read().attention?.reason).toContain("conflicting pull requests");
  expect(f.store.prWorkflows().list(`${target.repository}#5`)).toEqual([]);
  f.operate({
    kind: "associate",
    assignmentId: f.assignment().id,
    pullRequest: 6,
    headSha: secondHead,
    reason: "PR 6 is the reviewed implementation publication.",
  });
  const readCommit = vi.spyOn(f.github, "readCommit");
  f.blockedSignatures.add(secondHead);
  f.operate({ kind: "resume", reason: "Verify PR 6." });
  await f.sweep();
  expect(f.read().attention?.reason).toContain("lacks verified publication");
  expect(readCommit).toHaveBeenCalledWith(
    { ...target, pullRequest: 6 },
    secondHead,
    undefined,
    "repository",
  );
  expect(f.read().increments[0]!.publication).toBeNull();
  f.blockedSignatures.delete(secondHead);
  f.operate({ kind: "resume", reason: "Signature verified by GitHub." });
  await f.sweep();
  await f.sweep();
  expect(f.read().increments[0]!.publication).toMatchObject({ pullRequest: 6, source: "operator" });
  expect(f.assignment().claim).toMatchObject({ pullRequest: 5, headSha: head });
  expect(f.store.prWorkflows().list(`${target.repository}#5`)).toEqual([]);

  await f.sweep();
  expect(f.store.findWorkflow(target.repository, 6)?.state).toBe("ready");
  f.merge(6);
  await f.sweep();
  expect(f.read().increments[0]!.merge?.headSha).toBe(secondHead);
  await f.reconcilePull(5);
  expect(f.store.findWorkflow(target.repository, 5)).toMatchObject({
    githubStatus: "eligible",
    state: "awaiting_review",
  });
  expect(f.store.prWorkflows().list(`${target.repository}#5`)).toEqual([]);
});

it.each([false, true])(
  "rechecks the reserved branch on retry when candidate reappears: %s",
  async (reappears) => {
    const f = await fixture();
    await f.sweep();
    const first = f.assignment();
    f.publish(1, 5, head);
    f.pulls.delete(5);
    f.advance(180_000);
    await f.sweep();
    expect(f.read().attention?.reason).toContain("The reported PR is missing");

    f.operate({ kind: "retry", assignmentId: first.id, reason: "Authorize replacement." });
    f.operate({ kind: "resume", reason: "Recheck GitHub before replacing the assignment." });
    if (reappears) f.openPull(first, 5, head);
    await f.sweep();

    const increment = f.read().increments[0]!;
    expect(increment.assignments).toHaveLength(reappears ? 1 : 2);
    expect(increment.assignments[0]!.claim).toMatchObject({ outcome: "published", pullRequest: 5 });
    if (reappears)
      expect(increment.publication).toMatchObject({ pullRequest: 5, source: "native" });
    else expect(increment.publication).toBeNull();
  },
);

it.each([false, true])(
  "holds a late PR from a superseded assignment when replacement is already associated: %s",
  async (associated) => {
    const f = await fixture();
    await f.sweep();
    const first = f.assignment();
    f.publish(1, 5, head);
    f.pulls.delete(5);
    f.advance(180_000);
    await f.sweep();
    f.operate({ kind: "retry", assignmentId: first.id, reason: "Authorize replacement." });
    f.operate({ kind: "resume", reason: "Proceed with the replacement." });
    await f.sweep();
    f.publish(1, 6, secondHead);
    if (associated) {
      await f.sweep();
      await f.sweep();
      await f.sweep();
      expect(f.store.findWorkflow(target.repository, 6)?.state).toBe("ready");
      f.merge(6);
    }

    f.openPull(first, 5, head);
    f.restart();
    await f.sweep();
    expect(f.read()).toMatchObject({
      state: "attention",
      attention: {
        reason: expect.stringContaining("superseded Implementer assignment"),
        references: expect.arrayContaining([`https://github.com/${target.repository}/pull/5`]),
      },
    });
    expect(f.read().increments[0]!.publication?.pullRequest).toBe(associated ? 6 : undefined);
    expect(f.read().increments[0]!.merge).toBeNull();
    expect(f.read().increments[1]!.assignments).toEqual([]);

    f.pulls.get(5)!.state = "closed";
    f.operate({ kind: "resume", reason: "The superseded PR was closed without merging." });
    await f.sweep();
    expect(f.read().state).toBe("running");
    expect(f.read().increments[0]!.publication?.pullRequest).toBe(6);
    if (associated) {
      expect(f.read().increments[0]!.merge?.headSha).toBe(secondHead);
      f.publish(2, 7, head);
      await f.sweep();
      await f.sweep();
      await f.sweep();
      expect(f.store.findWorkflow(target.repository, 7)?.state).toBe("ready");
      f.merge(7);
      await f.sweep();
      expect(f.read().state).toBe("completed");

      f.pulls.get(5)!.state = "open";
      f.restart();
      const calls = f.calls.length;
      await f.reconcilePull(5);
      await f.sweep();
      expect(f.store.prWorkflows().list(`${target.repository}#5`)).toEqual([]);
      expect(f.store.findWorkflow(target.repository, 5)?.state).toBe("awaiting_review");
      expect(f.calls).toHaveLength(calls);
    }
  },
);

it("withdraws plan handoff on PR-only reconciliation when the base changes at the same head", async () => {
  const f = await fixture();
  await f.sweep();
  f.publish(1, 5, head);
  await f.sweep();
  await f.sweep();
  await f.sweep();
  const workflow = () => f.store.findWorkflow(target.repository, 5);
  expect(workflow()).toMatchObject({ state: "ready", headSha: head });

  f.pulls.get(5)!.baseRef = "other";
  await f.reconcilePull(5);
  expect(f.read().state).toBe("running");
  expect(workflow()).toMatchObject({
    state: "awaiting_review",
    githubStatus: "eligible",
    headSha: head,
  });
  const out = vi.spyOn(console, "info").mockImplementation(() => {});
  const reader = () => {
    throw new Error("Inspection should use the local database.");
  };
  await runPlanCommand(["plan", "attention"], f.dbPath, reader);
  expect(JSON.parse(String(out.mock.lastCall![0]))).toEqual([]);

  f.pulls.get(5)!.baseRef = "main";
  await f.reconcilePull(5);
  expect(workflow()).toMatchObject({ state: "ready", headSha: head });
  expect(f.calls).toHaveLength(2);
});

it("records consequential direction and requires a fresh grant for a terminal assignment", async () => {
  const f = await fixture();
  await f.sweep();
  const first = f.assignment();
  f.finish(f.latestId(first), {
    outcome: "decision_required",
    planRevision: revision,
    increment: 1,
    assignmentId: first.id,
    pullRequest: null,
    headSha: null,
    reason: "Choose the supported data format.",
  });
  await f.sweep();
  expect(f.read().attention?.reason).toContain("Choose the supported data format.");
  f.operate({ kind: "direction", reason: "Use the format specified in the approved design." });
  f.operate({ kind: "resume", reason: "Direction recorded." });
  await f.sweep();
  expect(f.calls).toHaveLength(1);
  f.operate({
    kind: "retry",
    assignmentId: first.id,
    reason: "Authorize a new initial assignment.",
  });
  f.operate({ kind: "resume", reason: "Proceed." });
  await f.sweep();
  expect(f.assignment().id).not.toBe(first.id);
  expect(f.calls[1]!.prompt).toContain("Use the format specified in the approved design.");
  expect(f.read().increments[0]!.assignments[0]!.claim).toMatchObject({
    outcome: "decision_required",
  });
});

it("holds a closed PR and a merge that bypassed Phase D handoff", async () => {
  const f = await fixture();
  await f.sweep();
  f.publish(1, 5, head);
  await f.sweep();
  f.pulls.get(5)!.state = "closed";
  await f.sweep();
  expect(f.read().attention?.reason).toContain("closed without merging");
  f.operate({ kind: "resume", reason: "Inspect updated GitHub state." });
  f.merge(5);
  await f.sweep();
  expect(f.read().attention?.reason).toContain("without a recorded Phase D handoff");
  expect(f.read().increments[1]!.assignments).toEqual([]);
});

it("keeps separate immutable approvals and preserves a stopped revision's history", async () => {
  const f = await fixture();
  const plans = f.store.plans();
  expect(plans.approve(f.approved).id).toBe(f.read().id);
  const next = {
    ...f.approved,
    revision: secondHead,
    increments: [{ number: 1, title: "Replacement", scope: "Changed scope." }],
  };
  expect(() => plans.approve(next)).toThrow("already has an active");
  await f.sweep();
  f.operate({ kind: "stop", reason: "Operator approved a replacement separately." });
  const replacement = plans.approve(next);
  expect(replacement.id).not.toBe(f.read().id);
  expect(() => f.operate({ kind: "resume", reason: "Check exclusivity." })).toThrow(
    "already has an active",
  );
  expect(f.read()).toMatchObject({ revision, state: "stopped" });
  expect(f.read().increments[0]!.scope).toBe("First scoped change.");
  expect(f.read().increments[0]!.assignments).toHaveLength(1);
});

it("adds plan tables to Phase D SQLite while preserving existing workflows", () => {
  const dir = mkdtempSync(join(tmpdir(), "switchyard-schema-"));
  const dbPath = join(dir, "schema.sqlite");
  try {
    const original = new WorkflowStore(dbPath);
    const id = `${target.repository}#1`;
    original.createWorkflow({
      id,
      identity: { repository: target.repository, pullRequest: 1 },
      headSha: head,
      state: "awaiting_review",
      requiredChecks: null,
      checks: [],
      escalationReason: null,
    });
    original.close();
    const raw = new DatabaseSync(dbPath);
    raw.exec("DROP TABLE plan_pull_requests; DROP TABLE plan_executions; PRAGMA user_version=22;");
    raw.close();
    const upgraded = new WorkflowStore(dbPath);
    try {
      expect(upgraded.getWorkflow(id)?.headSha).toBe(head);
      expect(upgraded.plans().list()).toEqual([]);
    } finally {
      upgraded.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
