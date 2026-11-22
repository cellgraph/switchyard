import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentAdapter } from "../src/agent.ts";
import { authorizeFix, createFixController } from "../src/fix-controller.ts";
import { createFixGit, runValidation } from "../src/fix-git.ts";
import { requiredChecksForCycle, type FixConfig, type FixCycle } from "../src/fix-store.ts";
import type { GitHubReader, PullRequestState } from "../src/github-api.ts";
import { GitHubTransientError } from "../src/github-app.ts";
import { createLocalAgentExecution } from "../src/local-agent-execution.ts";
import { createReconciler } from "../src/reconcile.ts";
import { WorkflowStore } from "../src/store.ts";
import { runUnattended, workerStatus } from "../src/unattended.ts";
import { createWorktreeManager } from "../src/worktree.ts";
import { agentRepository, git } from "./fixtures/agent-repository.ts";
import codexFixture from "./fixtures/codex-pr51.json" with { type: "json" };
import { finding, reviewStart, target, workflowId } from "./fixtures/review.ts";

describe("bounded single-PR fixes", () => {
  let fixture: ReturnType<typeof agentRepository>;
  let store: WorkflowStore;
  let worktrees: ReturnType<typeof createWorktreeManager>;
  let repository: ReturnType<typeof createFixGit>;
  let remote: string;
  let config: FixConfig;
  let reader: GitHubReader;
  let observedHead: string | undefined;
  let checkOutcome: "passed" | "failed" | null;
  let cleanReviewSha: string | undefined;
  let markForJudgment: boolean;
  let onTurn: (workingDirectory: string) => Promise<void>;
  let launches: number;
  let resumes: number;
  let session: AgentAdapter;

  const remoteHead = () => git(remote, "rev-parse", "refs/heads/feat/pr");
  const current = (db = store) => db.fixes(workflowId).read().at(-1)!;

  beforeEach(() => {
    fixture = agentRepository();
    store = new WorkflowStore(fixture.db);
    store.createWorkflow(fixture.workflow);
    remote = join(fixture.root, "remote.git");
    git(fixture.repo, "init", "--bare", remote);
    git(fixture.repo, "push", remote, "HEAD:refs/heads/feat/pr");
    git(fixture.repo, "config", "user.name", "Switchyard fixture");
    git(fixture.repo, "config", "user.email", "switchyard@example.invalid");
    config = {
      repositoryDirectory: fixture.repo,
      worktreeRoot: fixture.worktrees,
      codexHome: fixture.root,
      model: "fixture",
      localBranch: "fix/workflow",
      allowedPaths: ["tracked.txt", "test/"],
      requiredChecks: ["Quality checks"],
      validation: [
        {
          id: "verify",
          argv: [
            process.execPath,
            "-e",
            `if (!require("node:fs").readFileSync("tracked.txt", "utf8").includes("corrected")) process.exit(1)`,
          ],
        },
      ],
      maxCycles: 3,
      maxOperationAttempts: 2,
      maxValidationRetries: 1,
      agentTimeoutMs: 20_000,
      validationTimeoutMs: 10_000,
    };
    worktrees = createWorktreeManager(config);
    repository = createFixGit(worktrees, remote);
    observedHead = undefined;
    checkOutcome = null;
    cleanReviewSha = undefined;
    markForJudgment = false;
    launches = 0;
    resumes = 0;
    onTurn = async () => {};
    session = {
      startSession: ({ workingDirectory }) => ({
        reference: { id: "test-thread", provider: "codex" },
        async runTurn(turn) {
          launches++;
          expect(turn.prompt).toContain(finding.evidence);
          expect(turn.prompt).toContain("Operator reproduced the issue.");
          await onTurn(workingDirectory);
          turn.onEvent?.({
            provider: "codex",
            kind: "turn_completed",
            data: { usage: { input_tokens: 12, output_tokens: 5 } },
          });
          writeFileSync(join(workingDirectory, "tracked.txt"), `corrected ${launches}\n`);
          return {
            outcome: "completed",
            response: "",
            structuredOutput: {
              status: markForJudgment ? "needs_operator" : "addressed",
              addressedFindingIds: current().review.findings.map(({ id }) => id),
            },
          };
        },
      }),
      resumeSession(workspace) {
        resumes++;
        return this.startSession(workspace);
      },
    };
    reader = {
      completeReconciliation() {},
      async readPullRequest(): Promise<PullRequestState> {
        return {
          state: "open",
          headSha: observedHead ?? remoteHead(),
          headRef: "feat/pr",
          headRepository: "owner/repo",
          headDefaultBranch: "main",
        };
      },
      async readChecks(_target, sha) {
        return checkOutcome ? [{ name: "Quality checks", sha, outcome: checkOutcome }] : [];
      },
      async readReviewInputs() {
        const summary = codexFixture.issueComments[0]!;
        return {
          reviews: [],
          reviewComments: [],
          issueComments: cleanReviewSha
            ? [
                {
                  ...summary,
                  body: `<!-- codex-review-state:v1 ${JSON.stringify({
                    code_review: {
                      commit_sha: cleanReviewSha,
                      status: "completed",
                      has_any_findings: false,
                      has_unresolved_findings: false,
                    },
                  })} -->`,
                },
              ]
            : [],
        };
      },
    };
  });

  afterEach(() => {
    store.close();
    rmSync(fixture.root, { recursive: true, force: true });
  });

  function controller(
    db = store,
    gitBoundary = repository,
    refresh?: () => Promise<void>,
    configuredRequiredChecks = config.requiredChecks,
    options?: Partial<
      Pick<Parameters<typeof createFixController>[0], "drainSignal" | "report" | "validate">
    >,
  ) {
    const reconcile = createReconciler(db, reader, () =>
      requiredChecksForCycle(current(db), configuredRequiredChecks),
    );
    return createFixController({
      store: db,
      workflowId,
      config,
      configuredRequiredChecks,
      git: gitBoundary,
      readPullRequest: () => reader.readPullRequest(target),
      refresh: refresh ?? (() => reconcile(target)),
      validate: runValidation,
      worker: {
        configurationId: "fixture",
        runtime: () => ({
          provider: "codex",
          model: "fixture",
          sdkVersion: "fixture",
          cliVersion: "fixture",
          home: fixture.root,
          configuration: "test",
        }),
        execute: createLocalAgentExecution(worktrees, session, () => ({
          identity: "session",
          digest: "checkpoint",
        })).execute,
      },
      ...options,
    });
  }

  function review(id = "review-1", decision?: "accepted" | "rejected") {
    const headSha = store.getWorkflow(workflowId)!.headSha;
    store.reviews().start({ ...reviewStart, id, headSha });
    store.reviews().finish(id, {
      headSha,
      status: "completed",
      evidence: "The reviewer confirmed the issue.",
      findings: [{ ...finding, path: "tracked.txt" }],
    });
    const saved = store
      .reviews()
      .inspect(workflowId)
      .runs.find((run) => run.id === id)!.findings[0]!;
    if (decision) act(saved.id, headSha, decision, id);
    return saved.id;
  }

  function act(
    findingId: string,
    headSha: string,
    action: string,
    suffix: string,
    previousActionId?: string,
  ) {
    return store.reviews().act({
      id: `decision-${suffix}`,
      findingId,
      headSha,
      action,
      actor: "operator",
      rationale: "Operator reproduced the issue.",
      previousActionId,
    });
  }

  async function authorize() {
    const result = await controller().advance();
    expect(result.cycles.at(-1)?.phase).toBe("proposed");
    authorizeFix(store, workflowId, current().id, false);
  }

  async function validate() {
    review("review-1", "accepted");
    await authorize();
    await controller().advance();
    expect(current().phase).toBe("validated");
  }

  async function publish(gitBoundary = repository) {
    authorizeFix(store, workflowId, current().id, true);
    await controller(store, gitBoundary).advance();
  }

  function restart() {
    store.close();
    store = new WorkflowStore(fixture.db);
    store.recover();
  }

  it("waits for both operator approvals and drains claimed operations without replay across worker runs", async () => {
    const push = vi.fn(repository.push.bind(repository));
    const gitBoundary = { ...repository, push };
    const logs = vi.fn();
    async function poll(stop = new AbortController()) {
      await runUnattended({
        store,
        config: {
          targets: [target],
          fixes: new Map([[workflowId, config]]),
          reconcileIntervalMs: 1_000,
        },
        reader,
        signal: stop.signal,
        log: logs,
        wait: async () => stop.abort(),
        advance: (db, _id, _target, _configured, _reader, refresh, options) =>
          controller(db, gitBoundary, refresh, config.requiredChecks, options).advanceReconciled(),
      });
    }

    const findingId = review();
    await poll();
    expect(workerStatus(store)).toMatchObject({
      pullRequests: [{ attention: "finding_disposition" }],
    });
    expect(launches).toBe(0);
    act(findingId, fixture.workflow.headSha, "accepted", "worker");
    await poll();
    expect(workerStatus(store)).toMatchObject({
      pullRequests: [{ attention: "fix_authorization" }],
    });
    await poll();
    expect(launches).toBe(0);

    const stopAgent = new AbortController();
    onTurn = async () => stopAgent.abort();
    authorizeFix(store, workflowId, current().id, false);
    await poll(stopAgent);
    expect(current()).toMatchObject({ phase: "agent", validation: [], owner: null });
    expect(launches).toBe(1);

    restart();
    await poll();
    expect(workerStatus(store)).toMatchObject({
      pullRequests: [{ attention: "publication_authorization" }],
    });
    await poll();
    expect(push).not.toHaveBeenCalled();
    expect(launches).toBe(1);

    const stopPush = new AbortController();
    push.mockImplementationOnce((cycle, claim) =>
      repository.push(cycle, () => {
        claim();
        stopPush.abort();
      }),
    );
    authorizeFix(store, workflowId, current().id, true);
    await poll(stopPush);
    expect(current()).toMatchObject({ phase: "confirming", push: "returned" });
    expect(remoteHead()).toBe(current().commit);

    restart();
    await poll();
    expect(current()).toMatchObject({ phase: "finished", push: "confirmed" });
    expect(push).toHaveBeenCalledTimes(1);
    expect(launches).toBe(1);
    expect(store.getWorkflow(workflowId)).toMatchObject({ state: "awaiting_review", review: null });
    expect(logs).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "fix_operation",
        operation: "validation",
        outcome: "passed",
        commandId: "verify",
      }),
    );
  });

  it("reconciles an attached commit after a transient GitHub error before any push intent", async () => {
    await validate();
    const push = vi.fn(repository.push.bind(repository));
    const gitBoundary = { ...repository, push };
    const reconciliation = createReconciler(store, reader);
    const refresh = vi.fn(() => reconciliation(target));
    refresh.mockRejectedValueOnce(new GitHubTransientError("Temporary failure."));
    authorizeFix(store, workflowId, current().id, true);
    await expect(controller(store, gitBoundary, refresh).advanceReconciled()).rejects.toThrow(
      /Temporary/,
    );
    expect(current()).toMatchObject({
      phase: "committing",
      owner: null,
      commit: expect.any(String),
    });
    expect(current().push).toBeUndefined();
    expect(push).not.toHaveBeenCalled();
    await controller(store, gitBoundary, refresh).advance();
    expect(push).toHaveBeenCalledTimes(1);
    expect(remoteHead()).toBe(current().commit);
  });

  it("holds unknown validation outcomes even with retries remaining", async () => {
    review("review-1", "accepted");
    await authorize();
    const validateCommand = vi.fn(async (command: FixConfig["validation"][number]) => ({
      id: command.id,
      status: "unknown" as const,
      exitCode: null,
      output: "Timed out.",
    }));
    const advance = controller(store, repository, undefined, config.requiredChecks, {
      validate: validateCommand,
    });
    await advance.advance();
    expect(current()).toMatchObject({ phase: "escalated", validation: [{ status: "unknown" }] });
    await advance.advance();
    expect(validateCommand).toHaveBeenCalledTimes(1);
  });

  it("reconciles a new head after the agent turn before claiming validation", async () => {
    review("review-1", "accepted");
    await authorize();
    onTurn = async () => {
      observedHead = "b".repeat(40);
    };
    const validateCommand = vi.fn(runValidation);
    await controller(store, repository, undefined, config.requiredChecks, {
      validate: validateCommand,
    }).advance();
    expect(launches).toBe(1);
    expect(validateCommand).not.toHaveBeenCalled();
    expect(current()).toMatchObject({ phase: "escalated", validation: [] });
    expect(store.getWorkflow(workflowId)).toMatchObject({ headSha: observedHead });
  });

  function simulateDeadOwner(phase: FixCycle["phase"]) {
    store.fixes(workflowId).edit(({ cycles, save }) =>
      save({
        ...cycles.at(-1)!,
        phase,
        owner: 2_147_483_647,
      }),
    );
  }

  it("publishes one accepted, validated candidate across restarts and waits for an explicit new-head review and checks", async () => {
    await validate();
    const base = fixture.workflow.headSha;
    expect(current().review.findings.map(({ content }) => content.path)).toEqual(["tracked.txt"]);
    expect(current().validation).toEqual([
      { status: "passed", results: [{ id: "verify", status: "passed", exitCode: 0, output: "" }] },
    ]);
    expect(launches).toBe(1);
    expect(remoteHead()).toBe(base);
    restart();

    observedHead = base;
    await publish();
    const commit = current().commit!;
    expect(current()).toMatchObject({ phase: "confirming", push: "returned" });
    expect(remoteHead()).toBe(commit);
    await controller().advance();
    expect(store.getWorkflow(workflowId)?.state).toBe("validating");
    observedHead = undefined;
    cleanReviewSha = base;
    checkOutcome = "passed";
    restart();
    await controller().advance();
    expect(current()).toMatchObject({ phase: "finished", push: "confirmed" });
    expect(store.getWorkflow(workflowId)).toMatchObject({
      headSha: commit,
      state: "awaiting_review",
    });

    cleanReviewSha = commit;
    checkOutcome = null;
    await controller().advance();
    expect(store.getWorkflow(workflowId)?.state).toBe("awaiting_review");
    checkOutcome = "passed";
    const status = await controller().advance();
    expect(status.workflow.state).toBe("ready_for_human");
    expect(status.nextAction).toBe("Human merge review.");
    expect(launches).toBe(1);
    expect(readFileSync(join(fixture.repo, "tracked.txt"), "utf8")).toBe("original\n");
    expect(git(fixture.repo, "status", "--porcelain")).toBe("");
  });

  it.each([undefined, "rejected"] as const)(
    "requires accepted open dispositions (%s)",
    async (decision) => {
      review("review-1", decision);
      const status = await controller().advance();
      expect(status.cycles).toEqual([]);
      expect(status.workflow.escalationReason).toMatch(/disposition|no accepted/);
      expect(launches).toBe(0);
    },
  );

  it("checks disposition history again after the worker has opened its worktree", async () => {
    const id = review("review-1", "accepted");
    await authorize();
    const reconcile = createReconciler(store, reader, () => config.requiredChecks);
    let refreshes = 0;
    await controller(store, repository, async () => {
      await reconcile(target);
      if (++refreshes === 2)
        act(id, fixture.workflow.headSha, "superseded", "revoked", "decision-review-1");
    }).advance();
    expect(launches).toBe(0);
    expect(store.getWorkflow(workflowId)?.state).toBe("escalated");
  });

  it("revokes authorization when a newer review starts", async () => {
    review("review-1", "accepted");
    await authorize();
    store.reviews().start({ ...reviewStart, id: "newer", headSha: fixture.workflow.headSha });
    const status = await controller().advance();
    expect(status.workflow.escalationReason).toMatch(/review.*changed/i);
    expect(launches).toBe(0);
  });

  it("claims only one turn across live controllers and keeps the claim on recovery", async () => {
    review("review-1", "accepted");
    await authorize();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    onTurn = async () => {
      entered.resolve();
      await release.promise;
    };
    const first = controller().advance();
    await entered.promise;
    const second = new WorkflowStore(fixture.db);
    try {
      expect(second.recover().ambiguousOperations).toBe(0);
      const status = await controller(second).advance();
      expect(status.agent?.status).toBe("running");
      expect(launches).toBe(1);
    } finally {
      second.close();
      release.resolve();
      await first;
    }
    expect(current().phase).toBe("validated");
  });

  it("preserves hold when the PR changes during an agent turn", async () => {
    review("review-1", "accepted");
    await authorize();
    onTurn = async () => {
      observedHead = "b".repeat(40);
      await createReconciler(store, reader)(target);
    };
    const status = await controller().advance();
    expect(status.workflow.state).toBe("escalated");
    expect(status.session?.status).toBe("held");
    expect(current().validation).toEqual([]);
  });

  it("escalates when the agent asks for judgment", async () => {
    markForJudgment = true;
    review("review-1", "accepted");
    await authorize();
    await controller().advance();
    expect(store.getWorkflow(workflowId)?.escalationReason).toMatch(/operator judgment/);
    expect(current().validation).toEqual([]);
  });

  it("bounds validation retries and blocks publication on a command failure", async () => {
    config.validation = [
      { id: "failure", argv: [process.execPath, "-e", "console.error('failed'); process.exit(3)"] },
    ];
    review("review-1", "accepted");
    await authorize();
    await controller().advance();
    expect(current().phase).toBe("validation_retry");
    expect(() => authorizeFix(store, workflowId, current().id, true)).toThrow(/authorization/);
    restart();
    await controller().advance();
    expect(current().phase).toBe("escalated");
    expect(current().validation.map(({ results }) => results[0])).toEqual([
      { id: "failure", status: "failed", exitCode: 3, output: "failed\n" },
      { id: "failure", status: "failed", exitCode: 3, output: "failed\n" },
    ]);
    expect(remoteHead()).toBe(fixture.workflow.headSha);
  });

  it("revokes publication when already-staged file contents change", async () => {
    await validate();
    writeFileSync(join(current().worktree!.path, "tracked.txt"), "different corrected bytes\n");
    git(current().worktree!.path, "add", "--", "tracked.txt");
    await publish();
    expect(current()).toMatchObject({
      phase: "escalated",
      reason: expect.stringMatching(/checkout or index changed/),
    });
    expect(remoteHead()).toBe(fixture.workflow.headSha);
  });

  it("recovers a persisted local commit without creating another commit", async () => {
    await validate();
    authorizeFix(store, workflowId, current().id, true);
    const commit = repository.createCommit(current());
    store.fixes(workflowId).edit(({ save, cycles }) =>
      save({
        ...cycles.at(-1)!,
        phase: "committing",
        owner: 2_147_483_647,
        commit,
      }),
    );
    repository.attachCommit(current());
    restart();
    const createCommit = vi.spyOn(repository, "createCommit");
    await controller().advance();
    expect(createCommit).not.toHaveBeenCalled();
    expect(current().commit).toBe(commit);
    expect(remoteHead()).toBe(commit);
  });

  it("reconciles a crash after the remote accepted the push without replaying it", async () => {
    await validate();
    const push = vi.spyOn(repository, "push");
    await publish();
    simulateDeadOwner("pushing");
    restart();
    await controller().advance();
    expect(current()).toMatchObject({ phase: "finished", push: "confirmed" });
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("never replays an ambiguous push with the original ref still visible", async () => {
    await validate();
    const push = vi.spyOn(repository, "push").mockImplementation((_cycle, claim) => {
      claim();
      throw new Error("Transport closed without reporting a result.");
    });
    await publish();
    expect(current()).toMatchObject({ phase: "confirming", push: "unknown" });
    restart();
    await controller().advance();
    expect(current()).toMatchObject({
      phase: "escalated",
      push: "unknown",
      reason: expect.stringMatching(/cannot be confirmed/),
    });
    expect(push).toHaveBeenCalledTimes(1);
    expect(remoteHead()).toBe(fixture.workflow.headSha);
  });

  it("escalates a completed clean review with a failed required check on the published head", async () => {
    await validate();
    await publish();
    checkOutcome = "failed";
    const waiting = await controller().advance();
    expect(waiting.workflow).toMatchObject({ state: "awaiting_review", escalationReason: null });
    cleanReviewSha = remoteHead();
    const result = await controller().advance();
    expect(result.workflow).toMatchObject({
      state: "escalated",
      headSha: cleanReviewSha,
      escalationReason: expect.stringContaining("Inspect the failed checks: Quality checks"),
    });
    expect(result.cycles.at(-1)).toMatchObject({ phase: "finished", push: "confirmed" });
    expect(launches).toBe(1);
  });

  it("requires new finding decisions, then enforces the configured PR cycle limit", async () => {
    config.maxCycles = 1;
    await validate();
    await publish();
    await controller().advance();
    const id = review("review-2");
    const triage = await controller().advance();
    expect(triage.pendingFindingIds).toEqual([id]);
    expect(triage.workflow.escalationReason).toMatch(/explicit operator disposition/);
    act(id, remoteHead(), "accepted", "review-2");
    const bounded = await controller().advance();
    expect(bounded.workflow.escalationReason).toMatch(/cycle limit/);
    expect(launches).toBe(1);
  });

  it("holds a restarted agent claim with no terminal evidence", async () => {
    review("review-1", "accepted");
    await authorize();
    simulateDeadOwner("agent");
    const cycle = current();
    const ops = store.agentOperations();
    ops.request({
      operationId: cycle.operationId,
      workflowId,
      branch: config.localBranch,
      expectedPullRequestHead: cycle.head,
      expectedHead: cycle.head,
      configurationId: "fixture",
      promptDigest: "test",
      fix: { cycleId: cycle.id, findingIds: cycle.review.findings.map(({ id }) => id) },
    });
    expect(ops.claim(cycle.operationId)).not.toBeNull();
    using raw = new DatabaseSync(fixture.db);
    raw
      .prepare("UPDATE operations SET owner_pid=? WHERE operation_id=?")
      .run(2_147_483_647, cycle.operationId);
    restart();
    const status = await controller().advance();
    expect(status.agent?.status).toBe("unknown");
    expect(current().phase).toBe("escalated");
    expect(launches).toBe(0);
  });

  it("holds interrupted validation when an orphaned command could still be running", async () => {
    await validate();
    store.fixes(workflowId).edit(({ save, cycles }) => {
      const cycle = cycles.at(-1)!;
      return save({
        ...cycle,
        phase: "validating",
        owner: 2_147_483_647,
        validation: [{ status: "running", results: [] }],
      });
    });
    restart();
    await controller().advance();
    expect(current()).toMatchObject({
      phase: "escalated",
      validation: [{ status: "unknown", results: [] }],
    });
    expect(remoteHead()).toBe(fixture.workflow.headSha);
  });

  it("checks Git's advertised old ref at push, even when a branch disappears after preflight", async () => {
    await validate();
    await publish({
      ...repository,
      push(cycle, claim) {
        return repository.push(cycle, () => {
          claim();
          git(remote, "update-ref", "-d", "refs/heads/feat/pr");
        });
      },
    });
    expect(current()).toMatchObject({ phase: "confirming", push: "unknown" });
    expect(git(remote, "for-each-ref", "refs/heads/feat/pr")).toBe("");
  });

  it.each(["disposition", "stop"])(
    "blocks dispatch if a concurrent %s wins before Git starts",
    async (writer) => {
      await validate();
      const other = new WorkflowStore(fixture.db);
      try {
        await publish({
          ...repository,
          push(cycle, claim) {
            return repository.push(cycle, () => {
              if (writer === "disposition") revoke(other, cycle);
              else
                other.transition(workflowId, {
                  type: "stop",
                  reason: "Operator stopped the workflow.",
                });
              claim();
            });
          },
        });
        expect(current()).toMatchObject({ phase: "escalated" });
        expect(current().push).toBeUndefined();
        expect(remoteHead()).toBe(fixture.workflow.headSha);
      } finally {
        other.close();
      }
    },
  );

  function revoke(db: WorkflowStore, cycle: FixCycle) {
    const finding = cycle.review.findings[0]!;
    return db.reviews().act({
      id: "revoke-for-publication-test",
      findingId: finding.id,
      headSha: cycle.head,
      action: "superseded",
      actor: "operator",
      rationale: "Withdraw the fix.",
      previousActionId: finding.lastActionId,
    });
  }

  it("rejects revocation and stop from another connection once Git claims dispatch", async () => {
    await validate();
    const other = new WorkflowStore(fixture.db);
    try {
      await publish({
        ...repository,
        push(cycle, claim) {
          return repository.push(cycle, () => {
            claim();
            expect(current(other).push).toBe("intent");
            expect(() => revoke(other, cycle)).toThrow(/publication has already started/i);
            expect(() =>
              other.transition(workflowId, { type: "stop", reason: "Stop now." }),
            ).toThrow(/publication has already started/i);
          });
        },
      });
      expect(remoteHead()).toBe(current().commit);
      expect(current().push).toBe("returned");
      expect(store.reviews().inspect(workflowId).actionableFindings).toEqual([
        current().review.findings[0]!.id,
      ]);
    } finally {
      other.close();
    }
  });

  async function delayFinalObservation(
    db: WorkflowStore,
    delayedReader: GitHubReader,
    assertNewer: () => Promise<void>,
  ) {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let reads = 0;
    const old = createReconciler(
      db,
      {
        ...delayedReader,
        async readPullRequest(target) {
          const snapshot = await delayedReader.readPullRequest(target);
          if (++reads === 2) {
            entered.resolve();
            await release.promise;
          }
          return snapshot;
        },
      },
      () => config.requiredChecks,
    )(target);
    const finished = expect(old).rejects.toThrow(/superseded this observation/);
    await entered.promise;
    try {
      await assertNewer();
    } finally {
      release.resolve();
      await finished;
    }
  }

  it("cannot restore readiness with older passing checks on the same head", async () => {
    const head = remoteHead();
    cleanReviewSha = head;
    const other = new WorkflowStore(fixture.db);
    try {
      await delayFinalObservation(
        other,
        {
          ...reader,
          async readChecks() {
            return [{ name: "Quality checks", sha: head, outcome: "passed" }];
          },
        },
        async () => {
          checkOutcome = "failed";
          await createReconciler(store, reader, () => config.requiredChecks)(target);
        },
      );
      expect(store.getWorkflow(workflowId)).toMatchObject({
        state: "awaiting_review",
        headSha: head,
        checks: [{ name: "Quality checks", sha: head, outcome: "failed" }],
      });
    } finally {
      other.close();
    }
  });

  it("cannot apply an older pre-push head after the publication is confirmed", async () => {
    await validate();
    await publish();
    observedHead = fixture.workflow.headSha;
    const other = new WorkflowStore(fixture.db);
    try {
      await delayFinalObservation(other, reader, async () => {
        observedHead = undefined;
        await controller().advance();
        expect(current().push).toBe("confirmed");
      });
      expect(store.getWorkflow(workflowId)).toMatchObject({
        state: "awaiting_review",
        headSha: current().commit,
        escalationReason: null,
      });
    } finally {
      other.close();
    }
  });

  it("applies new required checks at confirmation and retains them in polling and CLI advances", async () => {
    await validate();
    await publish();
    cleanReviewSha = remoteHead();
    checkOutcome = "passed";
    const configured = ["Quality checks", "Integration"];
    const first = await controller(store, repository, undefined, configured).advance();
    expect(first.cycles.at(-1)?.push).toBe("confirmed");
    expect(first.workflow).toMatchObject({ state: "awaiting_review", requiredChecks: configured });
    const polling = createReconciler(store, reader, () =>
      requiredChecksForCycle(current(), configured),
    );
    await polling(target);
    expect(store.getWorkflow(workflowId)).toMatchObject({
      state: "awaiting_review",
      requiredChecks: configured,
    });
    await controller(store, repository, undefined, configured).advance();
    expect(store.getWorkflow(workflowId)).toMatchObject({
      state: "awaiting_review",
      requiredChecks: configured,
    });
  });

  it.each(["created", "modified", "unchanged"] as const)(
    "checks %s ignored inputs against the pre-turn checkout",
    async (change) => {
      const excludes = join(fixture.root, "fixture-excludes");
      writeFileSync(excludes, "dependencies/\n");
      git(fixture.repo, "config", "core.excludesFile", excludes);
      config.validation = [
        {
          id: "has-local-input",
          argv: [process.execPath, "-e", 'require("node:fs").accessSync("dependencies/input")'],
        },
      ];
      review("review-1", "accepted");
      await authorize();
      const reconcile = createReconciler(store, reader, () => config.requiredChecks);
      let refreshes = 0;
      if (change !== "unchanged") {
        onTurn = async (path) => {
          const directory = join(path, "dependencies");
          mkdirSync(directory, { recursive: true });
          writeFileSync(join(directory, "input"), "agent output");
        };
      }
      const result = await controller(store, repository, async () => {
        await reconcile(target);
        if (++refreshes === 2 && change !== "created") {
          const directory = join(
            store.agentOperations().get(current().operationId)!.evidence!.worktree!.path,
            "dependencies",
          );
          mkdirSync(directory);
          writeFileSync(join(directory, "input"), "preinstalled");
        }
      }).advance();
      if (change === "unchanged") {
        expect(result.cycles.at(-1)).toMatchObject({
          phase: "validated",
          validation: [{ status: "passed" }],
        });
      } else {
        expect(result.workflow.escalationReason).toMatch(/changed ignored inputs/i);
        expect(current().validation).toEqual([]);
        expect(remoteHead()).toBe(fixture.workflow.headSha);
      }
    },
  );

  it("holds an otherwise successful agent result that exceeds measured token limits", async () => {
    config.maxTotalTokens = 16;
    review("review-1", "accepted");
    await authorize();
    const status = await controller().advance();
    expect(status.workflow.escalationReason).toMatch(/token budget/);
    expect(status.limits.observedTokens).toBe(17);
    expect(current().validation).toEqual([]);
    expect(remoteHead()).toBe(fixture.workflow.headSha);
  });

  it("reuses the implementation session for a second independently authorized fix", async () => {
    await validate();
    await publish();
    await controller().advance();
    review("review-2", "accepted");
    await authorize();
    await controller().advance();
    expect(current().phase).toBe("validated");
    expect(launches).toBe(2);
    expect(resumes).toBe(1);
  });
});
