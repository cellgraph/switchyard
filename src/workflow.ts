export const workflowStates = ["awaiting_review", "escalated", "stopped"] as const;

export type WorkflowState = (typeof workflowStates)[number];
export type CheckOutcome = "passed" | "failed" | "pending" | "unknown";
export type WorkflowIdentity = {
  repository: string;
  pullRequest: number;
};
export type CheckEvidence = { name: string; sha: string; outcome: CheckOutcome };
export type GitHubPullRequestStatus = "eligible" | "draft" | "fork" | "closed" | "merged";
export type Workflow = {
  id: string;
  identity: WorkflowIdentity;
  state: WorkflowState;
  headSha: string;
  requiredChecks: string[] | null;
  checks: CheckEvidence[];
  escalationReason: string | null;
  githubStatus?: GitHubPullRequestStatus;
};

export type WorkflowCommand =
  | { type: "head_changed"; sha: string }
  | { type: "github_pull_request"; sha: string; status: GitHubPullRequestStatus }
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

  const held = isOperatorHeld(current);
  if (held && command.type !== "github_pull_request") {
    throw new InvalidTransitionError(
      `Cannot transition a ${current.state} workflow without a future explicit recovery action.`,
    );
  }

  switch (command.type) {
    case "github_pull_request":
      if (!command.sha)
        throw new InvalidTransitionError("A GitHub pull request requires a head SHA.");
      if (command.sha !== current.headSha) setHead(next, command.sha);
      next.githubStatus = command.status;
      if (!held) next.state = command.status === "eligible" ? "awaiting_review" : "stopped";
      if (next.state !== "awaiting_review") next.checks = [];
      break;
    case "head_changed":
      if (current.state !== "awaiting_review")
        throw new InvalidTransitionError(
          "An inactive workflow requires an authoritative GitHub observation.",
        );
      if (!command.sha || command.sha === current.headSha)
        throw new InvalidTransitionError("A head change requires a new non-empty SHA.");
      setHead(next, command.sha);
      break;
    case "checks_received":
      if (current.state !== "awaiting_review")
        throw new InvalidTransitionError("Cannot record current checks for an inactive workflow.");
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
      next.checks = [];
      break;
    case "stop":
      if (!command.reason.trim()) throw new InvalidTransitionError("Stopping requires a reason.");
      next.state = "stopped";
      next.escalationReason = command.reason;
      next.checks = [];
      break;
  }
  return { workflow: next, from, to: next.state, reason, headSha: next.headSha };
}

export function isOperatorHeld(workflow: Workflow | null): boolean {
  return (
    workflow !== null &&
    (workflow.state === "escalated" ||
      (workflow.state === "stopped" && workflow.escalationReason !== null))
  );
}

function setHead(workflow: Workflow, sha: string): void {
  workflow.headSha = sha;
  workflow.checks = [];
}

function transitionReason(command: WorkflowCommand, headSha: string): string {
  switch (command.type) {
    case "head_changed":
      return `head_changed to ${command.sha}`;
    case "github_pull_request":
      return `github_pull_request ${command.status} at ${command.sha}`;
    case "checks_received":
      return `checks_received for ${headSha}: ${command.evidence.map((check) => `${check.name}=${check.outcome}`).join(", ") || "no check evidence"}`;
    case "escalate":
    case "stop":
      return command.reason;
  }
}
