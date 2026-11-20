import type { AgentTurnResult } from "./agent.ts";
import type { WorkerSessionReference, WorkerTurnResult } from "./local-worker.ts";
import type { Worktree, WorktreeLocation, WorktreeTarget } from "./worktree.ts";

export type AgentRuntime = {
  provider: string;
  model: string;
  sdkVersion: string;
  cliVersion: string;
  home: string;
  configuration: string;
};

export type AgentTurnRequest = {
  operationId: string;
  workflowId: string;
  branch: string;
  expectedPullRequestHead: string;
  expectedHead: string;
  prompt: string;
};

export type AgentTurnIntent = Omit<AgentTurnRequest, "prompt"> & {
  promptDigest: string;
  configurationId: string;
  workflowRevision: number;
  mode: "awaiting_review" | "fixing";
};

export type AgentOperationStatus =
  | "requested"
  | "dispatching"
  | "running"
  | "completed"
  | "interrupted"
  | "unknown"
  | "manual_reconciliation";

export type AgentSessionCheckpoint = { identity: string; digest: string };

export type AgentTurnEvidence = {
  expectedWorktree?: WorktreeLocation;
  launchAuthorizedAt?: string;
  runtime?: AgentRuntime;
  worktree?: Worktree;
  reference?: WorkerSessionReference;
  agent?: Pick<AgentTurnResult, "outcome"> & { reason?: string };
  workspace?: WorkerTurnResult["workspace"];
  checkpoint?: { workspace: string; session: AgentSessionCheckpoint };
  error?: string;
};

export type AgentOperation = {
  intent: AgentTurnIntent;
  status: AgentOperationStatus;
  evidence: AgentTurnEvidence | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AgentSessionBinding = {
  initialOperationId: string;
  lastOperationId: string;
  status: "starting" | "active" | "held";
  baseHead: string;
  runtime: AgentRuntime | null;
  reference: WorkerSessionReference | null;
  head: string | null;
  checkpoint: AgentTurnEvidence["checkpoint"] | null;
  createdAt: string;
  updatedAt: string;
};

export interface AgentOperationWorker {
  readonly configurationId: string;
  runtime(): AgentRuntime;
  execute(input: {
    operationId: string;
    target: WorktreeTarget;
    prompt: string;
    previous: AgentSessionBinding | null;
    signal?: AbortSignal;
    authorizeLaunch(): void;
    recordExpectedWorktree(worktree: WorktreeLocation): void;
    recordWorkspace(worktree: Worktree): void;
    recordSession(reference: WorkerSessionReference): void;
  }): Promise<AgentTurnEvidence>;
}
