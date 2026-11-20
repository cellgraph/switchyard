import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession, AgentTurnResult } from "../src/agent.ts";
import { createLocalWorker } from "../src/local-worker.ts";
import { WorkflowStore } from "../src/store.ts";
import { createWorktreeManager, type WorktreeTarget } from "../src/worktree.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function fixtureRepository(path: string): string {
  mkdirSync(path);
  git(path, "init", "-b", "main");
  writeFileSync(join(path, "tracked.txt"), "original\n");
  git(path, "add", ".");
  git(
    path,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "initial",
  );
  return git(path, "rev-parse", "HEAD");
}

describe("isolated worktrees and the local worker", () => {
  let scratch: string;
  let primary: string;
  let root: string;
  let target: WorktreeTarget;
  let path: string;
  let worktrees: ReturnType<typeof createWorktreeManager>;

  beforeEach(() => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "switchyard-worker-")));
    primary = join(scratch, "primary");
    root = join(scratch, "worktrees");
    mkdirSync(root);
    target = {
      workflowId: "owner/repo#42",
      branch: "feat/workflow-42",
      expectedHead: fixtureRepository(primary),
    };
    path = join(root, createHash("sha256").update(target.workflowId).digest("hex"));
    worktrees = createWorktreeManager({ repositoryDirectory: primary, worktreeRoot: root });
  });

  afterEach(() => rmSync(scratch, { recursive: true, force: true }));

  it("creates one worktree, runs and resumes at that path, and preserves a dirty primary checkout", async () => {
    writeFileSync(join(primary, "tracked.txt"), "operator edits\n");
    writeFileSync(join(primary, "local.txt"), "operator scratch\n");
    const originalStatus = git(primary, "status", "--porcelain");
    const reference = { provider: "fixture", id: "opaque" };
    const runTurn = vi.fn<AgentSession["runTurn"]>(async ({ prompt, onEvent }) => {
      onEvent?.({ provider: "fixture", kind: "progress", data: { prompt } });
      writeFileSync(join(path, "tracked.txt"), prompt);
      writeFileSync(join(path, "new\nfile.txt"), "new");
      return {
        outcome: "completed",
        response: '{"status":"ok"}',
        structuredOutput: { status: "ok" },
      };
    });
    const agent = {
      startSession: vi.fn(() => ({ reference, runTurn })),
      resumeSession: vi.fn(() => ({ reference, runTurn })),
    };
    const worker = createLocalWorker(worktrees, agent);
    const session = worker.startSession(target);
    expect(agent.startSession).toHaveBeenCalledWith({ workingDirectory: path });
    expect(git(path, "log", "-1", "--format=%H")).toBe(target.expectedHead);
    expect(git(path, "branch", "--show-current")).toBe(target.branch);
    expect(worktrees.open(target, true).path).toBe(path);

    const progress = vi.fn();
    expect(
      await session.runTurn(target.expectedHead, { prompt: "edit", onEvent: progress }),
    ).toEqual({
      agent: {
        outcome: "completed",
        response: '{"status":"ok"}',
        structuredOutput: { status: "ok" },
      },
      workspace: { head: target.expectedHead, changedPaths: ["new\nfile.txt", "tracked.txt"] },
    });
    expect(progress).toHaveBeenCalledWith({
      provider: "fixture",
      kind: "progress",
      data: { prompt: "edit" },
    });

    const saved = session.reference!;
    expect(() =>
      worker.resumeSession(
        { ...target, workflowId: "owner/repo#43", branch: "feat/workflow-43" },
        saved,
      ),
    ).toThrow("worktree is missing");
    const other = { ...target, workflowId: "owner/repo#43", branch: "feat/workflow-43" };
    worktrees.open(other, true);
    expect(() => worker.resumeSession(other, saved)).toThrow("different worktree");

    const resumed = worker.resumeSession(target, saved);
    expect(agent.resumeSession).toHaveBeenCalledWith({ workingDirectory: path }, reference);
    expect(
      (await resumed.runTurn(target.expectedHead, { prompt: "follow-up" })).agent.outcome,
    ).toBe("completed");
    expect(readFileSync(join(path, "tracked.txt"), "utf8")).toBe("follow-up");
    expect(readFileSync(join(primary, "tracked.txt"), "utf8")).toBe("operator edits\n");
    expect(git(primary, "status", "--porcelain")).toBe(originalStatus);
    expect(git(primary, "rev-parse", "HEAD")).toBe(target.expectedHead);
    expect(git(primary, "branch", "--show-current")).toBe("main");
  });

  it("rejects overlapping paths, occupied branches, and a primary checkout at the workflow path", () => {
    expect(() =>
      createWorktreeManager({ repositoryDirectory: primary, worktreeRoot: primary }).open(
        target,
        true,
      ),
    ).toThrow("overlap");
    const numbered = join(scratch, createHash("sha256").update("primary").digest("hex"));
    const head = fixtureRepository(numbered);
    git(numbered, "switch", "-c", "feat/primary");
    expect(() =>
      createWorktreeManager({ repositoryDirectory: numbered, worktreeRoot: scratch }).open(
        { workflowId: "primary", branch: "feat/primary", expectedHead: head },
        true,
      ),
    ).toThrow("overlap");

    const elsewhere = join(scratch, "other");
    git(primary, "worktree", "add", "-b", target.branch, elsewhere, target.expectedHead);
    expect(() => worktrees.open(target, true)).toThrow("already checked out");
    expect(() => worktrees.open({ ...target, branch: "main" }, true)).toThrow("semantic");
  });

  it("refuses unregistered directories and branch, commit, and repository mismatches", () => {
    fixtureRepository(path);
    expect(() => worktrees.open(target, true)).toThrow("path already exists");
    rmSync(path, { recursive: true });
    const worktree = worktrees.open(target, true);
    expect(() => worktrees.validate(worktree, "0".repeat(40))).toThrow("different commit");
    expect(() => worktrees.open({ ...target, branch: "fix/other" }, true)).toThrow(
      "different branch",
    );
    git(path, "switch", "--detach");
    expect(() => worktrees.validate(worktree, target.expectedHead)).toThrow("different branch");
    rmSync(path, { recursive: true });
    fixtureRepository(path);
    expect(() => worktrees.validate(worktree, target.expectedHead)).toThrow(
      "registered repository",
    );
  });

  it("preserves dirty worktrees, and refuses active operations and unresolved entries", () => {
    const worktree = worktrees.open(target, true);
    writeFileSync(join(path, "tracked.txt"), "keep these edits");
    expect(() => worktrees.open(target, true)).toThrow("clean");
    expect(readFileSync(join(path, "tracked.txt"), "utf8")).toBe("keep these edits");

    const gitDir = git(path, "rev-parse", "--absolute-git-dir");
    const merge = join(gitDir, "MERGE_HEAD");
    writeFileSync(merge, target.expectedHead);
    expect(() => worktrees.validate(worktree, target.expectedHead)).toThrow("active Git operation");
    expect(readFileSync(merge, "utf8")).toBe(target.expectedHead);
    rmSync(merge);

    const blob = git(path, "rev-parse", "HEAD:tracked.txt");
    const empty = "0".repeat(blob.length);
    execFileSync("git", ["update-index", "--index-info"], {
      cwd: path,
      input: `0 ${empty}\ttracked.txt\n100644 ${blob} 1\ttracked.txt\n100644 ${blob} 2\ttracked.txt\n`,
    });
    expect(() => worktrees.validate(worktree, target.expectedHead)).toThrow("unresolved conflicts");
  });

  it("reports agent failures and ambiguous outcomes without changing controller state", async () => {
    const store = new WorkflowStore(":memory:");
    try {
      store.createWorkflow({
        id: target.workflowId,
        identity: { repository: "owner/repo", pullRequest: 42 },
        headSha: target.expectedHead,
        state: "awaiting_review",
        requiredChecks: null,
        review: null,
        checks: [],
        fixCycles: 0,
        cycleAwaitingReview: false,
        validationHeadSha: null,
        escalationReason: null,
      });
      const workflow = store.getWorkflow(target.workflowId);
      const runTurn = vi
        .fn<() => Promise<AgentTurnResult>>()
        .mockResolvedValueOnce({ outcome: "failed", reason: "Provider refused the turn." })
        .mockImplementationOnce(async () => {
          writeFileSync(join(path, "partial.txt"), "partial edits");
          throw new Error("transport failure");
        });
      const worker = createLocalWorker(worktrees, {
        startSession: () => ({ reference: { provider: "fixture", id: "opaque" }, runTurn }),
        resumeSession: () => {
          throw new Error("unexpected resume");
        },
      });
      const session = worker.startSession(target);
      const turn = { prompt: "test" };
      await expect(session.runTurn("0".repeat(40), turn)).rejects.toThrow("different commit");
      expect(runTurn).not.toHaveBeenCalled();
      expect((await session.runTurn(target.expectedHead, turn)).agent.outcome).toBe("failed");
      expect(await session.runTurn(target.expectedHead, turn)).toEqual({
        agent: { outcome: "unknown", reason: expect.any(String) },
        workspace: { head: target.expectedHead, changedPaths: ["partial.txt"] },
      });
      await expect(session.runTurn(target.expectedHead, turn)).rejects.toThrow("inspection");
      expect(store.getWorkflow(target.workflowId)).toEqual(workflow);
    } finally {
      store.close();
    }
  });

  it("rejects simultaneous turns in the same worktree and reports unsafe post-turn state", async () => {
    const finished = Promise.withResolvers<AgentTurnResult>();
    const worker = createLocalWorker(worktrees, {
      startSession: () => ({ reference: null, runTurn: () => finished.promise }),
      resumeSession: () => {
        throw new Error("unexpected resume");
      },
    });
    const first = worker.startSession(target);
    const second = worker.startSession(target);
    const turn = { prompt: "test" };
    const pending = first.runTurn(target.expectedHead, turn);
    await expect(second.runTurn(target.expectedHead, turn)).rejects.toThrow("already running");
    git(path, "switch", "--detach");
    finished.resolve({ outcome: "completed", response: "done" });
    expect(await pending).toEqual({
      agent: { outcome: "completed", response: "done" },
      workspace: { error: "Workflow worktree is on a different branch." },
    });
    await expect(first.runTurn(target.expectedHead, turn)).rejects.toThrow("inspection");
  });
});
