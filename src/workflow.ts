export const workflowStates = [
  "awaiting_review",
  "review_running",
  "review_findings",
  "ready_for_human",
  "escalated",
  "stopped",
] as const;

export type WorkflowState = (typeof workflowStates)[number];
export type ReviewOutcome =
  "completed_with_findings" | "completed_clean" | "in_progress" | "indeterminate";
export type CheckOutcome = "passed" | "failed" | "pending" | "unknown";
export type WorkflowIdentity = {
  repository: string;
  pullRequest: number;
};
export type CheckEvidence = { name: string; sha: string; outcome: CheckOutcome };
export type ReviewEvidence = { sha: string; outcome: ReviewOutcome; runId?: string };
export type Workflow = {
  id: string;
  identity: WorkflowIdentity;
  state: WorkflowState;
  headSha: string;
  requiredChecks: string[] | null;
  review: ReviewEvidence | null;
  checks: CheckEvidence[];
  escalationReason: string | null;
  closedByGitHub?: true;
};

export type WorkflowCommand =
  | { type: "head_changed"; sha: string }
  | { type: "github_pull_request"; sha: string; state: "open" | "closed" }
  | { type: "review_invalidated"; reason: string }
  | { type: "review_received"; evidence: ReviewEvidence }
  | { type: "checks_received"; evidence: CheckEvidence[]; configuredNames: string[] | null }
  | { type: "findings_changed" }
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

export function transitionWorkflow(
  current: Workflow,
  command: WorkflowCommand,
  hasBlockingFindings: boolean,
): Transition {
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
        next.review = null;
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
    case "review_invalidated":
      next.review = null;
      next.state = "awaiting_review";
      break;
    case "review_received":
      if (command.evidence.sha !== current.headSha)
        throw new InvalidTransitionError("Review evidence must match the current head SHA.");
      if (
        current.review?.sha === command.evidence.sha &&
        current.review.outcome === command.evidence.outcome &&
        current.review.runId === command.evidence.runId
      )
        return {
          workflow: current,
          from,
          to: from,
          reason: `duplicate review evidence: ${command.evidence.outcome} for ${command.evidence.sha}`,
          headSha: current.headSha,
        };
      next.review = command.evidence;
      next.escalationReason = null;
      if (command.evidence.outcome === "in_progress") {
        next.state = "review_running";
      } else if (command.evidence.outcome === "completed_with_findings") {
        next.state = "review_findings";
      } else if (command.evidence.outcome === "indeterminate") {
        next.state = "escalated";
        next.escalationReason = "Review evidence is indeterminate.";
      } else {
        next.state = isReady(next, hasBlockingFindings) ? "ready_for_human" : "awaiting_review";
      }
      break;
    case "checks_received":
      if (command.evidence.some((check) => check.sha !== current.headSha))
        throw new InvalidTransitionError("Check evidence must match the current head SHA.");
      next.checks = command.evidence;
      next.requiredChecks = command.configuredNames;
      updateReadiness();
      break;
    case "findings_changed":
      updateReadiness();
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
  if (next.state === "ready_for_human" && !isReady(next, hasBlockingFindings))
    throw new InvalidTransitionError(
      "Readiness requires explicit clean review, resolved blocking findings, and passing configured checks for the current SHA.",
    );
  return { workflow: next, from, to: next.state, reason, headSha: next.headSha };

  function updateReadiness() {
    if (isReady(next, hasBlockingFindings)) next.state = "ready_for_human";
    else if (current.state === "ready_for_human") next.state = "awaiting_review";
  }
}

function isReady(workflow: Workflow, hasBlockingFindings: boolean): boolean {
  if (hasBlockingFindings || !workflow.requiredChecks || workflow.requiredChecks.length === 0)
    return false;
  if (
    !workflow.review ||
    workflow.review.sha !== workflow.headSha ||
    workflow.review.outcome !== "completed_clean"
  )
    return false;
  const checks = new Map(
    workflow.checks
      .filter((check) => check.sha === workflow.headSha)
      .map((check) => [check.name, check.outcome]),
  );
  return workflow.requiredChecks.every((name) => checks.get(name) === "passed");
}

function setHead(workflow: Workflow, sha: string): void {
  workflow.headSha = sha;
  workflow.review = null;
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
    case "review_received":
      return `review_received: ${command.evidence.outcome} for ${command.evidence.sha}${command.evidence.runId ? ` (run ${command.evidence.runId})` : ""}`;
    case "checks_received":
      return `checks_received for ${headSha}: ${command.evidence.map((check) => `${check.name}=${check.outcome}`).join(", ") || "no check evidence"}`;
    case "escalate":
    case "stop":
    case "review_invalidated":
      return command.reason;
    default:
      return command.type;
  }
}
