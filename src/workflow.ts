export const workflowStates = [
  "awaiting_review",
  "review_running",
  "fixing",
  "validating",
  "ready_for_human",
  "escalated",
  "stopped",
] as const;

export type WorkflowState = (typeof workflowStates)[number];
export type ReviewOutcome =
  "completed_with_findings" | "completed_clean" | "in_progress" | "indeterminate";
export type CheckOutcome = "passed" | "failed" | "pending" | "unknown";
export type CycleOutcome = "successful" | "unsuccessful";
export type WorkflowIdentity = {
  repository: string;
  pullRequest: number;
};
export type CheckEvidence = { name: string; sha: string; outcome: CheckOutcome };
export type ReviewEvidence = { sha: string; outcome: ReviewOutcome };
export type Workflow = {
  id: string;
  identity: WorkflowIdentity;
  state: WorkflowState;
  headSha: string;
  requiredChecks: string[] | null;
  review: ReviewEvidence | null;
  checks: CheckEvidence[];
  fixCycles: number;
  escalationReason: string | null;
};

export type WorkflowCommand =
  | { type: "head_changed"; sha: string }
  | { type: "review_started" }
  | { type: "review_received"; evidence: ReviewEvidence }
  | { type: "checks_received"; evidence: CheckEvidence[]; configuredNames: string[] | null }
  | { type: "fix_started" }
  | { type: "validation_started" }
  | { type: "cycle_finished"; outcome: CycleOutcome }
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

  if (current.state === "stopped" || current.state === "escalated") {
    throw new InvalidTransitionError(
      `Cannot transition a ${current.state} workflow without a future explicit recovery action.`,
    );
  }

  switch (command.type) {
    case "head_changed":
      if (!command.sha || command.sha === current.headSha)
        throw new InvalidTransitionError("A head change requires a new non-empty SHA.");
      next.headSha = command.sha;
      next.review = null;
      next.checks = [];
      next.state = "awaiting_review";
      break;
    case "review_started":
      requireState(current, ["awaiting_review"]);
      next.state = "review_running";
      break;
    case "review_received":
      if (command.evidence.sha !== current.headSha)
        throw new InvalidTransitionError("Review evidence must match the current head SHA.");
      next.review = command.evidence;
      if (command.evidence.outcome === "completed_with_findings") next.state = "fixing";
      else if (command.evidence.outcome === "in_progress") next.state = "review_running";
      else if (command.evidence.outcome === "indeterminate") next.state = "escalated";
      else next.state = isReady(next) ? "ready_for_human" : "awaiting_review";
      if (command.evidence.outcome === "indeterminate")
        next.escalationReason = "Review evidence is indeterminate.";
      break;
    case "checks_received":
      if (command.evidence.some((check) => check.sha !== current.headSha))
        throw new InvalidTransitionError("Check evidence must match the current head SHA.");
      next.checks = command.evidence;
      next.requiredChecks = command.configuredNames;
      next.state = isReady(next)
        ? "ready_for_human"
        : current.state === "ready_for_human"
          ? "awaiting_review"
          : current.state;
      break;
    case "fix_started":
      requireState(current, ["fixing"]);
      if (current.fixCycles >= 3)
        throw new InvalidTransitionError(
          "The maximum of three unsuccessful fix cycles has been reached.",
        );
      next.state = "fixing";
      break;
    case "validation_started":
      requireState(current, ["fixing"]);
      next.state = "validating";
      break;
    case "cycle_finished":
      requireState(current, ["validating"]);
      if (command.outcome === "unsuccessful") next.fixCycles += 1;
      if (next.fixCycles >= 3 && command.outcome === "unsuccessful") {
        next.state = "escalated";
        next.escalationReason = "Three unsuccessful fix cycles.";
      } else next.state = "awaiting_review";
      break;
    case "escalate":
      if (!command.reason.trim())
        throw new InvalidTransitionError("An escalation requires a reason.");
      next.state = "escalated";
      next.escalationReason = command.reason;
      break;
    case "stop":
      if (!command.reason.trim()) throw new InvalidTransitionError("Stopping requires a reason.");
      next.state = "stopped";
      next.escalationReason = command.reason;
      break;
  }
  if (next.state === "ready_for_human" && !isReady(next))
    throw new InvalidTransitionError(
      "Readiness requires explicit clean review and passing configured checks for the current SHA.",
    );
  return { workflow: next, from, to: next.state, reason, headSha: next.headSha };
}

export function isReady(workflow: Workflow): boolean {
  if (!workflow.requiredChecks || workflow.requiredChecks.length === 0) return false;
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

function requireState(workflow: Workflow, allowed: WorkflowState[]): void {
  if (!allowed.includes(workflow.state))
    throw new InvalidTransitionError(
      `Cannot apply this command while workflow is ${workflow.state}.`,
    );
}

function transitionReason(command: WorkflowCommand, headSha: string): string {
  switch (command.type) {
    case "head_changed":
      return `head_changed to ${command.sha}`;
    case "review_received":
      return `review_received: ${command.evidence.outcome} for ${command.evidence.sha}`;
    case "checks_received":
      return `checks_received for ${headSha}: ${command.evidence.map((check) => `${check.name}=${check.outcome}`).join(", ") || "no check evidence"}`;
    case "cycle_finished":
      return `cycle_finished: ${command.outcome}`;
    case "escalate":
    case "stop":
      return command.reason;
    default:
      return command.type;
  }
}
