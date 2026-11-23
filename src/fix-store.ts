import type { DatabaseSync } from "node:sqlite";
import type { AgentConfig } from "./agent-config.ts";
import type { AgentTurnIntent } from "./agent-operation.ts";
import { digest } from "./review-store.ts";
import type { FindingInput } from "./review.ts";
import type { Workflow } from "./workflow.ts";
import type { Worktree } from "./worktree.ts";

export const fixMigration = `
  CREATE TABLE fix_cycles (
    id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflows(id),
    head_sha TEXT NOT NULL, record TEXT NOT NULL,
    UNIQUE(workflow_id, head_sha)
  );`;

export type ValidationCommand = { id: string; argv: string[] };
export type FixConfig = AgentConfig & {
  repositoryDirectory: string;
  worktreeRoot: string;
  localBranch: string;
  allowedPaths: string[];
  requiredChecks: string[];
  validation: ValidationCommand[];
  maxCycles: number;
  maxOperationAttempts: number;
  maxTotalTokens?: number;
  maxValidationRetries: number;
  agentTimeoutMs: number;
  validationTimeoutMs: number;
};
export type FindingAuthorization = {
  id: string;
  content: FindingInput;
  rationale: string;
  acceptanceId: string;
  lastActionId: string;
};
export type FixReview = {
  id: string;
  digest: string;
  evidence: string;
  findings: FindingAuthorization[];
  pending: string[];
};
export type ValidationResult = {
  id: string;
  status: "passed" | "failed" | "unknown";
  exitCode: number | null;
  output: string;
};
export type FixCycle = {
  id: string;
  workflowId: string;
  head: string;
  remoteBranch: string;
  review: FixReview;
  revision: number;
  version: number;
  config: FixConfig;
  phase:
    | "proposed"
    | "authorized"
    | "agent"
    | "validating"
    | "validation_retry"
    | "validated"
    | "publication_authorized"
    | "committing"
    | "pushing"
    | "confirming"
    | "finished"
    | "escalated";
  owner: number | null;
  operationId: string;
  worktree?: Worktree;
  candidate?: { tree: string; checkpoint: string; content: string };
  validation: Array<{
    status: "running" | "passed" | "failed" | "unknown";
    results: ValidationResult[];
  }>;
  commit?: string;
  confirmationReads?: number;
  interruptedPushDeadline?: number;
  push?: "intent" | "returned" | "unknown" | "confirmed";
  reason?: string;
  createdAt: string;
  updatedAt: string;
};

export function canConfirmLatePush(cycle: FixCycle | undefined): cycle is FixCycle {
  return (
    cycle?.phase === "escalated" &&
    cycle.push === "unknown" &&
    cycle.interruptedPushDeadline !== undefined
  );
}

export function requiredChecksForCycle(cycle: FixCycle | undefined, configured: string[] | null) {
  return cycle && !["proposed", "finished", "escalated"].includes(cycle.phase)
    ? cycle.config.requiredChecks
    : configured;
}

export function workflowAuthorizationRevision(db: DatabaseSync, id: string): number {
  return (
    db
      .prepare(
        `
    SELECT COALESCE(MAX(id), 0) AS revision FROM transitions WHERE workflow_id=?
    AND (from_state!=to_state OR reason LIKE 'head_changed to %'
      OR reason LIKE 'github_pull_request %' OR reason LIKE 'review_received:%')
  `,
      )
      .get(id) as { revision: number }
  ).revision;
}

export function readFixCycles(db: DatabaseSync, id: string): FixCycle[] {
  return db
    .prepare("SELECT record FROM fix_cycles WHERE workflow_id=? ORDER BY rowid")
    .all(id)
    .map(({ record }) => JSON.parse(String(record)) as FixCycle);
}

export function readFixReview(db: DatabaseSync, workflow: Workflow): FixReview | null {
  const projected = workflow.review;
  if (projected?.sha !== workflow.headSha || projected.outcome !== "completed_with_findings")
    return null;
  const run = db
    .prepare(
      `
    SELECT id, evidence, result_digest FROM review_runs
    WHERE id=? AND workflow_id=? AND head_sha=? AND eligible=1 AND status='completed'
  `,
    )
    .get(projected.runId ?? "", workflow.id, workflow.headSha) as
    { id: string; evidence: string; result_digest: string } | undefined;
  if (!run) return null;

  const findings: FindingAuthorization[] = [];
  const pending: string[] = [];
  const rows = db
    .prepare("SELECT id, content FROM review_findings WHERE run_id=? ORDER BY rowid")
    .all(run.id) as Array<{ id: string; content: string }>;
  const actions = db.prepare(
    "SELECT id, action, rationale FROM finding_actions WHERE finding_id=? ORDER BY rowid",
  );
  for (const row of rows) {
    const history = actions.all(row.id) as Array<{ id: string; action: string; rationale: string }>;
    const resolution = history.findLast(({ action }) =>
      ["fixed", "superseded", "reopened"].includes(action),
    );
    if (resolution && resolution.action !== "reopened") continue;
    const decision = history.findLast(({ action }) =>
      ["accepted", "deferred", "rejected"].includes(action),
    );
    if (!decision) pending.push(row.id);
    if (decision?.action === "accepted") {
      findings.push({
        id: row.id,
        content: JSON.parse(row.content) as FindingInput,
        rationale: decision.rationale,
        acceptanceId: decision.id,
        lastActionId: history.at(-1)!.id,
      });
    }
  }
  return {
    id: run.id,
    digest: digest([run.result_digest, findings, pending]),
    evidence: run.evidence,
    findings,
    pending,
  };
}

export function fixReviewStillAuthorized(
  db: DatabaseSync,
  workflow: Workflow,
  cycle: FixCycle,
): boolean {
  const review = readFixReview(db, workflow);
  return (
    workflow.headSha === cycle.head &&
    review?.id === cycle.review.id &&
    review.digest === cycle.review.digest
  );
}

export function fixAgentAuthorized(
  db: DatabaseSync,
  workflow: Workflow,
  intent: Pick<AgentTurnIntent, "operationId" | "expectedHead" | "branch" | "fix">,
): boolean {
  const latest = readFixCycles(db, workflow.id).at(-1);
  if (!latest || latest.phase === "finished") {
    // The standalone turn interface still supports historical, pre-Phase 4 workflow records.
    return !intent.fix && (workflow.state !== "fixing" || !workflow.review?.runId);
  }
  return (
    intent.fix?.cycleId === latest.id &&
    JSON.stringify(intent.fix.findingIds) ===
      JSON.stringify(latest.review.findings.map(({ id }) => id)) &&
    latest.phase === "agent" &&
    latest.operationId === intent.operationId &&
    latest.head === intent.expectedHead &&
    latest.config.localBranch === intent.branch &&
    workflowAuthorizationRevision(db, workflow.id) === latest.revision &&
    fixReviewStillAuthorized(db, workflow, latest)
  );
}
