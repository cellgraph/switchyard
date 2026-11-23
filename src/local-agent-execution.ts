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
      refreshLaunch,
      preflight,
      fixFindingIds,
      recordExpectedWorktree,
      recordWorkspace,
      recordSession,
    }) {
      recordExpectedWorktree(worktrees.locate(target));
      let source: AgentSessionCheckpoint | undefined;
      let ignoredBaseline: string | undefined;
      let readOnlyBaseline: string | undefined;
      const authorize = () => {
        if (fixFindingIds)
          ignoredBaseline = worktrees.ignoredCheckpoint(session.worktree, target.expectedHead);
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
            if (
              refreshLaunch &&
              worktrees.checkpoint(saved.worktree, target.expectedHead) !==
                previous?.checkpoint?.workspace
            )
              throw new Error("Worktree changed during dispatch preflight.");
            source = sessionCheckpoint(saved.agent.id, saved.worktree.path);
            if (!isDeepStrictEqual(source, previous?.checkpoint?.session))
              throw new Error("Agent session changed since the previous operation.");
            return authorize();
          })
        : worker.startSession(target, true, authorize, preflight?.worktree);
      const checkpoint = refreshLaunch
        ? worktrees.checkpoint(session.worktree, target.expectedHead)
        : undefined;
      if (
        preflight &&
        (!isDeepStrictEqual(preflight.worktree, session.worktree) ||
          preflight.checkpoint !== checkpoint)
      )
        throw new Error("Worktree changed since the deferred agent preflight.");
      recordWorkspace(session.worktree, checkpoint);
      if (refreshLaunch) {
        await refreshLaunch();
        if (preflight && worktrees.checkpoint(session.worktree, target.expectedHead) !== checkpoint)
          throw new Error("Worktree changed during agent preflight.");
      }
      if (
        fixFindingIds &&
        worktrees.validate(session.worktree, target.expectedHead).changedPaths.length
      )
        throw new Error("A bounded fix requires a clean starting checkout.");
      const outputSchema = fixFindingIds
        ? {
            type: "object",
            additionalProperties: false,
            required: ["status", "addressedFindingIds"],
            properties: {
              status: { type: "string", enum: ["addressed", "needs_operator"] },
              addressedFindingIds: {
                type: "array",
                items: { type: "string", enum: fixFindingIds },
              },
            },
          }
        : undefined;
      const result = await session.runTurn(target.expectedHead, {
        prompt,
        ...(outputSchema ? { outputSchema } : {}),
        ...(signal === undefined ? {} : { signal }),
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
      if (fixFindingIds && result.agent.outcome === "completed") {
        const report = result.agent.structuredOutput as
          { status?: unknown; addressedFindingIds?: unknown } | null | undefined;
        const addressed = report?.addressedFindingIds;
        if (
          report?.status === "addressed" &&
          Array.isArray(addressed) &&
          addressed.length === fixFindingIds.length &&
          fixFindingIds.every((id) => addressed.includes(id))
        ) {
          evidence.addressedFindings = fixFindingIds;
        } else {
          evidence.error =
            "Agent requested operator judgment or did not report addressing every accepted finding. Inspect the agent session.";
        }
      }
      if (reference) evidence.reference = reference;
      if (reference && result.agent.outcome === "completed" && "head" in result.workspace) {
        try {
          if (fixFindingIds) {
            const ignored = worktrees.ignoredCheckpoint(reference.worktree, result.workspace.head);
            if (ignoredBaseline === undefined || ignored !== ignoredBaseline)
              throw new Error(
                "The agent changed ignored inputs. Validation would not reflect the published tree.",
              );
            evidence.ignoredCheckpoint = ignored;
          }
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
