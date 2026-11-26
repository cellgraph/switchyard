export const workflowStates = ["awaiting_review", "escalated", "stopped"] as const;

export type WorkflowState = (typeof workflowStates)[number];
export type CheckOutcome = "passed" | "failed" | "pending" | "unknown";
export type WorkflowIdentity = {
  repository: string;
  pullRequest: number;
};
export type CheckEvidence = { name: string; sha: string; outcome: CheckOutcome };
export type Workflow = {
  id: string;
  identity: WorkflowIdentity;
  state: WorkflowState;
  headSha: string;
  requiredChecks: string[] | null;
  checks: CheckEvidence[];
  escalationReason: string | null;
  closedByGitHub?: true;
};

export type WorkflowCommand =
  | { type: "head_changed"; sha: string }
  | { type: "github_pull_request"; sha: string; state: "open" | "closed" }
  | { type: "checks_received"; evidence: CheckEvidence[]; configuredNames: string[] | null }
  | { type: "escalate"; reason: string }
  | { type: "stop"; reason: string };

export type Transition = {
  workflow: Workflow;
  from: WorkflowState;
  to: WorkflowState;
  reason: string;
  headSha: string;
};

export class InvalidTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTransitionError";
  }
}

export function transitionWorkflow(current: Workflow, command: WorkflowCommand): Transition {
  const next: Workflow = { ...current, checks: [...current.checks] };
  const from = current.state;
  const reason = transitionReason(command, current.headSha);

  const mayChangeGitHubClosure =
    current.closedByGitHub === true &&
    (command.type === "github_pull_request" ||
      command.type === "escalate" ||
      command.type === "stop");
  if ((current.state === "stopped" && !mayChangeGitHubClosure) || current.state === "escalated") {
    throw new InvalidTransitionError(
      `Cannot transition a ${current.state} workflow without a future explicit recovery action.`,
    );
  }

  switch (command.type) {
    case "github_pull_request":
      if (!command.sha)
        throw new InvalidTransitionError("A GitHub pull request requires a head SHA.");
      if (command.sha !== current.headSha) setHead(next, command.sha);
      if (command.state === "closed" || current.closedByGitHub) {
        next.checks = [];
        if (command.state === "closed") {
          next.state = "stopped";
          next.closedByGitHub = true;
          next.escalationReason = "GitHub pull request is closed.";
        } else {
          next.state = "awaiting_review";
          next.escalationReason = null;
          delete next.closedByGitHub;
        }
      }
      break;
    case "head_changed":
      if (!command.sha || command.sha === current.headSha)
        throw new InvalidTransitionError("A head change requires a new non-empty SHA.");
      setHead(next, command.sha);
      break;
    case "checks_received":
      if (command.evidence.some((check) => check.sha !== current.headSha))
        throw new InvalidTransitionError("Check evidence must match the current head SHA.");
      next.checks = command.evidence;
      next.requiredChecks = command.configuredNames;
      break;
    case "escalate":
      if (!command.reason.trim())
        throw new InvalidTransitionError("An escalation requires a reason.");
      next.state = "escalated";
      next.escalationReason = command.reason;
      delete next.closedByGitHub;
      break;
    case "stop":
      if (!command.reason.trim()) throw new InvalidTransitionError("Stopping requires a reason.");
      next.state = "stopped";
      next.escalationReason = command.reason;
      delete next.closedByGitHub;
      break;
  }
  return { workflow: next, from, to: next.state, reason, headSha: next.headSha };
}

function setHead(workflow: Workflow, sha: string): void {
  workflow.headSha = sha;
  workflow.checks = [];
  workflow.escalationReason = null;
  workflow.state = "awaiting_review";
}

function transitionReason(command: WorkflowCommand, headSha: string): string {
  switch (command.type) {
    case "head_changed":
      return `head_changed to ${command.sha}`;
    case "github_pull_request":
      return `github_pull_request ${command.state} at ${command.sha}`;
    case "checks_received":
      return `checks_received for ${headSha}: ${command.evidence.map((check) => `${check.name}=${check.outcome}`).join(", ") || "no check evidence"}`;
    case "escalate":
    case "stop":
      return command.reason;
  }
}
