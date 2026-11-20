import { isDeepStrictEqual } from "node:util";
import type { AgentAdapter } from "./agent.ts";
import type {
  AgentOperationWorker,
  AgentSessionCheckpoint,
  AgentTurnEvidence,
} from "./agent-operation.ts";
import { describeError } from "./controller.ts";
import { createLocalWorker } from "./local-worker.ts";
import type { WorktreeManager } from "./worktree.ts";

export function createLocalAgentExecution(
  worktrees: WorktreeManager,
  agent: AgentAdapter,
  sessionCheckpoint: (id: string, directory: string) => AgentSessionCheckpoint,
): Pick<AgentOperationWorker, "execute"> {
  const worker = createLocalWorker(worktrees, agent);
  return {
    async execute({
      target,
      previous,
      prompt,
      signal,
      authorizeLaunch,
      recordExpectedWorktree,
      recordWorkspace,
      recordSession,
    }) {
      recordExpectedWorktree(worktrees.locate(target));
      let source: AgentSessionCheckpoint | undefined;
      const saved = previous?.reference;
      if (previous) {
        if (!saved || !previous.checkpoint) throw new Error("Agent session binding is incomplete.");
        if (
          worktrees.checkpoint(saved.worktree, target.expectedHead) !==
          previous.checkpoint.workspace
        )
          throw new Error("Worktree changed since the previous agent operation.");
      }
      const session = saved
        ? worker.resumeSession(target, saved, () => {
            source = sessionCheckpoint(saved.agent.id, saved.worktree.path);
            if (!isDeepStrictEqual(source, previous?.checkpoint?.session))
              throw new Error("Agent session changed since the previous operation.");
            authorizeLaunch();
          })
        : worker.startSession(target, true, authorizeLaunch);
      recordWorkspace(session.worktree);
      const result = await session.runTurn(target.expectedHead, {
        prompt,
        ...(signal === undefined ? {} : { signal }),
        onEvent(event) {
          if (event.kind === "session_started" && session.reference)
            recordSession(session.reference);
        },
      });
      const reference = session.reference;
      const evidence: AgentTurnEvidence = {
        agent: {
          outcome: result.agent.outcome,
          ...("reason" in result.agent ? { reason: result.agent.reason } : {}),
        },
        workspace: result.workspace,
      };
      if (reference) evidence.reference = reference;
      if (reference && result.agent.outcome === "completed" && "head" in result.workspace) {
        try {
          const workspace = worktrees.checkpoint(reference.worktree, result.workspace.head);
          const session = sessionCheckpoint(reference.agent.id, reference.worktree.path);
          if (source && source.identity !== session.identity)
            throw new Error("Codex selected a different rollout during the turn.");
          evidence.checkpoint = {
            workspace,
            session,
          };
        } catch (error) {
          evidence.error = describeError(error);
        }
      }
      return evidence;
    },
  };
}
