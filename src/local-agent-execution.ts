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
  readOnly = false,
): Pick<AgentOperationWorker, "execute"> {
  const worker = createLocalWorker(worktrees, agent);
  return {
    async execute({
      target,
      previous,
      prompt,
      signal,
      authorizeLaunch,
      checkLaunch,
      recordExpectedWorktree,
      recordWorkspace,
      recordSession,
    }) {
      recordExpectedWorktree(worktrees.locate(target));
      let source: AgentSessionCheckpoint | undefined;
      let readOnlyBaseline: string | undefined;
      const authorize = () => {
        if (!readOnly) return authorizeLaunch();
        const before = worktrees.checkpoint(session.worktree, target.expectedHead);
        readOnlyBaseline = before;
        return Promise.resolve(authorizeLaunch()).then(() => {
          if (
            worktrees.checkpoint(session.worktree, target.expectedHead) !== before ||
            (saved &&
              !isDeepStrictEqual(source, sessionCheckpoint(saved.agent.id, saved.worktree.path)))
          )
            throw new Error("Worktree or session changed while awaiting launch authorization.");
        });
      };
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
            return authorize();
          })
        : worker.startSession(target, true, authorize);
      recordWorkspace(session.worktree);
      const result = await session.runTurn(target.expectedHead, {
        prompt,
        ...(signal === undefined ? {} : { signal }),
        ...(checkLaunch === undefined ? {} : { checkLaunch }),
        onEvent(event) {
          if (event.kind === "session_started" && session.reference)
            recordSession(session.reference);
        },
      });
      const reference = session.reference;
      const { usage, sessionCostUsd, model } = result.agent;
      const evidence: AgentTurnEvidence = {
        agent: {
          outcome: result.agent.outcome,
          ...("reason" in result.agent ? { reason: result.agent.reason } : {}),
        },
        workspace: result.workspace,
        ...(usage ? { usage } : {}),
        ...(sessionCostUsd === undefined ? {} : { sessionCostUsd }),
        ...(model ? { model } : {}),
      };
      if (reference) evidence.reference = reference;
      if (reference && result.agent.outcome === "completed" && "head" in result.workspace) {
        try {
          const workspace = worktrees.checkpoint(reference.worktree, result.workspace.head);
          if (readOnly && workspace !== readOnlyBaseline)
            throw new Error("The read-only turn changed checkout contents.");
          const session = sessionCheckpoint(reference.agent.id, reference.worktree.path);
          if (source && source.identity !== session.identity)
            throw new Error("The agent selected a different session artifact during the turn.");
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
