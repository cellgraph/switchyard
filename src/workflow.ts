export type WorkflowState =
  | "awaiting_review"
  | "review_running"
  | "fixing"
  | "validating"
  | "ready_for_human"
  | "escalated"
  | "stopped";
