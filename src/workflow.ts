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
export type ReviewEvidence = { sha: string; outcome: ReviewOutcome; runId?: string };
export type Workflow = {
  id: string;
  identity: WorkflowIdentity;
  state: WorkflowState;
  headSha: string;
  requiredChecks: string[] | null;
  review: ReviewEvidence | null;
  checks: CheckEvidence[];
  fixCycles: number;
  cycleAwaitingReview: boolean;
  validationHeadSha: string | null;
  escalationReason: string | null;
  closedByGitHub?: true;
};

export type WorkflowCommand =
  | { type: "head_changed"; sha: string }
  | { type: "github_pull_request"; sha: string; state: "open" | "closed" }
  | { type: "review_started" }
  | { type: "review_invalidated"; reason: string }
  | { type: "review_received"; evidence: ReviewEvidence }
  | { type: "checks_received"; evidence: CheckEvidence[]; configuredNames: string[] | null }
  | { type: "fix_attention"; reason: string | null }
  | { type: "fix_started" }
  | { type: "validation_started" }
  | { type: "cycle_finished"; outcome: CycleOutcome }
  | { type: "late_publication_confirmed"; sha: string }
  | { type: "escalate"; reason: string; observedHeadSha?: string }
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
  if (
    (current.state === "stopped" && !mayChangeGitHubClosure) ||
    (current.state === "escalated" && command.type !== "late_publication_confirmed")
  ) {
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
          next.validationHeadSha = null;
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
    case "review_started":
      requireState(current, ["awaiting_review"]);
      next.state = "review_running";
      break;
    case "review_invalidated":
      next.review = null;
      if (current.state !== "validating") next.state = "awaiting_review";
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
      if (command.evidence.outcome === "completed_with_findings") {
        if (current.state !== "validating") {
          if (current.cycleAwaitingReview) next.fixCycles += 1;
          next.cycleAwaitingReview = false;
          if (next.fixCycles >= 3) {
            next.state = "escalated";
            next.escalationReason = "Three fix cycles received findings in review.";
          } else next.state = "fixing";
        }
      } else if (command.evidence.outcome === "in_progress")
        next.state = current.state === "validating" ? "validating" : "review_running";
      else if (command.evidence.outcome === "indeterminate") next.state = "escalated";
      else {
        next.cycleAwaitingReview = false;
        next.state =
          current.state === "validating"
            ? "validating"
            : isReady(next)
              ? "ready_for_human"
              : "awaiting_review";
      }
      if (command.evidence.outcome === "indeterminate")
        next.escalationReason = "Review evidence is indeterminate.";
      break;
    case "checks_received":
      if (command.evidence.some((check) => check.sha !== current.headSha))
        throw new InvalidTransitionError("Check evidence must match the current head SHA.");
      next.checks = command.evidence;
      next.requiredChecks = command.configuredNames;
      next.state =
        current.state === "validating"
          ? "validating"
          : isReady(next)
            ? "ready_for_human"
            : current.state === "ready_for_human"
              ? "awaiting_review"
              : current.state;
      break;
    case "fix_attention":
      next.escalationReason = command.reason;
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
      next.validationHeadSha = current.headSha;
      next.state = "validating";
      break;
    case "cycle_finished":
      requireState(current, ["validating"]);
      if (command.outcome === "unsuccessful") next.fixCycles += 1;
      if (
        command.outcome === "successful" &&
        current.validationHeadSha !== current.headSha &&
        current.validationHeadSha !== null &&
        current.review?.sha === current.headSha &&
        current.review.outcome === "completed_with_findings"
      )
        next.fixCycles += 1;
      next.validationHeadSha = null;
      if (next.fixCycles >= 3 && command.outcome === "unsuccessful") {
        next.state = "escalated";
        next.escalationReason = "Three unsuccessful fix cycles.";
      } else if (next.fixCycles >= 3 && command.outcome === "successful") {
        next.cycleAwaitingReview = false;
        next.state = "escalated";
        next.escalationReason = "Three fix cycles received findings in review.";
      } else if (
        command.outcome === "successful" &&
        current.validationHeadSha !== current.headSha &&
        current.validationHeadSha !== null &&
        current.review?.sha === current.headSha &&
        current.review.outcome === "completed_with_findings"
      ) {
        next.cycleAwaitingReview = false;
        next.state = "fixing";
      } else if (
        command.outcome === "successful" &&
        current.review?.sha === current.headSha &&
        current.review.outcome === "completed_clean"
      ) {
        next.cycleAwaitingReview = false;
        next.state = isReady(next) ? "ready_for_human" : "awaiting_review";
      } else if (command.outcome === "unsuccessful") {
        next.cycleAwaitingReview = false;
        next.state = "fixing";
      } else {
        next.cycleAwaitingReview = true;
        next.state =
          current.review?.outcome === "in_progress" ? "review_running" : "awaiting_review";
      }
      break;
    case "late_publication_confirmed":
      requireState(current, ["escalated"]);
      next.headSha = command.sha;
      next.review = null;
      next.checks = [];
      next.validationHeadSha = null;
      next.cycleAwaitingReview = false;
      break;
    case "escalate":
      if (!command.reason.trim())
        throw new InvalidTransitionError("An escalation requires a reason.");
      if (command.observedHeadSha !== undefined) {
        if (!command.observedHeadSha)
          throw new InvalidTransitionError("An observed head SHA cannot be empty.");
        if (command.observedHeadSha !== current.headSha) setHead(next, command.observedHeadSha);
      }
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

function setHead(workflow: Workflow, sha: string): void {
  workflow.headSha = sha;
  workflow.review = null;
  workflow.checks = [];
  workflow.escalationReason = null;
  if (workflow.state !== "validating") workflow.state = "awaiting_review";
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
    case "cycle_finished":
      return `cycle_finished: ${command.outcome}`;
    case "escalate":
    case "stop":
    case "review_invalidated":
      return command.reason;
    default:
      return command.type;
  }
}
