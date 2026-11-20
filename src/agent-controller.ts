import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  AgentOperation,
  AgentOperationWorker,
  AgentTurnEvidence,
  AgentTurnRequest,
} from "./agent-operation.ts";
import { describeError } from "./controller.ts";
import type { WorkflowStore } from "./store.ts";

export function createAgentController(store: WorkflowStore, worker: AgentOperationWorker) {
  const operations = store.agentOperations();

  function request({
    operationId,
    workflowId,
    branch,
    expectedPullRequestHead,
    expectedHead,
    prompt,
  }: AgentTurnRequest) {
    if (
      ![operationId, workflowId, branch, expectedPullRequestHead, expectedHead, prompt].every(
        (value) => typeof value === "string" && value.trim(),
      )
    )
      throw new Error(
        "An agent turn requires an operation ID, workflow, branch, both head SHAs, and a prompt.",
      );
    if (
      ![expectedHead, expectedPullRequestHead].every((sha) =>
        /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha),
      )
    )
      throw new Error("Agent turns require full Git commit SHAs.");
    return operations.request({
      operationId,
      workflowId,
      branch,
      expectedPullRequestHead,
      expectedHead,
      configurationId: worker.configurationId,
      promptDigest: createHash("sha256").update(prompt).digest("hex"),
    });
  }

  return {
    request,
    async runTurn(input: AgentTurnRequest, signal?: AbortSignal): Promise<AgentOperation> {
      const operation = request(input);
      const { operationId, workflowId, branch, expectedHead, prompt } = input;
      if (signal?.aborted || operation.status !== "requested") return operation;
      const claim = operations.claim(operationId);
      if (!claim) return operations.get(operationId)!;

      let evidence: AgentTurnEvidence;
      try {
        const runtime = worker.runtime();
        const { previous } = claim;
        if (
          previous &&
          (previous.status !== "active" ||
            !previous.reference ||
            !previous.checkpoint ||
            !previous.runtime ||
            !isDeepStrictEqual(previous.runtime, runtime))
        )
          throw new Error("Recorded agent runtime or session is incompatible with continuation.");
        if (!operations.start(operationId, runtime))
          throw new Error("Workflow authorization changed before the worker started.");
        evidence = await worker.execute({
          operationId,
          target: { workflowId, branch, expectedHead },
          prompt,
          previous,
          ...(signal === undefined ? {} : { signal }),
          authorizeLaunch: () => operations.authorizeLaunch(operationId),
          recordExpectedWorktree: (expectedWorktree) =>
            operations.progress(operationId, { expectedWorktree }),
          recordWorkspace: (worktree) => operations.progress(operationId, { worktree }),
          recordSession: (reference) => operations.progress(operationId, { reference }),
        });
      } catch (error) {
        evidence = { error: describeError(error) };
      }
      // If this write fails, keep the existing intent so restart recovery holds the workflow.
      return operations.finish(operationId, evidence);
    },
  };
}
