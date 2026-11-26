import type { AgentAdapter, AgentSessionReference, AgentTurn, AgentTurnResult } from "./agent.ts";
import type { Worktree, WorktreeManager, WorktreeTarget } from "./worktree.ts";

export type WorkerSessionReference = {
  worktree: Worktree;
  agent: AgentSessionReference;
};

export type WorkerTurnResult = {
  agent: AgentTurnResult;
  workspace: { head: string; changedPaths: string[] } | { error: string };
};

export function createLocalWorker(worktrees: WorktreeManager, agent: AgentAdapter) {
  const active = new Set<string>();
  const uncertain = new Set<string>();

  function assertAvailable(path: string): void {
    if (active.has(path)) throw new Error("A turn is already running in this worktree.");
    if (uncertain.has(path))
      throw new Error("Worktree requires inspection after an uncertain turn.");
  }

  function openSession(
    target: WorktreeTarget,
    previous?: WorkerSessionReference,
    requireNew = false,
    beforeLaunch?: () => void | Promise<void>,
  ) {
    const expected = previous?.worktree;
    const worktree = worktrees.open(target, expected ? false : requireNew ? "new" : true);
    assertAvailable(worktree.path);
    if (
      expected &&
      (expected.repository !== worktree.repository ||
        expected.workflowId !== worktree.workflowId ||
        expected.path !== worktree.path ||
        expected.branch !== worktree.branch)
    )
      throw new Error("Session belongs to a different worktree.");
    if (expected && expected.checkoutIdentity !== worktree.checkoutIdentity)
      throw new Error("Session belongs to a different linked checkout.");

    const workspace = { workingDirectory: worktree.path };
    const openAgentSession = () =>
      previous ? agent.resumeSession(workspace, previous.agent) : agent.startSession(workspace);
    let session = beforeLaunch ? undefined : openAgentSession();
    let needsCleanStart = previous === undefined;

    return {
      worktree,
      get reference(): WorkerSessionReference | null {
        const reference = session?.reference;
        return reference ? { worktree: { ...worktree }, agent: reference } : null;
      },
      async runTurn(expectedHead: string, turn: AgentTurn): Promise<WorkerTurnResult> {
        assertAvailable(worktree.path);
        const before = worktrees.validate(worktree, expectedHead);
        if (needsCleanStart && before.changedPaths.length)
          throw new Error("A new agent session requires a clean workflow worktree.");
        if (turn.signal?.aborted)
          return {
            agent: { outcome: "interrupted", reason: "Canceled before launch." },
            workspace: before,
          };

        const authorization = beforeLaunch?.();
        if (authorization) {
          await authorization;
          worktrees.validate(worktree, expectedHead);
        }
        if (turn.signal?.aborted)
          return {
            agent: { outcome: "interrupted", reason: "Canceled before launch." },
            workspace: before,
          };
        // Synchronous checkout verification can delay the abort timer.
        turn.checkLaunch?.();
        session ??= openAgentSession();
        active.add(worktree.path);
        try {
          let result: AgentTurnResult;
          try {
            turn.checkLaunch?.();
            result = await session.runTurn(turn);
          } catch {
            result = {
              outcome: "unknown",
              reason: "Agent adapter stopped before reporting an outcome.",
            };
          }
          if (result.outcome === "unknown" || result.outcome === "interrupted")
            uncertain.add(worktree.path);
          if (session.reference) needsCleanStart = false;

          try {
            return { agent: result, workspace: worktrees.observe(worktree, expectedHead) };
          } catch (error) {
            uncertain.add(worktree.path);
            return {
              agent: result,
              workspace: {
                error: error instanceof Error ? error.message : "Worktree inspection failed.",
              },
            };
          }
        } finally {
          active.delete(worktree.path);
        }
      },
    };
  }

  return {
    startSession: (
      target: WorktreeTarget,
      requireNew = false,
      beforeLaunch?: () => void | Promise<void>,
    ) => openSession(target, undefined, requireNew, beforeLaunch),
    resumeSession: (
      target: WorktreeTarget,
      reference: WorkerSessionReference,
      beforeLaunch?: () => void | Promise<void>,
    ) => openSession(target, reference, false, beforeLaunch),
  };
}
