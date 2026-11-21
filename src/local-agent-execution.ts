import { isDeepStrictEqual } from "node:util";
import type { AgentAdapter } from "./agent.ts";
import type {
  AgentOperationWorker,
  AgentSessionCheckpoint,
  AgentTurnEvidence,
} from "./agent-operation.ts";
import { describeError } from "./controller.ts";
import { object } from "./github-data.ts";
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
      refreshLaunch,
      fixFindingIds,
      recordExpectedWorktree,
      recordWorkspace,
      recordSession,
    }) {
      recordExpectedWorktree(worktrees.locate(target));
      let source: AgentSessionCheckpoint | undefined;
      let ignoredBaseline: string | undefined;
      const authorize = () => {
        if (fixFindingIds)
          ignoredBaseline = worktrees.ignoredCheckpoint(session.worktree, target.expectedHead);
        authorizeLaunch();
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
            authorize();
          })
        : worker.startSession(target, true, authorize);
      recordWorkspace(session.worktree);
      if (refreshLaunch) await refreshLaunch();
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
      let usage: AgentTurnEvidence["usage"];
      const result = await session.runTurn(target.expectedHead, {
        prompt,
        ...(outputSchema ? { outputSchema } : {}),
        ...(signal === undefined ? {} : { signal }),
        onEvent(event) {
          if (event.kind === "session_started" && session.reference)
            recordSession(session.reference);
          if (fixFindingIds && event.provider === "codex" && event.kind === "turn_completed") {
            const reported = object(object(event.data)?.usage);
            const input = reported?.input_tokens;
            const output = reported?.output_tokens;
            if (
              typeof input === "number" &&
              typeof output === "number" &&
              input >= 0 &&
              output >= 0 &&
              Number.isSafeInteger(input + output) &&
              Number.isInteger(input) &&
              Number.isInteger(output)
            )
              usage = { inputTokens: input, outputTokens: output };
          }
        },
      });
      const reference = session.reference;
      const evidence: AgentTurnEvidence = {
        agent: {
          outcome: result.agent.outcome,
          ...("reason" in result.agent ? { reason: result.agent.reason } : {}),
        },
        workspace: result.workspace,
        ...(usage ? { usage } : {}),
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
            "Agent requested operator judgment or did not report addressing every accepted finding. Inspect the Codex session.";
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
